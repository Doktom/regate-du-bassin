import {
  adviseHelm,
  type BoatState,
  botPoseAt,
  BOT_PROFILES,
  type BotTrack,
  buildCourse,
  type CourseDef,
  createWindField,
  initialState,
  norm180,
  type Order,
  type RaceSnapshot,
  remainingDistance,
  runBot,
  startPosition,
  step,
  STEP_S,
  type World,
} from "@regate/sim";
import { polar, read, router, seabed, write } from "./assets.ts";

export interface SavedRace {
  date: string;
  courseId: string;
  orders: Order[];
  simT: number;
  wallAt: number;
  scale: number;
}

export interface RankRow {
  id: string;
  name: string;
  color: string;
  isPlayer: boolean;
  finishT: number | null;
  remainingM: number;
}

export interface HistoryEntry {
  date: string;
  course: string;
  rank: number;
  total: number;
  finishS: number | null;
  remainingM: number;
}

export type RaceEvent =
  | { kind: "mark"; name: string }
  | { kind: "grounded"; byTide: boolean }
  | { kind: "afloat" }
  | { kind: "finished" }
  | { kind: "closed" };

const raceKey = "regate.race";
const historyKey = "regate.history";
export const PLAYER_COLOR = "#e8674f";

export function loadSavedRace(date: string): SavedRace | null {
  const s = read<SavedRace>(raceKey);
  return s && s.date === date ? s : null;
}

export function loadHistory(): HistoryEntry[] {
  return read<HistoryEntry[]>(historyKey) ?? [];
}

export class Session {
  readonly world: World;
  readonly bots: BotTrack[];
  readonly snapshot: RaceSnapshot;
  readonly startT: number;
  readonly closeT: number;
  player: BoatState;
  previous: BoatState;
  orders: Order[] = [];
  simT: number;
  scale: number;
  /** Player track as x, y pairs, one point every 30 simulated seconds. */
  trail: number[] = [];
  over = false;
  private wallAt: number;
  private current: Order;
  private orderIndex = 0;
  private lastSave = 0;
  private recorded = false;

  constructor(snapshot: RaceSnapshot, def: CourseDef, scale: number, saved: SavedRace | null) {
    this.snapshot = snapshot;
    this.startT = snapshot.startT;
    this.closeT = snapshot.closeT;
    const course = buildCourse(def);
    const wind = createWindField(snapshot.wind);
    this.world = { polar, wind, tide: snapshot.tide, seabed, course };
    this.bots = BOT_PROFILES.map((p, i) =>
      runBot(this.world, router, p, startPosition(course, (i + 0.5) / BOT_PROFILES.length), this.startT, this.closeT),
    );
    const pos = startPosition(course, 0.5);
    const atStart = initialState(pos, this.startT, 0, this.world);
    this.player = initialState(pos, this.startT, adviseHelm(this.world, router, atStart).heading, this.world);
    this.previous = this.player;
    this.current = { t: this.startT, mode: "heading", value: this.player.heading };
    this.simT = this.startT;
    this.scale = scale;
    this.wallAt = Date.now();
    if (saved) {
      this.orders = saved.orders;
      this.scale = saved.scale;
      // The boat kept sailing while the app was closed.
      const elapsed = ((Date.now() - saved.wallAt) / 1000) * saved.scale;
      this.simT = Math.min(this.closeT, saved.simT + Math.max(0, elapsed));
      this.catchUp();
    }
    this.save();
  }

  private catchUp(): RaceEvent[] {
    const events: RaceEvent[] = [];
    while (this.player.t + STEP_S <= this.simT) {
      while (this.orderIndex < this.orders.length && this.orders[this.orderIndex].t <= this.player.t) {
        this.current = this.orders[this.orderIndex++];
      }
      const before = this.player;
      this.previous = before;
      this.player = step(this.world, before, this.current);
      if (this.player.nextMark > before.nextMark) {
        events.push({ kind: "mark", name: this.world.course.gates[this.player.nextMark - 1].name });
      }
      if (this.player.status === "grounded" && before.status !== "grounded") {
        events.push({ kind: "grounded", byTide: this.player.groundedByTide });
      }
      if (this.player.status === "sailing" && before.status === "grounded") events.push({ kind: "afloat" });
      if (this.player.status === "finished" && before.status !== "finished") events.push({ kind: "finished" });
      if ((this.player.t - this.startT) % 30 === 0) this.trail.push(this.player.x, this.player.y);
    }
    return events;
  }

