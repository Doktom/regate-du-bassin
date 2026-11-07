import { describe, expect, it } from "vitest";
import bathy from "../../../data/bathy.json";
import polarJson from "../../../data/boats/catamaran.json";
import coast from "../../../data/coastline.geojson?raw";
import courses from "../../../data/courses.json";
import fixture from "../../../data/fixtures/snapshot.json";
import {
  adviseHelm,
  BOT_PROFILES,
  buildCourse,
  courseLengthNm,
  type CourseDef,
  createSeabed,
  createWindField,
  initialState,
  isLand,
  type Order,
  type Polar,
  Router,
  runBot,
  type RaceSnapshot,
  startPosition,
  step,
  tideAt,
  toXY,
  uniformWind,
  type WindField,
  type World,
  isBlocked,
} from "../src/index.ts";

const seabed = createSeabed(bathy, JSON.parse(coast));
const router = new Router(seabed);
const polar = polarJson as Polar;
const snapshot = fixture as RaceSnapshot;
const defs = courses as CourseDef[];

function race(def: CourseDef, wind: WindField, startT = snapshot.startT) {
  const course = buildCourse(def);
  const w: World = { polar, wind, tide: snapshot.tide, seabed, course };
  return { w, track: runBot(w, router, BOT_PROFILES[0], startPosition(course, 0.5), startT, snapshot.closeT) };
}

describe("real map", () => {
  it("knows land and water at known places", () => {
    const eyracChannel = toXY(44.674, -1.17);
    expect(isLand(seabed, eyracChannel.x, eyracChannel.y)).toBe(false);
    const landes = toXY(44.62, -1.1);
    expect(isLand(seabed, landes.x, landes.y)).toBe(true);
    const ferretPeninsula = toXY(44.68, -1.25);
    expect(isLand(seabed, ferretPeninsula.x, ferretPeninsula.y)).toBe(true);
  });
  it("dries the flats at low water and covers them at high water", () => {
    const flat = toXY(44.7, -1.2);
    expect(isBlocked(seabed, flat.x, flat.y, -1.8, 0.3)).toBe(true);
    expect(isBlocked(seabed, flat.x, flat.y, 1.7, 0.3)).toBe(false);
  });
  it("keeps the Teychan channel open at low water", () => {
    const p = toXY(44.674, -1.17);
    expect(isBlocked(seabed, p.x, p.y, -1.9, 0.3)).toBe(false);
  });
});

describe("course library", () => {
  it("has between 6 and 10 courses", () => {
    expect(defs.length).toBeGreaterThanOrEqual(6);
    expect(defs.length).toBeLessThanOrEqual(10);
  });
  it.each(defs.map((d) => [d.id, d] as const))("%s starts on water at high tide", (_id, d) => {
    const c = buildCourse(d);
    for (const f of [0.1, 0.5, 0.9]) {
      const p = startPosition(c, f);
      expect(isLand(seabed, p.x, p.y)).toBe(false);
    }
    for (const g of c.gates) expect(isLand(seabed, g.buoy.x, g.buoy.y)).toBe(false);
  });
  it("prints the course lengths", () => {
    const lengths = defs.map((d) => `${d.id}: ${courseLengthNm(buildCourse(d)).toFixed(1)} NM`);
    console.log(lengths.join("\n"));
    expect(lengths.length).toBe(defs.length);
  });
});

describe("every course can be sailed to the finish", () => {
  const real = createWindField(snapshot.wind);
  const cases = defs.map((d) => [d.id, d] as const);

  it.each(cases)("%s with the real wind and tide", (id, d) => {
    const { track } = race(d, real);
    const h = track.final.finishT === null ? null : (track.final.finishT - snapshot.startT) / 3600;
    console.log(id, "real wind:", h === null ? `DNF at mark ${track.final.nextMark}` : `${h.toFixed(2)} h`);
    expect(track.final.status).toBe("finished");
  });

  for (const dir of [0, 90, 180, 270]) {
    it.each(cases)(`%s with 12 kn from ${dir} degrees`, (id, d) => {
      const { track } = race(d, uniformWind(dir, 12));
      const h = track.final.finishT === null ? null : (track.final.finishT - snapshot.startT) / 3600;
      console.log(id, dir, h === null ? `DNF at mark ${track.final.nextMark}, ${track.final.status}` : `${h.toFixed(2)} h`);
      expect(track.final.status).toBe("finished");
    });
  }

  it("tide data is calibrated to Eyrac at the fixture's low water", () => {
    const lowEyrac = Date.parse("2026-11-07T08:51:00Z") / 1000;
    expect(Math.abs(tideAt(snapshot.tide, lowEyrac) - (0.76 - 2.45))).toBeLessThan(0.25);
  });

  it("is deterministic to the bit on the real map", () => {
    const a = race(defs[0], real).track;
    const b = race(defs[0], real).track;
    expect(JSON.stringify(a.final)).toBe(JSON.stringify(b.final));
    expect(Buffer.from(a.samples.buffer).equals(Buffer.from(b.samples.buffer))).toBe(true);
  });
});

describe("helm advice", () => {
  const real = createWindField(snapshot.wind);
  const clockStep = 6;

  it.each(defs.map((d) => [d.id, d] as const))("%s can be finished by only following the advice", (id, d) => {
    const course = buildCourse(d);
    const w: World = { polar, wind: real, tide: snapshot.tide, seabed, course };
    const pos = startPosition(course, 0.5);
    let s = initialState(pos, snapshot.startT, adviseHelm(w, router, initialState(pos, snapshot.startT, 0, w)).heading, w);
    let order: Order = { t: s.t, mode: "heading", value: s.heading };
    let tacks = 0;
    while (s.status !== "finished" && s.t < snapshot.closeT) {
      if ((s.t - snapshot.startT) % (clockStep * 10) === 0 || s.status === "grounded") {
        order = { t: s.t + 1, mode: "heading", value: adviseHelm(w, router, s).heading };
      }
      const before = s.side;
      s = step(w, s, order);
      if (s.side !== before) tacks++;
    }
    const h = s.finishT === null ? `DNF mark ${s.nextMark}` : `${((s.finishT - snapshot.startT) / 3600).toFixed(2)} h`;
    console.log(id, "advice:", h, "tacks", tacks);
    expect(s.status).toBe("finished");
    // Following the advice must not turn into constant tacking.
    expect(tacks).toBeLessThan(90);
  });
});
