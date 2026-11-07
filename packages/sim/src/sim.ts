import type { Gate, RaceCourse } from "./course.ts";
import { headingVec, KN_TO_MS, norm180, norm360, segmentCrossing, type Vec } from "./geo.ts";
import { boatSpeed, type Polar } from "./polar.ts";
import { isBlocked, type Seabed } from "./seabed.ts";
import { tideAt, type TideSeries } from "./tide.ts";
import { sampleWind, type WindField } from "./wind.ts";

export const STEP_S = 10;
const WALK_M = 20;
const ESCAPE_PROBE_M = 60;
const TACK_FACTOR = 0.6;
const TACK_HOLD_S = 20;
const TACK_RECOVERY_S = 20;
const REACCEL_S = 30;

export interface Order {
  /** Epoch seconds at which the order applies. */
  t: number;
  mode: "heading" | "twa";
  /** Compass heading in degrees, or signed angle to the wind where heading = wind direction + value. */
  value: number;
}

export interface World {
  polar: Polar;
  wind: WindField;
  tide: TideSeries;
  seabed: Seabed;
  course: RaceCourse;
}

export type BoatStatus = "sailing" | "grounded" | "finished";

export interface BoatState {
  t: number;
  x: number;
  y: number;
  heading: number;
  speedKn: number;
  /** Side of the wind: +1 or -1. */
  side: number;
  status: BoatStatus;
  nextMark: number;
  tackAt: number;
  /** Time the boat last left a bank. */
  reaccelAt: number;
  groundedAt: number;
  groundedByTide: boolean;
  finishT: number | null;
  /** Time each mark was validated. */
  markTimes: number[];
}

const LONG_AGO = -1e12;

export function initialState(pos: Vec, t: number, heading: number, world: World): BoatState {
  const wind = sampleWind(world.wind, pos.x, pos.y, t);
  return {
    t,
    x: pos.x,
    y: pos.y,
    heading: norm360(heading),
    speedKn: 0,
    side: norm180(heading - wind.twd) >= 0 ? 1 : -1,
    status: "sailing",
    nextMark: 0,
    tackAt: LONG_AGO,
    reaccelAt: LONG_AGO,
    groundedAt: LONG_AGO,
    groundedByTide: false,
    finishT: null,
    markTimes: [],
  };
}

export function headingFor(order: Order, twd: number): number {
  return norm360(order.mode === "heading" ? order.value : twd + order.value);
}

export function tackFactor(sinceTackS: number): number {
  if (sinceTackS < TACK_HOLD_S) return TACK_FACTOR;
  const r = sinceTackS - TACK_HOLD_S;
  return r < TACK_RECOVERY_S ? TACK_FACTOR + ((1 - TACK_FACTOR) * r) / TACK_RECOVERY_S : 1;
}

export function reaccelFactor(sinceS: number): number {
  return sinceS < REACCEL_S ? sinceS / REACCEL_S : 1;
}

/** Fraction of p->q at which the mark is validated, or null. */
export function gateCrossing(gate: Gate, p: Vec, q: Vec): number | null {
  const u = segmentCrossing(p, q, gate.buoy, gate.end);
  if (u === null) return null;
  const d = headingVec(gate.travelDeg);
  return (q.x - p.x) * d.x + (q.y - p.y) * d.y > 0 ? u : null;
}

function blocked(w: World, x: number, y: number, t: number): boolean {
  return isBlocked(w.seabed, x, y, tideAt(w.tide, t), w.polar.draftM);
}

