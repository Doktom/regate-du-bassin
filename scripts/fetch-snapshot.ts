// Saves a real weather and tide snapshot as the test and offline fixture.
// Usage: node scripts/fetch-snapshot.ts [YYYY-MM-DD]
import { writeFileSync } from "node:fs";
import { fetchRaceSnapshot } from "../packages/sim/src/snapshot.ts";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const snapshot = await fetchRaceSnapshot(date, (url) => fetch(url));
const path = new URL("../data/fixtures/snapshot.json", import.meta.url);
writeFileSync(path, JSON.stringify(snapshot));
console.log(`${date}: ${snapshot.source}, ${snapshot.wind.times.length} hours, ${snapshot.tide.times.length} tide values`);
