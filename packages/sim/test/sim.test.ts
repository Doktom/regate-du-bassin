import { describe, expect, it } from "vitest";
import polarJson from "../../../data/boats/catamaran.json";
import {
  bestVmgAngles,
  boatSpeed,
  buildCourse,
  calibrateOpenMeteoTide,
  chooseCourse,
  fetchRaceSnapshot,
  createSeabed,
  createWindField,
  type CourseDef,
  gateCrossing,
  initialState,
  isBlocked,
  KN_TO_MS,
  nextTideExtremum,
  norm180,
  parisTime,
  type Polar,
  predictTrack,
  sampleWind,
  simulate,
  step,
  STEP_S,
  tackFactor,
  tideAt,
  toXY,
  uniformWind,
  type World,
  latOf,
  lonOf,
} from "../src/index.ts";

const polar = polarJson as Polar;

/** 40 by 40 cells of 0.002 degrees around the origin: 5 m deep, with one bank drying to +1 m. */
function makeSeabed() {
  const nx = 40;
  const ny = 40;
  const cells = new Int8Array(nx * ny).fill(-50);
  for (let j = 20; j < 26; j++) {
    for (let i = 10; i < 30; i++) cells[j * nx + i] = 10;
  }
  const data = btoa(String.fromCharCode(...new Uint8Array(cells.buffer)));
  return createSeabed({ lat0: 44.63, lon0: -1.18, dLat: 0.002, dLon: 0.002, nx, ny, data }, { features: [] });
}

const seabed = makeSeabed();
const bankSouthY = toXY(44.63 + 20 * 0.002, -1.14).y;

const def = (marks: CourseDef["marks"]): CourseDef => ({
  id: "t",
  name: "t",
  description: "",
  start: [
    { lat: 44.64, lon: -1.15 },
    { lat: 44.64, lon: -1.14 },
  ],
  marks,
  finish: [
    { lat: 44.645, lon: -1.15 },
    { lat: 44.645, lon: -1.14 },
  ],
});

const openCourse = def([{ name: "M", lat: 44.64, lon: -1.12, side: "port" }]);

function world(overrides: Partial<World> = {}, tideM = 2): World {
  return {
    polar,
    wind: uniformWind(0, 12),
    tide: { times: [0, 4e9], heightsM: [tideM, tideM] },
    seabed,
    course: buildCourse(openCourse),
    ...overrides,
  };
}

const T0 = 1000;
const heading = (value: number, t = T0) => ({ t, mode: "heading" as const, value });

describe("polar", () => {
  it("returns table values on the nodes", () => {
    expect(boatSpeed(polar, 90, 12)).toBeCloseTo(12);
    expect(boatSpeed(polar, 120, 20)).toBeCloseTo(17);
  });
  it("interpolates between nodes on both axes", () => {
    expect(boatSpeed(polar, 75, 12)).toBeCloseTo((9.5 + 12) / 2);
    expect(boatSpeed(polar, 90, 14)).toBeCloseTo((12 + 14) / 2);
    expect(boatSpeed(polar, 75, 14)).toBeCloseTo((9.5 + 12 + 11 + 14) / 4);
  });
  it("has a no-go zone below 40 degrees", () => {
    expect(boatSpeed(polar, 0, 12)).toBe(0);
    expect(boatSpeed(polar, 39, 12)).toBe(0);
    expect(boatSpeed(polar, 40, 12)).toBe(0);
    expect(boatSpeed(polar, 42, 12)).toBeGreaterThan(0);
  });
  it("scales down to zero with no wind and clamps above the table", () => {
    expect(boatSpeed(polar, 90, 0)).toBe(0);
    expect(boatSpeed(polar, 90, 2)).toBeCloseTo(2);
    expect(boatSpeed(polar, 90, 40)).toBeCloseTo(14.5);
  });
  it("finds VMG angles on the right side of the beam", () => {
    const v = bestVmgAngles(polar, 12);
    expect(v.upwind).toBeGreaterThan(40);
    expect(v.upwind).toBeLessThan(70);
    expect(v.downwind).toBeGreaterThan(120);
  });
});