/** Advances a boat by one fixed step. Pure: the input state is not modified. */
export function step(w: World, s: BoatState, order: Order): BoatState {
  const t = s.t + STEP_S;
  if (s.status === "finished") return { ...s, t, speedKn: 0 };

  const wind = sampleWind(w.wind, s.x, s.y, s.t);
  const heading = headingFor(order, wind.twd);
  const n: BoatState = { ...s, t, heading };
  const dir = headingVec(heading);

  if (s.status === "grounded") {
    // The water must be back under the boat, and the course must lead away from the obstacle.
    const free = !blocked(w, s.x, s.y, s.t);
    const orderedOff = s.groundedByTide || order.t > s.groundedAt;
    let clear = true;
    for (let d = WALK_M / 2; clear && d <= ESCAPE_PROBE_M; d += WALK_M / 2) {
      clear = !blocked(w, s.x + dir.x * d, s.y + dir.y * d, t);
    }
    if (!(free && orderedOff && clear)) return { ...n, speedKn: 0 };
    n.status = "sailing";
    n.reaccelAt = s.t;
    n.groundedByTide = false;
  } else if (blocked(w, s.x, s.y, s.t)) {
    return { ...n, status: "grounded", speedKn: 0, groundedAt: s.t, groundedByTide: true };
  }

  const twa = norm180(heading - wind.twd);
  const side = twa >= 0 ? 1 : -1;
  if (side !== s.side) {
    n.side = side;
    n.tackAt = s.t;
  }
  const speedKn =
    boatSpeed(w.polar, Math.abs(twa), wind.tws) *
    tackFactor(s.t - n.tackAt) *
    reaccelFactor(s.t - n.reaccelAt);
  n.speedKn = speedKn;

  const distance = speedKn * KN_TO_MS * STEP_S;
  const walks = Math.max(1, Math.ceil(distance / WALK_M));
  let moved = 0;
  let hit = false;
  for (let i = 1; i <= walks; i++) {
    const d = (distance * i) / walks;
    if (blocked(w, s.x + dir.x * d, s.y + dir.y * d, t)) {
      hit = true;
      break;
    }
    moved = d;
  }
  const from = { x: s.x, y: s.y };
  const to = { x: s.x + dir.x * moved, y: s.y + dir.y * moved };
  n.x = to.x;
  n.y = to.y;
  if (hit) {
    n.status = "grounded";
    n.speedKn = 0;
    n.groundedAt = t;
    n.groundedByTide = false;
  }

  // Marks and finish are checked along the whole segment, in order.
  let fromFrac = 0;
  const atFrac = (f: number): Vec => ({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
  while (n.nextMark < w.course.gates.length) {
    const u = gateCrossing(w.course.gates[n.nextMark], atFrac(fromFrac), to);
    if (u === null) break;
    fromFrac += (1 - fromFrac) * u;
    n.markTimes = [...n.markTimes, s.t + STEP_S * fromFrac];
    n.nextMark++;
  }
  if (n.nextMark === w.course.gates.length) {
    const u = segmentCrossing(atFrac(fromFrac), to, w.course.finishA, w.course.finishB);
    if (u !== null) {
      const f = fromFrac + (1 - fromFrac) * u;
      const end = atFrac(f);
      n.x = end.x;
      n.y = end.y;
      n.status = "finished";
      n.speedKn = 0;
      n.finishT = s.t + STEP_S * f;
    }
  }
  return n;
}

/** Replays time-sorted orders. The same inputs give the exact same state. */
export function simulate(
  w: World,
  initial: BoatState,
  orders: Order[],
  tEnd: number,
  onStep?: (s: BoatState) => void,
): BoatState {
  // Before the first order the boat keeps the heading it started with.
  let current: Order = { t: initial.t, mode: "heading", value: initial.heading };
  let s = initial;
  let k = 0;
  while (s.t + STEP_S <= tEnd) {
    while (k < orders.length && orders[k].t <= s.t) current = orders[k++];
    s = step(w, s, current);
    onStep?.(s);
  }
  return s;
}

/** Forward projection for the planned-track display, as if the order were given now. */
export function predictTrack(w: World, from: BoatState, order: Omit<Order, "t">, durationS: number): BoatState[] {
  const applied: Order = { ...order, t: from.t + 1 };
  const out: BoatState[] = [from];
  let s = from;
  for (let e = 0; e < durationS && s.status !== "finished"; e += STEP_S) {
    s = step(w, s, applied);
    out.push(s);
  }
  return out;
}
