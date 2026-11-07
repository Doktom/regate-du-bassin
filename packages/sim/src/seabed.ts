import { latOf, lonOf, toXY, type Vec } from "./geo.ts";

export interface BathyData {
  lat0: number;
  lon0: number;
  dLat: number;
  dLon: number;
  nx: number;
  ny: number;
  /** Base64 of int8 decimetres relative to mean sea level, row 0 at the south. */
  data: string;
}

export interface CoastGeoJson {
  features: { geometry: { coordinates: number[][][] } }[];
}

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

const BAND_M = 200;

export interface Seabed {
  bathy: BathyData;
  heights: Int8Array;
  /** Land polygons as rings of projected points. */
  rings: Vec[][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  bandMinY: number;
  bands: Edge[][];
}

export function createSeabed(bathy: BathyData, coast: CoastGeoJson): Seabed {
  const bytes = atob(bathy.data);
  const heights = new Int8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) heights[i] = (bytes.charCodeAt(i) << 24) >> 24;

  const rings: Vec[][] = [];
  for (const f of coast.features) {
    for (const ring of f.geometry.coordinates) {
      rings.push(ring.map(([lon, lat]) => toXY(lat, lon)));
    }
  }
  const sw = toXY(bathy.lat0, bathy.lon0);
  const ne = toXY(bathy.lat0 + (bathy.ny - 1) * bathy.dLat, bathy.lon0 + (bathy.nx - 1) * bathy.dLon);

  // Edges grouped by horizontal band, so a point-in-polygon ray only tests nearby edges.
  const bandMinY = sw.y - BAND_M;
  const bandCount = Math.ceil((ne.y - sw.y) / BAND_M) + 3;
  const bands: Edge[][] = Array.from({ length: bandCount }, () => []);
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const lo = Math.floor((Math.min(a.y, b.y) - bandMinY) / BAND_M);
      const hi = Math.floor((Math.max(a.y, b.y) - bandMinY) / BAND_M);
      for (let k = Math.max(0, lo); k <= Math.min(bandCount - 1, hi); k++) {
        bands[k].push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
      }
    }
  }
  return { bathy, heights, rings, minX: sw.x, maxX: ne.x, minY: sw.y, maxY: ne.y, bandMinY, bands };
}

export function isLand(s: Seabed, x: number, y: number): boolean {
  const k = Math.floor((y - s.bandMinY) / BAND_M);
  if (k < 0 || k >= s.bands.length) return false;
  let inside = false;
  for (const e of s.bands[k]) {
    if (e.ay > y !== e.by > y && x < e.ax + ((y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Seabed height relative to mean sea level, in metres, interpolated between cells. */
export function seabedHeight(s: Seabed, x: number, y: number): number {
  const { lat0, lon0, dLat, dLon, nx, ny } = s.bathy;
  const fx = Math.min(nx - 1.001, Math.max(0, (lonOf(x) - lon0) / dLon));
  const fy = Math.min(ny - 1.001, Math.max(0, (latOf(y) - lat0) / dLat));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const h = s.heights;
  const a = h[j * nx + i];
  const b = h[j * nx + i + 1];
  const c = h[(j + 1) * nx + i];
  const d = h[(j + 1) * nx + i + 1];
  return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 10;
}

/** True when a boat cannot be at this point at this tide height. */
export function isBlocked(s: Seabed, x: number, y: number, tideM: number, draftM: number): boolean {
  if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) return true;
  if (tideM < seabedHeight(s, x, y) + draftM) return true;
  return isLand(s, x, y);
}
