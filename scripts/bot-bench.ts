// Sails every course with a bot on the fixture and prints the time taken.
import { readFileSync } from "node:fs";
import * as sim from "../packages/sim/src/index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), "utf8"));
const seabed = sim.createSeabed(read("bathy.json"), read("coastline.geojson"));
const polar = read("boats/catamaran.json");
const snap = read("fixtures/snapshot.json");
const wind = sim.createWindField(snap.wind);
let t = performance.now();
const router = new sim.Router(seabed);
console.log("router", router.nx, router.ny, Math.round(performance.now() - t), "ms");
for (const d of read("courses.json").slice(0, Number(process.env.N ?? 99))) {
  const course = sim.buildCourse(d);
  const w = { polar, wind, tide: snap.tide, seabed, course };
  t = performance.now();
  const r = sim.runBot(w, router, sim.BOT_PROFILES[0], sim.startPosition(course, 0.5), snap.startT, snap.closeT);
  const f = r.final;
  console.log(d.id, sim.courseLengthNm(course).toFixed(1) + " NM", f.status, "mark", f.nextMark,
    f.finishT ? ((f.finishT - snap.startT) / 3600).toFixed(2) + " h" : "DNF", Math.round(performance.now() - t) + " ms");
}
