import { bearing, dist, headingVec, METRES_PER_NM, norm360, toXY, type Vec } from "./geo.ts";

export type Side = "port" | "starboard";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface CourseDef {
  id: string;
  name: string;
  description: string;
  start: [LatLon, LatLon];
  marks: (LatLon & { name: string; side: Side })[];
  finish: [LatLon, LatLon];
}

export interface Gate {
  name: string;
  side: Side;
  buoy: Vec;
  /** Fictive point on the side the boat must pass. */
  end: Vec;
  /** Direction a valid crossing goes, in degrees. */
  travelDeg: number;
}

export interface RaceCourse {
  def: CourseDef;
  startA: Vec;
  startB: Vec;
  gates: Gate[];
  finishA: Vec;
  finishB: Vec;
}

export const GATE_LENGTH_M = 1500;

function mid(a: Vec, b: Vec): Vec {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function buildCourse(def: CourseDef): RaceCourse {
  const startA = toXY(def.start[0].lat, def.start[0].lon);
  const startB = toXY(def.start[1].lat, def.start[1].lon);
  const finishA = toXY(def.finish[0].lat, def.finish[0].lon);
  const finishB = toXY(def.finish[1].lat, def.finish[1].lon);
  const points = [mid(startA, startB), ...def.marks.map((m) => toXY(m.lat, m.lon)), mid(finishA, finishB)];
  const gates = def.marks.map((m, i): Gate => {
    const buoy = points[i + 1];
    const inDir = headingVec(bearing(points[i], buoy));
    const outDir = headingVec(bearing(buoy, points[i + 2]));
    const sum = { x: inDir.x + outDir.x, y: inDir.y + outDir.y };
    // A hairpin has no usable bisector, so the gate faces the incoming direction.
    const t = Math.hypot(sum.x, sum.y) < 0.2 ? inDir : sum;
    const travelDeg = bearing({ x: 0, y: 0 }, t);
    // Leaving the buoy to port means the boat passes on its right-hand side.
    const gateDeg = norm360(travelDeg + (m.side === "port" ? 90 : -90));
    const d = headingVec(gateDeg);
    return {
      name: m.name,
      side: m.side,
      buoy,
      end: { x: buoy.x + d.x * GATE_LENGTH_M, y: buoy.y + d.y * GATE_LENGTH_M },
      travelDeg,
    };
  });
  return { def, startA, startB, gates, finishA, finishB };
}

/** Straight-line distance still to sail, in metres, through the marks not passed yet. */
export function remainingDistance(c: RaceCourse, pos: Vec, nextMark: number): number {
  let total = 0;
  let from = pos;
  for (let i = nextMark; i < c.gates.length; i++) {
    total += dist(from, c.gates[i].buoy);
    from = c.gates[i].buoy;
  }
  return total + dist(from, mid(c.finishA, c.finishB));
}

export function courseLengthNm(c: RaceCourse): number {
  return remainingDistance(c, mid(c.startA, c.startB), 0) / METRES_PER_NM;
}

export function startPosition(c: RaceCourse, fraction: number): Vec {
  return {
    x: c.startA.x + (c.startB.x - c.startA.x) * fraction,
    y: c.startA.y + (c.startB.y - c.startA.y) * fraction,
  };
}

/** Where the next mark or the finish line is, as a point to steer for. */
export function nextTarget(c: RaceCourse, nextMark: number): Vec {
  return nextMark < c.gates.length ? c.gates[nextMark].buoy : mid(c.finishA, c.finishB);
}
