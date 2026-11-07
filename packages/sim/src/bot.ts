import { type Gate, nextTarget } from "./course.ts";
import { bearing, dist, headingVec, norm180, norm360, type Vec } from "./geo.ts";
import { bestVmgAngles, boatSpeed, NO_GO_DEG } from "./polar.ts";
import { isBlocked, isLand, seabedHeight, type Seabed } from "./seabed.ts";
import {
  type BoatState,
  gateCrossing,
  initialState,
  type Order,
  STEP_S,
  step,
  type World,
} from "./sim.ts";
import { tideAt } from "./tide.ts";
import { sampleWind } from "./wind.ts";

const CELL_M = 150;
const TIDE_BUCKET_M = 0.25;
const SAFETY_M = 0.15;
const LOOKAHEAD_HOPS = 40;
const DECISION_S = 20;
const KEEP_TACK_RATIO = 0.4;
const CLEAR_SAMPLE_M = 20;
const ESCAPE_CHECK_M = 80;

/** Shortest water paths towards fixed targets, cached by tide level. */
export class Router {
  readonly nx: number;
  readonly ny: number;
  private readonly heights: Float64Array;
  private readonly fields = new Map<string, Float64Array>();
  private readonly seabed: Seabed;

  constructor(seabed: Seabed) {
    this.seabed = seabed;
    this.nx = Math.floor((seabed.maxX - seabed.minX) / CELL_M);
    this.ny = Math.floor((seabed.maxY - seabed.minY) / CELL_M);
    this.heights = new Float64Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const { x, y } = this.nodePos(i, j);
        this.heights[j * this.nx + i] = isLand(seabed, x, y) ? Infinity : seabedHeight(seabed, x, y);
      }
    }
  }

  nodePos(i: number, j: number): Vec {
    return { x: this.seabed.minX + (i + 0.5) * CELL_M, y: this.seabed.minY + (j + 0.5) * CELL_M };
  }

  nodeIndex(p: Vec): number {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((p.x - this.seabed.minX) / CELL_M)));
    const j = Math.max(0, Math.min(this.ny - 1, Math.floor((p.y - this.seabed.minY) / CELL_M)));
    return j * this.nx + i;
  }

  private nearestFree(p: Vec, limit: number): number {
    const c = this.nodeIndex(p);
    const ci = c % this.nx;
    const cj = Math.floor(c / this.nx);
    for (let r = 0; r < 60; r++) {
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (this.heights[j * this.nx + i] <= limit) return j * this.nx + i;
        }
      }
    }
    return c;
  }

  /** Water distance to the target from every node at this tide level; Infinity when cut off. */
  field(target: Vec, tideM: number, draftM: number): Float64Array {
    const bucket = Math.floor(tideM / TIDE_BUCKET_M);
    const key = `${Math.round(target.x)},${Math.round(target.y)},${bucket}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const limit = bucket * TIDE_BUCKET_M - draftM - SAFETY_M;
    const { nx, ny, heights } = this;
    const d = new Float64Array(nx * ny).fill(Infinity);
    const start = this.nearestFree(target, limit);
    d[start] = 0;
    // Binary heap of [distance, node], stored flat.
    const heapD: number[] = [0];
    const heapN: number[] = [start];
    const push = (dv: number, nv: number): void => {
      let c = heapD.length;
      heapD.push(dv);
      heapN.push(nv);
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heapD[p] <= dv) break;
        heapD[c] = heapD[p];
        heapN[c] = heapN[p];
        c = p;
      }
      heapD[c] = dv;
      heapN[c] = nv;
    };
    const pop = (): [number, number] => {
      const topD = heapD[0];
      const topN = heapN[0];
      const lastD = heapD.pop() as number;
      const lastN = heapN.pop() as number;
      const n = heapD.length;
      if (n > 0) {
        let c = 0;
        for (;;) {
          let k = 2 * c + 1;
          if (k >= n) break;
          if (k + 1 < n && heapD[k + 1] < heapD[k]) k++;
          if (heapD[k] >= lastD) break;
          heapD[c] = heapD[k];
          heapN[c] = heapN[k];
          c = k;
        }
        heapD[c] = lastD;
        heapN[c] = lastN;
      }
      return [topD, topN];
    };
    while (heapD.length > 0) {
      const [dv, nv] = pop();
      if (dv > d[nv]) continue;
      const i = nv % nx;
      const j = Math.floor(nv / nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const m = b * nx + a;
          if (heights[m] > limit) continue;
          const nd = dv + (di !== 0 && dj !== 0 ? 1.4142 : 1) * CELL_M;
          if (nd < d[m]) {
            d[m] = nd;
            push(nd, m);
          }
        }
      }
    }
    this.fields.set(key, d);
    return d;
  }

  /** Next node downhill in the distance field, or -1 at the target or when cut off. */
  downhill(field: Float64Array, node: number): number {
    const i = node % this.nx;
    const j = Math.floor(node / this.nx);
    let best = -1;
    let bestD = field[node];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= this.nx || b >= this.ny) continue;
        const m = b * this.nx + a;
        if (field[m] < bestD) {
          bestD = field[m];
          best = m;
        }
      }
    }
    return best;
  }
}

export interface BotProfile {
  id: string;
  name: string;
  color: string;
  /** Degrees added to the best upwind and downwind angles: a worse sailor is further off. */
  angleError: number;
  /** How far past the straight line the bot sails before tacking, 0 to 1. */
  layline: number;
}

interface BotMemory {
  side: number;
  lastTackT: number;
}

function clearOfBanks(w: World, from: Vec, to: Vec, t: number): boolean {
  const tide = Math.min(tideAt(w.tide, t), tideAt(w.tide, t + 900)) - SAFETY_M;
  const n = Math.max(1, Math.ceil(dist(from, to) / CLEAR_SAMPLE_M));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    const x = from.x + (to.x - from.x) * f;
    const y = from.y + (to.y - from.y) * f;
    if (isBlocked(w.seabed, x, y, tide, w.polar.draftM)) return false;
  }
  return true;
}

/** Sailable heading closest to the wanted one with open water right ahead, for a boat in tight spot. */
function escapeHeading(w: World, s: BoatState, wanted: number): number | null {
  const wind = sampleWind(w.wind, s.x, s.y, s.t);
  const tide = tideAt(w.tide, s.t + STEP_S);
  let best: number | null = null;
  let bestScore = Infinity;
  for (let a = 0; a < 360; a += 5) {
    if (Math.abs(norm180(a - wind.twd)) < NO_GO_DEG + 8) continue;
    const score = Math.abs(norm180(a - wanted));
    if (score >= bestScore) continue;
    const d = headingVec(a);
    let open = true;
    for (let m = 10; open && m <= ESCAPE_CHECK_M; m += 10) {
      open = !isBlocked(w.seabed, s.x + d.x * m, s.y + d.y * m, tide, w.polar.draftM);
    }
    if (open) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}

/** Point to steer for at this stage of the race, on the valid side of the next gate. */
function stageTarget(w: World, s: BoatState): Vec {
  const gate: Gate | undefined = w.course.gates[s.nextMark];
  if (!gate) {
    // Aim past the finish line, so the boat crosses it instead of circling its middle.
    const { finishA: a, finishB: b } = w.course;
    const mid = nextTarget(w.course, s.nextMark);
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const len = Math.hypot(nx, ny);
    const towards = (mid.x - s.x) * nx + (mid.y - s.y) * ny >= 0 ? 1 : -1;
    return { x: mid.x + (towards * nx * 250) / len, y: mid.y + (towards * ny * 250) / len };
  }
  const side = headingVec(bearing(gate.buoy, gate.end));
  const along = headingVec(gate.travelDeg);
  const off = (a: number, b: number): Vec => ({
    x: gate.buoy.x + side.x * a + along.x * b,
    y: gate.buoy.y + side.y * a + along.y * b,
  });
  const after = off(180, 220);
  // Go straight through the gate once that line crosses it, otherwise line up behind it first.
  return gateCrossing(gate, s, after) !== null ? after : off(180, -300);
}

function steerPoint(w: World, r: Router, s: BoatState): Vec {
  const target = stageTarget(w, s);
  if (clearOfBanks(w, s, target, s.t)) return target;
  const tide = Math.min(tideAt(w.tide, s.t), tideAt(w.tide, s.t + 900));
  const field = r.field(target, tide, w.polar.draftM);
  let node = r.nodeIndex(s);
  if (!Number.isFinite(field[node])) return target;
  let best: Vec | null = null;
  for (let hop = 0; hop < LOOKAHEAD_HOPS; hop++) {
    const next = r.downhill(field, node);
    if (next < 0) break;
    node = next;
    const p = r.nodePos(node % r.nx, Math.floor(node / r.nx));
    if (hop % 2 === 1 || best === null) {
      if (best !== null && !clearOfBanks(w, s, p, s.t)) break;
      best = p;
    }
  }
  return best ?? target;
}

function decide(w: World, r: Router, s: BoatState, mem: BotMemory, p: BotProfile): number {
  const wind = sampleWind(w.wind, s.x, s.y, s.t);
  const b = bearing(s, steerPoint(w, r, s));
  const rel = norm180(b - wind.twd);
  const abs = Math.abs(rel);
  const vmg = bestVmgAngles(w.polar, wind.tws);
  const up = vmg.upwind + p.angleError;
  const down = vmg.downwind - p.angleError;
  const cooled = s.t - mem.lastTackT > 40;
  const flip = (): void => {
    mem.side = -mem.side;
    mem.lastTackT = s.t;
  };

  let heading: number;
  const onTacks = abs < up || abs > down;
  if (abs < up) {
    if (cooled && mem.side * rel < -up * p.layline) flip();
    heading = wind.twd + mem.side * up;
  } else if (abs > down) {
    if (cooled && mem.side * rel < 0 && 180 - abs > (180 - down) * p.layline) flip();
    heading = wind.twd + mem.side * down;
  } else {
    heading = b;
    mem.side = rel >= 0 ? 1 : -1;
  }

  const ahead = (h: number): Vec => {
    const d = headingVec(h);
    return { x: s.x + d.x * 240, y: s.y + d.y * 240 };
  };
  if (!clearOfBanks(w, s, ahead(heading), s.t)) {
    if (onTacks) {
      const other = wind.twd - mem.side * (abs < up ? up : down);
      if (clearOfBanks(w, s, ahead(other), s.t)) {
        flip();
        return norm360(other);
      }
    }
    // Pick the free, sailable heading closest to where the bot wants to go.
    let bestH = heading;
    let bestScore = Infinity;
    for (let a = 0; a < 360; a += 10) {
      if (Math.abs(norm180(a - wind.twd)) < NO_GO_DEG + 8) continue;
      if (!clearOfBanks(w, s, ahead(a), s.t)) continue;
      const score = Math.abs(norm180(a - b));
      if (score < bestScore) {
        bestScore = score;
        bestH = a;
      }
    }
    if (bestScore === Infinity) bestH = escapeHeading(w, s, b) ?? heading;
    mem.side = norm180(bestH - wind.twd) >= 0 ? 1 : -1;
    return norm360(bestH);
  }
  return norm360(heading);
}

export interface HelmAdvice {
  /** Bearing of the next point to reach by water, which goes around the banks. */
  routeBearing: number;
  /** Fastest heading that makes way along that bearing and is clear of banks just ahead. */
  heading: number;
  /** Speed made good along the route on that heading, in knots. */
  vmgKn: number;
}

/** Sailing advice for a boat: the same reasoning the bots use, offered to human players. */
export function adviseHelm(w: World, r: Router, s: BoatState): HelmAdvice {
  const wind = sampleWind(w.wind, s.x, s.y, s.t);
  const routeBearing = bearing(s, steerPoint(w, r, s));
  const vmgOf = (h: number): number =>
    boatSpeed(w.polar, Math.abs(norm180(h - wind.twd)), wind.tws) * Math.cos(((h - routeBearing) * Math.PI) / 180);
  const isClear = (h: number): boolean => {
    const d = headingVec(h);
    return clearOfBanks(w, s, { x: s.x + d.x * 300, y: s.y + d.y * 300 }, s.t);
  };
  // Best clear heading on each side of the wind, or the best blocked one when nothing is clear.
  const best = { [1]: { heading: s.heading, vmgKn: -Infinity }, [-1]: { heading: s.heading, vmgKn: -Infinity } };
  for (let a = 0; a < 360; a++) {
    const v = vmgOf(a);
    const side = norm180(a - wind.twd) >= 0 ? 1 : -1;
    if (v > best[side].vmgKn && isClear(a)) best[side] = { heading: a, vmgKn: v };
  }
  const same = best[s.side === 1 ? 1 : -1];
  const other = best[s.side === 1 ? -1 : 1];
  // Stays on the current tack until the other one is clearly better: a tack costs time.
  const keep = same.vmgKn > 0 && same.vmgKn >= other.vmgKn * KEEP_TACK_RATIO;
  const chosen = keep || same.vmgKn >= other.vmgKn ? same : other;
  if (chosen.vmgKn === -Infinity) {
    // Banks all around: any way out, even if it does not help for now.
    const heading = escapeHeading(w, s, routeBearing) ?? s.heading;
    return { routeBearing, heading, vmgKn: vmgOf(heading) };
  }
  return { routeBearing, ...chosen };
}

export interface BotTrack {
  profile: BotProfile;
  /** One entry per simulation step: x, y, heading, speed. */
  samples: Float32Array;
  t0: number;
  final: BoatState;
}

/** Sails a full race for a bot. Deterministic, and uses the same step as a human boat. */
export function runBot(w: World, r: Router, profile: BotProfile, start: Vec, t0: number, tEnd: number): BotTrack {
  const n = Math.ceil((tEnd - t0) / STEP_S) + 1;
  const samples = new Float32Array(n * 4);
  let s = initialState(start, t0, bearing(start, nextTarget(w.course, 0)), w);
  const mem: BotMemory = { side: s.side, lastTackT: -1e12 };
  let order: Order = { t: t0, mode: "heading", value: s.heading };
  let idx = 0;
  const record = (): void => {
    samples[idx * 4] = s.x;
    samples[idx * 4 + 1] = s.y;
    samples[idx * 4 + 2] = s.heading;
    samples[idx * 4 + 3] = s.speedKn;
    idx++;
  };
  record();
  while (idx < n && s.status !== "finished") {
    if ((s.t - t0) % DECISION_S === 0 || s.status === "grounded") {
      order = { t: s.t + 1, mode: "heading", value: decide(w, r, s, mem, profile) };
    }
    s = step(w, s, order);
    record();
  }
  const last = (idx - 1) * 4;
  while (idx < n) {
    samples[idx * 4] = samples[last];
    samples[idx * 4 + 1] = samples[last + 1];
    samples[idx * 4 + 2] = samples[last + 2];
    idx++;
  }
  return { profile, samples, t0, final: s };
}

/** State of a bot at time t, interpolated for smooth display. */
export function botPoseAt(b: BotTrack, t: number): { x: number; y: number; heading: number; speedKn: number } {
  const f = Math.max(0, (t - b.t0) / STEP_S);
  const n = b.samples.length / 4;
  const i = Math.min(n - 2, Math.floor(f));
  const u = Math.min(1, f - i);
  const o = i * 4;
  const dh = norm180(b.samples[o + 6] - b.samples[o + 2]);
  return {
    x: b.samples[o] + (b.samples[o + 4] - b.samples[o]) * u,
    y: b.samples[o + 1] + (b.samples[o + 5] - b.samples[o + 1]) * u,
    heading: norm360(b.samples[o + 2] + dh * u),
    speedKn: b.samples[o + 3],
  };
}

export const BOT_PROFILES: BotProfile[] = [
  { id: "gaston", name: "Gaston l'ostréiculteur", color: "#c9553d", angleError: 0, layline: 0.9 },
  { id: "maite", name: "Maïté du Moulleau", color: "#7a5cc4", angleError: 1, layline: 0.6 },
  { id: "jeannot", name: "Jeannot la Pinasse", color: "#d99a2b", angleError: 4, layline: 0.8 },
  { id: "lulu", name: "Lulu de l'Herbe", color: "#2c8c7c", angleError: 2, layline: 0.4 },
  { id: "dede", name: "Dédé des Tchanquées", color: "#b8467e", angleError: 7, layline: 0.3 },
];
