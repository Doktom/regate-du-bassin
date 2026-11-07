// Publishes the race of the day, the same for every player.
// A published day is never rewritten: challenge links replay it later.
// Usage: node scripts/publish-daily.ts <folder> [YYYY-MM-DD]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDailyRace,
  type CourseDef,
  createSeabed,
  fetchRaceSnapshot,
  parisDate,
  parseDailyRace,
  type Polar,
  shiftDate,
} from "../packages/sim/src/index.ts";

const folder = process.argv[2];
if (!folder) throw new Error("Usage: node scripts/publish-daily.ts <folder> [YYYY-MM-DD]");
const date = process.argv[3] ?? parisDate();
const path = join(folder, `${date}.json`);

if (existsSync(path)) {
  console.log(`${date}: already published`);
} else {
  const data = (name: string): string => readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8");
  const seabed = createSeabed(JSON.parse(data("bathy.json")), JSON.parse(data("coastline.geojson")));
  const polar = JSON.parse(data("boats/catamaran.json")) as Polar;
  const courses = JSON.parse(data("courses.json")) as CourseDef[];

  const yesterday = join(folder, `${shiftDate(date, -1)}.json`);
  const previousId = existsSync(yesterday)
    ? (parseDailyRace(JSON.parse(readFileSync(yesterday, "utf8")), shiftDate(date, -1))?.courseId ?? null)
    : null;

  const snapshot = await fetchRaceSnapshot(date, (url) => fetch(url));
  const race = buildDailyRace(snapshot, courses, seabed, polar.draftM, previousId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path, JSON.stringify(race));
  console.log(`${date}: ${race.courseId}, ${snapshot.source}`);
}
