"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Compass,
  ImagePlus,
  MapPin,
  Plus,
  ScanSearch,
  Sparkles,
  SwitchCamera,
  Trash2,
  Zap,
} from "lucide-react";
import { createEngine, type Engine, type Prediction } from "@/lib/ar/engine";
import { extractGpsFromFile } from "@/lib/ar/exif";
import {
  bearingDegrees,
  blendLocation,
  haversineMeters,
  normalizeDegrees,
  relativeBearing,
  type LatLng,
  type UserLocation,
} from "@/lib/ar/geo";
import {
  createBuilding as createBuildingRemote,
  createSample as createSampleRemote,
  deleteBuilding as deleteBuildingRemote,
  getOrCreateAuthToken,
  listAllSamplesByBuilding,
  listBuildings as listBuildingsRemote,
  type ApiBuilding,
} from "@/lib/ar/backend";
import {
  type AllMeta,
  clearStoredDataset,
  loadDataset,
  loadMeta,
  saveDataset,
  saveMeta,
} from "@/lib/ar/storage";

type Mode = "teach" | "recognize";
type CameraState = "idle" | "starting" | "ready" | "error";
type Facing = "environment" | "user";
type LocationStatus = "idle" | "watching" | "denied" | "unavailable";
type OrientationStatus =
  | "idle"
  | "needsPermission"
  | "watching"
  | "denied"
  | "unavailable";

const FRAMES_PER_CAPTURE = 30;
const CAPTURE_INTERVAL_MS = 50;
const RECOGNIZE_INTERVAL_MS = 110;
const MAX_RANGE_M = 400;
const FOV_HALF_DEG = 32.5;
// TEMP: disable GPS gating while testing recognition quality/speed.
const ENABLE_GPS_FEATURES = false;
const CONSENSUS_WINDOW = 8;
const CONSENSUS_MIN_VOTES = 5;
const DEMO_LOCK_MS = 1500;
const NEGATIVE_LABEL = "NOT_BUILDING";
const RECOGNITION_PROFILES = {
  fast: { label: "Fast", minConfidence: 0.55 },
  balanced: { label: "Balanced", minConfidence: 0.62 },
  strict: { label: "Strict", minConfidence: 0.7 },
} as const;
type RecognitionProfile = keyof typeof RECOGNITION_PROFILES;
const RECOMMENDED_SAMPLES_PER_BUILDING = 20;

function isNegativeClassLabel(label: string, meta: AllMeta): boolean {
  if (label === NEGATIVE_LABEL) return true;
  return meta[label]?.isNegative === true;
}

function toDisplayPrediction(prediction: Prediction, meta: AllMeta): Prediction | null {
  if (isNegativeClassLabel(prediction.label, meta)) {
    return {
      label: "No building",
      confidence: 0,
      confidences: { "No building": 1 },
      isLowConfidence: false,
    };
  }
  return prediction;
}

type IosOrientationCtor = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

function getIosOrientationCtor(): IosOrientationCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { DeviceOrientationEvent?: IosOrientationCtor })
    .DeviceOrientationEvent;
  return ctor ?? null;
}

function describeCameraError(err: unknown): string {
  if (!(err instanceof Error)) return "Camera unavailable.";
  if (err.name === "NotAllowedError") {
    return "Camera permission was blocked. Open the lock/camera icon in your browser address bar, allow camera access, then tap Try again.";
  }
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
    return "No usable camera was found on this device.";
  }
  if (err.name === "NotReadableError") {
    return "Camera is in use by another app. Close it and try again.";
  }
  if (err.name === "SecurityError") {
    return "Camera requires HTTPS (or localhost). Reload over a secure URL.";
  }
  return err.message || "Camera unavailable.";
}

