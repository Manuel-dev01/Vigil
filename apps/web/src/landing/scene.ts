/**
 * The landing page's scene: a lattice sea at night, swept by Vigil's lamp, and one batch taken through
 * its life as the page scrolls (signed, batched, re-executed, fronted, final). A forged twin flares red
 * and sinks. Each new block on the real chain sends a faint ring out from the lamp; each anchored batch
 * stands as a beacon in the row behind.
 *
 * One render loop, driven by the page (`frame`). Only this module imports three.js, and the landing
 * page loads it after first paint.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";

export interface Progress {
  /** 0 at the top of the page, 1 when the hero has scrolled away. */
  hero: number;
  /** 0 to 5 through the batch's life (one unit per step); 0 before it, 5 after. */
  life: number;
  /** 0 to 1 as the dawn section comes in. */
  dawn: number;
}

export interface Watch {
  frame(timeMs: number, p: Progress): void;
  /** A new block: a ring goes out from the lamp. */
  pulse(): void;
  /** How many anchored batches stand in the row (they rise one by one). */
  setBeacons(n: number): void;
  resize(): void;
  dispose(): void;
}

const INK = new Color("#eae4d6");
const LAMP = new Color("#f3b33d");
const PORT = new Color("#ee5a3f");
const NIGHT = new Color("#0a1016");

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const LATTICE_VS = /* glsl */ `
uniform float uTime, uBeamCos, uBeamOn, uPulse, uFocusAmt, uSize, uPx;
uniform vec3 uLamp, uFocus;
uniform vec2 uBeam;
varying float vLight;
varying float vFar;
float swell(vec2 p, float t) {
  return 0.20 * sin(0.21 * p.x + 0.55 * t) + 0.15 * sin(0.17 * p.y - 0.42 * t + 1.3) + 0.06 * sin(0.63 * (p.x + p.y) + 1.05 * t);
}
void main() {
  vec3 p = position;
  p.y += swell(p.xz, uTime);
  vec2 d = p.xz - uLamp.xz;
  float dist = length(d);
  float c = dot(d / max(dist, 0.001), uBeam);
  float beam = uBeamOn * smoothstep(uBeamCos - 0.012, uBeamCos + 0.006, c) * (1.0 - smoothstep(3.0, 72.0, dist));
  float ring = uPulse * 15.0;
  float pulse = exp(-abs(dist - ring) * 1.3) * (1.0 - smoothstep(0.4, 3.2, uPulse)) * 0.5;
  float focus = uFocusAmt * exp(-length(p.xz - uFocus.xz) * 0.42);
  vLight = clamp(beam + pulse + focus, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFar = smoothstep(26.0, 96.0, -mv.z);
  gl_PointSize = max(1.0, uSize * uPx * (1.0 + vLight * 0.7) * (12.0 / -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const LATTICE_FS = /* glsl */ `
