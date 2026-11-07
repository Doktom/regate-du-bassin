import { type BoatState, headingVec, norm180, type RaceCourse, type Seabed, toXY, type Vec } from "@regate/sim";
import { seabed } from "./assets.ts";

const LABELS: [string, number, number][] = [
  ["Arcachon", 44.653, -1.165],
  ["La Teste", 44.632, -1.14],
  ["Gujan-Mestras", 44.633, -1.07],
  ["Le Teich", 44.628, -1.02],
  ["Biganos", 44.65, -0.985],
  ["Audenge", 44.685, -1.015],
  ["Lanton", 44.705, -1.04],
  ["Andernos", 44.748, -1.095],
  ["Arès", 44.77, -1.14],
  ["Claouey", 44.752, -1.18],
  ["Grand Piquey", 44.705, -1.243],
  ["Cap Ferret", 44.655, -1.255],
  ["Pyla", 44.625, -1.2],
];

type LandmarkKind = "lighthouse" | "dune" | "huts" | "jetty" | "port" | "oysters";
const LANDMARKS: [string, number, number, LandmarkKind][] = [
  ["Phare du Cap Ferret", 44.6437, -1.2486, "lighthouse"],
  ["Dune du Pilat", 44.589, -1.213, "dune"],
  ["Cabanes tchanquées", 44.6915, -1.17, "huts"],
  ["Jetée d'Eyrac", 44.6655, -1.1645, "jetty"],
  ["Port d'Arcachon", 44.6585, -1.141, "port"],
  ["Parcs à huîtres", 44.697, -1.114, "oysters"],
];

const COLOR_STOPS: [number, [number, number, number]][] = [
  [0.3, [205, 240, 226]],
  [1, [168, 232, 221]],
  [2.5, [118, 214, 208]],
  [5, [76, 188, 198]],
  [9, [52, 158, 186]],
  [15, [40, 130, 172]],
];

function lerpColor(depth: number): [number, number, number] {
  if (depth <= COLOR_STOPS[0][0]) return COLOR_STOPS[0][1];
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [d1, c1] = COLOR_STOPS[i];
    const [d0, c0] = COLOR_STOPS[i - 1];
    if (depth <= d1) {
      const f = (depth - d0) / (d1 - d0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}

const LUT_MIN_CM = -1600;
const LUT_MAX_CM = 1600;
const LUT_STEP_CM = 4;

/** Colour for each depth of water at the current tide. Sand is what the boat cannot cross. */
function buildDepthLut(draftM: number): Uint32Array {
  const lut = new Uint32Array((LUT_MAX_CM - LUT_MIN_CM) / LUT_STEP_CM + 1);
  for (let i = 0; i < lut.length; i++) {
    const depth = (LUT_MIN_CM + i * LUT_STEP_CM) / 100;
    let c: [number, number, number];
    if (depth >= draftM) {
      c = lerpColor(depth);
    } else if (depth >= 0) {
      // Awash: looks wet but stops the boat.
      c = [236, 226, 176];
    } else {
      const dry = Math.min(1, -depth / 1.2);
      c = [240 + 6 * dry, 224 + 8 * dry, 170 + 20 * dry];
    }
    lut[i] = 0xff000000 | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0]);
  }
  return lut;
}

const SCALE_UP = 3;

