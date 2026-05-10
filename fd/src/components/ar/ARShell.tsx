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
import { BuildingExperience } from "@/components/ar/BuildingExperience";
import { HighlightStatsStrip } from "@/components/ar/HighlightStatsStrip";
import { LanguageSwitcher } from "@/components/ar/LanguageSwitcher";
import { RecognizeMatchView } from "@/components/ar/RecognizeMatchView";
import { createEngine, type Engine, type Prediction } from "@/lib/ar/engine";
import { useI18n } from "@/lib/i18n/context";
import { type MessageKey } from "@/lib/i18n/dictionaries";
import { cn } from "@/lib/utils";
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
  createIssue as createIssueRemote,
  createIssueComment as createIssueCommentRemote,
  createBuilding as createBuildingRemote,
  createSample as createSampleRemote,
  deleteBuilding as deleteBuildingRemote,
  getIssueByLabel as getIssueByLabelRemote,
  getOrCreateAuthToken,
  listAllSamplesByBuilding,
  listBuildings as listBuildingsRemote,
  listIssueComments as listIssueCommentsRemote,
  recordMatchEvent as recordMatchEventRemote,
  supportIssue as supportIssueRemote,
  type ApiIssue,
  type ApiIssueComment,
  updateBuilding as updateBuildingRemote,
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
import {
  effectiveMargin,
  enrichUiPrediction,
  isNegativeClassLabel,
  isNonBuildingSceneLabel,
  passesRecognitionGate,
  RECOGNITION_PROFILE_GATES,
  type RecognitionGate,
  type UiPrediction,
} from "@/lib/ar/recognition-policy";

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
/** Frames classifier may disagree before releasing lock while the building stays mostly in frame. */
const LOCK_GRACE_FRAMES = 4;
const RECOGNITION_PROFILES = {
  fast: {
    ...RECOGNITION_PROFILE_GATES.fast,
    labelKey: "profileFast" satisfies MessageKey,
  },
  balanced: {
    ...RECOGNITION_PROFILE_GATES.balanced,
    labelKey: "profileBalanced" satisfies MessageKey,
  },
  strict: {
    ...RECOGNITION_PROFILE_GATES.strict,
    labelKey: "profileStrict" satisfies MessageKey,
  },
} as const;
type RecognitionProfile = keyof typeof RECOGNITION_PROFILES;
const RECOMMENDED_SAMPLES_PER_BUILDING = 20;
const CAMERA_MATCH_BADGE_MIN_CONFIDENCE = 0.3;
const MATCH_REPEAT_TO_SHOW_INFO = 1;

type IosOrientationCtor = {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
};

function getIosOrientationCtor(): IosOrientationCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = (window as unknown as { DeviceOrientationEvent?: IosOrientationCtor })
    .DeviceOrientationEvent;
  return ctor ?? null;
}

function describeCameraError(
  err: unknown,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (!(err instanceof Error)) return t("cameraUnavailable");
  if (err.name === "NotAllowedError") {
    return t("cameraBlockedPermission");
  }
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
    return t("cameraNoDevice");
  }
  if (err.name === "NotReadableError") {
    return t("cameraInUse");
  }
  if (err.name === "SecurityError") {
    return t("cameraNeedsHttps");
  }
  return err.message || t("cameraUnavailable");
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

function predictionRenderKey(pred: UiPrediction | null): string {
  if (!pred) return "none";
  const score = Math.round(pred.confidence * 100);
  return [
    pred.label,
    score,
    pred.isLowConfidence ? "low" : "ok",
    pred.isNoBuilding ? "no-scene" : "scene",
    pred.isNotInDb ? "unknown" : "known",
  ].join("|");
}

function isRoadIssueLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const key = label.trim().toLowerCase();
  return (
    key.includes("road") ||
    key.includes("break") ||
    key.includes("pothole") ||
    key.includes("zamiin") ||
    key.includes("зам")
  );
}

