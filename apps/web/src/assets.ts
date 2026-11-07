import {
  type CourseDef,
  createSeabed,
  type DailyRace,
  fetchRaceSnapshot,
  parisDate,
  parseDailyRace,
  type Polar,
  type RaceSnapshot,
  Router,
} from "@regate/sim";
import bathy from "../../../data/bathy.json";
import polarJson from "../../../data/boats/catamaran.json";
import coastRaw from "../../../data/coastline.geojson?raw";
import coursesJson from "../../../data/courses.json";
import fixture from "../../../data/fixtures/snapshot.json";

export const polar = polarJson as Polar;
export const courses = coursesJson as CourseDef[];
export const seabed = createSeabed(bathy, JSON.parse(coastRaw));
export const router = new Router(seabed);

export function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

export function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked: the game keeps running without saving.
  }
}

export interface LoadedSnapshot {
  snapshot: RaceSnapshot;
  /** True when every player has this exact data, which challenge links need. */
  shared: boolean;
  /** False when the game fell back on the recorded day. */
  live: boolean;
  /** Course of the day chosen for everyone, when the race is the published one. */
  courseId: string | null;
}

const dailyKey = (date: string): string => `regate.daily.${date}`;
const privateKey = (date: string): string => `regate.snapshot.${date}`;

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be blocked: there is nothing to remove then.
  }
}

/** A published day, from this device if it already has it. Never changes once published. */
export async function loadDaily(date: string): Promise<DailyRace | null> {
  const saved = parseDailyRace(read(dailyKey(date)), date);
  if (saved) return saved;
  try {
    const res = await fetch(`./daily/${date}.json`, { cache: "no-cache", signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const race = parseDailyRace(await res.json(), date);
    if (race) write(dailyKey(date), race);
    return race;
  } catch {
    return null;
  }
}

/**
 * Race of the day. The published one comes first. Before it is out, the device fetches its own
 * weather, and keeps it until the end of a race already started on it. The recorded day comes last.
 */
export async function loadSnapshot(): Promise<LoadedSnapshot> {
  const date = parisDate();
  const key = privateKey(date);
  const own = read<RaceSnapshot>(key);
  const race = read<{ date: string }>("regate.race");
  if (own && race?.date === date) return { snapshot: own, shared: false, live: true, courseId: null };

  const daily = await loadDaily(date);
  if (daily) {
    remove(key);
    return { snapshot: daily.snapshot, shared: true, live: true, courseId: daily.courseId };
  }
  if (own) return { snapshot: own, shared: false, live: true, courseId: null };
  try {
    const snapshot = await fetchRaceSnapshot(date, (url) => fetch(url, { signal: AbortSignal.timeout(12000) }));
    write(key, snapshot);
    return { snapshot, shared: false, live: true, courseId: null };
  } catch (err) {
    console.warn("Météo du jour indisponible, données enregistrées utilisées", err);
    return { snapshot: fixture as RaceSnapshot, shared: false, live: false, courseId: null };
  }
}

/** Forgets this device's own weather, so a new race can use the published one. */
export function forgetPrivateSnapshot(date: string): void {
  remove(privateKey(date));
}

/** Weather files are large: only the days still in use stay on the device. */
export function purgeOldDays(keep: string[]): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      const m = key && /^regate\.(?:daily|snapshot)\.(.+)$/.exec(key);
      if (key && m && !keep.includes(m[1])) localStorage.removeItem(key);
    }
  } catch {
    // Storage can be blocked: there is nothing to clean then.
  }
}
