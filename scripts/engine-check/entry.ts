// Sails every course with the real simulation, to compare the exact end states between browsers.
import bathy from "../../data/bathy.json";
import polar from "../../data/boats/catamaran.json";
import coast from "../../data/coastline.geojson";
import courses from "../../data/courses.json";
import fixture from "../../data/fixtures/snapshot.json";
import {
  adviseHelm,
  buildCourse,
  createSeabed,
  createWindField,
  type Order,
  playerStartState,
  Router,
  roundOrderValue,
  simulate,
  startPosition,
  step,
} from "../../packages/sim/src/index.ts";

const seabed = createSeabed(bathy as never, JSON.parse(coast as unknown as string));
const router = new Router(seabed);
const snapshot = fixture as never as { startT: number; closeT: number; tide: never; wind: never };

(globalThis as Record<string, unknown>).runRaces = () => {
  const out: Record<string, unknown> = {};
  for (const def of courses as never[]) {
    const course = buildCourse(def);
    const w = { polar: polar as never, wind: createWindField(snapshot.wind), tide: snapshot.tide, seabed, course };
    const start = playerStartState(w, router, startPosition(course, 0.5), snapshot.startT);
    const orders: Order[] = [];
    let s = start;
    let current: Order = { t: snapshot.startT, mode: "heading", value: start.heading };
    let k = 0;
    while (s.status !== "finished" && s.t + 10 <= snapshot.closeT) {
      if ((s.t - snapshot.startT) % 300 === 0) {
        orders.push({ t: s.t + 1, mode: "heading", value: roundOrderValue(adviseHelm(w, router, s).heading) });
      }
      while (k < orders.length && orders[k].t <= s.t) current = orders[k++];
      s = step(w, s, current);
    }
    const end = simulate(w, start, orders, s.t);
    out[(def as { id: string }).id] = { x: end.x, y: end.y, finishT: end.finishT, orders: orders.length };
  }
  return JSON.stringify(out);
};
