import exifr from "exifr";
import type { LatLng } from "./geo";

export async function extractGpsFromFile(file: File): Promise<LatLng | null> {
  try {
    const gps = await exifr.gps(file);
    if (
      gps &&
      typeof gps.latitude === "number" &&
      typeof gps.longitude === "number" &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude)
    ) {
      return { lat: gps.latitude, lng: gps.longitude };
    }
  } catch {
    // exifr throws on non-images or unsupported formats — ignore
  }
  return null;
}
