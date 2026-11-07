import {
  type CourseDef,
  createSeabed,
  fetchRaceSnapshot,
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

export function parisDate(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(ms));
}

export interface LoadedSnapshot {
  snapshot: RaceSnapshot;
  live: boolean;
}

/** Today's data, frozen at first load. Falls back on the recorded day when offline. */
export async function loadSnapshot(): Promise<LoadedSnapshot> {
  const date = parisDate();
  const key = `regate.snapshot.${date}`;
  const saved = read<RaceSnapshot>(key);
  if (saved) return { snapshot: saved, live: true };
  try {
    const snapshot = await fetchRaceSnapshot(date, (url) =>
      fetch(url, { signal: AbortSignal.timeout(12000) }),
    );
    write(key, snapshot);
    return { snapshot, live: true };
  } catch (err) {
    console.warn("Météo du jour indisponible, données enregistrées utilisées", err);
    return { snapshot: fixture as RaceSnapshot, live: false };
  }
}
