import { adviseHelm, type BotTrack, type Router } from "./bot.ts";
import type { Vec } from "./geo.ts";
import { type BoatState, initialState, type Order, simulate, STEP_S, type World } from "./sim.ts";

/**
 * A finished race that fits in a link. Replaying the orders on the same published day
 * rebuilds the whole race, so nothing has to be stored on a server.
 */
export interface Challenge {
  date: string;
  courseId: string;
  name: string;
  /** Race time announced by the sender, in seconds, or null if the boat did not finish. */
  finishS: number | null;
  orders: ChallengeOrder[];
}

export interface ChallengeOrder {
  /** Simulation step from the start at which the order first applies. */
  step: number;
  mode: Order["mode"];
  value: number;
}

export const MAX_CHALLENGE_ORDERS = 3000;
export const MAX_NAME_LENGTH = 20;
export const DEFAULT_CHALLENGER_NAME = "Un ami";
const MAX_STEP = 8640;
const MAX_CODE_LENGTH = 40000;
const CODE = /^1_(\d{4}-\d{2}-\d{2})_([a-z0-9-]{1,40})_(-|[0-9a-z]{1,8})_([0-9a-z.]*)_((?:[0-9a-f]{2})*)$/;

/** Order values are kept to a tenth of a degree, so a link replays the race exactly. */
export function roundOrderValue(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Removes control and text-direction characters, which could disguise a name. */
export function cleanName(raw: string): string {
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...clean].slice(0, MAX_NAME_LENGTH).join("").trim();
}

/**
 * Orders as the simulation applies them: an order takes effect at the first step at or after
 * its time, and it is compared with a grounding time that is always a whole step. Rounding up
 * to the step therefore leaves the race unchanged.
 */
export function toChallengeOrders(orders: Order[], startT: number): ChallengeOrder[] {
  return orders.map((o) => ({
    step: Math.max(0, Math.ceil((o.t - startT) / STEP_S)),
    mode: o.mode,
    value: roundOrderValue(o.value),
  }));
}

export function fromChallengeOrders(orders: ChallengeOrder[], startT: number): Order[] {
  return orders.map((o) => ({ t: startT + o.step * STEP_S, mode: o.mode, value: o.value }));
}

export function encodeChallenge(c: Challenge): string {
  const numbers: string[] = [];
  let previous = 0;
  for (const o of c.orders) {
    const tenths = Math.round(o.value * 10);
    const zigzag = tenths >= 0 ? tenths * 2 : -tenths * 2 - 1;
    numbers.push((o.step - previous).toString(36), (zigzag * 2 + (o.mode === "twa" ? 1 : 0)).toString(36));
    previous = o.step;
  }
  const finish = c.finishS === null ? "-" : Math.round(c.finishS * 10).toString(36);
  const name = [...new TextEncoder().encode(cleanName(c.name) || DEFAULT_CHALLENGER_NAME)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `1_${c.date}_${c.courseId}_${finish}_${numbers.join(".")}_${name}`;
}

/** Reads a link. Its content comes from someone else: anything unexpected gives null. */
export function decodeChallenge(code: string): Challenge | null {
  if (code.length > MAX_CODE_LENGTH) return null;
  const m = CODE.exec(code);
  if (!m) return null;
  const [, date, courseId, finish, list, hex] = m;
  if (Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return null;

  const numbers = list === "" ? [] : list.split(".");
  if (numbers.length % 2 !== 0 || numbers.length > MAX_CHALLENGE_ORDERS * 2) return null;
  const orders: ChallengeOrder[] = [];
  let step = 0;
  for (let i = 0; i < numbers.length; i += 2) {
    if (numbers[i] === "" || numbers[i + 1] === "") return null;
    step += parseInt(numbers[i], 36);
    const packed = parseInt(numbers[i + 1], 36);
    if (!Number.isSafeInteger(step) || !Number.isSafeInteger(packed) || step > MAX_STEP) return null;
    const mode: Order["mode"] = packed % 2 === 1 ? "twa" : "heading";
    const zigzag = Math.floor(packed / 2);
    const value = (zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2) / 10;
    if (mode === "heading" ? value < 0 || value > 360 : Math.abs(value) > 180) return null;
    orders.push({ step, mode, value });
  }

  let name: string;
  try {
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return {
    date,
    courseId,
    name: cleanName(name) || DEFAULT_CHALLENGER_NAME,
    finishS: finish === "-" ? null : parseInt(finish, 36) / 10,
    orders,
  };
}

/** Starting state shared by every human boat, so a replay starts from the same place. */
export function playerStartState(w: World, r: Router, pos: Vec, t: number): BoatState {
  const probe = initialState(pos, t, 0, w);
  return initialState(pos, t, adviseHelm(w, r, probe).heading, w);
}

/** Replays a race as a track that can be displayed and ranked like a bot's. */
export function replayTrack(
  w: World,
  start: BoatState,
  orders: Order[],
  tEnd: number,
  profile: BotTrack["profile"],
): BotTrack {
  const n = Math.ceil((tEnd - start.t) / STEP_S) + 1;
  const samples = new Float32Array(n * 4);
  let idx = 0;
  const record = (s: BoatState): void => {
    if (idx >= n) return;
    samples[idx * 4] = s.x;
    samples[idx * 4 + 1] = s.y;
    samples[idx * 4 + 2] = s.heading;
    samples[idx * 4 + 3] = s.speedKn;
    idx++;
  };
  record(start);
  const final = simulate(w, start, orders, tEnd, record);
  while (idx < n) record(final);
  return { profile, samples, t0: start.t, final };
}