function loadImageFromFile(
  file: File,
): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to decode ${file.name}`));
    };
    img.src = url;
  });
}

type Positioned = {
  label: string;
  count: number;
  distance: number;
  relBearing: number;
  screenX: number;
  screenY: number;
};

export default function ARShell() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const missStreakRef = useRef(0);
  const allowedLabelsRef = useRef<Set<string> | undefined>(undefined);

  const [mode, setMode] = useState<Mode>("recognize");
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [engineStatus, setEngineStatus] = useState<"loading" | "ready" | "error">("loading");
  const [engineError, setEngineError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const [capture, setCapture] = useState<{ label: string; progress: number } | null>(null);
  const [addingPhotos, setAddingPhotos] = useState<{ current: number; total: number } | null>(null);
  const [recognitionProfile, setRecognitionProfile] = useState<RecognitionProfile>("balanced");
  const [demoLockEnabled, setDemoLockEnabled] = useState(true);
  const [lastInferenceMs, setLastInferenceMs] = useState<number>(0);
  const [hydrationStatus, setHydrationStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [lockActive, setLockActive] = useState(false);
  const consensusRef = useRef<Array<{ label: string | null; confidence: number }>>([]);
  const lockUntilRef = useRef(0);

  const [meta, setMeta] = useState<AllMeta>({});
  const [backendReady, setBackendReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const buildingByLabelRef = useRef<Record<string, ApiBuilding>>({});
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>(() => {
    if (!ENABLE_GPS_FEATURES) return "idle";
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      return "unavailable";
    }
    return "watching";
  });
  const [heading, setHeading] = useState<number | null>(null);
  const [orientationStatus, setOrientationStatus] = useState<OrientationStatus>(() => {
    const ctor = getIosOrientationCtor();
    if (!ctor) return "unavailable";
    if (typeof ctor.requestPermission === "function") return "needsPermission";
    return "watching";
  });

  const cameraReady = cameraState === "ready";

  const startCamera = useCallback(
    async (target?: Facing) => {
      const facingTarget = target ?? facing;
      if (cameraState === "starting") return;
      setCameraError(null);
      setCameraState("starting");

      let newStream: MediaStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingTarget },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (e) {
        setCameraError(describeCameraError(e));
        setCameraState("error");
        return;
      }

      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = newStream;
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        await videoRef.current.play().catch(() => {});
      }
      setFacing(facingTarget);
      setCameraState("ready");
    },
    [cameraState, facing],
  );

  const switchCamera = useCallback(() => {
    if (cameraState !== "ready") return;
    startCamera(facing === "environment" ? "user" : "environment");
  }, [cameraState, facing, startCamera]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const ensureRemoteBuilding = useCallback(
    async (label: string, location?: LatLng | null): Promise<string | null> => {
      const token = tokenRef.current;
      if (!token) return null;
      const existing = buildingByLabelRef.current[label];
      if (existing) return existing.id;

      const created = await createBuildingRemote(token, {
        name: label,
        lat: location?.lat,
        lng: location?.lng,
      });
      buildingByLabelRef.current[label] = created;
      return created.id;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getOrCreateAuthToken();
        if (cancelled) return;
        tokenRef.current = token;
        const buildings = await listBuildingsRemote(token);
        if (cancelled) return;
        const nextMap: Record<string, ApiBuilding> = {};
        for (const building of buildings) {
          nextMap[building.name] = building;
        }
        buildingByLabelRef.current = nextMap;
        setBackendReady(true);
      } catch (error) {
        console.warn("AR: backend auth/sync failed", error);
        setBackendReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const eng = engineRef.current;
    const token = tokenRef.current;
    if (!eng || !token || !backendReady) return;
    if (eng.totalExamples() > 0) {
      setHydrationStatus("done");
      return;
    }

    void (async () => {
      try {
        setHydrationStatus("loading");
        const groups = await listAllSamplesByBuilding(token);
        if (cancelled) return;
        for (const group of groups) {
          for (const sample of group.samples) {
            if (sample.embedding.length === 0) continue;
            eng.addEmbedding(sample.embedding, group.building.name);
          }
        }
        saveDataset(eng);
        setCounts(eng.counts());
        setHydrationStatus("done");
      } catch (error) {
        console.warn("AR: remote sample hydration failed", error);
        setHydrationStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backendReady, engineStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const eng = await createEngine();
        if (cancelled) {
          eng.dispose();
          return;
        }
        engineRef.current = eng;
        loadDataset(eng);
        setCounts(eng.counts());
        setMeta(loadMeta());
        setEngineStatus("ready");
      } catch (e) {
        setEngineError(e instanceof Error ? e.message : "Engine load failed");
        setEngineStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      const eng = engineRef.current;
      if (eng) {
        engineRef.current = null;
        eng.dispose();
      }
    };
  }, []);

  useEffect(() => {
    if (!ENABLE_GPS_FEATURES) return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setUserLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        setLocationStatus(
          err.code === err.PERMISSION_DENIED ? "denied" : "unavailable",
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    if (orientationStatus !== "watching") return;
    const handler = (event: DeviceOrientationEvent) => {
      const webkit =
        "webkitCompassHeading" in event
          ? Number((event as unknown as { webkitCompassHeading: number }).webkitCompassHeading)
          : undefined;
      const next =
        typeof webkit === "number" && Number.isFinite(webkit)
          ? webkit
          : event.alpha != null
            ? 360 - event.alpha
            : null;
      if (next !== null && Number.isFinite(next)) {
        setHeading(normalizeDegrees(next));
      }
    };
    window.addEventListener("deviceorientation", handler, true);
    return () => window.removeEventListener("deviceorientation", handler, true);
  }, [orientationStatus]);

  const enableCompass = useCallback(async () => {
    const ctor = getIosOrientationCtor();
    if (!ctor?.requestPermission) {
      setOrientationStatus("watching");
      return;
    }
    try {
      const result = await ctor.requestPermission();
      setOrientationStatus(result === "granted" ? "watching" : "denied");
    } catch {
      setOrientationStatus("denied");
    }
  }, []);

  const updateBuildingLocation = useCallback((label: string, sample: LatLng | null) => {
    if (!ENABLE_GPS_FEATURES) return;
    if (!sample) return;
    setMeta((prev) => {
      const existing = prev[label] ?? {};
      const n = existing.locationSampleCount ?? 0;
      const blended = blendLocation(existing.location, sample, n);
      const next: AllMeta = {
        ...prev,
        [label]: { ...existing, location: blended, locationSampleCount: n + 1 },
      };
      saveMeta(next);
      return next;
    });
  }, []);

  const nearby = useMemo(() => {
    if (!ENABLE_GPS_FEATURES) return [] as Positioned[];
    if (!userLocation) return [] as Positioned[];
    const out: Array<{
      label: string;
      count: number;
      distance: number;
      relBearing: number | null;
      inFov: boolean;
    }> = [];
    for (const [label, m] of Object.entries(meta)) {
      if (!m.location) continue;
      const count = counts[label] ?? 0;
      if (count === 0) continue;
      const distance = haversineMeters(userLocation, m.location);
      if (distance > MAX_RANGE_M) continue;
      const buildingBearing = bearingDegrees(userLocation, m.location);
      const relBearing =
        heading != null ? relativeBearing(buildingBearing, heading) : null;
      const inFov = relBearing != null && Math.abs(relBearing) <= FOV_HALF_DEG;
      out.push({ label, count, distance: Math.round(distance), relBearing, inFov });
    }
    out.sort((a, b) => a.distance - b.distance);
    const positioned: Positioned[] = [];
    for (const b of out) {
      if (!b.inFov || b.relBearing === null) continue;
      const screenX = 50 + (b.relBearing / FOV_HALF_DEG) * 45;
      const screenY = 32 + Math.min(20, Math.log10(Math.max(b.distance, 10) / 10 + 1) * 12);
      positioned.push({
        label: b.label,
        count: b.count,
        distance: b.distance,
        relBearing: b.relBearing,
        screenX,
        screenY,
      });
    }
    return positioned;
  }, [counts, meta, userLocation, heading]);

  const allowedLabels = useMemo(() => {
    if (!ENABLE_GPS_FEATURES) return undefined;
    if (!userLocation) return undefined;
    const inRange = Object.entries(meta).filter(([label, m]) => {
      if (!m.location) return false;
      if ((counts[label] ?? 0) === 0) return false;
      return haversineMeters(userLocation, m.location) <= MAX_RANGE_M;
    });
    if (inRange.length === 0) return undefined;
    return new Set(inRange.map(([label]) => label));
  }, [counts, meta, userLocation]);

  const toggleLabelNegative = useCallback((label: string, value: boolean) => {
    setMeta((prev) => {
      const existing = prev[label] ?? {};
      const next: AllMeta = {
        ...prev,
        [label]: { ...existing, isNegative: value },
      };
      saveMeta(next);
      return next;
    });
  }, []);

  useEffect(() => {
    allowedLabelsRef.current = allowedLabels;
  }, [allowedLabels]);

  useEffect(() => {
    if (mode !== "recognize") return;
    if (engineStatus !== "ready" || !cameraReady) return;

    let stopped = false;
    let timer: number | undefined;

    const tick = async () => {
      if (stopped) return;
      const eng = engineRef.current;
      const video = videoRef.current;
      if (!eng || !video || video.readyState < 2) {
        timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
        return;
      }
      try {
        const startedAt = performance.now();
        const r = await eng.classify(video, allowedLabelsRef.current, {
          minConfidence: RECOGNITION_PROFILES[recognitionProfile].minConfidence,
          returnBestEffort: true,
        });
        const now = performance.now();
        setLastInferenceMs(Math.round(now - startedAt));
        if (!stopped) {
          if (demoLockEnabled && now < lockUntilRef.current) {
            setLockActive(true);
            timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
            return;
          }
          setLockActive(false);

          const voteLabel = r && !r.isLowConfidence ? r.label : null;
          consensusRef.current.push({ label: voteLabel, confidence: r?.confidence ?? 0 });
          if (consensusRef.current.length > CONSENSUS_WINDOW) {
            consensusRef.current.shift();
          }

          const votes = new Map<string, number>();
          for (const item of consensusRef.current) {
            if (!item.label) continue;
            votes.set(item.label, (votes.get(item.label) ?? 0) + 1);
          }
          let topLabel: string | null = null;
          let topVotes = 0;
          for (const [label, count] of votes.entries()) {
            if (count > topVotes) {
              topVotes = count;
              topLabel = label;
            }
          }

          if (topLabel && topVotes >= CONSENSUS_MIN_VOTES) {
            const topItems = consensusRef.current.filter((item) => item.label === topLabel);
            const avgConfidence =
              topItems.reduce((sum, item) => sum + item.confidence, 0) / topItems.length;
            const consensusPrediction = toDisplayPrediction(
              {
                label: topLabel,
                confidence: avgConfidence,
                confidences: r?.confidences ?? { [topLabel]: avgConfidence },
                isLowConfidence: false,
              },
              meta,
            );
            setPrediction(consensusPrediction);
            missStreakRef.current = 0;
            if (demoLockEnabled) {
              lockUntilRef.current = now + DEMO_LOCK_MS;
              setLockActive(true);
            }
            timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
            return;
          }

          if (r) {
            missStreakRef.current = 0;
            setPrediction(toDisplayPrediction(r, meta));
          } else {
            missStreakRef.current += 1;
            if (missStreakRef.current >= 3) {
              setPrediction(null);
            }
          }
        }
      } catch (e) {
        console.warn("AR: classify failed", e);
      }
      timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
    };
    tick();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [mode, engineStatus, cameraReady, recognitionProfile, demoLockEnabled, meta]);

  const startCapture = useCallback(async () => {
    const eng = engineRef.current;
    const video = videoRef.current;
    const label = selectedBuilding?.trim();
    if (!eng || !video || !label || capture || addingPhotos) return;

    const captureLocation = userLocation
      ? { lat: userLocation.lat, lng: userLocation.lng }
      : null;

    setCapture({ label, progress: 0 });
    const embeddings: number[][] = [];
    for (let i = 0; i < FRAMES_PER_CAPTURE; i++) {
      const current = engineRef.current;
      if (!current) break;
      try {
        current.addExample(video, label);
        // Keep the realtime path fast: only sample a few embeddings for backend sync.
        if (backendReady && i % 10 === 0) {
          embeddings.push(current.extractEmbedding(video));
        }
      } catch (e) {
        console.warn("AR: addExample failed", e);
      }
      setCapture({ label, progress: i + 1 });
      await new Promise((r) => window.setTimeout(r, CAPTURE_INTERVAL_MS));
    }
    const final = engineRef.current;
    if (final) {
      saveDataset(final);
      setCounts(final.counts());
    }
    if (captureLocation) updateBuildingLocation(label, captureLocation);
    if (backendReady && embeddings.length > 0) {
      void (async () => {
        try {
          const buildingId = await ensureRemoteBuilding(label, captureLocation);
          if (!buildingId) return;
          const dimensions = embeddings[0]?.length ?? 0;
          if (dimensions === 0) return;
          const averaged = new Array<number>(dimensions).fill(0);
          for (const vector of embeddings) {
            for (let i = 0; i < dimensions; i++) averaged[i] += vector[i] ?? 0;
          }
          for (let i = 0; i < dimensions; i++) averaged[i] /= embeddings.length;

          await createSampleRemote(tokenRef.current!, {
            buildingId,
            embedding: averaged,
            lat: captureLocation?.lat,
            lng: captureLocation?.lng,
            source: "camera",
          });
        } catch (error) {
          console.warn("AR: capture sync failed", error);
        }
      })();
    }
    setCapture(null);
  }, [
    addingPhotos,
    backendReady,
    capture,
    ensureRemoteBuilding,
    selectedBuilding,
    updateBuildingLocation,
    userLocation,
  ]);

  const addPhotos = useCallback(
    async (files: File[]) => {
      const eng = engineRef.current;
      const label = selectedBuilding?.trim();
      if (!eng || !label || files.length === 0 || capture || addingPhotos) return;

      setAddingPhotos({ current: 0, total: files.length });
      const syncJobs: Array<Promise<unknown>> = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let revoke: (() => void) | null = null;
        try {
          const exif = await extractGpsFromFile(file);
          const loaded = await loadImageFromFile(file);
          revoke = loaded.revoke;
          const current = engineRef.current;
          if (!current) break;
          current.addExample(loaded.img, label);
          const embedding = backendReady ? current.extractEmbedding(loaded.img) : [];
          const photoLocation =
            exif ?? (userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null);
          if (photoLocation) updateBuildingLocation(label, photoLocation);
          if (backendReady) {
            syncJobs.push(
              (async () => {
                const buildingId = await ensureRemoteBuilding(label, photoLocation);
                if (buildingId && tokenRef.current && embedding.length > 0) {
                  await createSampleRemote(tokenRef.current, {
                    buildingId,
                    embedding,
                    lat: photoLocation?.lat,
                    lng: photoLocation?.lng,
                    source: "photo",
                  });
                }
              })(),
            );
          }
        } catch (e) {
          console.warn("AR: photo failed", file.name, e);
        } finally {
          revoke?.();
        }
        setAddingPhotos({ current: i + 1, total: files.length });
      }
      const final = engineRef.current;
      if (final) {
        saveDataset(final);
        setCounts(final.counts());
      }
      if (syncJobs.length > 0) {
        void Promise.allSettled(syncJobs).then((results) => {
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed > 0) {
            console.warn(`AR: ${failed} photo sync job(s) failed`);
          }
        });
      }
      setAddingPhotos(null);
    },
    [
      addingPhotos,
      backendReady,
      capture,
      ensureRemoteBuilding,
      selectedBuilding,
      updateBuildingLocation,
      userLocation,
    ],
  );

  const removeLabel = (label: string) => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.clearLabel(label);
    saveDataset(eng);
    setCounts(eng.counts());
    setMeta((prev) => {
      const next = { ...prev };
      delete next[label];
      saveMeta(next);
      return next;
    });
    if (backendReady) {
      const remote = buildingByLabelRef.current[label];
      if (remote && tokenRef.current) {
        void deleteBuildingRemote(tokenRef.current, remote.id).catch((error) => {
          console.warn(`AR: failed deleting remote building "${label}"`, error);
        });
      }
      delete buildingByLabelRef.current[label];
    }
    if (selectedBuilding === label) setSelectedBuilding(null);
  };

  const changeMode = (next: Mode) => {
    if (next !== "recognize") {
      setPrediction(null);
      missStreakRef.current = 0;
      consensusRef.current = [];
      lockUntilRef.current = 0;
      setLockActive(false);
    }
    setMode(next);
  };

  const clearAll = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!window.confirm("Clear all taught buildings?")) return;
    eng.clearAll();
    clearStoredDataset();
    setCounts(eng.counts());
    setMeta({});
    if (backendReady && tokenRef.current) {
      const remoteBuildings = Object.values(buildingByLabelRef.current);
      for (const building of remoteBuildings) {
        void deleteBuildingRemote(tokenRef.current, building.id).catch((error) => {
          console.warn(`AR: failed deleting remote building "${building.name}"`, error);
        });
      }
      buildingByLabelRef.current = {};
    }
    setSelectedBuilding(null);
  };

  const selectedCount = selectedBuilding ? (counts[selectedBuilding] ?? 0) : 0;
  const hasFloatingLabels = mode === "recognize" && nearby.length > 0;
  const showCompassPrompt =
    mode === "recognize" &&
    cameraReady &&
    ENABLE_GPS_FEATURES &&
    orientationStatus === "needsPermission" &&
    Object.keys(meta).length > 0;

  return (
    <main className="relative mx-auto flex h-svh w-full max-w-md flex-col overflow-hidden bg-neutral-950 text-white md:my-4 md:h-[calc(100svh-2rem)] md:rounded-3xl md:shadow-2xl md:ring-1 md:ring-white/10">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-0 bg-black/30" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.45)_0%,transparent_22%,transparent_55%,rgba(0,0,0,0.85)_100%)]" />
      {mode === "recognize" && cameraReady && prediction?.label !== "No building" && (
        <div className="pointer-events-none absolute inset-0 z-11 flex items-center justify-center">
          <div className="relative h-[40vh] w-[74vw] max-w-[330px] rounded-2xl border border-cyan-200/40">
            <div className="absolute left-0 top-0 h-8 w-8 border-l-2 border-t-2 border-cyan-300" />
            <div className="absolute right-0 top-0 h-8 w-8 border-r-2 border-t-2 border-cyan-300" />
            <div className="absolute bottom-0 left-0 h-8 w-8 border-b-2 border-l-2 border-cyan-300" />
            <div className="absolute bottom-0 right-0 h-8 w-8 border-b-2 border-r-2 border-cyan-300" />
            <div className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 animate-pulse bg-cyan-300/75" />
          </div>
        </div>
      )}

      <div className="relative z-20 flex items-start justify-between gap-2 px-4 pt-[max(env(safe-area-inset-top),12px)]">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-cyan-200">
            Building AR
          </p>
          <h1 className="text-base font-semibold">
            {mode === "teach" ? "Teach mode" : "Recognize mode"}
          </h1>
        </div>
        <StatusPill engineStatus={engineStatus} cameraState={cameraState} />
      </div>

      {engineError && (
        <div className="relative z-30 mx-4 mt-3 rounded-lg border border-red-500/40 bg-black/85 p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <p className="font-semibold">Recognition engine failed</p>
              <p className="mt-1 text-xs text-neutral-300">{engineError}</p>
            </div>
          </div>
        </div>
      )}

      {(cameraState === "idle" ||
        cameraState === "starting" ||
        cameraState === "error") && (
        <CameraGate state={cameraState} error={cameraError} onStart={startCamera} />
      )}

      {cameraState === "ready" && engineStatus === "loading" && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/15 bg-black/65 px-4 py-3 text-center backdrop-blur">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300" />
          <p className="mt-2 text-sm font-medium">Loading recognition model</p>
          <p className="mt-0.5 text-[11px] text-neutral-400">~3 MB, one-time download</p>
        </div>
      )}

      {hasFloatingLabels && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {nearby.map((b) => {
            const isMatch = prediction?.label === b.label;
            return (
              <div
                key={b.label}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-all duration-200"
                style={{ left: `${b.screenX}%`, top: `${b.screenY}%` }}
              >
                <div
                  className={`h-3 w-3 rounded-full ${
                    isMatch
                      ? "bg-cyan-300 ring-4 ring-cyan-300/30 animate-pulse"
                      : "bg-white/70 ring-2 ring-white/20"
                  }`}
                />
                <div className="mt-1 h-3 w-px bg-white/30" />
                <div
                  className={`mt-0.5 rounded-md border px-2 py-1 text-center backdrop-blur ${
                    isMatch
                      ? "border-cyan-300/60 bg-cyan-300/15"
                      : "border-white/15 bg-black/55"
                  }`}
                >
                  <p
                    className={`text-xs font-semibold leading-tight ${
                      isMatch ? "text-cyan-100" : "text-white"
                    }`}
                  >
                    {b.label}
                  </p>
                  <p className="text-[10px] leading-tight text-neutral-300">
                    {b.distance}m
                    {isMatch && prediction
                      ? ` · ${Math.round(prediction.confidence * 100)}%`
                      : ""}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mode === "recognize" && !hasFloatingLabels && prediction?.label === "No building" && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 max-w-[min(90vw,280px)] -translate-x-1/2 -translate-y-1/2 px-4 text-center">
          <p className="text-lg font-semibold text-white drop-shadow-md">Show the building</p>
          <p className="mt-2 text-sm leading-snug text-neutral-200 drop-shadow-md">
            Place the building in the frame.
          </p>
        </div>
      )}

      {mode === "recognize" && !hasFloatingLabels && prediction && prediction.label !== "No building" && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-cyan-300/50 bg-black/55 px-4 py-3 text-center backdrop-blur">
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">
            {prediction.isLowConfidence ? "Candidate" : "Detected"}
          </p>
          <p className="mt-1 text-2xl font-semibold">{prediction.label}</p>
          <div className="mx-auto mt-2 h-1.5 w-40 rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-cyan-300 transition-[width] duration-200"
              style={{ width: `${Math.round(prediction.confidence * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-neutral-300">
            {`${Math.round(prediction.confidence * 100)}%${prediction.isLowConfidence ? " low confidence" : " match"}`}
          </p>
        </div>
      )}

      <div className="relative z-20 mt-auto px-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {cameraReady && (
          <div className="mb-2 flex items-center justify-end gap-2">
            {showCompassPrompt && (
              <button
                type="button"
                onClick={enableCompass}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-cyan-300/50 bg-black/55 px-3 text-xs font-medium text-cyan-200 backdrop-blur active:scale-95"
              >
                <Compass className="h-4 w-4" />
                Enable compass
              </button>
            )}
            <button
              type="button"
              onClick={switchCamera}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/55 backdrop-blur transition active:scale-95"
              aria-label={`Switch to ${facing === "environment" ? "front" : "back"} camera`}
              title={`Switch to ${facing === "environment" ? "front" : "back"} camera`}
            >
              <SwitchCamera className="h-5 w-5 text-white" />
            </button>
          </div>
        )}

        <div className="rounded-2xl border border-white/15 bg-neutral-950/82 p-3 shadow-2xl backdrop-blur">
          <ModeToggle
            mode={mode}
            onChange={changeMode}
            profile={recognitionProfile}
            onProfileChange={setRecognitionProfile}
            demoLockEnabled={demoLockEnabled}
            onToggleDemoLock={() => setDemoLockEnabled((prev) => !prev)}
          />
          <SensorRow
            locationStatus={locationStatus}
            orientationStatus={orientationStatus}
            userLocation={userLocation}
            heading={heading}
            onEnableCompass={enableCompass}
          />
          <DebugHud
            classifyMs={lastInferenceMs}
            hydrationStatus={hydrationStatus}
            minConfidence={RECOGNITION_PROFILES[recognitionProfile].minConfidence}
            sampleTotal={Object.values(counts).reduce((a, b) => a + b, 0)}
            lockActive={lockActive}
            demoLockEnabled={demoLockEnabled}
          />
          <div className="mt-2">
            {mode === "teach" ? (
              <TeachContent
                counts={counts}
                meta={meta}
                selectedBuilding={selectedBuilding}
                setSelectedBuilding={setSelectedBuilding}
                selectedCount={selectedCount}
                capture={capture}
                addingPhotos={addingPhotos}
                onCapture={startCapture}
                onAddPhotos={addPhotos}
                onRemove={removeLabel}
                onClearAll={clearAll}
                onToggleNegative={toggleLabelNegative}
                engineReady={engineStatus === "ready"}
                cameraReady={cameraReady}
                userLocation={userLocation}
              />
            ) : (
              <RecognizeContent
                prediction={prediction}
                counts={counts}
                nearby={nearby}
                hasGps={!!userLocation}
                minConfidence={RECOGNITION_PROFILES[recognitionProfile].minConfidence}
                onSwitchTeach={() => changeMode("teach")}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function StatusPill({
  engineStatus,
  cameraState,
}: {
  engineStatus: "loading" | "ready" | "error";
  cameraState: CameraState;
}) {
  const ok = engineStatus === "ready" && cameraState === "ready";
  const errored = engineStatus === "error" || cameraState === "error";

  const label =
    engineStatus === "error"
      ? "Engine error"
      : cameraState === "error"
        ? "Camera blocked"
        : cameraState === "idle"
          ? "Tap to enable"
          : engineStatus === "loading"
            ? "Loading model"
            : cameraState === "starting"
              ? "Starting camera"
              : "Ready";

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] backdrop-blur ${
        ok
          ? "bg-emerald-500/20 text-emerald-200"
          : errored
            ? "bg-red-500/20 text-red-200"
            : "bg-amber-500/20 text-amber-200"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          ok ? "bg-emerald-300" : errored ? "bg-red-300" : "animate-pulse bg-amber-300"
        }`}
      />
      {label}
    </div>
  );
}

function SensorRow({
  locationStatus,
  orientationStatus,
  userLocation,
  heading,
  onEnableCompass,
}: {
  locationStatus: LocationStatus;
  orientationStatus: OrientationStatus;
  userLocation: UserLocation | null;
  heading: number | null;
  onEnableCompass: () => void;
}) {
  const gpsLabel =
    locationStatus === "watching" && userLocation
      ? `GPS · ±${Math.round(userLocation.accuracy)}m`
      : locationStatus === "watching"
        ? "GPS · waiting"
        : locationStatus === "denied"
          ? "GPS · denied"
          : locationStatus === "unavailable"
            ? "GPS · n/a"
            : "GPS · …";

  const compassLabel =
    orientationStatus === "watching" && heading != null
      ? `${Math.round(heading)}°`
      : orientationStatus === "watching"
        ? "compass · waiting"
        : orientationStatus === "needsPermission"
          ? "Enable compass"
          : orientationStatus === "denied"
            ? "compass · denied"
            : "compass · n/a";

  const gpsOk = locationStatus === "watching" && !!userLocation;
  const compassOk = orientationStatus === "watching" && heading != null;
  const compassNeeds = orientationStatus === "needsPermission";

  return (
    <div className="mt-2 flex items-center gap-2 text-[10px]">
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
          gpsOk ? "bg-emerald-500/15 text-emerald-200" : "bg-white/8 text-neutral-300"
        }`}
      >
        <MapPin className="h-3 w-3" />
        {gpsLabel}
      </span>
      <button
        type="button"
        onClick={compassNeeds ? onEnableCompass : undefined}
        disabled={!compassNeeds}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
          compassOk
            ? "bg-emerald-500/15 text-emerald-200"
            : compassNeeds
              ? "bg-cyan-300/15 text-cyan-200"
              : "bg-white/8 text-neutral-300"
        } ${compassNeeds ? "cursor-pointer" : "cursor-default"}`}
      >
        <Compass className="h-3 w-3" />
        {compassLabel}
      </button>
    </div>
  );
}

function CameraGate({
  state,
  error,
  onStart,
}: {
  state: CameraState;
  error: string | null;
  onStart: () => void;
}) {
  const isError = state === "error";
  const isStarting = state === "starting";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85 px-6 backdrop-blur">
      <div className="max-w-xs text-center">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${
            isError ? "bg-red-500/15" : "bg-cyan-300/15"
          }`}
        >
          {isError ? (
            <AlertCircle className="h-7 w-7 text-red-300" />
          ) : (
            <Camera className="h-7 w-7 text-cyan-300" />
          )}
        </div>
        <h2 className="mt-4 text-lg font-semibold">
          {isError ? "Camera blocked" : "Enable camera"}
        </h2>
        <p className="mt-2 text-sm leading-5 text-neutral-300">
          {isError
            ? error
            : "We use the rear camera to recognize buildings. Frames stay on your device — nothing is uploaded."}
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={isStarting}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-xl bg-cyan-300 px-5 text-sm font-semibold text-neutral-950 disabled:opacity-60"
        >
          {isStarting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-900/30 border-t-neutral-900" />
              Starting...
            </>
          ) : (
            <>
              <Camera className="h-4 w-4" />
              {isError ? "Try again" : "Enable camera"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
  profile,
  onProfileChange,
  demoLockEnabled,
  onToggleDemoLock,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  profile: RecognitionProfile;
  onProfileChange: (p: RecognitionProfile) => void;
  demoLockEnabled: boolean;
  onToggleDemoLock: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/8 p-1">
        <button
          type="button"
          onClick={() => onChange("recognize")}
          className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition ${
            mode === "recognize" ? "bg-white text-neutral-950" : "text-neutral-200"
          }`}
        >
          <ScanSearch className="h-4 w-4" />
          Recognize
        </button>
        <button
          type="button"
          onClick={() => onChange("teach")}
          className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition ${
            mode === "teach" ? "bg-white text-neutral-950" : "text-neutral-200"
          }`}
        >
          <Plus className="h-4 w-4" />
          Teach
        </button>
      </div>
      {mode === "recognize" && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 rounded-lg bg-white/8 p-1 text-[11px]">
            {(Object.keys(RECOGNITION_PROFILES) as RecognitionProfile[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onProfileChange(key)}
                className={`flex-1 rounded-md px-2 py-1 ${
                  profile === key
                    ? "bg-cyan-300 text-neutral-950"
                    : "text-neutral-300 hover:bg-white/10"
                }`}
              >
                {RECOGNITION_PROFILES[key].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onToggleDemoLock}
            className={`w-full rounded-lg px-2 py-1 text-[11px] ${
              demoLockEnabled
                ? "bg-cyan-300/25 text-cyan-100"
                : "bg-white/8 text-neutral-300 hover:bg-white/10"
            }`}
          >
            Demo lock {demoLockEnabled ? "ON" : "OFF"}
          </button>
        </div>
      )}
    </div>
  );
}