uniform vec3 uInk, uLampC;
uniform float uFade;
varying float vLight;
varying float vFar;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float soft = 1.0 - smoothstep(0.16, 0.5, r);
  vec3 col = mix(uInk * 0.8, uLampC, vLight);
  float a = soft * (0.42 + 0.58 * vLight) * (1.0 - vFar) * uFade;
  gl_FragColor = vec4(col, a);
}`;

const BEAM_VS = /* glsl */ `
uniform float uLen;
varying float vAlong;
varying vec3 vN;
varying vec3 vV;
void main() {
  vAlong = -position.y / uLen;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FS = /* glsl */ `
uniform vec3 uLampC;
uniform float uOn;
varying float vAlong;
varying vec3 vN;
varying vec3 vV;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float a = uOn * 0.15 * pow(facing, 1.6) * (1.0 - smoothstep(0.0, 1.0, vAlong)) * smoothstep(0.0, 0.03, vAlong);
  gl_FragColor = vec4(uLampC, a);
}`;

/** Soft round lights (the lamp, sparks, beacon tops): one size and colour per material. */
const GLOW_VS = /* glsl */ `
uniform float uSize, uPx;
attribute float aOn;
varying float vOn;
void main() {
  vOn = aOn;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * uPx * (12.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uFade;
varying float vOn;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = exp(-r * r * 18.0);
  float halo = exp(-r * r * 3.5) * 0.35;
  gl_FragColor = vec4(uColor, (core + halo) * vOn * uFade);
}`;

function glow(color: Color, size: number, px: number, count: number): { points: Points; on: BufferAttribute; pos: BufferAttribute; mat: ShaderMaterial } {
  const g = new BufferGeometry();
  const pos = new BufferAttribute(new Float32Array(count * 3), 3);
  const on = new BufferAttribute(new Float32Array(count).fill(1), 1);
  g.setAttribute("position", pos);
  g.setAttribute("aOn", on);
  const mat = new ShaderMaterial({
    vertexShader: GLOW_VS,
    fragmentShader: GLOW_FS,
    uniforms: { uSize: { value: size }, uPx: { value: px }, uColor: { value: color.clone() }, uFade: { value: 1 } },
    transparent: true,
    depthWrite: false,
    // Lights draw over the slabs they sit on.
    depthTest: false,
    blending: AdditiveBlending,
  });
  const points = new Points(g, mat);
  points.renderOrder = 10;
  points.frustumCulled = false;
  return { points, on, pos, mat };
}

export function startWatch(canvas: HTMLCanvasElement, opts: { reduced: boolean }): Watch | undefined {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return undefined;
  }
  const small = () => innerWidth < 720;
  const px = Math.min(devicePixelRatio || 1, small() ? 1.5 : 1.75);
  renderer.setPixelRatio(px);
  renderer.setClearColor(NIGHT, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 200);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);

  // ------------------------------------------------------------------ the lattice sea
  // A skewed lattice (basis (1, 0) and (0.42, 0.91)), not a square grid: the lattices under ML-DSA
  // and ML-KEM have bases too. Wider than the view at every depth.
  const S = small() ? 0.95 : 0.62;
  const B2X = 0.42;
  const B2Z = 0.91;
  const verts: number[] = [];
  for (let j = 0; ; j++) {
    const z = 7 - j * S * B2Z;
    if (z < -96) break;
    const maxX = 12 + (7 - z) * 1.0;
    const shift = ((j * S * B2X) % S) - S / 2;
    for (let x = -maxX + shift; x < maxX; x += S) verts.push(x, 0, z);
  }
  const latticeGeo = keep(new BufferGeometry());
  latticeGeo.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
  const lamp = new Vector3(2.5, 1.6, -11);
  const latticeMat = keep(
    new ShaderMaterial({
      vertexShader: LATTICE_VS,
      fragmentShader: LATTICE_FS,
      uniforms: {
        uTime: { value: 0 },
        uLamp: { value: lamp },
        uBeam: { value: new Vector2(0, -1) },
        uBeamCos: { value: Math.cos(0.17) },
        uBeamOn: { value: 0 },
        uPulse: { value: 99 },
        uFocus: { value: new Vector3() },
        uFocusAmt: { value: 0 },
        uSize: { value: small() ? 3.0 : 2.5 },
        uPx: { value: px },
        uInk: { value: INK.clone() },
        uLampC: { value: LAMP.clone() },
        uFade: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const lattice = new Points(latticeGeo, latticeMat);
  lattice.frustumCulled = false;
  scene.add(lattice);

  // ------------------------------------------------------------------ the lamp and its beam
  const BEAM_LEN = 60;
  const HALF = 0.17;
  const coneGeo = keep(new ConeGeometry(Math.tan(HALF) * BEAM_LEN, BEAM_LEN, 48, 1, true));
  coneGeo.translate(0, -BEAM_LEN / 2, 0);
  const beamMat = keep(
    new ShaderMaterial({
      vertexShader: BEAM_VS,
      fragmentShader: BEAM_FS,
      uniforms: { uLen: { value: BEAM_LEN }, uLampC: { value: LAMP.clone() }, uOn: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    }),
  );
  const beam = new Mesh(coneGeo, beamMat);
  beam.position.copy(lamp);
  scene.add(beam);

  const lampGlow = glow(LAMP, 26, px, 1);
  lampGlow.pos.setXYZ(0, lamp.x, lamp.y, lamp.z);
  keep(lampGlow.points.geometry);
  keep(lampGlow.mat);
  scene.add(lampGlow.points);


  // ------------------------------------------------------------------ the batch and its forged twin
  const B = new Vector3(9, 0.35, -20);
  const F = new Vector3(11.6, 0.35, -21.4);
  const slabGeo = keep(new BoxGeometry(1.7, 0.16, 1.05));
  const slabEdges = keep(new EdgesGeometry(slabGeo));
  const makeSlab = (color: Color) => {
    const fill = keep(new MeshBasicMaterial({ color: NIGHT, transparent: true, opacity: 0 }));
    const line = keep(new LineBasicMaterial({ color: color.clone(), transparent: true, opacity: 0 }));
    const g = new Group();
    g.add(new Mesh(slabGeo, fill), new LineSegments(slabEdges, line));
    scene.add(g);
    return { g, fill, line };
  };
  const batch = makeSlab(INK);
  const forged = makeSlab(PORT);
  // Lights on the slabs: the forged one flares port red when caught; the real one glints when it passes.
  const flare = glow(PORT, 72, px, 1);
  const glint = glow(LAMP, 14, px, 1);
  for (const g of [flare, glint]) {
    keep(g.points.geometry);
    keep(g.mat);
    scene.add(g.points);
  }

  // The anchor: a line from the batch down into the sea.
  const anchorGeo = keep(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, -1, 0)]));
  const anchorMat = keep(new LineBasicMaterial({ color: LAMP, transparent: true, opacity: 0 }));
  const anchor = new Line(anchorGeo, anchorMat);
  scene.add(anchor);

  // Payments converging into the batch (step 1).
  const SPARKS = 7;
  const sparkFrom = Array.from({ length: SPARKS }, (_, i) => {
    const a = (i / SPARKS) * Math.PI * 2 + 0.6;
    const r = 5 + (i % 3) * 1.6;
    return new Vector3(B.x + Math.cos(a) * r, 0.2 + (i % 2) * 0.5, B.z + Math.sin(a) * r * 0.7);
  });
  const sparks = glow(INK, 7, px, SPARKS);
  keep(sparks.points.geometry);
  keep(sparks.mat);
  scene.add(sparks.points);

  // The exit: a line from the batch to the payout, drawn as it is paid (step 4).
  const EXIT_N = 64;
  const payout = new Vector3(B.x - 10, 0.3, B.z + 12);
  const exitPts: Vector3[] = [];
  for (let i = 0; i <= EXIT_N; i++) {
    const t = i / EXIT_N;
    const p = new Vector3().lerpVectors(B, payout, t);
    p.y += Math.sin(t * Math.PI) * 2.4;
    exitPts.push(p);
  }
  const exitGeo = keep(new BufferGeometry().setFromPoints(exitPts));
  const exitMat = keep(new LineBasicMaterial({ color: LAMP, transparent: true, opacity: 0 }));
  const exitLine = new Line(exitGeo, exitMat);
  exitLine.frustumCulled = false;
  scene.add(exitLine);
  const exitHead = glow(LAMP, 12, px, 1);
  keep(exitHead.points.geometry);
  keep(exitHead.mat);
  scene.add(exitHead.points);

  // ------------------------------------------------------------------ the anchored record: beacons
  const MAX_BEACONS = 64;
  const beaconDir = new Vector3(0.5, 0, -0.86).normalize();
  const beaconStart = new Vector3(B.x + 2.4, 0, B.z - 2.6);
  const tickPos = new Float32Array(MAX_BEACONS * 6);
  const beaconTops = glow(LAMP, 6.5, px, MAX_BEACONS);
  for (let i = 0; i < MAX_BEACONS; i++) {
    const at = beaconStart.clone().addScaledVector(beaconDir, i * 1.45);
    tickPos.set([at.x, -0.2, at.z, at.x, 0.75, at.z], i * 6);
    beaconTops.pos.setXYZ(i, at.x, 0.8, at.z);
    beaconTops.on.setX(i, 0);
  }
  const tickGeo = keep(new BufferGeometry());
  tickGeo.setAttribute("position", new BufferAttribute(tickPos, 3));
  tickGeo.setDrawRange(0, 0);
  const tickMat = keep(new LineBasicMaterial({ color: LAMP, transparent: true, opacity: 0.55 }));
  const ticks = new LineSegments(tickGeo, tickMat);
  ticks.frustumCulled = false;
  scene.add(ticks);
  keep(beaconTops.points.geometry);
  keep(beaconTops.mat);
  scene.add(beaconTops.points);
  // Where the batch docks when final: the head of the row, where it stands as a beacon of its own.
  const dock = beaconStart.clone().addScaledVector(beaconDir, -1.45);
  const dockTickGeo = keep(new BufferGeometry().setFromPoints([new Vector3(dock.x, -0.2, dock.z), new Vector3(dock.x, 0.75, dock.z)]));
  const dockTickMat = keep(new LineBasicMaterial({ color: LAMP, transparent: true, opacity: 0 }));
  scene.add(new Line(dockTickGeo, dockTickMat));
  const docked = glow(LAMP, 9, px, 1);
  docked.pos.setXYZ(0, dock.x, 0.8, dock.z);
  keep(docked.points.geometry);
  keep(docked.mat);
  scene.add(docked.points);
  let beaconsWanted = 0;
  let beaconsShown = 0;
  let beaconClock = 0;

  // ------------------------------------------------------------------ camera
  const camPos = new Vector3();
  const camLook = new Vector3();
  // Keyframes, the batch's relative to where it floats.
  const at = (dx: number, dy: number, dz: number) => B.clone().add(new Vector3(dx, dy, dz));
  const K = {
    hero: { pos: new Vector3(0, 3.3, 14), look: new Vector3(0, 0, -14) },
    near: { pos: at(-3.8, 1.9, 12.6), look: B.clone() },
    exit: { pos: at(-7, 3.2, 19), look: at(-4.6, -0.1, 5) },
    rest: { pos: at(-9.5, 3.4, 15), look: at(1.2, 0.2, -4) },
  };
  const tmpA = new Vector3();
  const tmpB = new Vector3();
  const mixKey = (a: { pos: Vector3; look: Vector3 }, b: { pos: Vector3; look: Vector3 }, t: number) => {
    camPos.copy(a.pos).lerp(b.pos, t);
    camLook.copy(a.look).lerp(b.look, t);
  };

  let w = 0;
  let h = 0;
  const resize = () => {
    w = canvas.clientWidth || innerWidth;
    h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < h ? 62 : 45;
    // Shift the picture so the scene sits beside the words: right of the legend column on wide
    // screens, above the words on narrow ones.
    if (w >= 900) camera.setViewOffset(w, h, -w * 0.14, 0, w, h);
    else camera.setViewOffset(w, h, w * 0.12, h * 0.2, w, h);
    camera.updateProjectionMatrix();
  };
  resize();

  // ------------------------------------------------------------------ the frame
  let t0 = -1;
  let pulseAt = -1e9;
  const beamDir = new Vector3();
  const DOWN = new Vector3(0, -1, 0);
  const thetaTo = (p: Vector3) => Math.atan2(p.x - lamp.x, -(p.z - lamp.z));

  const frame = (now: number, p: Progress) => {
    if (t0 < 0) t0 = now;
    const motion = !opts.reduced;
    const t = motion ? (now - t0) / 1000 : 4;
    const intro = motion ? easeOut(t / 1.6) : 1;
    const beamOn = motion ? easeOut((t - 0.5) / 1.1) : 1;
    const s = motion ? p.life : 0;
    const dawn = motion ? p.dawn : 0;

    // Steps: s in [0,1] signed, [1,2] batched, [2,3] re-executed, [3,4] fronted, [4,5] final.
    const appear = smooth(0.25, 1.0, s);
    const anchored = smooth(1.15, 1.9, s);
    const lock = smooth(1.9, 2.4, s) * (1 - smooth(4.2, 4.9, s));
    const verified = smooth(2.3, 2.9, s);
    const forgedIn = smooth(2.05, 2.35, s);
    const forgedFlare = smooth(2.4, 2.55, s) * (1 - smooth(2.6, 2.9, s));
    const forgedSink = smooth(2.6, 3.0, s);
    const paid = smooth(3.15, 3.85, s);
    const settle = smooth(4.1, 4.9, s);

    // Beam: a slow sweep, or locked on the batch while it is checked.
    const sweep = 0.95 + 0.62 * Math.sin(t * 0.33);
    const theta = lerp(motion ? sweep : 1.05, thetaTo(B), lock);
    beamDir.set(Math.sin(theta), -0.055, -Math.cos(theta)).normalize();
    beam.quaternion.setFromUnitVectors(DOWN, beamDir);
    const fade = intro * (1 - dawn);
    const u = latticeMat.uniforms;
    u.uTime!.value = t;
    (u.uBeam!.value as Vector2).set(Math.sin(theta), -Math.cos(theta));
    u.uBeamOn!.value = beamOn;
    u.uPulse!.value = motion ? (now - pulseAt) / 1000 : 99;
    u.uFocus!.value = B;
    u.uFocusAmt!.value = appear * (0.25 + 0.55 * verified) * (1 - settle);
    u.uFade!.value = fade;
    beamMat.uniforms.uOn!.value = beamOn * (1 - dawn);
    lampGlow.mat.uniforms.uFade!.value = beamOn * (1 - dawn);

    // The batch.
    const bob = motion ? Math.sin(t * 0.9) * 0.05 : 0;
    const home = tmpA.copy(B);
    const dockTop = tmpB.copy(dock).setY(0.8);
    batch.g.position.copy(home).lerp(dockTop, settle);
    batch.g.position.y = lerp(lerp(-0.9, B.y, appear) + bob, dockTop.y, settle);
    batch.g.scale.setScalar(lerp(1, 0.18, settle));
    batch.fill.opacity = 0.9 * appear * (1 - settle);
    batch.line.opacity = appear * (1 - settle * 0.6);
    batch.line.color.copy(INK).lerp(LAMP, Math.max(verified, anchored * 0.35));

    glint.pos.setXYZ(0, batch.g.position.x, batch.g.position.y + 0.12, batch.g.position.z);
    glint.pos.needsUpdate = true;
    glint.on.setX(0, verified * (1 - settle) * (0.55 + 0.45 * smooth(2.3, 2.6, s) * (1 - smooth(2.6, 3.2, s))));
    glint.on.needsUpdate = true;
    dockTickMat.opacity = 0.75 * settle * fade;
    docked.on.setX(0, settle);
    docked.on.needsUpdate = true;
    docked.mat.uniforms.uFade!.value = fade;

    anchor.position.copy(batch.g.position);
    anchor.scale.y = 0.001 + 2.2 * anchored * (1 - settle);
    anchorMat.opacity = 0.8 * anchored * (1 - settle);

    // The forged twin: in, flare, sink.
    forged.g.position.set(F.x, lerp(lerp(-0.9, F.y, forgedIn), -2.2, forgedSink) + bob, F.z);
    forged.fill.opacity = 0.85 * forgedIn * (1 - forgedSink);
    forged.line.opacity = (0.55 + 0.45 * forgedFlare) * forgedIn * (1 - forgedSink);
    forged.g.scale.setScalar(1 + 0.12 * forgedFlare);
    flare.pos.setXYZ(0, forged.g.position.x, forged.g.position.y + 0.1, forged.g.position.z);
    flare.pos.needsUpdate = true;
    flare.on.setX(0, forgedIn * (0.25 + 0.75 * forgedFlare) * (1 - forgedSink));
    flare.on.needsUpdate = true;

    // Payments converging (step 1).
    for (let i = 0; i < SPARKS; i++) {
      const k = smooth(0.0 + i * 0.07, 0.6 + i * 0.07, s);
      sparks.pos.setXYZ(i, lerp(sparkFrom[i]!.x, B.x, k), lerp(sparkFrom[i]!.y, B.y, k), lerp(sparkFrom[i]!.z, B.z, k));
      sparks.on.setX(i, s > 0.02 ? 1 - smooth(0.75, 1.0, k) : 0);
    }
    sparks.pos.needsUpdate = true;
    sparks.on.needsUpdate = true;
    sparks.mat.uniforms.uFade!.value = fade;

    // The exit (step 4).
    const drawn = Math.floor(paid * EXIT_N);
    exitGeo.setDrawRange(0, drawn + 1);
    exitMat.opacity = 0.9 * (paid > 0 ? 1 : 0) * (1 - smooth(4.3, 4.9, s));
    const head = exitPts[Math.min(drawn, EXIT_N)]!;
    exitHead.pos.setXYZ(0, head.x, head.y, head.z);
    exitHead.pos.needsUpdate = true;
    exitHead.on.setX(0, paid > 0 && paid < 1 ? 1 : paid >= 1 ? 0.55 * (1 - smooth(4.3, 4.9, s)) : 0);
    exitHead.on.needsUpdate = true;

    // Beacons rise one by one up to the number of anchored batches.
    if (beaconsShown !== beaconsWanted) {
      if (!motion) beaconsShown = beaconsWanted;
      else if (now - beaconClock > 45) {
        beaconClock = now;
        beaconsShown += Math.sign(beaconsWanted - beaconsShown);
      }
      tickGeo.setDrawRange(0, beaconsShown * 2);
      for (let i = 0; i < MAX_BEACONS; i++) beaconTops.on.setX(i, i < beaconsShown ? 0.8 : 0);
      beaconTops.on.needsUpdate = true;
    }
    tickMat.opacity = 0.5 * fade;
    beaconTops.mat.uniforms.uFade!.value = fade;

    // Camera: the hero drifts toward the batch as it scrolls away; then the batch's own path.
    const heroT = motion ? smooth(0, 1, p.hero) * 0.35 : 0;
    if (s <= 0) mixKey(K.hero, K.near, heroT);
    else if (s < 1) mixKey(K.hero, K.near, lerp(heroT, 1, smooth(0, 1, s)));
    else if (s < 3) mixKey(K.near, K.near, 0);
    else if (s < 4) mixKey(K.near, K.exit, smooth(3, 3.8, s));
    else mixKey(K.exit, K.rest, smooth(4, 5, s));
    camLook.y += 2.6 * dawn;
    camPos.y += 1.2 * dawn;
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    renderer.render(scene, camera);
  };

  return {
    frame,
    pulse: () => {
      pulseAt = performance.now();
    },
    setBeacons: (n: number) => {
      beaconsWanted = Math.max(0, Math.min(MAX_BEACONS, Math.floor(n)));
    },
    resize,
    dispose: () => {
      for (const d of disposables) d.dispose();
      scene.traverse((o) => {
        const m = (o as Mesh).material as Material | Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      });
      renderer.dispose();
    },
  };
}
