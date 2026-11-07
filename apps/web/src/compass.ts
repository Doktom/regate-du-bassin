import { NO_GO_DEG, norm360 } from "@regate/sim";

export interface CompassState {
  heading: number;
  /** Heading being set by the player, or null. */
  draft: number | null;
  twd: number;
  tws: number;
  /** Bearing of the next mark. */
  target: number;
  /** Best angles to the wind, drawn as green ticks. */
  upwind: number;
  downwind: number;
  speedKn: number;
}

const RAD = Math.PI / 180;

/** Round compass at the bottom of the screen: the one control needed to play. */
export class Compass {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private size = 0;
  private dragging = false;
  onChange: ((heading: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.fromEvent(e);
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.dragging) this.fromEvent(e);
    });
    const stop = (): void => {
      this.dragging = false;
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  private fromEvent(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2;
    const dy = e.clientY - r.top - r.height / 2;
    if (Math.hypot(dx, dy) < 6) return;
    this.onChange?.(Math.round(norm360((Math.atan2(dx, -dy) * 180) / Math.PI)));
  }

  draw(s: CompassState): void {
    const css = this.canvas.getBoundingClientRect().width;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.size !== css) {
      this.size = css;
      this.canvas.width = Math.round(css * dpr);
      this.canvas.height = Math.round(css * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, css, css);
    const c = css / 2;
    const R = c - 4;
    const polar = (deg: number, r: number): [number, number] => [
      c + Math.sin(deg * RAD) * r,
      c - Math.cos(deg * RAD) * r,
    ];

    g.fillStyle = "rgba(255,255,255,0.93)";
    g.strokeStyle = "rgba(20,70,90,0.35)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    const sector = (from: number, to: number, color: string, inner: number): void => {
      g.fillStyle = color;
      g.beginPath();
      g.arc(c, c, R - 1, (from - 90) * RAD, (to - 90) * RAD);
      g.arc(c, c, inner, (to - 90) * RAD, (from - 90) * RAD, true);
      g.closePath();
      g.fill();
    };
    // No-go sector, then the band a catamaran sails best in on each side.
    sector(s.twd - NO_GO_DEG, s.twd + NO_GO_DEG, "rgba(216,65,47,0.3)", R * 0.62);
    for (const side of [-1, 1]) {
      for (const a of [s.upwind, s.downwind]) {
        const h = s.twd + side * a;
        sector(h - 2.5, h + 2.5, "rgba(31,157,87,0.75)", R * 0.76);
      }
    }

    g.strokeStyle = "rgba(20,70,90,0.55)";
    for (let a = 0; a < 360; a += 10) {
      const major = a % 30 === 0;
      g.lineWidth = major ? 1.5 : 1;
      const [x0, y0] = polar(a, R - (major ? 8 : 4));
      const [x1, y1] = polar(a, R - 1);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    g.fillStyle = "#1d4450";
    g.font = `700 ${Math.max(10, css * 0.065)}px 'Trebuchet MS', sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const [t, a] of [["N", 0], ["E", 90], ["S", 180], ["O", 270]] as [string, number][]) {
      const [x, y] = polar(a, R - 18);
      g.fillText(t, x, y);
    }

    // Wind: a blue arrow pointing the way it blows, from the rim.
    const [wx0, wy0] = polar(s.twd, R - 1);
    const [wx1, wy1] = polar(s.twd, R * 0.55);
    g.strokeStyle = "#1565a8";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(wx0, wy0);
    g.lineTo(wx1, wy1);
    g.stroke();
    const [ax, ay] = polar(s.twd - 9, R * 0.68);
    const [bx, by] = polar(s.twd + 9, R * 0.68);
    g.fillStyle = "#1565a8";
    g.beginPath();
    g.moveTo(wx1, wy1);
    g.lineTo(ax, ay);
    g.lineTo(bx, by);
    g.closePath();
    g.fill();

    // Next mark: a small buoy on the rim.
    const [tx, ty] = polar(s.target, R - 2);
    g.fillStyle = "#f6c945";
    g.strokeStyle = "#1d4450";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(tx, ty, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // Current heading: thin line. Course being set: strong needle.
    const needle = (h: number, color: string, width: number, reach: number): void => {
      const [x, y] = polar(h, R * reach);
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(x, y);
      g.stroke();
    };
    if (s.draft !== null) needle(s.heading, "rgba(29,68,80,0.35)", 3, 0.8);
    needle(s.draft ?? s.heading, "#e8674f", 4.5, 0.86);

    g.fillStyle = "rgba(255,255,255,0.96)";
    g.beginPath();
    g.arc(c, c, R * 0.33, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1d4450";
    g.font = `800 ${css * 0.115}px 'Trebuchet MS', sans-serif`;
    g.fillText(`${Math.round(s.draft ?? s.heading)}°`, c, c - css * 0.03);
    g.font = `600 ${css * 0.068}px 'Trebuchet MS', sans-serif`;
    g.fillText(`${s.speedKn.toFixed(1)} nd`, c, c + css * 0.075);
  }
}