describe("wind", () => {
  const twoHours = {
    lats: [44, 45],
    lons: [-2, 0],
    times: [0, 3600],
    speedKn: [10, 10, 10, 10, 10, 10, 10, 10],
    dirDeg: [350, 350, 350, 350, 10, 10, 10, 10],
  };
  it("interpolates across north on the u/v components, never on the angle", () => {
    const w = sampleWind(createWindField(twoHours), 0, 0, 1800);
    expect(Math.abs(norm180(w.twd))).toBeLessThan(1e-6);
    expect(w.tws).toBeGreaterThan(9.8);
  });
  it("interpolates in space", () => {
    const f = createWindField({
      lats: [44, 45],
      lons: [-2, 0],
      times: [0, 3600],
      speedKn: [10, 20, 10, 20, 10, 20, 10, 20],
      dirDeg: new Array(8).fill(90),
    });
    const x = toXY(44.5, -1).x;
    const y = toXY(44.5, -1).y;
    expect(sampleWind(f, x, y, 0).tws).toBeCloseTo(15);
  });
  it("uniform wind reports its direction", () => {
    const w = sampleWind(uniformWind(270, 12), 0, 0, 500);
    expect(w.twd).toBeCloseTo(270);
    expect(w.tws).toBeCloseTo(12);
  });
});

describe("tide", () => {
  const s = { times: [0, 3600, 7200, 10800, 14400], heightsM: [0, 1, 1.5, 1, 0] };
  it("passes through the hourly values and stays smooth between them", () => {
    expect(tideAt(s, 3600)).toBeCloseTo(1);
    expect(tideAt(s, 7200)).toBeCloseTo(1.5);
    expect(tideAt(s, 5400)).toBeGreaterThan(1);
    expect(tideAt(s, 5400)).toBeLessThan(1.5);
  });
  it("finds the next high water", () => {
    const e = nextTideExtremum(s, 0);
    expect(e?.kind).toBe("high");
    expect(Math.abs((e?.t ?? 0) - 7200)).toBeLessThan(900);
  });
  it("applies the Eyrac calibration", () => {
    const c = calibrateOpenMeteoTide([0], [1]);
    expect(c.times[0]).toBe(89 * 60);
    expect(c.heightsM[0]).toBeCloseTo(1.322);
  });
});

describe("boat speed and tacks", () => {
  it("moves by polar speed over one step", () => {
    const w = world();
    const s0 = initialState(toXY(44.64, -1.15), T0, 90, w);
    const s1 = step(w, s0, heading(90));
    expect(s1.speedKn).toBeCloseTo(12);
    expect(s1.x - s0.x).toBeCloseTo(12 * KN_TO_MS * STEP_S);
    expect(s1.y - s0.y).toBeCloseTo(0);
  });
  it("does not move inside the no-go zone", () => {
    const w = world();
    const s0 = initialState(toXY(44.64, -1.15), T0, 20, w);
    const s1 = step(w, s0, heading(20));
    expect(s1.speedKn).toBe(0);
    expect(s1.x).toBe(s0.x);
  });
  it("penalises a tack, then recovers progressively", () => {
    expect(tackFactor(0)).toBeCloseTo(0.6);
    expect(tackFactor(19)).toBeCloseTo(0.6);
    expect(tackFactor(30)).toBeCloseTo(0.8);
    expect(tackFactor(40)).toBe(1);
    const w = world();
    const s0 = initialState(toXY(44.64, -1.15), T0, 60, w);
    const s1 = step(w, s0, heading(-60));
    const expected = boatSpeed(polar, 60, 12) * 0.6;
    expect(s1.speedKn).toBeCloseTo(expected);
    expect(s1.side).toBe(-1);
  });
  it("angle-to-wind mode follows a wind shift", () => {
    const f = createWindField({
      lats: [44, 45],
      lons: [-2, 0],
      times: [0, 1000, 1010, 4e9],
      speedKn: new Array(16).fill(12),
      dirDeg: [0, 0, 0, 0, 0, 0, 0, 0, 30, 30, 30, 30, 30, 30, 30, 30],
    });
    const w = world({ wind: f });
    const s0 = initialState(toXY(44.64, -1.15), 1010, 90, w);
    const s1 = step(w, s0, { t: 1010, mode: "twa", value: 90 });
    expect(s1.heading).toBeCloseTo(120);
    const s2 = step(world({ wind: uniformWind(0, 12) }), s0, heading(90, 1010));
    expect(s2.heading).toBeCloseTo(90);
  });
});

