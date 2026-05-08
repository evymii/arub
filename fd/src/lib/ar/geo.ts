export type LatLng = { lat: number; lng: number };

export type UserLocation = LatLng & { accuracy: number };

const EARTH_RADIUS_M = 6371000;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function bearingDegrees(from: LatLng, to: LatLng): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeDegrees(toDeg(Math.atan2(y, x)));
}

export function relativeBearing(targetBearing: number, heading: number): number {
  const diff = normalizeDegrees(targetBearing - heading);
  return diff > 180 ? diff - 360 : diff;
}

export function blendLocation(
  prev: LatLng | undefined | null,
  sample: LatLng,
  prevWeight: number,
): LatLng {
  if (!prev) return { lat: sample.lat, lng: sample.lng };
  const total = prevWeight + 1;
  return {
    lat: (prev.lat * prevWeight + sample.lat) / total,
    lng: (prev.lng * prevWeight + sample.lng) / total,
  };
}