function DebugHud({
  sampleTotal,
  classifyMs,
  minConfidence,
  hydrationStatus,
  lockActive,
  demoLockEnabled,
}: {
  sampleTotal: number;
  classifyMs: number;
  minConfidence: number;
  hydrationStatus: "idle" | "loading" | "done" | "error";
  lockActive: boolean;
  demoLockEnabled: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-neutral-300">
      <span className="rounded-full bg-white/8 px-2 py-0.5">samples {sampleTotal}</span>
      <span className="rounded-full bg-white/8 px-2 py-0.5">classify {classifyMs}ms</span>
      <span className="rounded-full bg-white/8 px-2 py-0.5">
        threshold {Math.round(minConfidence * 100)}%
      </span>
      <span className="rounded-full bg-white/8 px-2 py-0.5">sync {hydrationStatus}</span>
      <span className="rounded-full bg-white/8 px-2 py-0.5">
        lock {demoLockEnabled ? (lockActive ? "active" : "armed") : "off"}
      </span>
    </div>
  );
}

function TeachContent({
  counts,
  meta,
  selectedBuilding,
  setSelectedBuilding,
  selectedCount,
  capture,
  addingPhotos,
  onCapture,
  onAddPhotos,
  onRemove,
  onClearAll,
  onToggleNegative,
  engineReady,
  cameraReady,
  userLocation,
}: {
  counts: Record<string, number>;
  meta: AllMeta;
  selectedBuilding: string | null;
  setSelectedBuilding: (v: string | null) => void;
  selectedCount: number;
  capture: { label: string; progress: number } | null;
  addingPhotos: { current: number; total: number } | null;
  onCapture: () => void;
  onAddPhotos: (files: File[]) => void;
  onRemove: (label: string) => void;
  onClearAll: () => void;
  onToggleNegative: (label: string, isNegative: boolean) => void;
  engineReady: boolean;
  cameraReady: boolean;
  userLocation: UserLocation | null;
}) {
  if (selectedBuilding == null) {
    return (
      <BuildingPicker
        counts={counts}
        meta={meta}
        onSelect={setSelectedBuilding}
        onToggleNegative={onToggleNegative}
        onRemove={onRemove}
        onClearAll={onClearAll}
        engineReady={engineReady}
      />
    );
  }
  return (
    <BuildingEditor
      label={selectedBuilding}
      count={selectedCount}
      hasLocation={!!meta[selectedBuilding]?.location}
      isNegative={meta[selectedBuilding]?.isNegative === true}
      onToggleNegative={onToggleNegative}
      capture={capture}
      addingPhotos={addingPhotos}
      onBack={() => setSelectedBuilding(null)}
      onCapture={onCapture}
      onAddPhotos={onAddPhotos}
      onRemove={onRemove}
      engineReady={engineReady}
      cameraReady={cameraReady}
      userLocation={userLocation}
    />
  );
}