describe("grounding", () => {
  const justSouthOfBank = { x: toXY(44.64, -1.14).x, y: bankSouthY - 120 };
  const windEast = uniformWind(90, 12);

  it("stops at the edge of a dry bank", () => {
    const w = world({ wind: windEast }, 0);
    const s0 = initialState(justSouthOfBank, T0, 0, w);
    const end = simulate(w, s0, [heading(0)], T0 + 60);
    expect(end.status).toBe("grounded");
    expect(end.y).toBeLessThan(bankSouthY + 200);
    expect(isBlocked(seabed, end.x, end.y, 0, polar.draftM)).toBe(false);
  });
  it("passes over the same bank when the tide is high enough", () => {
    const w = world({ wind: windEast }, 2);
    const s0 = initialState(justSouthOfBank, T0, 0, w);
    expect(simulate(w, s0, [heading(0)], T0 + 120).status).toBe("sailing");
  });
  it("uses the draft in the threshold", () => {
    expect(isBlocked(seabed, justSouthOfBank.x, bankSouthY + 400, 1.2, 0.3)).toBe(true);
    expect(isBlocked(seabed, justSouthOfBank.x, bankSouthY + 400, 1.31, 0.3)).toBe(false);
  });
  it("stays grounded without a new order and leaves with a course away from the bank", () => {
    const w = world({ wind: windEast }, 0);
    const s0 = initialState(justSouthOfBank, T0, 0, w);
    const stuck = simulate(w, s0, [heading(0)], T0 + 120);
    expect(stuck.status).toBe("grounded");
    const stillStuck = step(w, stuck, heading(0));
    expect(stillStuck.status).toBe("grounded");
    const towardsBank = step(w, stuck, heading(0, stuck.t + 1));
    expect(towardsBank.status).toBe("grounded");
    const away = step(w, stuck, heading(180, stuck.t + 1));
    expect(away.status).toBe("sailing");
    // Restart with speed zero, then a 30 s re-acceleration. Going from heading 0 to 180
    // under an east wind also changes side, so the tack penalty applies too.
    expect(away.speedKn).toBe(0);
    const next = step(w, away, heading(180, stuck.t + 1));
    expect(next.speedKn).toBeCloseTo((boatSpeed(polar, 90, 12) / 3) * 0.6);
  });
  it("does not count a thin ridge just ahead as a way out", () => {
    const nx = 40;
    const ny = 40;
    const cells = new Int8Array(nx * ny).fill(-50);
    // Two rows of 22 m cells dry, just north of the boat, with deep water beyond.
    for (let i = 0; i < nx; i++) {
      cells[20 * nx + i] = 10;
      cells[21 * nx + i] = 10;
    }
    const data = btoa(String.fromCharCode(...new Uint8Array(cells.buffer)));
    const fine = createSeabed(
      { lat0: 44.64, lon0: -1.142, dLat: 0.0002, dLon: 0.0002, nx, ny, data },
      { features: [] },
    );
    const w = world({ wind: windEast, seabed: fine }, 0);
    const start = { x: toXY(44.64, -1.138).x, y: toXY(44.64 + 17.5 * 0.0002, -1.138).y };
    const hit = simulate(w, initialState(start, T0, 0, w), [heading(0)], T0 + 60);
    expect(hit.status).toBe("grounded");
    let s = hit;
    const push = heading(0, hit.t + 1);
    for (let i = 0; i < 6; i++) {
      s = step(w, s, push);
      expect(s.status).toBe("grounded");
    }
    expect(step(w, s, heading(180, s.t + 1)).status).toBe("sailing");
  });
  it("is stranded when the tide falls under the boat, until the water returns", () => {
    const onBank = { x: justSouthOfBank.x, y: bankSouthY + 400 };
    const tide = { times: [0, 1000, 2000, 3000, 4000, 5000], heightsM: [2, 2, 0, 0, 2, 2] };
    const w = world({ wind: windEast, tide });
    let s = initialState(onBank, 2500, 180, w);
    s = step(w, s, heading(180, 2500));
    expect(s.status).toBe("grounded");
    const escape = heading(270, 2600);
    const stranded = simulate(w, s, [escape], 3000);
    expect(stranded.status).toBe("grounded");
    const stillDry = simulate(w, stranded, [escape], 3400);
    expect(stillDry.status).toBe("grounded");
    expect(stillDry.x).toBe(s.x);
    const floated = simulate(w, stillDry, [escape], 3900);
    expect(floated.status).toBe("sailing");
    expect(floated.x).toBeLessThan(s.x);
  });
});

