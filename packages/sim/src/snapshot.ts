import { buildCourse, type CourseDef, type RaceCourse } from "./course.ts";
import { bearing, norm180, type Vec } from "./geo.ts";
import { seabedHeight, type Seabed } from "./seabed.ts";
import { calibrateOpenMeteoTide, tideAt, type TideSeries } from "./tide.ts";
import { sampleWind, type WindField, type WindSnapshot } from "./wind.ts";

/** Everything frozen for one race day. This data is the only game truth. */
export interface RaceSnapshot {
  date: string;
  source: string;
  startT: number;
  closeT: number;
  wind: WindSnapshot;
  tide: TideSeries;
}

const LATS = Array.from({ length: 11 }, (_, i) => Math.round((44.58 + i * 0.02) * 100) / 100);
const LONS = Array.from({ length: 16 }, (_, i) => Math.round((-1.3 + i * 0.02) * 100) / 100);
const CHUNK = 60;
const MODELS = ["meteofrance_arome_france_hd", "meteofrance_arome_france"];
const TIDE_POINT = { lat: 44.63, lon: -1.25 };

/** Epoch seconds of a wall-clock time in Paris, across daylight saving changes. */
export function parisTime(date: string, hour: number): number {
  const naive = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`) / 1000;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(naive * 1000));
  const shownHour = Number(parts.find((p) => p.type === "hour")?.value);
  let offsetH = shownHour - hour;
  if (offsetH < -12) offsetH += 24;
  if (offsetH > 12) offsetH -= 24;
  return naive - offsetH * 3600;
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface HourlyResponse {
  hourly: {
    time: string[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
    sea_level_height_msl: (number | null)[];
  };
}

const toEpoch = (iso: string): number => Date.parse(`${iso}:00Z`) / 1000;

async function fetchWindModel(date: string, model: string, fetcher: Fetcher): Promise<WindSnapshot> {
  const points: { lat: number; lon: number }[] = [];
  for (const lat of LATS) for (const lon of LONS) points.push({ lat, lon });
  const responses: HourlyResponse[] = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const part = points.slice(i, i + CHUNK);
    const url =
      "https://api.open-meteo.com/v1/meteofrance" +
      `?latitude=${part.map((p) => p.lat).join(",")}` +
      `&longitude=${part.map((p) => p.lon).join(",")}` +
      "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn" +
      `&models=${model}&timezone=UTC&start_date=${date}&end_date=${date}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`Open-Meteo wind: ${model}`);
    responses.push(...((await res.json()) as HourlyResponse[]));
  }
  const allTimes = responses[0].hourly.time;
  const keep = allTimes.map((_, k) => k).filter((k) => k >= 5 && k <= 21);
  const speedKn: number[] = [];
  const dirDeg: number[] = [];
  const gustKn: number[] = [];
  for (const k of keep) {
    for (const r of responses) {
      const sp = r.hourly.wind_speed_10m[k];
      const dir = r.hourly.wind_direction_10m[k];
      if (sp === null || dir === null) throw new Error(`Open-Meteo wind incomplete: ${model}`);
      speedKn.push(sp);
      dirDeg.push(dir);
      gustKn.push(r.hourly.wind_gusts_10m[k] ?? sp);
    }
  }
  return { lats: LATS, lons: LONS, times: keep.map((k) => toEpoch(allTimes[k])), speedKn, dirDeg, gustKn };
}

export async function fetchRaceSnapshot(
  date: string,
  fetcher: Fetcher,
  startHour = 10,
  closeHour = 18,
): Promise<RaceSnapshot> {
  let wind: WindSnapshot | null = null;
  let usedModel = "";
  for (const model of MODELS) {
    try {
      wind = await fetchWindModel(date, model, fetcher);
      usedModel = model;
      break;
    } catch {
      // Falls through to the coarser model.
    }
  }
  if (!wind) throw new Error("Open-Meteo wind unavailable");

  const tideUrl =
    "https://marine-api.open-meteo.com/v1/marine" +
    `?latitude=${TIDE_POINT.lat}&longitude=${TIDE_POINT.lon}` +
    `&hourly=sea_level_height_msl&timezone=UTC&start_date=${shiftDate(date, -1)}&end_date=${shiftDate(date, 1)}`;
  const tideRes = await fetcher(tideUrl);
  if (!tideRes.ok) throw new Error("Open-Meteo tide unavailable");
  const tideJson = (await tideRes.json()) as HourlyResponse;
  const raw = tideJson.hourly.sea_level_height_msl;
  if (raw.some((h) => h === null)) throw new Error("Open-Meteo tide incomplete");

  return {
    date,
    source: usedModel,
    startT: parisTime(date, startHour),
    closeT: parisTime(date, closeHour),
    wind,
    tide: calibrateOpenMeteoTide(tideJson.hourly.time.map(toEpoch), raw as number[]),
  };
}

export interface ChosenCourse {
  course: RaceCourse;
  /** Angle between the first leg and the wind, in degrees. Smaller means closer to a beat. */
  firstLegToWind: number;
}

/**
 * Course of the day: keeps those whose marks are afloat at some point of the race,
 * then takes the first leg closest to dead upwind, without repeating yesterday's.
 */
export function chooseCourse(
  defs: CourseDef[],
  wind: WindField,
  tide: TideSeries,
  seabed: Seabed,
  startT: number,
  closeT: number,
  draftM: number,
  previousId: string | null,
): ChosenCourse {
  let maxTide = -Infinity;
  for (let t = startT; t <= closeT; t += 600) maxTide = Math.max(maxTide, tideAt(tide, t));
  const usable = defs
    .map((d) => buildCourse(d))
    .filter((c) => c.gates.every((g) => maxTide >= seabedHeight(seabed, g.buoy.x, g.buoy.y) + draftM));
  const pool = usable.filter((c) => c.def.id !== previousId);
  const candidates = pool.length > 0 ? pool : usable.length > 0 ? usable : defs.map((d) => buildCourse(d));
  let best: ChosenCourse | null = null;
  for (const course of candidates) {
    const from: Vec = {
      x: (course.startA.x + course.startB.x) / 2,
      y: (course.startA.y + course.startB.y) / 2,
    };
    const w = sampleWind(wind, from.x, from.y, startT);
    const angle = Math.abs(norm180(bearing(from, course.gates[0].buoy) - w.twd));
    if (best === null || angle < best.firstLegToWind) best = { course, firstLegToWind: angle };
  }
  return best as ChosenCourse;
}

