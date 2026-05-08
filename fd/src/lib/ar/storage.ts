import type { Engine } from "./engine";
import type { LatLng } from "./geo";

const KEY_DATASET = "ar.knn.dataset.v1";
const KEY_META = "ar.building.meta.v1";

export type BuildingMeta = {
  location?: LatLng;
  locationSampleCount?: number;
  /** Taught class counts as "not a building" → Recognize shows score 0. */
  isNegative?: boolean;
};

export type AllMeta = Record<string, BuildingMeta>;

export function saveDataset(engine: Engine) {
  try {
    localStorage.setItem(KEY_DATASET, engine.serialize());
  } catch (e) {
    console.warn("AR: save dataset failed", e);
  }
}

export function loadDataset(engine: Engine): boolean {
  try {
    const json = localStorage.getItem(KEY_DATASET);
    if (!json) return false;
    engine.deserialize(json);
    return true;
  } catch (e) {
    console.warn("AR: load dataset failed", e);
    return false;
  }
}

export function saveMeta(meta: AllMeta) {
  try {
    localStorage.setItem(KEY_META, JSON.stringify(meta));
  } catch (e) {
    console.warn("AR: save meta failed", e);
  }
}

export function loadMeta(): AllMeta {
  try {
    const json = localStorage.getItem(KEY_META);
    if (!json) return {};
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as AllMeta) : {};
  } catch (e) {
    console.warn("AR: load meta failed", e);
    return {};
  }
}

export function clearStoredDataset() {
  try {
    localStorage.removeItem(KEY_DATASET);
    localStorage.removeItem(KEY_META);
  } catch {}
}
