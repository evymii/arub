import * as tf from "@tensorflow/tfjs";
import * as mobilenet from "@tensorflow-models/mobilenet";
import * as knnClassifier from "@tensorflow-models/knn-classifier";

import { drawVideoScanRoiToCanvas } from "@/lib/ar/video-scan-roi";

let modelPromise: Promise<mobilenet.MobileNet> | null = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = mobilenet.load({ version: 2, alpha: 0.5 });
  }
  return modelPromise;
}

export type Prediction = {
  label: string;
  confidence: number;
  confidences: Record<string, number>;
  isLowConfidence?: boolean;
  /** Best cosine similarity minus runner-up (0–1); larger ⇒ more distinct winner. */
  margin?: number;
};

export type ImageSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

export type Engine = {
  addExample: (source: ImageSource, label: string) => void;
  addEmbedding: (embedding: number[], label: string) => void;
  extractEmbedding: (source: ImageSource) => number[];
  classify: (
    source: ImageSource,
    allowedLabels?: ReadonlySet<string>,
    options?: { minConfidence?: number; returnBestEffort?: boolean },
  ) => Promise<Prediction | null>;
  counts: () => Record<string, number>;
  totalExamples: () => number;
  clearLabel: (label: string) => void;
  clearAll: () => void;
  serialize: () => string;
  deserialize: (json: string) => void;
  dispose: () => void;
};

/** Default gate for cosine similarity (same scale as confidence / 100%). */
const SIMILARITY_THRESHOLD = 0.4;

type CpuLabel = { label: string; vectors: Float32Array[]; norms: Float32Array };

export async function createEngine(): Promise<Engine> {
  const model = await getModel();
  const classifier = knnClassifier.create();

  let cpuCache: CpuLabel[] | null = null;
  const invalidate = () => {
    cpuCache = null;
  };

  const buildCache = (): CpuLabel[] => {
    const dataset = classifier.getClassifierDataset();
    const built: CpuLabel[] = [];
    for (const [label, tensor] of Object.entries(dataset)) {
      const data = tensor.dataSync() as Float32Array;
      const [n, dim] = tensor.shape as [number, number];
      const vectors: Float32Array[] = new Array(n);
      const norms = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = data.slice(i * dim, (i + 1) * dim);
        vectors[i] = v;
        let s = 0;
        for (let j = 0; j < dim; j++) s += v[j] * v[j];
        norms[i] = Math.sqrt(s) + 1e-10;
      }
      built.push({ label, vectors, norms });
    }
    return built;
  };

  const embed = (source: ImageSource) => {
    if (source instanceof HTMLVideoElement) {
      const roi = drawVideoScanRoiToCanvas(source);
      if (roi) return model.infer(roi, true) as tf.Tensor;
    }
    return model.infer(source, true) as tf.Tensor;
  };
  const extractEmbedding = (source: ImageSource): number[] => {
    const tensor = embed(source);
    try {
      return Array.from(tensor.dataSync() as Float32Array);
    } finally {
      tensor.dispose();
    }
  };

  const totalExamples = () =>
    Object.values(classifier.getClassExampleCount()).reduce((a, b) => a + b, 0);

  /**
   * Robust per-label score:
   * - 1 sample: use best cosine similarity.
   * - 2 samples: still trust best (avoid over-penalizing small classes).
   * - 3+ samples: lightly blend best and runner-up to reduce noisy spikes.
   */
  const robustLabelScore = (best: number, second: number, sampleCount: number): number => {
    if (sampleCount <= 2) return best;
    return best * 0.85 + second * 0.15;
  };

  return {
    addExample(source, label) {
      const tensor = embed(source);
      classifier.addExample(tensor, label);
      tensor.dispose();
      invalidate();
    },

    addEmbedding(embedding, label) {
      if (embedding.length === 0) return;
      const tensor = tf.tensor2d([embedding], [1, embedding.length]);
      classifier.addExample(tensor, label);
      tensor.dispose();
      invalidate();
    },

    extractEmbedding,

    async classify(source, allowedLabels, options) {
      const total = totalExamples();
      if (total === 0) return null;
      const minConfidence = options?.minConfidence ?? SIMILARITY_THRESHOLD;

      const eTensor = embed(source);
      try {
        const queryData = (await eTensor.data()) as Float32Array;
        let qNorm = 0;
        for (let i = 0; i < queryData.length; i++) qNorm += queryData[i] * queryData[i];
        qNorm = Math.sqrt(qNorm) + 1e-10;

        if (cpuCache === null) cpuCache = buildCache();

        const perLabel: { label: string; score: number }[] = [];
        for (const entry of cpuCache) {
          if (allowedLabels && !allowedLabels.has(entry.label)) continue;
          let bestSim = -1;
          let secondSim = -1;
          for (let i = 0; i < entry.vectors.length; i++) {
            const v = entry.vectors[i];
            const vNorm = entry.norms[i];
            let dot = 0;
            for (let j = 0; j < v.length; j++) dot += v[j] * queryData[j];
            const sim = dot / (qNorm * vNorm);
            if (sim > bestSim) {
              secondSim = bestSim;
              bestSim = sim;
            } else if (sim > secondSim) {
              secondSim = sim;
            }
          }
          const score = robustLabelScore(
            bestSim,
            secondSim < 0 ? bestSim : secondSim,
            entry.vectors.length,
          );
          perLabel.push({ label: entry.label, score });
        }

        perLabel.sort((a, b) => b.score - a.score);
        const best = perLabel[0];
        if (!best) return null;

        const second = perLabel[1]?.score ?? 0;
        const margin = Math.max(0, best.score - second);

        const confidences: Record<string, number> = {};
        for (const item of perLabel) {
          confidences[item.label] = Math.max(0, Math.min(1, item.score));
        }
        const confidence = Math.max(0, Math.min(1, best.score));
        if (best.score < minConfidence && !options?.returnBestEffort) return null;
        return {
          label: best.label,
          confidence,
          confidences,
          isLowConfidence: confidence < minConfidence,
          margin,
        };
      } finally {
        eTensor.dispose();
      }
    },

    counts: () => classifier.getClassExampleCount(),
    totalExamples,
    clearLabel: (label) => {
      classifier.clearClass(label);
      invalidate();
    },
    clearAll: () => {
      classifier.clearAllClasses();
      invalidate();
    },

    serialize() {
      const dataset = classifier.getClassifierDataset();
      const out: Record<string, { shape: number[]; data: number[] }> = {};
      for (const [label, tensor] of Object.entries(dataset)) {
        out[label] = { shape: tensor.shape, data: Array.from(tensor.dataSync()) };
      }
      return JSON.stringify(out);
    },

    deserialize(json) {
      const parsed = JSON.parse(json) as Record<string, { shape: number[]; data: number[] }>;
      const dataset: Record<string, tf.Tensor2D> = {};
      for (const [label, { shape, data }] of Object.entries(parsed)) {
        dataset[label] = tf.tensor2d(data, shape as [number, number]);
      }
      classifier.setClassifierDataset(dataset);
      invalidate();
    },

    dispose() {
      classifier.dispose();
      invalidate();
    },
  };
}