  /** Moves the race clock to the wall clock, and returns what happened meanwhile. */
  advance(): RaceEvent[] {
    const now = Date.now();
    this.simT = Math.min(this.closeT, this.simT + ((now - this.wallAt) / 1000) * this.scale);
    this.wallAt = now;
    const events = this.catchUp();
    if (!this.over && (this.player.status === "finished" || this.simT >= this.closeT)) {
      this.over = true;
      if (this.player.status !== "finished") events.push({ kind: "closed" });
      this.recordResult();
    }
    if (now - this.lastSave > 4000) this.save();
    return events;
  }

  /** Keeps the race clock still, for as long as this is called. */
  hold(): void {
    this.wallAt = Date.now();
  }

  setScale(scale: number): void {
    this.advance();
    this.scale = scale;
    this.save();
  }

  sendOrder(mode: Order["mode"], value: number): void {
    this.orders.push({ t: this.simT, mode, value });
    this.save();
  }

  /** Order currently steering the boat, including one waiting for the next step. */
  activeOrder(): Order {
    return this.orders.length > 0 ? this.orders[this.orders.length - 1] : this.current;
  }

  save(): void {
    this.lastSave = Date.now();
    const s: SavedRace = {
      date: this.snapshot.date,
      courseId: this.world.course.def.id,
      orders: this.orders,
      simT: this.simT,
      wallAt: Date.now(),
      scale: this.scale,
    };
    write(raceKey, s);
  }

  /** Display position, one step behind the race clock so motion can be interpolated. */
  playerPose(): { x: number; y: number; heading: number } {
    const a = this.previous;
    const b = this.player;
    const f = Math.min(1, Math.max(0, (this.simT - b.t) / STEP_S));
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      heading: a.heading + norm180(b.heading - a.heading) * f,
    };
  }

  botPose(b: BotTrack): { x: number; y: number; heading: number; speedKn: number } {
    return botPoseAt(b, this.simT - STEP_S);
  }

  /** Arrivals first by time, then the others by distance left. */
  ranking(atT = this.simT): RankRow[] {
    const c = this.world.course;
    const rows: RankRow[] = this.bots.map((b) => {
      const done = b.final.finishT !== null && b.final.finishT <= atT;
      const pose = botPoseAt(b, atT);
      const nextMark = b.final.markTimes.filter((t) => t <= atT).length;
      return {
        id: b.profile.id,
        name: b.profile.name,
        color: b.profile.color,
        isPlayer: false,
        finishT: done ? b.final.finishT : null,
        remainingM: done ? 0 : remainingDistance(c, pose, nextMark),
      };
    });
    const p = this.player;
    rows.push({
      id: "player",
      name: "Vous",
      color: PLAYER_COLOR,
      isPlayer: true,
      finishT: p.finishT,
      remainingM: p.status === "finished" ? 0 : remainingDistance(c, p, p.nextMark),
    });
    return rows.sort((a, b) => {
      if (a.finishT !== null && b.finishT !== null) return a.finishT - b.finishT;
      if (a.finishT !== null) return -1;
      if (b.finishT !== null) return 1;
      return a.remainingM - b.remainingM;
    });
  }

  /** Final ranking: the bots' whole race is already known, so they can be read at closing time. */
  finalRanking(): RankRow[] {
    return this.ranking(this.closeT);
  }

  private recordResult(): void {
    if (this.recorded) return;
    this.recorded = true;
    const rows = this.finalRanking();
    const rank = rows.findIndex((r) => r.isPlayer) + 1;
    const me = rows[rank - 1];
    const history = loadHistory().filter((h) => h.date !== this.snapshot.date);
    history.unshift({
      date: this.snapshot.date,
      course: this.world.course.def.name,
      rank,
      total: rows.length,
      finishS: me.finishT === null ? null : me.finishT - this.startT,
      remainingM: me.remainingM,
    });
    write(historyKey, history.slice(0, 30));
  }
}
