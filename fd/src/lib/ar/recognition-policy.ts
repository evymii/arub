import type { Prediction } from "@/lib/ar/engine";
import type { AllMeta } from "@/lib/ar/storage";

export const NEGATIVE_LABEL = "NOT_BUILDING";

/** Numeric gates and consensus sizing; UI adds i18n `labelKey` in `ARShell`. */
export const RECOGNITION_PROFILE_GATES = {
  fast: {
    minConfidence: 0.28,
    minMargin: 0.025,
    consensusWindow: 8,
    consensusMinVotes: 4,
  },
  balanced: {
    minConfidence: 0.3,
    minMargin: 0.03,
    consensusWindow: 8,
    consensusMinVotes: 5,
  },
  strict: {
    minConfidence: 0.4,
    minMargin: 0.06,
    consensusWindow: 10,
    consensusMinVotes: 6,
  },
} as const;

export type RecognitionProfile = keyof typeof RECOGNITION_PROFILE_GATES;

export type RecognitionGate = {
  minConfidence: number;
  minMargin: number;
};

export type UiPrediction = Prediction & {
  isNoBuilding?: boolean;
  isNotInDb?: boolean;
  rankedAboveThreshold?: Array<{ label: string; score: number }>;
};

/**
 * Scene/object mode: do not suppress semantic labels by default.
 * Previously this list blocked labels like road/street and made valid matches
 * look like "no scene". Keep empty unless you explicitly want hard rejects.
 */
const SUPPRESSED_AR_LABELS = new Set<string>();

export function isSuppressedArLabel(label: string): boolean {
  const key = label.trim().toLowerCase();
  if (SUPPRESSED_AR_LABELS.has(key)) return true;
  const first = (key.split(/[\s/_-]+/)[0] ?? key).toLowerCase();
  return SUPPRESSED_AR_LABELS.has(first);
}

export function isNegativeClassLabel(label: string, meta: AllMeta): boolean {
  if (label === NEGATIVE_LABEL) return true;
  return meta[label]?.isNegative === true;
}

export function isNonBuildingSceneLabel(label: string, meta: AllMeta): boolean {
  return isNegativeClassLabel(label, meta) || isSuppressedArLabel(label);
}

export function effectiveMargin(
  prediction: Pick<Prediction, "margin" | "confidences">,
): number {
  if (prediction.margin != null && Number.isFinite(prediction.margin)) {
    return Math.max(0, prediction.margin);
  }
  const vals = Object.values(prediction.confidences).sort((a, b) => b - a);
  if (vals.length === 0) return 0;
  if (vals.length === 1) return vals[0] ?? 0;
  return Math.max(0, (vals[0] ?? 0) - (vals[1] ?? 0));
}

export function passesRecognitionGate(prediction: Prediction, gate: RecognitionGate): boolean {
  return (
    prediction.confidence >= gate.minConfidence && effectiveMargin(prediction) >= gate.minMargin
  );
}

export function toDisplayPrediction(
  prediction: Prediction,
  meta: AllMeta,
  noBuildingLabel: string,
): UiPrediction | null {
  if (isNonBuildingSceneLabel(prediction.label, meta)) {
    return {
      label: noBuildingLabel,
      confidence: 0,
      confidences: { [noBuildingLabel]: 1 },
      isLowConfidence: false,
      isNoBuilding: true,
    };
  }
  return { ...prediction, isNoBuilding: false };
}

export function enrichUiPrediction(
  r: Prediction,
  meta: AllMeta,
  noBuildingLabel: string,
  gate: RecognitionGate,
): UiPrediction | null {
  const rankedAll = Object.entries(r.confidences)
    .filter(([, s]) => s >= gate.minConfidence)
    .sort((a, b) => b[1] - a[1])
    .map(([label, score]) => ({ label, score }));

  const margin = effectiveMargin(r);
  if (r.confidence < gate.minConfidence || margin < gate.minMargin) {
    return {
      label: "",
      confidence: r.confidence,
      confidences: r.confidences,
      isNotInDb: true,
      isLowConfidence: true,
      rankedAboveThreshold: [],
    };
  }

  const base = toDisplayPrediction(r, meta, noBuildingLabel);
  if (!base) return null;

  if (base.isNoBuilding) {
    return { ...base, rankedAboveThreshold: rankedAll };
  }

  const rankedPositive = rankedAll.filter(
    (row) => !isNonBuildingSceneLabel(row.label, meta),
  );
  return { ...base, rankedAboveThreshold: rankedPositive };
}