describe("marks", () => {
  const straight = (side: "port" | "starboard"): CourseDef => ({
    ...def([{ name: "M", lat: 44.64, lon: -1.125, side }]),
    finish: [
      { lat: 44.638, lon: -1.112 },
      { lat: 44.642, lon: -1.112 },
    ],
  });
  const eastbound = buildCourse(straight("port"));
  const gate = eastbound.gates[0];

  it("leaves a mark to port with the gate on the right of the course", () => {
    expect(gate.end.y).toBeLessThan(gate.buoy.y);
  });
  it("leaves a mark to starboard with the gate on the left of the course", () => {
    const c = buildCourse(straight("starboard"));
    expect(c.gates[0].end.y).toBeGreaterThan(c.gates[0].buoy.y);
  });
  it("validates a crossing on the right side", () => {
    const p = { x: gate.buoy.x - 50, y: gate.buoy.y - 200 };
    const q = { x: gate.buoy.x + 50, y: gate.buoy.y - 200 };
    expect(gateCrossing(gate, p, q)).toBeCloseTo(0.5);
  });
  it("refuses a crossing on the wrong side", () => {
    const p = { x: gate.buoy.x - 50, y: gate.buoy.y + 200 };
    const q = { x: gate.buoy.x + 50, y: gate.buoy.y + 200 };
    expect(gateCrossing(gate, p, q)).toBeNull();
  });
  it("refuses a crossing in the wrong direction", () => {
    const p = { x: gate.buoy.x + 50, y: gate.buoy.y - 200 };
    const q = { x: gate.buoy.x - 50, y: gate.buoy.y - 200 };
    expect(gateCrossing(gate, p, q)).toBeNull();
  });
  it("detects a crossing in the middle of a simulation step, with sub-step timing", () => {
    const w = world({ wind: uniformWind(0, 12), course: eastbound });
    const speedM = 12 * KN_TO_MS * STEP_S;
    const before = { x: gate.buoy.x - speedM / 2, y: gate.buoy.y - 200 };
    const s0 = initialState(before, T0, 90, w);
    const s1 = step(w, s0, heading(90));
    expect(s1.nextMark).toBe(1);
    expect(s1.markTimes[0]).toBeCloseTo(T0 + STEP_S / 2, 6);
  });
  it("finishes only once every mark is passed", () => {
    const w = world({ course: eastbound });
    const line = eastbound.finishA;
    const skip = initialState({ x: line.x - 20, y: (line.y + eastbound.finishB.y) / 2 }, T0, 45, w);
    expect(simulate(w, skip, [heading(45)], T0 + 20).status).toBe("sailing");
    const done = { ...skip, nextMark: 1 };
    const end = simulate(w, done, [heading(45)], T0 + 20);
    expect(end.status).toBe("finished");
    expect(end.finishT).toBeGreaterThan(T0);
    expect(end.finishT).toBeLessThan(T0 + 20);
    expect(end.x).toBeCloseTo(line.x, 3);
    const frozen = step(w, end, heading(45));
    expect(frozen.x).toBe(end.x);
    expect(frozen.finishT).toBe(end.finishT);
  });
});

