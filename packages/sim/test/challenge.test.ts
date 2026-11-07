import { describe, expect, it } from "vitest";
import bathy from "../../../data/bathy.json";
import polarJson from "../../../data/boats/catamaran.json";
import coast from "../../../data/coastline.geojson?raw";
import courses from "../../../data/courses.json";
import fixture from "../../../data/fixtures/snapshot.json";
import {
  adviseHelm,
  type BoatState,
  buildCourse,
  buildDailyRace,
  type Challenge,
  cleanName,
  type CourseDef,
  createSeabed,
  createWindField,
  decodeChallenge,
  encodeChallenge,
  fromChallengeOrders,
  type Order,
  parseDailyRace,
  playerStartState,
  type Polar,
  type RaceSnapshot,
  replayTrack,
  roundOrderValue,
  Router,
  simulate,
  startPosition,
  step,
  STEP_S,
  toChallengeOrders,
  type World,
} from "../src/index.ts";

const seabed = createSeabed(bathy, JSON.parse(coast));
const router = new Router(seabed);
const polar = polarJson as Polar;
const snapshot = fixture as RaceSnapshot;
const defs = courses as CourseDef[];
const profile = { id: "rival", name: "Test", color: "#000", angleError: 0, layline: 0 };

function worldFor(id: string): World {
  const course = buildCourse(defs.find((d) => d.id === id) as CourseDef);
  return { polar, wind: createWindField(snapshot.wind), tide: snapshot.tide, seabed, course };
}

/** Sails like the game does: orders arrive between two steps, at any fraction of a second. */
function humanRace(w: World, everyS: number, offsetS: number): { start: BoatState; orders: Order[]; final: BoatState } {
  const t0 = snapshot.startT;
  const start = playerStartState(w, router, startPosition(w.course, 0.5), t0);
  const orders: Order[] = [];
  let s = start;
  let current: Order = { t: t0, mode: "heading", value: start.heading };
  let index = 0;
  let nextOrderT = t0 + offsetS;
  while (s.status !== "finished" && s.t + STEP_S <= snapshot.closeT) {
    if (s.t >= nextOrderT) {
      const useTwa = orders.length % 3 === 2;
      const heading = adviseHelm(w, router, s).heading;
      const t = s.t + 3.37;
      orders.push({ t, mode: useTwa ? "twa" : "heading", value: roundOrderValue(useTwa ? ((heading + 180) % 360) - 180 : heading) });
      nextOrderT += everyS;
    }
    while (index < orders.length && orders[index].t <= s.t) current = orders[index++];
    s = step(w, s, current);
  }
  return { start, orders, final: s };
}

function roundTrip(c: Challenge): Challenge {
  const decoded = decodeChallenge(encodeChallenge(c));
  if (!decoded) throw new Error("Code refused");
  return decoded;
}

describe("challenge link", () => {
  const sample: Challenge = {
    date: "2026-11-07",
    courseId: "ile-aux-oiseaux",
    name: "Maïté 🌊",
    finishS: 6123.4,
    orders: [
      { step: 0, mode: "heading", value: 0 },
      { step: 0, mode: "heading", value: 360 },
      { step: 12, mode: "twa", value: -42.3 },
      { step: 12, mode: "twa", value: 180 },
      { step: 2880, mode: "heading", value: 217.9 },
    ],
  };

  it("gives back exactly what was encoded", () => {
    expect(roundTrip(sample)).toEqual(sample);
    expect(roundTrip({ ...sample, finishS: null, orders: [] })).toEqual({ ...sample, finishS: null, orders: [] });
  });

  it("only uses characters that survive in a link", () => {
    expect(encodeChallenge(sample)).toMatch(/^[0-9a-z._-]+$/);
    expect(encodeChallenge(sample)).toMatch(/[0-9a-z]$/);
  });

  it("refuses anything malformed", () => {
    const code = encodeChallenge(sample);
    const bad = [
      "",
      "defi",
      code.replace(/^1_/, "2_"),
      code.replace("2026-11-07", "../../secret"),
      code.replace("2026-11-07", "2026-99-99"),
      code.replace("ile-aux-oiseaux", "ILE/../x"),
      "1_2026-11-07_arguin_-_1_6161",
      "1_2026-11-07_arguin_-_.._6161",
      "1_2026-11-07_arguin_-_zzzzzz.0_6161",
      "1_2026-11-07_arguin_-_0.zzzz_6161",
      "1_2026-11-07_arguin_-_0.0_ff",
      `1_2026-11-07_arguin_-_${"0.0.".repeat(30000)}0.0_6161`,
    ];
    for (const b of bad) expect(decodeChallenge(b), b).toBeNull();
  });

  it("cleans names that come from a link", () => {
    expect(cleanName("  Jo‮\u0000\n  le   Marin ")).toBe("Jo le Marin");
    expect([...cleanName("x".repeat(99))].length).toBe(20);
    const hex = [...new TextEncoder().encode("‮")].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(decodeChallenge(`1_2026-11-07_arguin_-__${hex}`)?.name).toBe("Un ami");
  });

  it("keeps HTML in a name as plain characters, for display as text only", () => {
    expect(roundTrip({ ...sample, name: "<img src=x>" }).name).toBe("<img src=x>");
  });
});

