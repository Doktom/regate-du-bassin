import { datan2, dcos, dhypot, dsin } from "./dmath.ts";
import { latOf, lonOf, norm360 } from "./geo.ts";

/** Frozen wind forecast. Values are flat arrays indexed [time][lat][lon]. */
export interface WindSnapshot {
  lats: number[];
  lons: number[];
  /** Epoch seconds, ascending. */
  times: number[];
  speedKn: number[];
  gustKn?: number[];
  /** Meteorological direction: where the wind blows from, in degrees. */
  dirDeg: number[];
}

export interface WindField {
  lats: number[];
  lons: number[];
  times: number[];
  u: Float64Array;
  v: Float64Array;
}

export interface WindSample {
  /** Where the wind blows from, in degrees. */
  twd: number;
  tws: number;
}

/** Precomputes the u/v components, which are the only values ever interpolated. */
export function createWindField(s: WindSnapshot): WindField {
  const n = s.speedKn.length;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = (s.dirDeg[i] * Math.PI) / 180;
    u[i] = -s.speedKn[i] * dsin(r);
    v[i] = -s.speedKn[i] * dcos(r);
  }
  return { lats: s.lats, lons: s.lons, times: s.times, u, v };
}

export function uniformWind(dirDeg: number, speedKn: number): WindField {
  return createWindField({
    lats: [44, 45],
    lons: [-2, 0],
    times: [0, 4e9],
    speedKn: new Array(8).fill(speedKn),
    dirDeg: new Array(8).fill(dirDeg),
  });
}

function locate(axis: number[], v: number): [number, number] {
  const last = axis.length - 1;
  if (v <= axis[0]) return [0, 0];
  if (v >= axis[last]) return [last - 1, 1];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= v) lo = mid;
    else hi = mid;
  }
  return [lo, (v - axis[lo]) / (axis[lo + 1] - axis[lo])];
}

export function sampleWind(f: WindField, x: number, y: number, t: number): WindSample {
  const [j, fy] = locate(f.lats, latOf(y));
  const [i, fx] = locate(f.lons, lonOf(x));
  const [k, ft] = locate(f.times, t);
  const nx = f.lons.length;
  const ny = f.lats.length;
  const at = (arr: Float64Array, tk: number): number => {
    const o = tk * ny * nx;
    const a = arr[o + j * nx + i];
    const b = arr[o + j * nx + i + 1];
    const c = arr[o + (j + 1) * nx + i];
    const d = arr[o + (j + 1) * nx + i + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  const u = at(f.u, k) * (1 - ft) + at(f.u, k + 1) * ft;
  const v = at(f.v, k) * (1 - ft) + at(f.v, k + 1) * ft;
  return { tws: dhypot(u, v), twd: norm360((datan2(-u, -v) * 180) / Math.PI) };
}
