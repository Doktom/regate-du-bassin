import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { datan2, dcos, dhypot, dsin } from "../src/dmath.ts";

const close = (a: number, b: number, tol = 4e-15): boolean => Math.abs(a - b) <= tol;

describe("trigonometry identical in every browser", () => {
  it("matches Math.sin and Math.cos at the precision of a double", () => {
    for (let d = -720; d <= 720; d += 0.137) {
      const r = (d * Math.PI) / 180;
      expect(close(dsin(r), Math.sin(r)), `sin ${d}`).toBe(true);
      expect(close(dcos(r), Math.cos(r)), `cos ${d}`).toBe(true);
    }
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBe(1);
  });

  it("matches Math.atan2 in every quadrant and on the axes", () => {
    for (let d = -180; d <= 180; d += 0.0731) {
      for (const size of [1e-6, 0.7, 12, 25000]) {
        const y = size * Math.sin((d * Math.PI) / 180);
        const x = size * Math.cos((d * Math.PI) / 180);
        expect(close(datan2(y, x), Math.atan2(y, x)), `${y} ${x}`).toBe(true);
      }
    }
    for (const [y, x] of [[0, 1], [0, -1], [1, 0], [-1, 0], [5, 5], [-5, -5]]) {
      expect(close(datan2(y, x), Math.atan2(y, x)), `${y} ${x}`).toBe(true);
    }
    expect(datan2(0, 0)).toBe(0);
  });

  it("matches Math.hypot", () => {
    expect(dhypot(3, 4)).toBe(5);
    expect(close(dhypot(-1234.5, 678.9), Math.hypot(-1234.5, 678.9), 1e-11)).toBe(true);
  });

  it("is the only trigonometry used by the simulation", () => {
    const folder = new URL("../src/", import.meta.url);
    const forbidden = /Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|exp|log|log2|log10|pow|cbrt|sinh|cosh|tanh)\b|\*\*\s*[0-9a-z(]/;
    for (const file of readdirSync(folder)) {
      const code = readFileSync(new URL(file, folder), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(forbidden.exec(code)?.[0] ?? null, file).toBeNull();
    }
  });
});