export default function ARShell() {
  const { t } = useI18n();
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
  const [prediction, setPrediction] = useState<UiPrediction | null>(null);
  /** Pinned building for floating GLB sheet; cleared only by “scan again” or leaving Recognize. */
  const [experienceBuildingLabel, setExperienceBuildingLabel] = useState<string | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null);
  const [capture, setCapture] = useState<{ label: string; progress: number } | null>(null);
  const [addingPhotos, setAddingPhotos] = useState<{ current: number; total: number } | null>(null);
  const [recognitionProfile, setRecognitionProfile] = useState<RecognitionProfile>("balanced");
  const [demoLockEnabled, setDemoLockEnabled] = useState(true);
  const [lastInferenceMs, setLastInferenceMs] = useState<number>(0);
  const inferenceUiLastCommitAtRef = useRef(0);
  const inferenceUiLastValueRef = useRef(0);
  const predictionUiKeyRef = useRef<string>("none");
  const [hydrationStatus, setHydrationStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [lockActive, setLockActive] = useState(false);
  const consensusRef = useRef<Array<{ label: string | null; confidence: number }>>([]);
  /** Classifier label held on screen while Lock is on ("building still in frame"). */
  const lockHoldLabelRef = useRef<string | null>(null);
  const lockGraceMissRef = useRef(0);
  const experienceStreakRef = useRef<{ label: string; passes: number }>({ label: "", passes: 0 });

  const [meta, setMeta] = useState<AllMeta>({});
  const metaRef = useRef<AllMeta>({});
  const [backendReady, setBackendReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const buildingByLabelRef = useRef<Record<string, ApiBuilding>>({});
  const lastRecordedIssueForLabelRef = useRef<string>("");
  const [activeIssue, setActiveIssue] = useState<ApiIssue | null>(null);
  const [issueComments, setIssueComments] = useState<ApiIssueComment[]>([]);
  const [issueBusy, setIssueBusy] = useState(false);
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
        setCameraError(describeCameraError(e, t));
        setCameraState("error");
        return;
      }

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = newStream;
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        await videoRef.current.play().catch(() => {});
      }
      setFacing(facingTarget);
      setCameraState("ready");
    },
    [cameraState, facing, t],
  );

  const switchCamera = useCallback(() => {
    if (cameraState !== "ready") return;
    startCamera(facing === "environment" ? "user" : "environment");
  }, [cameraState, facing, startCamera]);

  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
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
        isNotBuilding: meta[label]?.isNegative === true,
      });
      buildingByLabelRef.current[label] = created;
      return created.id;
    },
    [meta],
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
        const nextMeta = { ...metaRef.current };
        for (const building of buildings) {
          const existing = nextMeta[building.name] ?? {};
          const isNegative = existing.isNegative === true || building.isNotBuilding === true;
          nextMeta[building.name] = { ...existing, isNegative };
          if (existing.isNegative === true && building.isNotBuilding !== true) {
            void updateBuildingRemote(token, building.id, { isNotBuilding: true })
              .then((updated) => {
                buildingByLabelRef.current[building.name] = { ...building, ...updated };
              })
              .catch((error) => {
                console.warn("AR: failed to backfill not-building flag", error);
              });
          }
        }
        metaRef.current = nextMeta;
        saveMeta(nextMeta);
        setMeta(nextMeta);
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
        const nextMeta = { ...metaRef.current };
        for (const group of groups) {
          const name = group.building.name;
          const existing = nextMeta[name] ?? {};
          nextMeta[name] = {
            ...existing,
            isNegative: existing.isNegative === true || group.building.isNotBuilding === true,
          };
        }
        metaRef.current = nextMeta;
        saveMeta(nextMeta);
        setMeta(nextMeta);
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
        const loadedMeta = loadMeta();
        metaRef.current = loadedMeta;
        setMeta(loadedMeta);
        setEngineStatus("ready");
      } catch (e) {
        setEngineError(e instanceof Error ? e.message : t("engineLoadFailed"));
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
  }, [t]);

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
      if (isNegativeClassLabel(label, meta)) continue;
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
      if (isNegativeClassLabel(label, meta)) return false;
      if ((counts[label] ?? 0) === 0) return false;
      return haversineMeters(userLocation, m.location) <= MAX_RANGE_M;
    });
    if (inRange.length === 0) return undefined;
    return new Set(inRange.map(([label]) => label));
  }, [counts, meta, userLocation]);

  /**
   * Labels the classifier may compare against. Negative ("not building") labels
   * stay in the set as rejectors: if they are most similar, UI asks for a building.
   */
  const recognitionAllowedLabels = useMemo((): Set<string> | undefined => {
    const negativeRejectors = new Set<string>();
    const buildingCandidates = new Set<string>();
    let anySamples = false;
    for (const [label, n] of Object.entries(counts)) {
      if (n <= 0) continue;
      anySamples = true;
      if (isNegativeClassLabel(label, meta)) {
        negativeRejectors.add(label);
      } else {
        buildingCandidates.add(label);
      }
    }
    if (!anySamples) return undefined;

    const labels = new Set<string>(negativeRejectors);
    if (allowedLabels === undefined) {
      for (const label of buildingCandidates) labels.add(label);
      return labels;
    }

    for (const label of buildingCandidates) {
      if (allowedLabels.has(label)) labels.add(label);
    }
    return labels;
  }, [counts, meta, allowedLabels]);

  const toggleLabelNegative = useCallback(
    (label: string, value: boolean) => {
      setMeta((prev) => {
        const existing = prev[label] ?? {};
        const next: AllMeta = {
          ...prev,
          [label]: { ...existing, isNegative: value },
        };
        metaRef.current = next;
        saveMeta(next);
        return next;
      });
      const token = tokenRef.current;
      const remote = buildingByLabelRef.current[label];
      if (!backendReady || !token) return;

      if (remote?.id) {
        void updateBuildingRemote(token, remote.id, { isNotBuilding: value })
          .then((updated) => {
            buildingByLabelRef.current[label] = { ...remote, ...updated };
          })
          .catch((err) => {
            console.warn("AR: failed to persist not-building flag", err);
          });
        return;
      }

      if (value) {
        void createBuildingRemote(token, { name: label, isNotBuilding: true })
          .then((created) => {
            buildingByLabelRef.current[label] = created;
          })
          .catch((err) => {
            console.warn("AR: failed to create not-building remote label", err);
          });
      }
    },
    [backendReady],
  );

  useEffect(() => {
    allowedLabelsRef.current = recognitionAllowedLabels;
  }, [recognitionAllowedLabels]);

  const toggleDemoLock = useCallback(() => {
    setDemoLockEnabled((prev) => {
      if (prev) {
        lockHoldLabelRef.current = null;
        lockGraceMissRef.current = 0;
        requestAnimationFrame(() => {
          setLockActive(false);
        });
      }
      return !prev;
    });
  }, []);

  const syncArExperience = useCallback(
    (rawLabel: string | null | undefined, mode: "positive" | "clear") => {
      if (mode === "clear" || !rawLabel || isNonBuildingSceneLabel(rawLabel, meta)) {
        experienceStreakRef.current = { label: "", passes: 0 };
        setExperienceBuildingLabel(null);
        return;
      }
      if (experienceStreakRef.current.label === rawLabel) {
        experienceStreakRef.current.passes += 1;
      } else {
        experienceStreakRef.current = { label: rawLabel, passes: 1 };
      }
      if (experienceStreakRef.current.passes < MATCH_REPEAT_TO_SHOW_INFO) return;
      setExperienceBuildingLabel(rawLabel);
      if (!backendReady) return;
      const token = tokenRef.current;
      const building = buildingByLabelRef.current[rawLabel];
      if (!token || !building) return;
      const dedupeKey = `${rawLabel}:${experienceStreakRef.current.passes}`;
      if (lastRecordedIssueForLabelRef.current === dedupeKey) return;
      lastRecordedIssueForLabelRef.current = dedupeKey;
      void (async () => {
        try {
          const foundIssue = await getIssueByLabelRemote(token, rawLabel);
          const issue =
            foundIssue ??
            (await createIssueRemote(token, {
              title: rawLabel,
              buildingId: building.id,
              description: t("issueCreatedFromMatch"),
              lat: building.lat ?? undefined,
              lng: building.lng ?? undefined,
            }));
          await recordMatchEventRemote(token, issue.id, { buildingId: building.id });
          const updatedIssue = await getIssueByLabelRemote(token, rawLabel);
          setActiveIssue(updatedIssue);
          if (updatedIssue) {
            const comments = await listIssueCommentsRemote(token, updatedIssue.id).catch(() => []);
            setIssueComments(comments);
          } else {
            setIssueComments([]);
          }
        } catch (error) {
          console.warn("AR: issue sync failed; keeping local match UI", error);
        }
      })();
    },
    [backendReady, meta, t],
  );

  const clearRecognitionExperience = useCallback(() => {
    setExperienceBuildingLabel(null);
    experienceStreakRef.current = { label: "", passes: 0 };
    lastRecordedIssueForLabelRef.current = "";
    setActiveIssue(null);
    setIssueComments([]);
    predictionUiKeyRef.current = "none";
    setPrediction(null);
    missStreakRef.current = 0;
    consensusRef.current = [];
    lockHoldLabelRef.current = null;
    lockGraceMissRef.current = 0;
    setLockActive(false);
  }, []);

  const hydrateIssueForLabel = useCallback(
    async (label: string) => {
      const token = tokenRef.current;
      if (!token || !backendReady) return;
      const issue = await getIssueByLabelRemote(token, label);
      setActiveIssue(issue);
      if (issue) {
        const comments = await listIssueCommentsRemote(token, issue.id).catch(() => []);
        setIssueComments(comments);
      } else {
        setIssueComments([]);
      }
    },
    [backendReady],
  );

  useEffect(() => {
    if (!experienceBuildingLabel) {
      setActiveIssue(null);
      setIssueComments([]);
      return;
    }
    void hydrateIssueForLabel(experienceBuildingLabel);
  }, [experienceBuildingLabel, hydrateIssueForLabel]);

  const handleJoinDiscussion = useCallback((label: string) => {
    setExperienceBuildingLabel(label);
  }, []);

  const handleReportIssue = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || !backendReady) return;
    const topLabel = prediction?.label?.trim();
    const title = topLabel && topLabel.length > 0 ? topLabel : "Unrecognized scene";
    const ok = window.confirm(t("confirmCreateIssue"));
    if (!ok) return;
    setIssueBusy(true);
    try {
      const issue = await createIssueRemote(token, {
        title,
        description: t("issueCreatedFromAr"),
        lat: userLocation?.lat,
        lng: userLocation?.lng,
      });
      setActiveIssue(issue);
      setIssueComments([]);
      setExperienceBuildingLabel(title);
    } finally {
      setIssueBusy(false);
    }
  }, [backendReady, prediction?.label, t, userLocation?.lat, userLocation?.lng]);

  const handleSupportIssue = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || !activeIssue || issueBusy) return;
    setIssueBusy(true);
    try {
      const updated = await supportIssueRemote(token, activeIssue.id);
      if (updated) setActiveIssue(updated);
    } finally {
      setIssueBusy(false);
    }
  }, [activeIssue, issueBusy]);

  const handleAddIssueComment = useCallback(async () => {
    const token = tokenRef.current;
    if (!token || !activeIssue || issueBusy) return;
    const text = window.prompt(t("issueCommentPrompt"));
    if (!text || text.trim().length === 0) return;
    setIssueBusy(true);
    try {
      const created = await createIssueCommentRemote(token, activeIssue.id, text.trim());
      setIssueComments((prev) => [...prev, created]);
      const refreshed = await getIssueByLabelRemote(
        token,
        activeIssue.buildingLabel ?? experienceBuildingLabel ?? activeIssue.title,
      ).catch(() => null);
      if (refreshed) setActiveIssue(refreshed);
    } finally {
      setIssueBusy(false);
    }
  }, [activeIssue, experienceBuildingLabel, issueBusy, t]);

  useEffect(() => {
    if (mode !== "recognize") return;
    if (engineStatus !== "ready" || !cameraReady) return;

    let stopped = false;
    let timer: number | undefined;
    const commitPrediction = (next: UiPrediction | null) => {
      const key = predictionRenderKey(next);
      if (key === predictionUiKeyRef.current) return;
      predictionUiKeyRef.current = key;
      setPrediction(next);
    };

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(tick, 600);
        return;
      }
      const eng = engineRef.current;
      const video = videoRef.current;
      if (!eng || !video || video.readyState < 2) {
        timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
        return;
      }
      try {
        const startedAt = performance.now();
        const profile = RECOGNITION_PROFILES[recognitionProfile];
        const gate: RecognitionGate = {
          minConfidence: profile.minConfidence,
          minMargin: profile.minMargin,
        };
        const r = await eng.classify(video, allowedLabelsRef.current, {
          minConfidence: profile.minConfidence,
          returnBestEffort: true,
        });
        const nextInferenceMs = Math.round(performance.now() - startedAt);
        const shouldCommitInferenceMs =
          startedAt - inferenceUiLastCommitAtRef.current >= 500 ||
          Math.abs(nextInferenceMs - inferenceUiLastValueRef.current) >= 10;
        if (shouldCommitInferenceMs) {
          inferenceUiLastCommitAtRef.current = startedAt;
          inferenceUiLastValueRef.current = nextInferenceMs;
          setLastInferenceMs(nextInferenceMs);
        }
        if (!stopped) {
          const voteLabel = r && passesRecognitionGate(r, gate) ? r.label : null;
          consensusRef.current.push({ label: voteLabel, confidence: r?.confidence ?? 0 });
          if (consensusRef.current.length > profile.consensusWindow) {
            consensusRef.current.shift();
          }

          const held = demoLockEnabled ? lockHoldLabelRef.current : null;
          if (held !== null) {
            const aligns =
              r !== null && r.label === held && passesRecognitionGate(r, gate);
            if (aligns) {
              lockGraceMissRef.current = 0;
              setLockActive(true);
              const heldPred = enrichUiPrediction(r, meta, t("percentNoBuilding"), gate);
              commitPrediction(heldPred);
              if (heldPred?.isNotInDb || heldPred?.isNoBuilding) {
                syncArExperience(null, "clear");
              } else if (heldPred?.label) {
                syncArExperience(held, "positive");
              }
              timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
              return;
            }
            lockGraceMissRef.current += 1;
            if (lockGraceMissRef.current < LOCK_GRACE_FRAMES) {
              setLockActive(true);
              timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
              return;
            }
            lockHoldLabelRef.current = null;
            lockGraceMissRef.current = 0;
            setLockActive(false);
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

          if (topLabel && topVotes >= profile.consensusMinVotes) {
            const topItems = consensusRef.current.filter(
              (item) => item.label === topLabel && item.confidence >= gate.minConfidence,
            );
            const avgConfidence =
              topItems.length > 0
                ? topItems.reduce((sum, item) => sum + item.confidence, 0) / topItems.length
                : 0;
            const confidences = r?.confidences ?? { [topLabel]: avgConfidence };
            const consensusMargin = effectiveMargin({ confidences });
            const consensusRaw: Prediction = {
              label: topLabel,
              confidence: avgConfidence,
              confidences,
              margin: consensusMargin,
              isLowConfidence:
                avgConfidence < gate.minConfidence || consensusMargin < gate.minMargin,
            };
            const consensusPrediction = enrichUiPrediction(
              consensusRaw,
              meta,
              t("percentNoBuilding"),
              gate,
            );
            commitPrediction(consensusPrediction);
            if (consensusPrediction?.isNotInDb || consensusPrediction?.isNoBuilding) {
              syncArExperience(null, "clear");
            } else if (consensusPrediction?.label) {
              syncArExperience(consensusPrediction.label, "positive");
            }
            missStreakRef.current = 0;
            if (
              demoLockEnabled &&
              consensusPrediction &&
              !consensusPrediction.isNoBuilding &&
              !consensusPrediction.isNotInDb &&
              !isNonBuildingSceneLabel(topLabel, meta)
            ) {
              lockHoldLabelRef.current = topLabel;
              lockGraceMissRef.current = 0;
              setLockActive(true);
            } else {
              lockHoldLabelRef.current = null;
              lockGraceMissRef.current = 0;
              setLockActive(false);
            }
            timer = window.setTimeout(tick, RECOGNIZE_INTERVAL_MS);
            return;
          }

          if (r) {
            missStreakRef.current = 0;
            const disp = enrichUiPrediction(r, meta, t("percentNoBuilding"), gate);
            commitPrediction(disp);
            if (disp?.isNotInDb || disp?.isNoBuilding) {
              syncArExperience(null, "clear");
            } else if (disp?.label) {
              syncArExperience(disp.label, "positive");
            }
            if (
              demoLockEnabled &&
              disp &&
              !disp.isNoBuilding &&
              !disp.isNotInDb &&
              !isNonBuildingSceneLabel(r.label, meta)
            ) {
              lockHoldLabelRef.current = r.label;
              lockGraceMissRef.current = 0;
              setLockActive(true);
            } else {
              lockHoldLabelRef.current = null;
              lockGraceMissRef.current = 0;
              setLockActive(false);
            }
          } else {
            missStreakRef.current += 1;
            if (missStreakRef.current >= 3) {
              commitPrediction(null);
              syncArExperience(null, "clear");
              lockHoldLabelRef.current = null;
              lockGraceMissRef.current = 0;
              setLockActive(false);
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
  }, [
    mode,
    engineStatus,
    cameraReady,
    recognitionProfile,
    demoLockEnabled,
    meta,
    t,
    syncArExperience,
  ]);

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
      setExperienceBuildingLabel(null);
      experienceStreakRef.current = { label: "", passes: 0 };
      lastRecordedIssueForLabelRef.current = "";
      setActiveIssue(null);
      setIssueComments([]);
      predictionUiKeyRef.current = "none";
      setPrediction(null);
      missStreakRef.current = 0;
      consensusRef.current = [];
      lockHoldLabelRef.current = null;
      lockGraceMissRef.current = 0;
      setLockActive(false);
    }
    setMode(next);
  };

  const clearAll = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (!window.confirm(t("confirmClearAll"))) return;
    eng.clearAll();
    clearStoredDataset();
    setCounts(eng.counts());
    setMeta({});
    setActiveIssue(null);
    setIssueComments([]);
    lastRecordedIssueForLabelRef.current = "";
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
  const teachScanFrameActive =
    mode === "teach" &&
    cameraReady &&
    !!selectedBuilding &&
    meta[selectedBuilding]?.isNegative !== true;
  const showCompassPrompt =
    mode === "recognize" &&
    cameraReady &&
    ENABLE_GPS_FEATURES &&
    orientationStatus === "needsPermission" &&
    Object.keys(meta).length > 0;
  const showRoadIssueMatchedBadge =
    mode === "recognize" &&
    cameraReady &&
    !!prediction &&
    !prediction.isNoBuilding &&
    prediction.confidence >= CAMERA_MATCH_BADGE_MIN_CONFIDENCE &&
    experienceStreakRef.current.label === prediction.label &&
    experienceStreakRef.current.passes >= MATCH_REPEAT_TO_SHOW_INFO &&
    isRoadIssueLabel(prediction.label);
  const showMatchedStatsStrip =
    mode === "recognize" &&
    cameraReady &&
    !!prediction &&
    !prediction.isNoBuilding &&
    prediction.confidence >= CAMERA_MATCH_BADGE_MIN_CONFIDENCE &&
    experienceStreakRef.current.label === prediction.label &&
    experienceStreakRef.current.passes >= MATCH_REPEAT_TO_SHOW_INFO;

  return (
    <main className="relative mx-auto flex h-svh w-full max-w-md flex-col overflow-hidden bg-white text-zinc-900 md:my-4 md:h-[calc(100svh-2rem)] md:rounded-2xl md:shadow-xl md:ring-1 md:ring-zinc-200">
      <section
        className={cn(
          "relative w-full shrink-0 overflow-hidden bg-zinc-900 transition-[height] duration-300 ease-in-out",
          mode === "teach" ? "h-[50svh]" : "h-[80svh] rounded-b-3xl",
        )}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-20 bg-gradient-to-b from-white/85 via-white/25 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-16 bg-gradient-to-t from-black/35 to-transparent" />
        {showMatchedStatsStrip && <HighlightStatsStrip />}

        <div className="relative z-10 flex items-start justify-between gap-2 px-3 pt-[max(env(safe-area-inset-top),10px)]">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-zinc-600">
              {t("brandSubtitle")}
            </p>
            <h1 className="text-sm font-bold text-zinc-900">
              {mode === "teach" ? t("modeTeach") : t("modeRecognize")}
            </h1>
          </div>
          <StatusPill engineStatus={engineStatus} cameraState={cameraState} />
        </div>
        {showRoadIssueMatchedBadge && (
          <div className="pointer-events-none relative z-10 mt-1 flex justify-center px-3">
            <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50/95 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-800 shadow-sm">
              {t("matchedLabel")} · {t("roadIssueMatchedName")}
            </span>
          </div>
        )}

        {engineError && (
          <div className="relative z-20 mx-3 mt-2 rounded-lg border border-red-200 bg-white/95 p-2 text-xs text-red-800 shadow-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div>
                <p className="font-semibold">{t("engineFailedTitle")}</p>
                <p className="mt-0.5 text-[11px] text-red-700/85">{engineError}</p>
              </div>
            </div>
          </div>
        )}

        {((mode === "recognize" && cameraReady && !prediction?.isNoBuilding) || teachScanFrameActive) && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            {/* ROI must match `SCAN_ROI_*` in `@/lib/ar/video-scan-roi` (embeddings use that crop). */}
            <div className="relative h-[42%] max-h-[260px] w-[72%] max-w-[300px] rounded-2xl border border-[#ffc300]/60">
              <div className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-[#fca311]" />
              <div className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-[#fca311]" />
              <div className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-[#fca311]" />
              <div className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-[#fca311]" />
              <div className="absolute left-2 right-2 top-1/2 h-px -translate-y-1/2 animate-pulse bg-[#ffc300]/90" />
            </div>
          </div>
        )}

        {cameraState === "ready" && engineStatus === "loading" && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/25">
            <div className="rounded-xl border border-ar-navy/20 bg-white/95 px-4 py-3 text-center shadow-lg ring-1 ring-zinc-100 backdrop-blur-sm">
              <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-ar-navy" />
              <p className="mt-2 text-xs font-medium text-zinc-900">{t("loadingModel")}</p>
              <p className="mt-0.5 text-[10px] text-zinc-500">{t("loadingModelHint")}</p>
            </div>
          </div>
        )}

        {(cameraState === "idle" ||
          cameraState === "starting" ||
          cameraState === "error") && (
          <CameraGate state={cameraState} error={cameraError} onStart={startCamera} />
        )}

        {hasFloatingLabels && (
          <div className="pointer-events-none absolute inset-0 z-[6]">
            {nearby.map((b) => {
              const isMatch = prediction?.label === b.label;
              return (
                <div
                  key={b.label}
                  className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center transition-all duration-200"
                  style={{ left: `${b.screenX}%`, top: `${b.screenY}%` }}
                >
                  <div
                    className={cn(
                      "h-3 w-3 rounded-full shadow-md",
                      isMatch
                        ? "bg-[#fca311] ring-4 ring-[#ffc300]/50 animate-pulse"
                        : "bg-white ring-2 ring-white",
                    )}
                  />
                  <div className="mt-1 h-3 w-px bg-white/50" />
                  <div
                    className={cn(
                      "mt-0.5 rounded-md border px-2 py-1 text-center shadow-md backdrop-blur-sm",
                      isMatch
                        ? "border-[#fca311]/55 bg-white/92 ring-1 ring-ar-navy/15"
                        : "border-white/40 bg-black/55",
                    )}
                  >
                    <p
                      className={cn(
                        "text-xs font-semibold leading-tight",
                        isMatch ? "text-zinc-900" : "text-white",
                      )}
                    >
                      {b.label}
                    </p>
                    <p
                      className={cn(
                        "text-[10px] leading-tight",
                        isMatch ? "text-zinc-600" : "text-white/80",
                      )}
                    >
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

        {cameraReady && (
          <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
            <LanguageSwitcher />
            {showCompassPrompt && (
              <button
                type="button"
                onClick={enableCompass}
                className="inline-flex h-8 items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-2.5 text-[10px] font-medium text-zinc-800 shadow-md active:scale-95"
              >
                <Compass className="h-3.5 w-3.5 text-ar-navy" />
                {t("compass")}
              </button>
            )}
            <button
              type="button"
              onClick={switchCamera}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-white/95 text-zinc-800 shadow-md transition active:scale-95"
              aria-label={
                facing === "environment" ? t("switchCameraAriaFront") : t("switchCameraAriaBack")
              }
              title={
                facing === "environment" ? t("switchCameraAriaFront") : t("switchCameraAriaBack")
              }
            >
              <SwitchCamera className="h-5 w-5 text-ar-navy" />
            </button>
          </div>
        )}
      </section>

      <section
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden transition-[min-height] duration-300 ease-in-out",
          mode === "teach" ? "min-h-[50svh] border-t border-zinc-200 bg-white" : "min-h-0 bg-zinc-100",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col pb-[max(env(safe-area-inset-bottom),10px)]",
            mode === "recognize" ? "px-3 pt-3" : "px-2.5 pt-2",
            mode === "teach" && "overflow-y-auto",
            mode === "recognize" &&
              "rounded-t-3xl border border-b-0 border-zinc-200/90 bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.06)]",
          )}
        >
          <ModeToggle
            mode={mode}
            onChange={changeMode}
            profile={recognitionProfile}
            onProfileChange={setRecognitionProfile}
            demoLockEnabled={demoLockEnabled}
            onToggleDemoLock={toggleDemoLock}
          />
          {ENABLE_GPS_FEATURES && (
            <SensorRow
              locationStatus={locationStatus}
              orientationStatus={orientationStatus}
              userLocation={userLocation}
              heading={heading}
              onEnableCompass={enableCompass}
            />
          )}
          {mode !== "recognize" && (
            <DebugHud
              classifyMs={lastInferenceMs}
              hydrationStatus={hydrationStatus}
              minConfidence={RECOGNITION_PROFILES[recognitionProfile].minConfidence}
              sampleTotal={Object.values(counts).reduce((a, b) => a + b, 0)}
              lockActive={lockActive}
              demoLockEnabled={demoLockEnabled}
              compact={false}
            />
          )}
          <div className={cn("min-h-0", mode === "teach" ? "mt-2 flex-1" : "mt-1 flex-none")}>
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
                matchMinSimilarity={RECOGNITION_PROFILES[recognitionProfile].minConfidence}
                onConfirmMatch={handleJoinDiscussion}
                onJoinDiscussion={handleJoinDiscussion}
                onReportIssue={handleReportIssue}
                onSwitchTeach={() => changeMode("teach")}
              />
            )}
          </div>
        </div>
      </section>
      {mode === "recognize" && experienceBuildingLabel !== null && (
        <BuildingExperience
          buildingName={experienceBuildingLabel}
          issue={activeIssue}
          issueComments={issueComments}
          issueBusy={issueBusy}
          onSupportIssue={handleSupportIssue}
          onAddIssueComment={handleAddIssueComment}
          onRefreshRecognition={clearRecognitionExperience}
        />
      )}
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
  const { t } = useI18n();
  const ok = engineStatus === "ready" && cameraState === "ready";
  const errored = engineStatus === "error" || cameraState === "error";

  const label =
    engineStatus === "error"
      ? t("statusEngineError")
      : cameraState === "error"
        ? t("statusCameraBlocked")
        : cameraState === "idle"
          ? t("statusTapToEnable")
          : engineStatus === "loading"
            ? t("loadingModel")
            : cameraState === "starting"
              ? t("statusStartingCamera")
              : t("statusReady");

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm ring-1 ring-zinc-200 backdrop-blur-sm",
        ok
          ? "bg-emerald-50 text-emerald-800"
          : errored
            ? "bg-red-50 text-red-800"
            : "bg-[#ffc300]/20 text-zinc-800",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : errored ? "bg-red-500" : "animate-pulse bg-[#fca311]",
        )}
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
  const { t } = useI18n();
  const gpsLabel =
    locationStatus === "watching" && userLocation
      ? t("gpsAccuracy", { n: Math.round(userLocation.accuracy) })
      : locationStatus === "watching"
        ? t("gpsWaiting")
        : locationStatus === "denied"
          ? t("gpsDenied")
          : locationStatus === "unavailable"
            ? t("gpsNa")
            : t("gpsEllipsis");

  const compassLabel =
    orientationStatus === "watching" && heading != null
      ? t("compassDegrees", { n: Math.round(heading) })
      : orientationStatus === "watching"
        ? t("compassWaiting")
        : orientationStatus === "needsPermission"
          ? t("compassEnable")
          : orientationStatus === "denied"
            ? t("compassDenied")
            : t("compassNa");

  const gpsOk = locationStatus === "watching" && !!userLocation;
  const compassOk = orientationStatus === "watching" && heading != null;
  const compassNeeds = orientationStatus === "needsPermission";

  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[9px] text-zinc-600">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 ring-1 ring-zinc-200",
          gpsOk ? "bg-emerald-50 text-emerald-800" : "bg-zinc-50 text-zinc-600",
        )}
      >
        <MapPin className="h-2.5 w-2.5 text-ar-navy" />
        {gpsLabel}
      </span>
      <button
        type="button"
        onClick={compassNeeds ? onEnableCompass : undefined}
        disabled={!compassNeeds}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 ring-1 ring-zinc-200",
          compassOk
            ? "bg-emerald-50 text-emerald-800"
            : compassNeeds
              ? "bg-[#ffc300]/25 text-zinc-900"
              : "cursor-default bg-zinc-50 text-zinc-500",
          compassNeeds && "cursor-pointer",
        )}
      >
        <Compass className="h-2.5 w-2.5 text-ar-navy" />
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
  const { t } = useI18n();
  const isError = state === "error";
  const isStarting = state === "starting";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/80 px-6 backdrop-blur-md">
      <div className="max-w-xs rounded-2xl border border-ar-navy/15 bg-white p-6 text-center shadow-xl ring-1 ring-zinc-100">
        <div
          className={cn(
            "mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-100",
            isError ? "bg-red-50" : "bg-[#ffc300]/20",
          )}
        >
          {isError ? (
            <AlertCircle className="h-7 w-7 text-red-600" />
          ) : (
            <Camera className="h-7 w-7 text-ar-navy" />
          )}
        </div>
        <h2 className="mt-4 text-lg font-bold text-zinc-900">
          {isError ? t("cameraBlockedTitle") : t("enableCameraTitle")}
        </h2>
        <p className="mt-2 text-sm leading-5 text-zinc-600">
          {isError ? error : t("cameraPrivacyHint")}
        </p>
        <button
          type="button"
          onClick={onStart}
          disabled={isStarting}
          className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#fca311] px-4 text-sm font-bold text-zinc-900 shadow-md disabled:opacity-60"
        >
          {isStarting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-800" />
              {t("starting")}
            </>
          ) : (
            <>
              <Camera className="h-4 w-4 text-ar-navy" />
              {isError ? t("tryAgain") : t("enableCameraCta")}
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
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-zinc-100 p-1 ring-1 ring-zinc-200/90">
        <button
          type="button"
          onClick={() => onChange("recognize")}
          className={cn(
            "flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition",
            mode === "recognize"
              ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200"
              : "text-zinc-500 hover:bg-white/70",
          )}
        >
          <ScanSearch className="h-3.5 w-3.5 shrink-0 text-ar-navy" />
          {t("modeRecognize")}
        </button>
        <button
          type="button"
          onClick={() => onChange("teach")}
          className={cn(
            "flex h-9 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold transition",
            mode === "teach"
              ? "bg-[#fca311] text-zinc-900 shadow-sm"
              : "text-zinc-500 hover:bg-white/70",
          )}
        >
          <Plus className="h-3.5 w-3.5 shrink-0 text-ar-navy" />
          {t("modeTeach")}
        </button>
      </div>
      {mode === "recognize" && (
        <div className="flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 gap-0.5 rounded-xl border border-zinc-200 bg-zinc-100 p-0.5">
            {(Object.keys(RECOGNITION_PROFILES) as RecognitionProfile[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onProfileChange(key)}
                className={cn(
                  "min-h-9 min-w-0 flex-1 rounded-lg px-1 py-1.5 text-[10px] font-semibold transition",
                  profile === key
                    ? "bg-[#ffc300] font-bold text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:bg-white/80",
                )}
              >
                {t(RECOGNITION_PROFILES[key].labelKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onToggleDemoLock}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl border border-zinc-200 px-2.5 text-[10px] font-semibold transition",
              demoLockEnabled
                ? "bg-white text-zinc-900 shadow-sm"
                : "bg-zinc-50 text-zinc-500",
            )}
          >
            {t("lockToggle")} {demoLockEnabled ? t("lockOn") : t("lockOff")}
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
  compact,
}: {
  sampleTotal: number;
  classifyMs: number;
  minConfidence: number;
  hydrationStatus: "idle" | "loading" | "done" | "error";
  lockActive: boolean;
  demoLockEnabled: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const hydrationLabel =
    hydrationStatus === "idle"
      ? t("hydrateIdle")
      : hydrationStatus === "loading"
        ? t("hydrateLoading")
        : hydrationStatus === "done"
          ? t("hydrateDone")
          : t("hydrateError");
  const chip =
    "rounded bg-zinc-50 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-zinc-600 ring-1 ring-zinc-200";
  if (compact) {
    return (
      <p className="mt-1 truncate font-mono text-[8px] text-zinc-400">
        n={sampleTotal} · {classifyMs}ms · {t("debugThr")}={Math.round(minConfidence * 100)}% ·{" "}
        {hydrationLabel} · lk={demoLockEnabled ? (lockActive ? "*" : "+") : "—"}
      </p>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className={chip}>
        {t("debugSamples")} {sampleTotal}
      </span>
      <span className={chip}>{classifyMs}ms</span>
      <span className={chip}>
        {t("debugThr")} {Math.round(minConfidence * 100)}%
      </span>
      <span className={chip}>{hydrationLabel}</span>
      <span className={chip}>
        {t("debugLock")}{" "}
        {demoLockEnabled
          ? lockActive
            ? t("debugLockActive")
            : t("debugLockArmed")
          : t("debugLockOff")}
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
  const { t } = useI18n();
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
    <div className="space-y-2">
      <p className="text-[11px] leading-snug text-zinc-500">
        {t("teachHintHighlight").trim() ? (
          <>
            {t("teachHintBefore")}{" "}
            <span className="font-semibold text-[#fca311]">{t("teachHintHighlight")}</span>{" "}
            {t("teachHintAfter")}
          </>
        ) : (
          t("teachHintBefore")
        )}
      </p>

      {taught.length > 0 && (
        <div className="max-h-[38svh] space-y-1 overflow-y-auto scroll-smooth pb-1">
          {taught.map(([label, count]) => {
            const hasLoc = !!meta[label]?.location;
            const isNegative = meta[label]?.isNegative === true;
            return (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1",
                  isNegative
                    ? "bg-[#ffc300]/15 ring-[#fca311]/40"
                    : "bg-white ring-zinc-200",
                )}
              >
                <label className="flex shrink-0 cursor-pointer flex-col items-center gap-0.5 py-0.5">
                  <input
                    type="checkbox"
                    checked={isNegative}
                    onChange={(e) => {
                      e.stopPropagation();
                      onToggleNegative(label, e.target.checked);
                    }}
                    aria-label={t("ariaMarkNegative", { name: label })}
                    className="h-3.5 w-3.5 rounded border-ar-navy/30 text-[#fca311] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ar-navy"
                  />
                  <span className="text-[7px] font-bold uppercase tracking-tight text-zinc-500">
                    {t("negShort")}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => onSelect(label)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-semibold text-zinc-900">{label}</p>
                  <p className="flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                    <span>
                      {count} {count === 1 ? t("sampleOne") : t("sampleMany")}
                    </span>
                    {isNegative && (
                      <span className="inline-flex rounded bg-[#fca311]/25 px-1 py-px text-[9px] font-semibold text-zinc-900">
                        {t("tagNotBuilding")}
                      </span>
                    )}
                    {count < RECOMMENDED_SAMPLES_PER_BUILDING && (
                      <span className="inline-flex rounded bg-amber-100 px-1 py-px text-[9px] text-amber-900">
                        {t("tagLow")}
                      </span>
                    )}
                    {hasLoc && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1 py-px text-[9px] text-emerald-900">
                        <MapPin className="h-2.5 w-2.5 text-ar-navy" />
                        {t("tagGps")}
                      </span>
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(label)}
                  className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                  aria-label={t("ariaRemove", { name: label })}
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
        className="flex gap-1.5"
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("placeholderNewBuilding")}
          className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-[#fca311] focus:outline-none focus:ring-1 focus:ring-[#fca311]/45"
        />
        <button
          type="submit"
          disabled={!trimmed || !engineReady}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg bg-[#fca311] px-3 text-xs font-bold text-zinc-900 shadow-sm disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5 text-ar-navy" />
          {exists ? t("open") : t("add")}
        </button>
      </form>

      {taught.length > 0 && (
        <button
          type="button"
          onClick={onClearAll}
          className="w-full rounded-lg border border-red-200 bg-red-50 py-1.5 text-[11px] font-semibold text-red-800 hover:bg-red-100"
        >
          {t("clearAll")}
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
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isBusy = capture !== null || addingPhotos !== null;
  const captureDisabled = !engineReady || !cameraReady || isBusy || isNegative;
  const photoDisabled = !engineReady || isBusy || isNegative;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          disabled={isBusy}
        >
          <ArrowLeft className="h-4 w-4 text-ar-navy" />
          {t("buildingsBack")}
        </button>
        <button
          type="button"
          onClick={() => onRemove(label)}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
          aria-label={t("ariaDelete", { name: label })}
          disabled={isBusy}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-2.5">
        <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#fca311]">
          {t("teachingLabel")}
        </p>
        <p className="mt-0.5 truncate text-sm font-bold text-zinc-900">{label}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
          <span>
            {count} {count === 1 ? t("sampleOne") : t("sampleMany")}
          </span>
          {hasLocation ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-medium text-emerald-900">
              <MapPin className="h-2.5 w-2.5 text-ar-navy" />
              {t("tagGps")}
            </span>
          ) : userLocation ? (
            <span className="text-[10px] text-[#fca311]">{t("gpsOnCapture")}</span>
          ) : (
            <span className="text-[10px] text-amber-800/80">{t("noGps")}</span>
          )}
        </p>
        {count < RECOMMENDED_SAMPLES_PER_BUILDING && (
          <p className="mt-1 text-[10px] text-zinc-500">
            {t("teachSampleHint", { n: RECOMMENDED_SAMPLES_PER_BUILDING })}
          </p>
        )}
      </div>

      <label
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 transition",
          isNegative
            ? "border-[#fca311]/45 bg-[#ffc300]/20"
            : "border-zinc-200 bg-white",
        )}
      >
        <input
          type="checkbox"
          checked={isNegative}
          onChange={(e) => onToggleNegative(label, e.target.checked)}
          className="h-4 w-4 shrink-0 rounded border-ar-navy/30 text-[#fca311] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ar-navy"
        />
        <span className="text-[11px] leading-snug text-zinc-800">
          <span className="font-bold text-[#fca311]">{t("notBuildingBold")}</span>
          {t("notBuildingRest")}
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCapture}
          disabled={captureDisabled}
          className="flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg bg-[#fca311] text-zinc-900 shadow-sm transition disabled:opacity-50"
        >
          {capture ? (
            <>
              <Zap className="h-4 w-4 text-ar-navy" />
              <span className="text-xs font-semibold">
                {capture.progress}/{FRAMES_PER_CAPTURE}
              </span>
            </>
          ) : (
            <>
              <Camera className="h-4 w-4 text-ar-navy" />
              <span className="text-xs font-semibold">
                {t("captureN", { n: FRAMES_PER_CAPTURE })}
              </span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={photoDisabled}
          className="flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-sm transition hover:bg-zinc-50 disabled:opacity-50"
        >
          {addingPhotos ? (
            <>
              <Zap className="h-4 w-4 text-ar-navy" />
              <span className="text-[11px] font-bold">
                {addingPhotos.current}/{addingPhotos.total}
              </span>
            </>
          ) : (
            <>
              <ImagePlus className="h-4 w-4 text-ar-navy" />
              <span className="text-[11px] font-bold">{t("photos")}</span>
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

      <p className="rounded-lg border border-dashed border-zinc-200 bg-white p-2 text-center text-[10px] leading-snug text-zinc-500">
        {t("exifHint")}
      </p>
    </div>
  );
}

function RecognizeContent({
  prediction,
  counts,
  nearby,
  hasGps,
  matchMinSimilarity,
  onConfirmMatch,
  onJoinDiscussion,
  onReportIssue,
  onSwitchTeach,
}: {
  prediction: UiPrediction | null;
  counts: Record<string, number>;
  nearby: Positioned[];
  hasGps: boolean;
  matchMinSimilarity: number;
  onConfirmMatch: (label: string) => void;
  onJoinDiscussion: (label: string) => void;
  onReportIssue: () => void;
  onSwitchTeach: () => void;
}) {
  const { t } = useI18n();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const labelCount = Object.keys(counts).length;

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <Sparkles className="h-6 w-6 text-ar-navy" />
        <p className="text-base font-bold text-zinc-900">{t("noBuildingsYet")}</p>
        <p className="max-w-[280px] text-sm leading-relaxed text-zinc-500">{t("openTeachHint")}</p>
        <button
          type="button"
          onClick={onSwitchTeach}
          className="mt-1 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-900 shadow-sm"
        >
          {t("modeTeach")}
        </button>
      </div>
    );
  }

  if (nearby.length > 0) {
    return (
      <div className="space-y-1">
        <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-[#fca311]">
          {t("inView")}
        </p>
        {nearby.map((b) => {
          const isMatch = prediction?.label === b.label;
          return (
            <div
              key={b.label}
              className={cn(
                "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 ring-1",
                isMatch
                  ? "bg-[#ffc300]/25 ring-[#fca311]/40"
                  : "bg-white ring-zinc-200",
              )}
            >
              <div className="min-w-0">
                <p
                  className={cn(
                    "truncate text-xs font-bold",
                    isMatch ? "text-zinc-900" : "text-zinc-700",
                  )}
                >
                  {b.label}
                </p>
                <p className="text-[9px] text-zinc-500">{b.distance}m</p>
              </div>
              <div className="text-right text-[9px] font-semibold text-zinc-600">
                {isMatch && prediction
                  ? `${Math.round(prediction.confidence * 100)}%`
                  : t("ellipsis")}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <RecognizeMatchView
      prediction={prediction}
      totalSamples={total}
      labelCount={labelCount}
      hasGps={hasGps}
      matchMinSimilarity={matchMinSimilarity}
      onJoinDiscussion={onJoinDiscussion}
      onReportIssue={onReportIssue}
      onSwitchTeach={onSwitchTeach}
      onConfirmTopMatch={onConfirmMatch}
    />
  );
}
