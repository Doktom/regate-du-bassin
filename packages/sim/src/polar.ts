export interface Polar {
  id: string;
  name: string;
  draftM: number;
  twa: number[];
  tws: number[];
  /** Boat speed in knots, indexed [twa][tws]. */
  speedKn: number[][];
}

/** Below this angle to the wind the boat cannot make way. */
export const NO_GO_DEG = 40;

function bracket(axis: number[], v: number): [number, number, number] {
  const last = axis.length - 1;
  if (v <= axis[0]) return [0, 0, 0];
  if (v >= axis[last]) return [last, last, 0];
  let i = 0;
  while (axis[i + 1] < v) i++;
  return [i, i + 1, (v - axis[i]) / (axis[i + 1] - axis[i])];
}

/** Bilinear lookup. twa is an absolute angle in degrees, tws is in knots. */
export function boatSpeed(p: Polar, twa: number, tws: number): number {
  const [a0, a1, fa] = bracket(p.twa, Math.abs(twa));
  const [s0, s1, fs] = bracket(p.tws, tws);
  const low = p.speedKn[a0][s0] * (1 - fs) + p.speedKn[a0][s1] * fs;
  const high = p.speedKn[a1][s0] * (1 - fs) + p.speedKn[a1][s1] * fs;
  return low * (1 - fa) + high * fa;
}

export interface VmgAngles {
  upwind: number;
  downwind: number;
}

/** Best angles to sail straight upwind or straight downwind, to the degree. */
export function bestVmgAngles(p: Polar, tws: number): VmgAngles {
  let upwind = 45;
  let downwind = 150;
  let bestUp = -Infinity;
  let bestDown = -Infinity;
  for (let a = NO_GO_DEG; a <= 180; a++) {
    const vmg = boatSpeed(p, a, tws) * Math.cos((a * Math.PI) / 180);
    if (vmg > bestUp) {
      bestUp = vmg;
      upwind = a;
    }
    if (-vmg > bestDown) {
      bestDown = -vmg;
      downwind = a;
    }
  }
  return { upwind, downwind };
}