/** Water and banks drawn from the seabed at a given tide. Only redrawn when the tide moves. */
class WaterLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private readonly heightsCm: Int16Array;
  private readonly lut: Uint32Array;
  private lastCm = Infinity;

  constructor(s: Seabed, draftM: number) {
    const { nx, ny } = s.bathy;
    const w = (nx - 1) * SCALE_UP;
    const h = (ny - 1) * SCALE_UP;
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    this.image = this.ctx.createImageData(w, h);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.lut = buildDepthLut(draftM);
    this.heightsCm = new Int16Array(w * h);
    for (let py = 0; py < h; py++) {
      // Image rows go from north to south, seabed rows from south to north.
      const gy = ny - 1 - py / SCALE_UP;
      const j = Math.min(ny - 2, Math.floor(gy));
      const ty = gy - j;
      for (let px = 0; px < w; px++) {
        const gx = px / SCALE_UP;
        const i = Math.floor(gx);
        const tx = gx - i;
        const a = s.heights[j * nx + i];
        const b = s.heights[j * nx + i + 1];
        const c = s.heights[(j + 1) * nx + i];
        const d = s.heights[(j + 1) * nx + i + 1];
        this.heightsCm[py * w + px] = ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) * 10;
      }
    }
  }

  update(tideM: number): void {
    const cm = Math.round(tideM * 100);
    if (Math.abs(cm - this.lastCm) < 2) return;
    this.lastCm = cm;
    const { pixels, heightsCm, lut } = this;
    const last = lut.length - 1;
    for (let i = 0; i < pixels.length; i++) {
      let k = ((cm - heightsCm[i] - LUT_MIN_CM) / LUT_STEP_CM) | 0;
      if (k < 0) k = 0;
      else if (k > last) k = last;
      pixels[i] = lut[k];
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}

function hash(n: number): number {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
}

/** Land, pine forests and the dune, drawn once. */
function buildLandLayer(s: Seabed): HTMLCanvasElement {
  const worldW = s.maxX - s.minX;
  const worldH = s.maxY - s.minY;
  const width = 2200;
  const k = width / worldW;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round(worldH * k);
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const px = (p: Vec): [number, number] => [(p.x - s.minX) * k, (s.maxY - p.y) * k];
  const path = (rings: Vec[][]): Path2D => {
    const out = new Path2D();
    for (const r of rings) {
      r.forEach((p, i) => {
        const [x, y] = px(p);
        if (i === 0) out.moveTo(x, y);
        else out.lineTo(x, y);
      });
      out.closePath();
    }
    return out;
  };
  const arguinCentre = toXY(44.575, -1.25);
  const isArguin = (r: Vec[]): boolean => {
    const m = r.reduce((acc, p) => ({ x: acc.x + p.x / r.length, y: acc.y + p.y / r.length }), { x: 0, y: 0 });
    return Math.hypot(m.x - arguinCentre.x, m.y - arguinCentre.y) < 3500 && r.length < 200;
  };
  const sandRings = s.rings.filter(isArguin);
  const landRings = s.rings.filter((r) => !isArguin(r));
  const land = path(landRings);

  g.save();
  g.shadowColor = "rgba(244,232,190,0.95)";
  g.shadowBlur = 7;
  g.fillStyle = "#86ab7c";
  g.fill(land);
  g.restore();
  g.save();
  g.clip(land);
  // Pines as soft dark dabs.
  for (let i = 0; i < 26000; i++) {
    const x = hash(i) * c.width;
    const y = hash(i + 0.37) * c.height;
    const r = 1.4 + hash(i + 0.71) * 2.6;
    g.fillStyle = hash(i + 0.13) > 0.5 ? "rgba(71,112,82,0.5)" : "rgba(98,140,96,0.5)";
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // The dune, along the ocean south of Pyla.
  const [dx, dy] = px(toXY(44.589, -1.211));
  g.translate(dx, dy);
  g.rotate(0.12);
  const dune = g.createRadialGradient(0, 0, 3, 0, 0, 62);
  dune.addColorStop(0, "#efcf85");
  dune.addColorStop(0.75, "#ecca80");
  dune.addColorStop(1, "rgba(236,202,128,0)");
  g.fillStyle = dune;
  g.scale(0.42, 1);
  g.beginPath();
  g.arc(0, 0, 62, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.lineWidth = 1.5;
  g.strokeStyle = "rgba(90,120,84,0.75)";
  g.stroke(land);

  const sand = path(sandRings);
  g.fillStyle = "#f3e3b2";
  g.fill(sand);
  g.strokeStyle = "rgba(190,165,105,0.8)";
  g.stroke(sand);
  return c;
}

interface Particle {
  x: number;
  y: number;
  life: number;
  max: number;
}

export interface Boat {
  x: number;
  y: number;
  heading: number;
  twd: number;
  color: string;
  label?: string;
  size: number;
  speedKn: number;
}

export interface DrawInput {
  course: RaceCourse;
  /** Index of the next gate. Gates before it are drawn as passed. */
  nextMark: number;
  player: Boat | null;
  others: Boat[];
  trail: number[] | null;
  prediction: BoatState[] | null;
  /** Heading preview around the boat, while the player is setting a course. */
  draftHeading: number | null;
  windAt: (x: number, y: number) => { twd: number; tws: number };
  tideM: number;
}

// The fixed layers are costly to build and the same for every view.
let layers: { water: WaterLayer; land: HTMLCanvasElement } | null = null;

/** Full-screen map: fixed layers cached off-screen, only moving things redrawn each frame. */
export class MapView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly water: WaterLayer;
  private readonly land: HTMLCanvasElement;
  private particles: Particle[] = [];
  private dpr = 1;
  width = 0;
  height = 0;
  centerX = 0;
  centerY = 0;
  /** Pixels per metre, in CSS pixels. */
  zoom = 0.05;
  private time = 0;

  constructor(canvas: HTMLCanvasElement, draftM: number) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
    layers ??= { water: new WaterLayer(seabed, draftM), land: buildLandLayer(seabed) };
    this.water = layers.water;
    this.land = layers.land;
    this.resize();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.particles = [];
  }

  sx(x: number): number {
    return this.width / 2 + (x - this.centerX) * this.zoom;
  }

  sy(y: number): number {
    return this.height / 2 - (y - this.centerY) * this.zoom;
  }

  toWorld(px: number, py: number): Vec {
    return { x: this.centerX + (px - this.width / 2) / this.zoom, y: this.centerY - (py - this.height / 2) / this.zoom };
  }

  minZoom(): number {
    return Math.max(this.width / (seabed.maxX - seabed.minX), this.height / (seabed.maxY - seabed.minY));
  }

  clampView(): void {
    this.zoom = Math.max(this.minZoom(), Math.min(0.6, this.zoom));
    const hw = this.width / 2 / this.zoom;
    const hh = this.height / 2 / this.zoom;
    this.centerX = Math.max(seabed.minX + hw, Math.min(seabed.maxX - hw, this.centerX));
    this.centerY = Math.max(seabed.minY + hh, Math.min(seabed.maxY - hh, this.centerY));
  }

  fit(points: Vec[], paddingPx = 70): void {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    this.centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    this.centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
    this.zoom = Math.min((this.width - paddingPx * 2) / Math.max(w, 1), (this.height - paddingPx * 2) / Math.max(h, 1));
    this.clampView();
  }

  draw(d: DrawInput, dtS: number): void {
    const g = this.ctx;
    this.time += dtS;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.water.update(d.tideM);
    const worldW = seabed.maxX - seabed.minX;
    const worldH = seabed.maxY - seabed.minY;
    const x0 = this.sx(seabed.minX);
    const y0 = this.sy(seabed.maxY);
    const w = worldW * this.zoom;
    const h = worldH * this.zoom;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "medium";
    g.drawImage(this.water.canvas, x0, y0, w, h);
    this.drawParticles(d, dtS);
    g.drawImage(this.land, x0, y0, w, h);
    this.drawLabels();
    this.drawCourse(d);
    if (d.trail) this.drawTrail(d.trail);
    if (d.prediction) this.drawPrediction(d.prediction);
    for (const b of d.others) this.drawBoat(b);
    if (d.player) {
      if (d.draftHeading !== null) this.drawHeadingRing(d.player, d.draftHeading);
      // A halo keeps your own boat easy to spot in a crowded start.
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.strokeStyle = "#e8674f";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(this.sx(d.player.x), this.sy(d.player.y), d.player.size + 8, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      this.drawBoat(d.player);
    }
  }

  private drawParticles(d: DrawInput, dtS: number): void {
    const g = this.ctx;
    const centre = this.toWorld(this.width / 2, this.height / 2);
    const tws = d.windAt(centre.x, centre.y).tws;
    const small = this.width * this.height < 500000;
    const target = Math.round(Math.min(small ? 170 : 340, (small ? 40 : 80) + tws * (small ? 9 : 18)));
    while (this.particles.length < target) this.particles.push(this.spawn(true));
    if (this.particles.length > target) this.particles.length = target;
    const toRad = Math.PI / 180;
    g.lineCap = "round";
    g.lineWidth = 1.3;
    g.strokeStyle = "rgba(255,255,255,0.62)";
    g.beginPath();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.life += dtS;
      const out = p.x < this.toWorld(0, 0).x || p.x > this.toWorld(this.width, 0).x;
      if (p.life > p.max || out) {
        this.particles[i] = this.spawn(false);
        continue;
      }
      const wind = d.windAt(p.x, p.y);
      const a = wind.twd * toRad;
      // Moves with the wind: fast enough to read on screen at any zoom level.
      const pxPerS = 7 + wind.tws * 3.2;
      const dx = -Math.sin(a);
      const dy = -Math.cos(a);
      p.x += (dx * pxPerS * dtS) / this.zoom;
      p.y += (dy * pxPerS * dtS) / this.zoom;
      const sxp = this.sx(p.x);
      const syp = this.sy(p.y);
      const len = 5 + wind.tws * 1.1;
      g.moveTo(sxp, syp);
      g.lineTo(sxp - dx * len, syp + dy * len);
    }
    g.stroke();
  }

  private spawn(anywhere: boolean): Particle {
    const a = this.toWorld(0, 0);
    const b = this.toWorld(this.width, this.height);
    const max = 1.4 + Math.random() * 2.4;
    return {
      x: a.x + Math.random() * (b.x - a.x),
      y: b.y + Math.random() * (a.y - b.y),
      life: anywhere ? Math.random() * max : 0,
      max,
    };
  }

  private drawLabels(): void {
    const g = this.ctx;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.font = "600 12px 'Trebuchet MS', 'Segoe UI', sans-serif";
    for (const [name, lat, lon] of LABELS) {
      const p = toXY(lat, lon);
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      if (x < -60 || y < -20 || x > this.width + 60 || y > this.height + 20) continue;
      g.lineWidth = 3;
      g.strokeStyle = "rgba(60,94,68,0.75)";
      g.strokeText(name, x, y);
      g.fillStyle = "#f7f5e4";
      g.fillText(name, x, y);
    }
    if (this.zoom < 0.04) return;
    g.font = "600 10.5px 'Trebuchet MS', 'Segoe UI', sans-serif";
    for (const [name, lat, lon, kind] of LANDMARKS) {
      const p = toXY(lat, lon);
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      if (x < -60 || y < -30 || x > this.width + 60 || y > this.height + 30) continue;
      this.drawLandmark(kind, x, y);
      g.lineWidth = 3;
      g.strokeStyle = "rgba(255,255,255,0.75)";
      g.strokeText(name, x, y + 15);
      g.fillStyle = "#35525a";
      g.fillText(name, x, y + 15);
    }
  }

  private drawLandmark(kind: LandmarkKind, x: number, y: number): void {
    const g = this.ctx;
    g.save();
    g.translate(x, y);
    g.lineWidth = 1.2;
    g.strokeStyle = "#35525a";
    if (kind === "lighthouse") {
      g.fillStyle = "#fff";
      g.beginPath();
      g.moveTo(-3, 6);
      g.lineTo(-2, -6);
      g.lineTo(2, -6);
      g.lineTo(3, 6);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = "#e8674f";
      g.fillRect(-2.5, -2, 5, 3);
      g.fillStyle = "#f6c945";
      g.beginPath();
      g.arc(0, -8, 2.2, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    } else if (kind === "dune") {
      g.fillStyle = "#e4bb6c";
      g.beginPath();
      g.moveTo(-9, 5);
      g.quadraticCurveTo(-2, -9, 9, 5);
      g.closePath();
      g.fill();
      g.stroke();
    } else if (kind === "huts") {
      for (const dx of [-5, 5]) {
        g.fillStyle = "#b5835a";
        g.fillRect(dx - 3.5, -5, 7, 5);
        g.strokeRect(dx - 3.5, -5, 7, 5);
        g.beginPath();
        g.moveTo(dx - 3, 0);
        g.lineTo(dx - 3, 6);
        g.moveTo(dx + 3, 0);
        g.lineTo(dx + 3, 6);
        g.stroke();
      }
    } else if (kind === "jetty") {
      g.fillStyle = "#c9a26f";
      g.fillRect(-1.8, -8, 3.6, 14);
      g.strokeRect(-1.8, -8, 3.6, 14);
    } else if (kind === "port") {
      g.beginPath();
      g.arc(0, -4, 2, 0, Math.PI * 2);
      g.moveTo(0, -2);
      g.lineTo(0, 6);
      g.moveTo(-5, 2);
      g.quadraticCurveTo(0, 8, 5, 2);
      g.stroke();
    } else {
      g.strokeStyle = "#6c7f6a";
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(-8, i * 4);
        g.lineTo(8, i * 4);
        g.stroke();
      }
    }
    g.restore();
  }

  private drawCourse(d: DrawInput): void {
    const g = this.ctx;
    const c = d.course;
    const line = (a: Vec, b: Vec, color: string): void => {
      g.strokeStyle = color;
      g.lineWidth = 3;
      g.setLineDash([7, 5]);
      g.beginPath();
      g.moveTo(this.sx(a.x), this.sy(a.y));
      g.lineTo(this.sx(b.x), this.sy(b.y));
      g.stroke();
      g.setLineDash([]);
      for (const p of [a, b]) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(this.sx(p.x), this.sy(p.y), 4, 0, Math.PI * 2);
        g.fill();
      }
    };
    line(c.startA, c.startB, "#ffffff");
    line(c.finishA, c.finishB, "#2b3a3e");

    // Leg lines, faint, to read the course at a glance.
    const pts: Vec[] = [
      { x: (c.startA.x + c.startB.x) / 2, y: (c.startA.y + c.startB.y) / 2 },
      ...c.gates.map((m) => m.buoy),
      { x: (c.finishA.x + c.finishB.x) / 2, y: (c.finishA.y + c.finishB.y) / 2 },
    ];
    g.strokeStyle = "rgba(20,70,90,0.28)";
    g.lineWidth = 1.5;
    g.setLineDash([2, 6]);
    g.beginPath();
    pts.forEach((p, i) => (i === 0 ? g.moveTo(this.sx(p.x), this.sy(p.y)) : g.lineTo(this.sx(p.x), this.sy(p.y))));
    g.stroke();
    g.setLineDash([]);

    c.gates.forEach((gate, i) => {
      const x = this.sx(gate.buoy.x);
      const y = this.sy(gate.buoy.y);
      const passed = i < d.nextMark;
      const isNext = i === d.nextMark;
      const color = gate.side === "port" ? "#d8412f" : "#1f9d57";
      if (isNext) {
        // The valid side, as a short band leaving the buoy towards the fictive point.
        const ex = this.sx(gate.buoy.x + (gate.end.x - gate.buoy.x) * 0.35);
        const ey = this.sy(gate.buoy.y + (gate.end.y - gate.buoy.y) * 0.35);
        g.strokeStyle = "rgba(255,255,255,0.75)";
        g.lineWidth = 2.5;
        g.setLineDash([3, 5]);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(ex, ey);
        g.stroke();
        g.setLineDash([]);
        const pulse = 13 + Math.sin(this.time * 3) * 3;
        g.strokeStyle = "rgba(255,255,255,0.9)";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, pulse, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = passed ? 0.45 : 1;
      g.fillStyle = color;
      g.strokeStyle = "#fff";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = "#fff";
      g.font = "700 10px 'Trebuchet MS', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(passed ? "✓" : String(i + 1), x, y + 0.5);
      g.font = "600 11px 'Trebuchet MS', sans-serif";
      g.lineWidth = 3;
      g.strokeStyle = "rgba(255,255,255,0.85)";
      g.strokeText(gate.name, x, y - 19);
      g.fillStyle = "#1d4450";
      g.fillText(gate.name, x, y - 19);
      g.globalAlpha = 1;
    });
  }

  private drawTrail(t: number[]): void {
    if (t.length < 4) return;
    const g = this.ctx;
    g.strokeStyle = "rgba(255,255,255,0.7)";
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < t.length; i += 2) {
      const x = this.sx(t[i]);
      const y = this.sy(t[i + 1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  private drawPrediction(track: BoatState[]): void {
    if (track.length < 2) return;
    const g = this.ctx;
    const end = track[track.length - 1];
    g.strokeStyle = "rgba(232,103,79,0.95)";
    g.lineWidth = 2.5;
    g.setLineDash([8, 6]);
    g.beginPath();
    track.forEach((s, i) => {
      const x = this.sx(s.x);
      const y = this.sy(s.y);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.setLineDash([]);
    // One dot every five minutes.
    g.fillStyle = "#fff";
    g.strokeStyle = "rgba(232,103,79,0.95)";
    g.lineWidth = 2;
    for (let i = 30; i < track.length; i += 30) {
      g.beginPath();
      g.arc(this.sx(track[i].x), this.sy(track[i].y), 3.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    if (end.status === "grounded") {
      const x = this.sx(end.x);
      const y = this.sy(end.y);
      g.strokeStyle = "#b3261e";
      g.lineWidth = 3.5;
      g.beginPath();
      g.moveTo(x - 7, y - 7);
      g.lineTo(x + 7, y + 7);
      g.moveTo(x + 7, y - 7);
      g.lineTo(x - 7, y + 7);
      g.stroke();
    }
  }

  private drawHeadingRing(b: Boat, heading: number): void {
    const g = this.ctx;
    const x = this.sx(b.x);
    const y = this.sy(b.y);
    const R = 64;
    const a = (heading * Math.PI) / 180;
    g.strokeStyle = "rgba(255,255,255,0.65)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, y, R, 0, Math.PI * 2);
    g.stroke();
    // No-go sector.
    const wind = ((b.twd - 90) * Math.PI) / 180;
    const noGo = (40 * Math.PI) / 180;
    g.fillStyle = "rgba(216,65,47,0.25)";
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, R, wind - noGo, wind + noGo);
    g.closePath();
    g.fill();
    g.fillStyle = "#e8674f";
    g.strokeStyle = "#fff";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x + Math.sin(a) * R, y - Math.cos(a) * R, 9, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  private drawBoat(b: Boat): void {
    const g = this.ctx;
    const x = this.sx(b.x);
    const y = this.sy(b.y);
    if (x < -40 || y < -40 || x > this.width + 40 || y > this.height + 40) return;
    const dir = headingVec(b.heading);
    // Wake: a short V, longer as the boat goes faster.
    if (b.speedKn > 0.5) {
      const len = b.size * (1 + b.speedKn * 0.16);
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.lineWidth = 1.5;
      const tx = x - dir.x * b.size * 0.8;
      const ty = y + dir.y * b.size * 0.8;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(tx - dir.y * s * 2, ty - dir.x * s * 2);
        g.lineTo(tx - dir.x * len - dir.y * s * len * 0.28, ty + dir.y * len - dir.x * s * len * 0.28);
        g.stroke();
      }
    }
    g.save();
    g.translate(x, y);
    g.rotate((b.heading * Math.PI) / 180);
    const s = b.size;
    // Twin hulls.
    g.fillStyle = b.color;
    g.strokeStyle = "rgba(20,50,60,0.85)";
    g.lineWidth = 1;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(side * s * 0.42, -s);
      g.quadraticCurveTo(side * s * 0.62, 0, side * s * 0.55, s * 0.85);
      g.lineTo(side * s * 0.3, s * 0.85);
      g.quadraticCurveTo(side * s * 0.25, 0, side * s * 0.42, -s);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.fillRect(-s * 0.36, -s * 0.2, s * 0.72, s * 0.5);
    // Sail: swings to leeward, further out as the boat bears away.
    const twa = norm180(b.heading - b.twd);
    const swing = ((Math.min(85, Math.abs(twa) * 0.55) * (twa >= 0 ? 1 : -1)) * Math.PI) / 180;
    g.rotate(swing);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 3;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(0, -s * 0.1);
    g.quadraticCurveTo(-Math.sign(twa || 1) * s * 0.3, s * 0.5, 0, s * 1.05);
    g.stroke();
    g.restore();
    if (b.label) {
      g.font = "600 10.5px 'Trebuchet MS', sans-serif";
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.lineWidth = 3;
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.strokeText(b.label, x + s + 5, y);
      g.fillStyle = "#1d4450";
      g.fillText(b.label, x + s + 5, y);
    }
  }
}
