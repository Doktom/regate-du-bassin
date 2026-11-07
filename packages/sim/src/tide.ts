/** Tide height relative to mean sea level, one value for the whole Bassin. */
export interface TideSeries {
  /** Epoch seconds, ascending and evenly spaced. */
  times: number[];
  heightsM: number[];
}

export interface TideExtremum {
  t: number;
  h: number;
  kind: "high" | "low";
}

/** Calibration of Open-Meteo Marine against the Arcachon-Eyrac table, see docs/tide-report.md. */
export const TIDE_CALIBRATION = { lagS: 89 * 60, scale: 1.065, offsetM: 0.257 };

/** Height of mean sea level above chart datum at Eyrac, to display heights like a tide table. */
export const MSL_ABOVE_DATUM_M = 2.45;

export function calibrateOpenMeteoTide(times: number[], rawHeightsM: number[]): TideSeries {
  const { lagS, scale, offsetM } = TIDE_CALIBRATION;
  return {
    times: times.map((t) => t + lagS),
    heightsM: rawHeightsM.map((h) => Math.round((h * scale + offsetM) * 1000) / 1000),
  };
}

/** Catmull-Rom through the hourly values, so high and low waters are not flattened. */
export function tideAt(s: TideSeries, t: number): number {
  const n = s.times.length;
  if (t <= s.times[0]) return s.heightsM[0];
  if (t >= s.times[n - 1]) return s.heightsM[n - 1];
  const dt = s.times[1] - s.times[0];
  const i = Math.min(n - 2, Math.floor((t - s.times[0]) / dt));
  const f = (t - s.times[i]) / dt;
  const p1 = s.heightsM[i];
  const p2 = s.heightsM[i + 1];
  const p0 = s.heightsM[Math.max(0, i - 1)];
  const p3 = s.heightsM[Math.min(n - 1, i + 2)];
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
      (3 * p1 - p0 - 3 * p2 + p3) * f * f * f)
  );
}

/** Next high or low water after t, or null when the series ends first. */
export function nextTideExtremum(s: TideSeries, t: number): TideExtremum | null {
  const stepS = 300;
  const end = s.times[s.times.length - 1];
  let cur = tideAt(s, t + stepS);
  const rising = cur >= tideAt(s, t);
  for (let u = t + stepS; u < end; u += stepS) {
    const next = tideAt(s, u + stepS);
    if (next >= cur !== rising) {
      return { t: u, h: cur, kind: rising ? "high" : "low" };
    }
    cur = next;
  }
  return null;
}
