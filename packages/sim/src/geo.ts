import { datan2, dcos, dhypot, dsin } from "./dmath.ts";
/** Local equirectangular projection centred on the Bassin. x is east, y is north, in metres. */
const ORIGIN_LAT = 44.67;
const ORIGIN_LON = -1.14;
const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * DEG;
const M_PER_DEG_LON = M_PER_DEG_LAT * dcos(ORIGIN_LAT * DEG);

export const KN_TO_MS = 1852 / 3600;
export const METRES_PER_NM = 1852;

export interface Vec {
  x: number;
  y: number;
}

export function toXY(lat: number, lon: number): Vec {
  return { x: (lon - ORIGIN_LON) * M_PER_DEG_LON, y: (lat - ORIGIN_LAT) * M_PER_DEG_LAT };
}

export function lonOf(x: number): number {
  return x / M_PER_DEG_LON + ORIGIN_LON;
}

export function latOf(y: number): number {
  return y / M_PER_DEG_LAT + ORIGIN_LAT;
}

export function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Wraps an angle to (-180, 180]. */
export function norm180(deg: number): number {
  const d = norm360(deg);
  return d > 180 ? d - 360 : d;
}

export function headingVec(deg: number): Vec {
  return { x: dsin(deg * DEG), y: dcos(deg * DEG) };
}

export function bearing(a: Vec, b: Vec): number {
  return norm360(datan2(b.x - a.x, b.y - a.y) / DEG);
}

export function dist(a: Vec, b: Vec): number {
  return dhypot(b.x - a.x, b.y - a.y);
}

/** Parameter along p->q where it crosses a->b, or null when the segments do not cross. */
export function segmentCrossing(p: Vec, q: Vec, a: Vec, b: Vec): number | null {
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