function BuildingPicker({
  counts,
  meta,
  onSelect,
  onToggleNegative,
  onRemove,
  onClearAll,
  engineReady,
}: {
  counts: Record<string, number>;
  meta: AllMeta;
  onSelect: (name: string) => void;
  onToggleNegative: (label: string, isNegative: boolean) => void;
  onRemove: (name: string) => void;
  onClearAll: () => void;
  engineReady: boolean;
}) {
  const [name, setName] = useState("");
  const taught = Object.entries(counts);
  const trimmed = name.trim();
  const exists = taught.some(([l]) => l === trimmed);

  const submit = () => {
    if (!trimmed || !engineReady) return;
    onSelect(trimmed);
    setName("");
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-400">
        Check <span className="text-amber-200">Not bldg</span> for any taught class that should
        resolve to score 0 in Recognize (non-building / negative examples).
      </p>

      {taught.length > 0 && (
        <div className="max-h-44 space-y-1.5 overflow-y-auto">
          {taught.map(([label, count]) => {
            const hasLoc = !!meta[label]?.location;
            const isNegative = meta[label]?.isNegative === true;
            return (
              <div
                key={label}
                className={`flex items-center gap-2 rounded-lg px-2 py-2 ${
                  isNegative ? "bg-amber-300/10 ring-1 ring-amber-300/35" : "bg-white/8"
                }`}
              >
                <label className="flex shrink-0 cursor-pointer flex-col items-center gap-0.5 py-1">
                  <input
                    type="checkbox"
                    checked={isNegative}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleNegative(label, e.target.checked);
                    }}
                    aria-label={`Mark ${label} as not-building negative`}
                    className="h-4 w-4 rounded border-white/30 bg-neutral-950 text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                  />
                  <span className="text-[8px] font-medium uppercase tracking-tight text-amber-200/90">
                    Not bldg
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => onSelect(label)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium">{label}</p>
                  <p className="flex flex-wrap items-center gap-1 text-[10px] text-neutral-400">
                    <span>
                      {count} sample{count === 1 ? "" : "s"}
                    </span>
                    {isNegative && (
                      <span className="inline-flex rounded-full bg-amber-500/20 px-1 py-px text-amber-100">
                        negative
                      </span>
                    )}
                    {count < RECOMMENDED_SAMPLES_PER_BUILDING && (
                      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-1 py-px text-amber-200">
                        low
                      </span>
                    )}
                    {hasLoc && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1 py-px text-emerald-200">
                        <MapPin className="h-2.5 w-2.5" />
                        GPS
                      </span>
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(label)}
                  className="rounded-md p-1.5 text-neutral-400 hover:bg-white/10 hover:text-red-300"
                  aria-label={`Remove ${label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New building name"
          className="h-10 min-w-0 flex-1 rounded-lg border border-white/15 bg-white/8 px-3 text-sm placeholder:text-neutral-500 focus:border-cyan-300 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || !engineReady}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-cyan-300 px-3 text-sm font-semibold text-neutral-950 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {exists ? "Open" : "Create"}
        </button>
      </form>

      {taught.length > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className="w-full rounded-lg border border-red-500/30 bg-red-500/10 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/15"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

function BuildingEditor({
  label,
  count,
  hasLocation,
  isNegative,
  onToggleNegative,
  capture,
  addingPhotos,
  onBack,
  onCapture,
  onAddPhotos,
  onRemove,
  engineReady,
  cameraReady,
  userLocation,
}: {
  label: string;
  count: number;
  hasLocation: boolean;
  isNegative: boolean;
  onToggleNegative: (lbl: string, value: boolean) => void;
  capture: { label: string; progress: number } | null;
  addingPhotos: { current: number; total: number } | null;
  onBack: () => void;
  onCapture: () => void;
  onAddPhotos: (files: File[]) => void;
  onRemove: (name: string) => void;
  engineReady: boolean;
  cameraReady: boolean;
  userLocation: UserLocation | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isBusy = capture !== null || addingPhotos !== null;
  const captureDisabled = !engineReady || !cameraReady || isBusy;
  const photoDisabled = !engineReady || isBusy;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex items-center gap-1 rounded-md px-1 py-1 text-xs text-neutral-300 hover:text-white"
          disabled={isBusy}
        >
          <ArrowLeft className="h-4 w-4" />
          Buildings
        </button>
        <button
          type="button"
          onClick={() => onRemove(label)}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-white/10 hover:text-red-300 disabled:opacity-40"
          aria-label={`Delete ${label}`}
          disabled={isBusy}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="rounded-lg bg-white/8 p-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">Teaching</p>
        <p className="mt-0.5 truncate text-base font-semibold">{label}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-neutral-400">
          <span>
            {count} sample{count === 1 ? "" : "s"}
          </span>
          {hasLocation ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] text-emerald-200">
              <MapPin className="h-2.5 w-2.5" />
              GPS locked
            </span>
          ) : userLocation ? (
            <span className="text-[10px] text-cyan-200">capture will save GPS</span>
          ) : (
            <span className="text-[10px] text-amber-200">no GPS</span>
          )}
        </p>
        {count < RECOMMENDED_SAMPLES_PER_BUILDING && (
          <p className="mt-1 text-[10px] text-amber-200">
            Add at least {RECOMMENDED_SAMPLES_PER_BUILDING} samples for stable recognition.
          </p>
        )}
      </div>

      <label
        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition ${
          isNegative ? "border-amber-300/55 bg-amber-300/10" : "border-white/12 bg-white/5"
        }`}
      >
        <input
          type="checkbox"
          checked={isNegative}
          onChange={(e) => onToggleNegative(label, e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-white/30 bg-neutral-950 text-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
        />
        <span className="text-xs leading-snug text-neutral-200">
          <span className="font-medium text-amber-100">Not building</span>
          {" — "}
          Recognize maps this tag to score 0.
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCapture}
          disabled={captureDisabled}
          className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg bg-cyan-300 text-neutral-950 transition disabled:opacity-50"
        >
          {capture ? (
            <>
              <Zap className="h-4 w-4" />
              <span className="text-xs font-semibold">
                {capture.progress}/{FRAMES_PER_CAPTURE}
              </span>
            </>
          ) : (
            <>
              <Camera className="h-4 w-4" />
              <span className="text-xs font-semibold">Capture {FRAMES_PER_CAPTURE}</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={photoDisabled}
          className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-white/20 bg-white/8 transition hover:bg-white/12 disabled:opacity-50"
        >
          {addingPhotos ? (
            <>
              <Zap className="h-4 w-4 text-cyan-300" />
              <span className="text-xs font-semibold">
                {addingPhotos.current}/{addingPhotos.total}
              </span>
            </>
          ) : (
            <>
              <ImagePlus className="h-4 w-4 text-cyan-300" />
              <span className="text-xs font-semibold">Add photos</span>
            </>
          )}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onAddPhotos(files);
          e.target.value = "";
        }}
      />

      <p className="rounded-lg border border-dashed border-white/15 bg-white/5 p-2 text-center text-[11px] text-neutral-400">
        Tip: photo EXIF GPS is read automatically. Capturing on-site stamps the
        building&apos;s location for AR labels.
      </p>
    </div>
  );
}

function RecognizeContent({
  prediction,
  counts,
  nearby,
  hasGps,
  minConfidence,
  onSwitchTeach,
}: {
  prediction: Prediction | null;
  counts: Record<string, number>;
  nearby: Positioned[];
  hasGps: boolean;
  minConfidence: number;
  onSwitchTeach: () => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const labelCount = Object.keys(counts).length;
  const isNoBuilding = prediction?.label === "No building";

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <Sparkles className="h-6 w-6 text-cyan-300" />
        <p className="text-sm font-medium">No buildings taught yet</p>
        <p className="text-xs text-neutral-400">Switch to Teach mode and add a building.</p>
        <button
          type="button"
          onClick={onSwitchTeach}
          className="mt-1 rounded-lg bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-neutral-950"
        >
          Go to Teach mode
        </button>
      </div>
    );
  }

  if (nearby.length > 0) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">In view</p>
        {nearby.map((b) => {
          const isMatch = prediction?.label === b.label;
          return (
            <div
              key={b.label}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${
                isMatch
                  ? "border border-cyan-300/50 bg-cyan-300/10"
                  : "bg-white/5"
              }`}
            >
              <div className="min-w-0">
                <p
                  className={`truncate text-sm font-semibold ${
                    isMatch ? "text-cyan-100" : ""
                  }`}
                >
                  {b.label}
                </p>
                <p className="text-[10px] text-neutral-400">{b.distance}m away</p>
              </div>
              <div className="text-right text-[10px] text-neutral-300">
                {isMatch && prediction
                  ? `${Math.round(prediction.confidence * 100)}% match`
                  : "scanning"}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (!prediction) {
    return (
      <p className="py-3 text-center text-xs text-neutral-400">
        {hasGps
          ? "No taught buildings in range. Move closer or teach a new one."
          : `Aim camera at a building... (${total} sample${total === 1 ? "" : "s"} across ${labelCount} building${labelCount === 1 ? "" : "s"})`}
      </p>
    );
  }

  if (isNoBuilding) {
    return (
      <div className="py-3 text-center">
        <p className="text-sm font-semibold text-white">Show the building</p>
        <p className="mt-1 text-xs text-neutral-400">Place the building in the frame.</p>
      </div>
    );
  }

  const ranked = Object.entries(prediction.confidences).sort(([, a], [, b]) => b - a);

  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-white/8 p-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-200">Top match</p>
        <p className="mt-0.5 text-base font-semibold">{prediction.label}</p>
        <div className="mt-1.5 h-1.5 rounded-full bg-white/15">
          <div
            className="h-full rounded-full bg-cyan-300 transition-[width] duration-200"
            style={{ width: `${Math.round(prediction.confidence * 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-neutral-400">
          {`${Math.round(prediction.confidence * 100)}% confidence${prediction.isLowConfidence ? ` (below ${Math.round(minConfidence * 100)}% threshold)` : ""}`}
        </p>
      </div>
      {ranked.length > 1 && (
        <div className="space-y-1">
          {ranked.slice(1, 4).map(([label, conf]) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs"
            >
              <span className="truncate text-neutral-300">{label}</span>
              <span className="text-neutral-500">{Math.round(conf * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
