/**
 * Trigonometry that gives the same bits in every browser.
 *
 * JavaScript leaves the exact result of Math.sin, cos, atan2 and hypot to each engine, and they do
 * differ. Additions, multiplications, divisions and Math.sqrt are exactly defined, so these
 * versions use nothing else. A race replayed from a link depends on it: the simulation must not
 * call the Math versions. Coefficients come from fdlibm (Sun Microsystems), as used in many libm.
 */
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const PIO2 = 1.5707963267948966;
const PI = 3.141592653589793;

function kernelSin(r: number): number {
  const z = r * r;
  return (
    r +
    r *
      z *
      (-1.6666666666666632e-1 +
        z *
          (8.33333333332249e-3 +
            z *
              (-1.984126982985795e-4 +
                z * (2.7557313707070068e-6 + z * (-2.5050760253406863e-8 + z * 1.58969099521155e-10)))))
  );
}

function kernelCos(r: number): number {
  const z = r * r;
  return (
    1 -
    0.5 * z +
    z *
      z *
      (4.16666666666666e-2 +
        z *
          (-1.388888888887411e-3 +
            z *
              (2.480158728947673e-5 +
                z * (-2.755731435139066e-7 + z * (2.087572321298175e-9 + z * -1.1359647557788195e-11)))))
  );
}

/** Angle within a quarter turn of zero, with the number of quarter turns removed (0 to 3). */
function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x / PIO2);
  const q = ((k % 4) + 4) % 4;
  return { r: x - k * PIO2_HI - k * PIO2_LO, q };
}

export function dsin(x: number): number {
  const { r, q } = reduce(x);
  if (q === 0) return kernelSin(r);
  if (q === 1) return kernelCos(r);
  return q === 2 ? -kernelSin(r) : -kernelCos(r);
}

export function dcos(x: number): number {
  const { r, q } = reduce(x);
  if (q === 0) return kernelCos(r);
  if (q === 1) return -kernelSin(r);
  return q === 2 ? -kernelCos(r) : kernelSin(r);
}

const ATAN_HI = [4.636476090008061e-1, 7.853981633974483e-1, 9.827937232473291e-1, 1.5707963267948966];
const ATAN_LO = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17];

function atanPositive(a: number): number {
  let id: number;
  let x: number;
  if (a < 0.4375) {
    id = -1;
    x = a;
  } else if (a < 0.6875) {
    id = 0;
    x = (2 * a - 1) / (2 + a);
  } else if (a < 1.1875) {
    id = 1;
    x = (a - 1) / (a + 1);
  } else if (a < 2.4375) {
    id = 2;
    x = (a - 1.5) / (1 + 1.5 * a);
  } else {
    id = 3;
    x = -1 / a;
  }
  const z = x * x;
  const w = z * z;
  const s1 =
    z *
    (3.333333333333293e-1 +
      w *
        (1.4285714272503466e-1 +
          w *
            (9.090887133436507e-2 +
              w * (6.661073137387531e-2 + w * (4.976877994615932e-2 + w * 1.6285820115365782e-2)))));
  const s2 =
    w *
    (-1.9999999999876483e-1 +
      w *
        (-1.1111110405462356e-1 +
          w * (-7.691876205044830e-2 + w * (-5.833570133790573e-2 + w * -3.6531572744216916e-2))));
  if (id < 0) return x - x * (s1 + s2);
  return ATAN_HI[id] - (x * (s1 + s2) - ATAN_LO[id] - x);
}

export function datan2(y: number, x: number): number {
  if (x === 0) return y > 0 ? PIO2 : y < 0 ? -PIO2 : 0;
  const a = atanPositive(Math.abs(y / x));
  const angle = x > 0 ? a : PI - a;
  return y < 0 ? -angle : angle;
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
