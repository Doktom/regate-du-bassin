// Traces a boat that only follows the helm advice. Usage: node scripts/advice-trace.ts <course id>
import { readFileSync } from "node:fs";
import * as sim from "../packages/sim/src/index.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), "utf8"));
const seabed = sim.createSeabed(read("bathy.json"), read("coastline.geojson"));
const polar = read("boats/catamaran.json");
const snap = read("fixtures/snapshot.json");
const wind = sim.createWindField(snap.wind);
const router = new sim.Router(seabed);
const def = read("courses.json").find((c: { id: string }) => c.id === process.argv[2]);
const course = sim.buildCourse(def);
const w = { polar, wind, tide: snap.tide, seabed, course };
const pos = sim.startPosition(course, 0.5);
let s = sim.initialState(pos, snap.startT, sim.adviseHelm(w, router, sim.initialState(pos, snap.startT, 0, w)).heading, w);
let order: sim.Order = { t: s.t, mode: "heading", value: s.heading };
while (s.status !== "finished" && s.t < snap.closeT) {
  if ((s.t - snap.startT) % 60 === 0 || s.status === "grounded") {
    order = { t: s.t + 1, mode: "heading", value: sim.adviseHelm(w, router, s).heading };
  }
  s = sim.step(w, s, order);
  if ((s.t - snap.startT) % 900 === 0) {
    const a = sim.adviseHelm(w, router, s);
    const wi = sim.sampleWind(wind, s.x, s.y, s.t);
    console.log(((s.t - snap.startT) / 3600).toFixed(2), s.status, "mark", s.nextMark, "pos", sim.latOf(s.y).toFixed(4), sim.lonOf(s.x).toFixed(4),
      "hdg", Math.round(s.heading), "spd", s.speedKn.toFixed(1), "tws", wi.tws.toFixed(1), "twd", Math.round(wi.twd), "route", Math.round(a.routeBearing), "vmg", a.vmgKn.toFixed(1));
  }
}
console.log(s.status, s.finishT ? ((s.finishT - snap.startT) / 3600).toFixed(2) : "");