describe("determinism", () => {
  it("gives the same state to the bit for the same inputs", () => {
    const tide = { times: [0, 2000, 4000], heightsM: [0.5, 2, 0.5] };
    const w = world({ wind: uniformWind(37, 13.3), tide });
    const orders = [
      heading(95, T0),
      { t: T0 + 100, mode: "twa" as const, value: -70 },
      heading(310, T0 + 300),
    ];
    const start = initialState(toXY(44.64, -1.15), T0, 95, w);
    const a = simulate(w, start, orders, T0 + 900);
    const b = simulate(w, start, orders, T0 + 900);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("gives the same state when resumed from a checkpoint", () => {
    const w = world({ wind: uniformWind(37, 13.3) });
    const orders = [heading(95, T0), heading(300, T0 + 300)];
    const start = initialState(toXY(44.64, -1.15), T0, 95, w);
    const full = simulate(w, start, orders, T0 + 900);
    const checkpoint = simulate(w, start, orders, T0 + 400);
    expect(JSON.stringify(simulate(w, checkpoint, orders.slice(1), T0 + 900))).toBe(JSON.stringify(full));
  });
  it("does not modify the input state", () => {
    const w = world();
    const s0 = initialState(toXY(44.64, -1.15), T0, 90, w);
    const copy = JSON.stringify(s0);
    step(w, s0, heading(90));
    expect(JSON.stringify(s0)).toBe(copy);
  });
  it("predicts a track that matches the real run", () => {
    const w = world();
    const s0 = initialState(toXY(44.64, -1.15), T0, 90, w);
    const track = predictTrack(w, s0, { mode: "heading", value: 90 }, 120);
    expect(track.length).toBe(13);
    const real = simulate(w, s0, [heading(90)], T0 + 120);
    expect(track[12].x).toBeCloseTo(real.x);
  });
});

describe("projection", () => {
  it("round-trips", () => {
    const p = toXY(44.7, -1.2);
    expect(latOf(p.y)).toBeCloseTo(44.7);
    expect(lonOf(p.x)).toBeCloseTo(-1.2);
  });
});

describe("paris time", () => {
  it("handles winter and summer offsets", () => {
    expect(parisTime("2026-11-07", 10)).toBe(Date.parse("2026-11-07T09:00:00Z") / 1000);
    expect(parisTime("2026-07-07", 10)).toBe(Date.parse("2026-07-07T08:00:00Z") / 1000);
  });
});

describe("course choice", () => {
  const north = def([{ name: "N", lat: 44.7, lon: -1.145, side: "port" }]);
  const a = { ...north, id: "north" };
  const b = { ...def([{ name: "E", lat: 44.64, lon: -1.1, side: "port" }]), id: "east" };
  const tide = { times: [0, 4e9], heightsM: [2, 2] };
  it("takes the first leg closest to dead upwind", () => {
    const c = chooseCourse([a, b], uniformWind(0, 10), tide, seabed, 0, 3600, 0.3, null);
    expect(c.course.def.id).toBe("north");
  });
  it("does not repeat yesterday's course", () => {
    const c = chooseCourse([a, b], uniformWind(0, 10), tide, seabed, 0, 3600, 0.3, "north");
    expect(c.course.def.id).toBe("east");
  });
  it("rejects a course whose mark never floats", () => {
    const dry = { ...def([{ name: "D", lat: 44.674, lon: -1.14, side: "port" }]), id: "dry" };
    const low = { times: [0, 4e9], heightsM: [0, 0] };
    const c = chooseCourse([dry, b], uniformWind(0, 10), low, seabed, 0, 3600, 0.3, null);
    expect(c.course.def.id).toBe("east");
  });
});

describe("race snapshot download", () => {
  const hours = Array.from({ length: 24 }, (_, h) => `2026-11-07T${String(h).padStart(2, "0")}:00`);
  const point = {
    hourly: {
      time: hours,
      wind_speed_10m: hours.map(() => 10),
      wind_direction_10m: hours.map(() => 90),
      wind_gusts_10m: hours.map(() => 15),
    },
  };
  const count = (url: string): number => new URL(url).searchParams.get("latitude")?.split(",").length ?? 0;
  const fetcher = (failModel: string | null) => async (url: string) => {
    if (url.includes("marine-api")) {
      const time = Array.from({ length: 72 }, (_, i) => new Date(Date.UTC(2026, 10, 6, i)).toISOString().slice(0, 16));
      return { ok: true, json: async () => ({ hourly: { time, sea_level_height_msl: time.map(() => 1) } }) };
    }
    if (failModel && url.includes(`models=${failModel}&`)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => Array.from({ length: count(url) }, () => point) };
  };

  it("builds a full grid from several requests", async () => {
    const s = await fetchRaceSnapshot("2026-11-07", fetcher(null));
    const nPoints = s.wind.lats.length * s.wind.lons.length;
    expect(nPoints).toBe(176);
    expect(s.wind.speedKn.length).toBe(nPoints * s.wind.times.length);
    expect(s.source).toBe("meteofrance_arome_france_hd");
    expect(s.tide.heightsM[0]).toBeCloseTo(1.322);
    expect(s.startT).toBe(Date.parse("2026-11-07T09:00:00Z") / 1000);
  });
  it("falls back on the coarser model", async () => {
    const s = await fetchRaceSnapshot("2026-11-07", fetcher("meteofrance_arome_france_hd"));
    expect(s.source).toBe("meteofrance_arome_france");
  });
  it("rejects when there is no network, so the app can use the recorded day", async () => {
    await expect(
      fetchRaceSnapshot("2026-11-07", () => Promise.reject(new Error("offline"))),
    ).rejects.toThrow();
  });
});
