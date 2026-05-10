import { describe, expect, it } from "vitest";

import type { Prediction } from "@/lib/ar/engine";

import {
  enrichUiPrediction,
  effectiveMargin,
  isSuppressedArLabel,
  passesRecognitionGate,
  RECOGNITION_PROFILE_GATES,
  toDisplayPrediction,
} from "@/lib/ar/recognition-policy";

const balancedGate = {
  minConfidence: RECOGNITION_PROFILE_GATES.balanced.minConfidence,
  minMargin: RECOGNITION_PROFILE_GATES.balanced.minMargin,
};

function pred(
  overrides: Partial<Prediction> & Pick<Prediction, "label" | "confidence" | "confidences">,
): Prediction {
  return {
    isLowConfidence: false,
    ...overrides,
  };
}

describe("effectiveMargin", () => {
  it("uses engine margin when provided", () => {
    expect(
      effectiveMargin({
        margin: 0.12,
        confidences: { a: 0.9, b: 0.89 },
      }),
    ).toBeCloseTo(0.12, 5);
  });

  it("falls back to top-two confidence spread when margin is absent", () => {
    expect(
      effectiveMargin({
        confidences: { east: 0.55, west: 0.5, north: 0.1 },
      }),
    ).toBeCloseTo(0.05, 5);
  });

  it("treats single class as margin equal to its score", () => {
    expect(effectiveMargin({ confidences: { only: 0.73 } })).toBeCloseTo(0.73, 5);
  });
});

describe("passesRecognitionGate", () => {
  it("rejects when similarity is below threshold", () => {
    const gate = { minConfidence: 0.4, minMargin: 0.05 };
    const p = pred({
      label: "A",
      confidence: 0.39,
      confidences: { A: 0.39, B: 0.1 },
      margin: 0.29,
    });
    expect(passesRecognitionGate(p, gate)).toBe(false);
  });

  it("rejects when margin is below threshold", () => {
    const gate = { minConfidence: 0.4, minMargin: 0.06 };
    const p = pred({
      label: "A",
      confidence: 0.5,
      confidences: { A: 0.5, B: 0.48 },
      margin: 0.02,
    });
    expect(passesRecognitionGate(p, gate)).toBe(false);
  });

  it("accepts when both similarity and margin satisfy the gate", () => {
    const gate = { minConfidence: 0.4, minMargin: 0.05 };
    const p = pred({
      label: "A",
      confidence: 0.45,
      confidences: { A: 0.45, B: 0.35 },
      margin: 0.1,
    });
    expect(passesRecognitionGate(p, gate)).toBe(true);
  });
});

describe("isSuppressedArLabel", () => {
  it("matches suppressed tokens case-insensitively", () => {
    expect(isSuppressedArLabel("Human")).toBe(true);
    expect(isSuppressedArLabel("  wall ")).toBe(true);
  });

  it("matches first token of compound names", () => {
    expect(isSuppressedArLabel("human_far")).toBe(true);
    expect(isSuppressedArLabel("road-ahead")).toBe(true);
  });

  it("does not suppress arbitrary building-like names", () => {
    expect(isSuppressedArLabel("Town Hall")).toBe(false);
  });
});

describe("enrichUiPrediction", () => {
  const noBuildingUi = "%NO_BUILDING%";

  it("returns not-in-library when similarity is below gate", () => {
    const raw = pred({
      label: "Hall",
      confidence: 0.35,
      confidences: { Hall: 0.35 },
      margin: 0.35,
    });
    const ui = enrichUiPrediction(raw, {}, noBuildingUi, balancedGate);
    expect(ui?.isNotInDb).toBe(true);
    expect(ui?.label).toBe("");
  });

  it("returns not-in-library when margin is below gate", () => {
    const raw = pred({
      label: "Hall",
      confidence: 0.55,
      confidences: { Hall: 0.55, Other: 0.52 },
      margin: 0.03,
    });
    const ui = enrichUiPrediction(raw, {}, noBuildingUi, balancedGate);
    expect(ui?.isNotInDb).toBe(true);
  });

  it("shows building UI and filters ranked negatives when prediction is confident", () => {
    const meta = {};
    const raw = pred({
      label: "Hall",
      confidence: 0.55,
      confidences: { Hall: 0.55, NOT_BUILDING: 0.45 },
      margin: 0.1,
    });
    const ui = enrichUiPrediction(raw, meta, noBuildingUi, balancedGate);
    expect(ui?.isNotInDb).not.toBe(true);
    expect(ui?.label).toBe("Hall");
    expect(ui?.rankedAboveThreshold?.map((r) => r.label)).toEqual(["Hall"]);
  });
});

describe("toDisplayPrediction", () => {
  it("maps suppressed winning label to no-building UX string", () => {
    const p = pred({
      label: "human",
      confidence: 0.99,
      confidences: { human: 0.99 },
      margin: 0.9,
    });
    const ui = toDisplayPrediction(p, {}, "__NB__");
    expect(ui?.isNoBuilding).toBe(true);
    expect(ui?.label).toBe("__NB__");
  });
});

describe("RECOGNITION_PROFILE_GATES", () => {
  it("orders strict thresholds above balanced above fast", () => {
    const { fast, balanced, strict } = RECOGNITION_PROFILE_GATES;
    expect(fast.minConfidence).toBeLessThan(balanced.minConfidence);
    expect(balanced.minConfidence).toBeLessThan(strict.minConfidence);
    expect(fast.minMargin).toBeLessThan(balanced.minMargin);
    expect(balanced.minMargin).toBeLessThan(strict.minMargin);
  });
});
