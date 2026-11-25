/**
 * The chart plate behind every app page's header: the landing page's lattice sea, seen from the deck in
 * plain 2D canvas (no three.js on the app pages). The lattice has the same basis as the landing scene,
 * (1, 0) and (0.42, 0.91), laid on a plane in perspective. Vigil's lamp stands on the horizon and sweeps
 * the sea; the points in its beam are lit. Each new block on the chain sends a ring out from the lamp.
 *
 * The plate lives in the app shell, so it stays put while pages change: a page change only turns the
 * lamp to a new heading. It draws only while it is on screen and the tab is visible, and with reduced
 * motion it draws one still frame.
 */

export interface Plate {
  /** A new block: a ring goes out from the lamp. */
  pulse(): void;
  /** Turn the lamp to a page's heading (radians from straight ahead; positive turns right). */
  turn(heading: number): void;
  /** Re-read the theme's colours (day or night). */
  retheme(): void;
  dispose(): void;
}

interface Pt {
  /** World position on the sea plane: x across, z away from the eye. */
  x: number;
  z: number;
  /** A per-point phase, so the swell is not uniform. */
  ph: number;
}

const B2 = { x: 0.42, z: 0.91 };
const TAU = Math.PI * 2;

const rgb = (css: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [234, 228, 214];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function startPlate(canvas: HTMLCanvasElement, opts: { reduced: boolean }): Plate {
  const ctx = canvas.getContext("2d", { alpha: true })!;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let pts: Pt[] = [];
  let ink: [number, number, number] = [234, 228, 214];
  let lamp: [number, number, number] = [243, 179, 61];
  let day = false;
  // Camera: eye height over the sea, focal length, and the horizon's place on the canvas.
  const eye = 1.25;
  let f = 600;
  let horizon = 0;
  let lampX = 0;
  // Lamp heading: current and target, plus the sweep's own slow swing.
  let heading = 0.18;
  let target = 0.18;
  const rings: number[] = [];
  let raf = 0;
  let visible = true;
  let last = performance.now();
  let t = 0;

  function retheme(): void {
    const cs = getComputedStyle(document.documentElement);
    ink = rgb(cs.getPropertyValue("--chart") || "#eae4d6");
    lamp = rgb(cs.getPropertyValue("--lamp-glow") || "#f3b33d");
    day = (cs.getPropertyValue("color-scheme") || "").includes("light") && !(cs.getPropertyValue("color-scheme") || "").includes("dark");
    if (opts.reduced) draw();
  }

  function layout(): void {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const phone = w < 700;
    f = phone ? w * 1.15 : Math.min(w * 0.62, 900);
    // The horizon runs just under the site header, with the lamp on it above the soundings column.
    horizon = phone ? 96 : 104;
    lampX = w * (phone ? 0.8 : 0.78);
    // The lattice: rows along the second basis vector, out to the far edge of the plate.
    const s = phone ? 0.95 : 0.62;
    const zNear = 1.1;
    const zFar = phone ? 26 : 34;
    pts = [];
    for (let j = 0; ; j++) {
      const z = zNear + j * B2.z * s;
      if (z > zFar) break;
      const halfW = ((w / 2 + 40) * z) / f;
      const shift = (j * B2.x * s) % s;
      const cx = ((lampX - w / 2) * z) / f;
      const i0 = Math.floor((cx - halfW - shift) / s);
      const i1 = Math.ceil((cx + halfW - shift) / s);
      for (let i = i0; i <= i1; i++) {
        const x = i * s + shift;
        pts.push({ x, z, ph: Math.sin(i * 12.9898 + j * 78.233) * 43758.5453 });
      }
    }
    if (opts.reduced) draw();
  }

  function draw(): void {
    ctx.clearRect(0, 0, w, h);
    const sweep = opts.reduced ? 0 : Math.sin(t * 0.00021) * 0.32;
    const dir = heading + sweep;
    const half = 0.17; // the beam's half-angle, as on the mark
    const lampWorldX = ((lampX - w / 2) * 40) / f;
    const lampZ = 40;
    const [ir, ig, ib] = ink;
    const [lr, lg, lb] = lamp;
    const baseA = day ? 0.42 : 0.4;
    for (const p of pts) {
      const swell = opts.reduced ? 0 : Math.sin(p.x * 0.9 + t * 0.0011 + p.ph) * 0.05 + Math.sin(p.z * 0.7 - t * 0.0008) * 0.04;
      const sy = horizon + ((eye + swell) * f) / p.z;
      if (sy > h + 4) continue;
      const sx = w / 2 + (p.x * f) / p.z;
      if (sx < -4 || sx > w + 4) continue;
      // Angle from the lamp (on the horizon, far away) towards the point, on the sea plane.
      const dx = p.x - lampWorldX;
      const dz = lampZ - p.z;
      const ang = Math.atan2(dx, dz);
      const off = Math.abs(ang + dir);
      let lit = off < half ? 1 - off / half : 0;
      lit = lit * lit;
      const dist = Math.hypot(dx, dz);
      let ring = 0;
      for (const r of rings) {
        const d = Math.abs(dist - r);
        if (d < 1.4) ring = Math.max(ring, (1 - d / 1.4) * Math.max(0, 1 - r / 46));
      }
      // Nearer points are larger and stronger; far ones fade into the haze.
      const near = Math.min(1, 5 / p.z);
      const fog = Math.max(0, 1 - p.z / 38);
      const size = 0.7 + near * 1.6 + lit * 1.2 + ring * 1.2;
      const a = (baseA * (0.35 + near * 0.65) + lit * 0.55 + ring * 0.5) * fog;
      if (a < 0.015) continue;
      const k = Math.min(1, lit * 1.2 + ring);
      ctx.fillStyle = `rgba(${Math.round(ir + (lr - ir) * k)},${Math.round(ig + (lg - ig) * k)},${Math.round(ib + (lb - ib) * k)},${a.toFixed(3)})`;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
    // The lamp on the horizon, with its glow and the beam's two edges, faint.
    const ly = horizon - 2;
    const g = ctx.createRadialGradient(lampX, ly, 0, lampX, ly, 40);
    g.addColorStop(0, `rgba(${lr},${lg},${lb},${day ? 0.5 : 0.55})`);
    g.addColorStop(1, `rgba(${lr},${lg},${lb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(lampX - 48, ly - 48, 96, 96);
    ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
    ctx.beginPath();
    ctx.arc(lampX, ly, 3.2, 0, TAU);
    ctx.fill();
  }

  function loop(now: number): void {
    const dt = Math.min(64, now - last);
    last = now;
    t += dt;
    heading += (target - heading) * Math.min(1, dt / 260);
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i]! += dt * 0.012;
      if (rings[i]! > 48) rings.splice(i, 1);
    }
    draw();
    raf = requestAnimationFrame(loop);
  }

  function run(): void {
    cancelAnimationFrame(raf);
    if (opts.reduced || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  const io = new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    run();
  });
  io.observe(canvas);
  const onVis = () => run();
  document.addEventListener("visibilitychange", onVis);
  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas);

  retheme();
  layout();
  if (opts.reduced) draw();
  else run();

  return {
    pulse() {
      if (!opts.reduced && rings.length < 4) rings.push(0);
    },
    turn(next) {
      target = next;
      if (opts.reduced) {
        heading = next;
        draw();
      }
    },
    retheme,
    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}