describe("challenge replay", () => {
  for (const [id, everyS, offsetS] of [
    ["ile-aux-oiseaux", 240, 7],
    ["eyrac-ferret", 600, 33],
    ["arguin", 90, 61],
  ] as const) {
    it(`rebuilds the race of the sender on ${id}`, () => {
      const w = worldFor(id);
      const { start, orders, final } = humanRace(w, everyS, offsetS);
      expect(orders.length).toBeGreaterThan(2);

      const code = encodeChallenge({
        date: snapshot.date,
        courseId: id,
        name: "A",
        finishS: final.finishT === null ? null : final.finishT - snapshot.startT,
        orders: toChallengeOrders(orders, snapshot.startT),
      });
      const decoded = decodeChallenge(code) as Challenge;
      const replayed = fromChallengeOrders(decoded.orders, snapshot.startT);
      const end = simulate(w, start, replayed, final.t);
      expect(end).toEqual(final);

      const track = replayTrack(w, start, replayed, snapshot.closeT, profile);
      expect(track.final.finishT).toBe(final.finishT);
      expect(track.samples.length).toBe((Math.ceil((snapshot.closeT - snapshot.startT) / STEP_S) + 1) * 4);
    });
  }

  it("treats an order on a grounded boat the same after rounding to the step", () => {
    const w = worldFor("ile-aux-oiseaux");
    const t0 = snapshot.startT;
    const start = playerStartState(w, router, startPosition(w.course, 0.5), t0);
    // Sails towards the sand, is ordered off at various moments around the grounding.
    const bearingToLand: Order = { t: t0 + 1, mode: "heading", value: 300 };
    const groundedRun = simulate(w, start, [bearingToLand], snapshot.closeT);
    expect(groundedRun.status).toBe("grounded");
    const groundedAt = groundedRun.groundedAt;
    let freed = 0;
    for (const late of [0.2, 5, 9.9, 10, 10.1, 25.5]) {
      const orders: Order[] = [bearingToLand, { t: groundedAt + late - 10, mode: "heading", value: 120 }];
      const direct = simulate(w, start, orders, snapshot.closeT);
      const replayed = simulate(w, start, fromChallengeOrders(toChallengeOrders(orders, t0), t0), snapshot.closeT);
      expect(replayed).toEqual(direct);
      if (direct.status !== "grounded") freed++;
    }
    expect(freed).toBeGreaterThan(0);
  });
});

describe("race of the day", () => {
  it("picks the course for everyone, and changes it from one day to the next", () => {
    const first = buildDailyRace(snapshot, defs, seabed, polar.draftM, null);
    expect(buildDailyRace(snapshot, defs, seabed, polar.draftM, null).courseId).toBe(first.courseId);
    expect(buildDailyRace(snapshot, defs, seabed, polar.draftM, first.courseId).courseId).not.toBe(first.courseId);
  });

  it("accepts a valid file and refuses a wrong one", () => {
    const good = buildDailyRace(snapshot, defs, seabed, polar.draftM, null);
    const reread = JSON.parse(JSON.stringify(good));
    expect(parseDailyRace(reread, snapshot.date)?.courseId).toBe(good.courseId);
    expect(parseDailyRace(reread, "2020-01-01")).toBeNull();
    expect(parseDailyRace(null, snapshot.date)).toBeNull();
    expect(parseDailyRace("<!doctype html>", snapshot.date)).toBeNull();
    expect(parseDailyRace({ courseId: "arguin" }, snapshot.date)).toBeNull();
    const truncated = JSON.parse(JSON.stringify(good));
    truncated.snapshot.wind.speedKn.pop();
    expect(parseDailyRace(truncated, snapshot.date)).toBeNull();
  });
});
