// The world: everything you can see and bump into, built from code.
// No model files, no downloaded textures — geometry is boxes/planes/cones
// and every texture is drawn onto a <canvas> at boot.
//
// This file has two halves:
//   1. THE ENGINE (keep): colliders, ground/ceiling queries, the collision
//      pushout, static box batching, the distance culler, sky + sun.
//   2. THE DEMO SCENE (replace): a small hall with a doorway, a stair, an
//      upper floor, some crates, a glass screen and a few trees. Each piece
//      is there to exercise one engine feature — swap in your own place.
//
// Coordinates are meters. +X east, -Z north, Y up. The player spawns south
// of the hall and walks north (-Z) through the door.

import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SITE } from './config.js';

const { clamp } = MathUtils;

// Sky: 'fixed' pins a flattering late-afternoon sun. 'real' follows the
// actual sun for the lat/lon below (day, golden hour, night with stars).
export const SKY = {
  mode: 'fixed',
  fixedElevationDeg: 24,
  fixedAzimuthDeg: 140,
  lat: 0,   // only used in 'real' mode — put your own place here
  lon: 0,
};

/** Approximate solar elevation+azimuth (radians) for a date/lat/lon —
 *  NOAA's simplified formulas, plenty accurate for lighting a sky. */
function solarPos(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = 23.439 * rad;
  const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const GMST = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = (GMST + lon / 15) * 15 * rad;
  const ha = lst - RA;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.cos(lat * rad) * Math.tan(dec) - Math.sin(lat * rad) * Math.cos(ha));
  return { el, az };
}

// ---------------------------------------------------------------- textures

/** Square canvas texture that tiles. `draw(ctx, size)` paints it once. */
export function canvasTex(size, draw, repX = 1, repY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repX, repY);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Same pixels, different tiling — one clone per surface size. */
export function cloneTex(tex, repX, repY) {
  const t = tex.clone();
  t.repeat.set(repX, repY);
  t.needsUpdate = true;
  return t;
}

function speckle(ctx, s, base, variance, count, alpha = 0.16) {
  for (let i = 0; i < count; i++) {
    const v = base + (Math.random() - 0.5) * variance;
    ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
    ctx.globalAlpha = alpha;
    ctx.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  ctx.globalAlpha = 1;
}

function buildTextures() {
  const T = {};
  T.grass = canvasTex(256, (g, s) => {
    g.fillStyle = '#4c7a3a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      const v = 60 + Math.random() * 70;
      g.fillStyle = `rgba(${v * 0.6 | 0},${v + 40 | 0},${v * 0.45 | 0},0.35)`;
      g.fillRect(Math.random() * s, Math.random() * s, 1.5, 3 + Math.random() * 4);
    }
  });
  T.path = canvasTex(256, (g, s) => {
    g.fillStyle = '#b9b3a6';
    g.fillRect(0, 0, s, s);
    speckle(g, s, 170, 60, 1800);
    g.strokeStyle = 'rgba(70,66,60,0.45)';
    g.lineWidth = 2;
    for (let i = 0; i <= 2; i++) {
      g.beginPath(); g.moveTo(0, i * s / 2); g.lineTo(s, i * s / 2); g.stroke();
      g.beginPath(); g.moveTo(i * s / 2, 0); g.lineTo(i * s / 2, s); g.stroke();
    }
  });
  // Interior floor: keep it DARK-ISH and MATTE. The outdoor sun is a
  // directional light — it is not blocked by a roof unless shadows are on,
  // and even then a pale or glossy floor blows out into a white blob.
  // Rule of thumb: interior floor albedo <= ~0.6, roughness >= 0.7.
  T.planks = canvasTex(512, (g, s) => {
    g.fillStyle = '#7a5a3c';
    g.fillRect(0, 0, s, s);
    const rows = 8;
    for (let r = 0; r < rows; r++) {
      const y = (r * s) / rows;
      const shade = 0.86 + Math.random() * 0.22;
      g.fillStyle = `rgb(${122 * shade | 0},${90 * shade | 0},${60 * shade | 0})`;
      g.fillRect(0, y, s, s / rows);
      g.fillStyle = 'rgba(40,26,14,0.55)';
      g.fillRect(0, y, s, 2);
      const seam = ((r * 173) % s);
      g.fillRect(seam, y, 2, s / rows);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(50,32,18,${0.05 + Math.random() * 0.08})`;
        g.fillRect(Math.random() * s, y + Math.random() * (s / rows), 30 + Math.random() * 90, 1);
      }
    }
  });
  T.brick = canvasTex(256, (g, s) => {
    g.fillStyle = '#c9bfae'; // mortar
    g.fillRect(0, 0, s, s);
    const bw = s / 4, bh = s / 8;
    for (let r = 0; r < 8; r++) {
      for (let c = -1; c < 5; c++) {
        const shade = 0.82 + Math.random() * 0.3;
        g.fillStyle = `rgb(${168 * shade | 0},${82 * shade | 0},${58 * shade | 0})`;
        g.fillRect(c * bw + (r % 2) * (bw / 2) + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
  });
  T.crate = canvasTex(128, (g, s) => {
    g.fillStyle = '#a57b4a';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#5e4424';
    g.lineWidth = 8;
    g.strokeRect(4, 4, s - 8, s - 8);
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(8, 8); g.lineTo(s - 8, s - 8); g.stroke();
    g.beginPath(); g.moveTo(s - 8, 8); g.lineTo(8, s - 8); g.stroke();
  });
  return T;
}

/** BoxGeometry whose texture tiles in METERS instead of stretching once
 *  per face. Without this, a 24 m wall and a 3 m lintel sharing one brick
 *  material show different-sized bricks. `tile` = [metersU, metersV] for
 *  one repeat of the texture; null keeps the default 0..1 mapping. */
function tiledBox(w, h, d, tile) {
  const g = new BoxGeometry(w, h, d);
  if (!tile) return g;
  const uv = g.attributes.uv;
  // face order: +x, -x, +y, -y, +z, -z — 4 vertices each
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * dims[f][0]) / tile[0], (uv.getY(k) * dims[f][1]) / tile[1]);
    }
  }
  return g;
}

/** Set the largest font (<= px) that fits text inside maxW. Returns the size. */
export function fitFont(g, text, px, maxW, family = 'VT323, monospace') {
  let fs = px;
  g.font = `${fs}px ${family}`;
  while (fs > 14 && g.measureText(text).width > maxW) {
    fs -= 2;
    g.font = `${fs}px ${family}`;
  }
  return fs;
}

/** Canvas-drawn framed sign plane (text auto-shrinks to fit).
 *  ASPECT RULE: the canvas (w x h pixels) and the plane (mw x mh meters)
 *  must have the same aspect ratio or the lettering stretches. The default
 *  is 8:1 — pass matching w/h for any other shape.
 *  borderW 0 = frameless: on LIGHT signs a drawn outline shimmers into
 *  broken lines at grazing angles; give those a real backing box instead. */
export function makeSign(text, {
  w = 1024, h = 128, fs = 72, color = '#ffc233', bg = '#101622',
  mw = 8, mh = 1, sub = null, subColor = '#9fc4d8', borderW = 6,
} = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  if (borderW > 0) {
    g.strokeStyle = color;
    g.lineWidth = borderW;
    g.strokeRect(borderW / 2 + 1, borderW / 2 + 1, w - borderW - 2, h - borderW - 2);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, text, fs, w - 72);
  g.fillStyle = color;
  g.fillText(text, w / 2, sub ? h * 0.36 : h / 2);
  if (sub) {
    fitFont(g, sub, fs * 0.42, w - 72);
    g.fillStyle = subColor;
    g.fillText(sub, w / 2, h * 0.76);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new MeshStandardMaterial({
    map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5,
  });
  return new Mesh(new PlaneGeometry(mw, mh), mat);
}

// ================================================================ World

export class World {
  /**
   * @param {*} scene three.js Scene
   * @param {*} renderer WebGLRenderer (shadow settings, anisotropy caps)
   * @param {number} bootTier 0 = full quality, 1 = light, 2 = potato
   */
  constructor(scene, renderer, bootTier = 0) {
    this.scene = scene;
    this.bootTier = bootTier;
    this.lowPerf = bootTier;
    this.group = new Group();
    scene.add(this.group);
    this.colliders = [];
    this.boundaryRadius = 110; // invisible fence: nobody walks off the map
    this.shadows = bootTier < 2;

    this.T = buildTextures();
    this._mats();
    this._lightsAndSky(renderer);

    // ---- the demo scene: replace these with your own builders ----
    this._ground();
    this._hall();
    this._upperFloor();
    this._props();
    this._trees();

    // merge all batched static boxes — must run before the passes below
    // so the anisotropy / shadow-diet / culler passes see the final meshes
    this._flushBoxes();
    this._finalPasses(renderer);
  }

  // ------------------------------------------------ collision & ground API
  // (used by controls.js — this is the whole physics "engine")

  /** Axis-aligned box the player cannot walk through, and can stand on.
   *  opts.seeThrough: blocks walking but not sightlines (glass) — kiosk
   *  labels stay visible through it. */
  addCollider(minX, maxX, minZ, maxZ, minY = 0, maxY = 4, opts = {}) {
    this.colliders.push({ minX, maxX, minZ, maxZ, minY, maxY, seeThrough: !!opts.seeThrough });
  }

  /** Lowest collider UNDERSIDE above the feet at x/z — the head-bump
   *  ceiling. Only colliders starting above knee height count (walls
   *  rooted at the floor are the pushout's job, not a ceiling). */
  ceilingHeightAt(x, z, feet = 0) {
    let cy = Infinity;
    const r = 0.3;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (x + r < c.minX || x - r > c.maxX || z + r < c.minZ || z - r > c.maxZ) continue;
      if (c.minY >= feet + 0.5 && c.minY < cy) cy = c.minY;
    }
    return cy;
  }

  /** Height of the floor under the player. Collider tops at/below the feet
   *  are standable — jump onto crates, tables, upper floors.
   *  STEP_UP: tops up to 0.21 m ABOVE the feet also count as ground, so the
   *  player glides up stair treads. Without it, stairs built from stacked
   *  boxes strand you inside step 1. Keep stair risers under 0.2 m; taller
   *  things (a 0.5 m crate) still need a jump. */
  groundHeightAt(x, z, feet = 0) {
    let g = 0;
    const STEP_UP = 0.21;
    const r = 0.3;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      if (x + r < c.minX || x - r > c.maxX || z + r < c.minZ || z - r > c.maxZ) continue;
      if (c.maxY <= feet + STEP_UP && c.maxY > g) g = c.maxY;
    }
    return g;
  }

  /** Circle-vs-box pushout in the XZ plane, 2 relaxation passes.
   *  A collider only acts as a wall if it overlaps the player's body
   *  vertically (shin to head). */
  resolveCollisions(pos, feetY, r = 0.45) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.colliders.length; i++) {
        const c = this.colliders[i];
        if (!(feetY + 1.7 > c.minY && feetY + 0.2 < c.maxY)) continue;
        // Overhead slab (an upper floor's underside): the head poking into
        // it mid-jump is the head-bump's problem, NOT a wall. Treating a
        // room-sized slab as a wall while the player stands deep inside its
        // footprint makes the pushout below eject them through the nearest
        // room wall. Never remove this line.
        if (c.minY > feetY + 1.2) continue;
        const cx = clamp(pos.x, c.minX, c.maxX);
        const cz = clamp(pos.z, c.minZ, c.maxZ);
        const dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2), push = (r - d) / d;
          pos.x += dx * push;
          pos.z += dz * push;
        } else {
          // center is inside the box: leave by the nearest face
          const pL = pos.x - c.minX, pR = c.maxX - pos.x;
          const pB = pos.z - c.minZ, pF = c.maxZ - pos.z;
          const m = Math.min(pL, pR, pB, pF);
          if (m === pL) pos.x = c.minX - r;
          else if (m === pR) pos.x = c.maxX + r;
          else if (m === pB) pos.z = c.minZ - r;
          else pos.z = c.maxZ + r;
        }
      }
    }
    const rr = Math.hypot(pos.x, pos.z);
    if (rr > this.boundaryRadius) {
      pos.x *= this.boundaryRadius / rr;
      pos.z *= this.boundaryRadius / rr;
    }
  }

  setVisible(v) { this.group.visible = v; }

  // ------------------------------------------------------ building helpers

  /** A static box. Fire-and-forget: it returns null while batching, so do
   *  not keep the result — same-material boxes are merged into ONE mesh at
   *  the end of the constructor. Draw calls are the fps ceiling in a world
   *  made of thousands of little boxes; this is the single biggest win.
   *  Transparent materials stay individual (they need per-mesh depth sort),
   *  and anything created after the flush is a normal live mesh. */
  box(w, h, d, mat, x, y, z, { collide = false, shadow = true, seeThrough = false } = {}) {
    if (collide) {
      this.addCollider(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y - h / 2, y + h / 2, { seeThrough });
    }
    if (!this._boxFlushed && !mat.transparent) {
      (this._boxBatch ??= []).push({ w, h, d, mat, x, y, z, shadow });
      return null;
    }
    const m = new Mesh(tiledBox(w, h, d, mat.userData.tile), mat);
    m.position.set(x, y, z);
    if (this.shadows && shadow) { m.castShadow = true; m.receiveShadow = true; }
    this.group.add(m);
    return m;
  }

  /** Merge every batched box into one mesh per (material, shadow-flag). */
  _flushBoxes() {
    const batch = this._boxBatch ?? [];
    this._boxFlushed = true;
    this._boxBatch = null;
    if (!batch.length) return;
    const buckets = new Map(); // material -> [noShadowGeos, shadowGeos]
    for (const b of batch) {
      let byShadow = buckets.get(b.mat);
      if (!byShadow) buckets.set(b.mat, byShadow = [[], []]);
      const g = tiledBox(b.w, b.h, b.d, b.mat.userData.tile);
      g.translate(b.x, b.y, b.z);
      byShadow[b.shadow ? 1 : 0].push(g);
    }
    let meshes = 0;
    for (const [mat, byShadow] of buckets) {
      for (const sh of [0, 1]) {
        if (!byShadow[sh].length) continue;
        const merged = mergeGeometries(byShadow[sh], false);
        for (const g of byShadow[sh]) g.dispose();
        const m = new Mesh(merged, mat);
        if (this.shadows && sh) { m.castShadow = true; m.receiveShadow = true; }
        m.matrixAutoUpdate = false;
        this.group.add(m);
        meshes += 1;
      }
    }
    console.log(`box batch: ${batch.length} boxes -> ${meshes} merged meshes`);
  }

  /** A horizontal plane (floors, paths, decals). */
  plane(w, d, mat, x, y, z, { receive = true } = {}) {
    const p = new Mesh(new PlaneGeometry(w, d), mat);
    p.rotation.x = -Math.PI / 2;
    p.position.set(x, y, z);
    if (this.shadows && receive) p.receiveShadow = true;
    this.group.add(p);
    return p;
  }

  /** One-time passes over the finished scene. */
  _finalPasses(renderer) {
    // Anisotropic filtering: floors and walls seen at glancing angles
    // shimmer and blur without it. Capped at 4 — it kills the shimmer as
    // well as 8 at half the worst-case texture taps (integrated GPUs care).
    const maxAniso = Math.min(4, renderer.capabilities?.getMaxAnisotropy?.() ?? 1);
    if (maxAniso > 1) {
      const seen = new Set();
      this.group.traverse((o) => {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const tex of [m?.map, m?.emissiveMap]) {
            if (!tex || seen.has(tex)) continue;
            seen.add(tex);
            tex.anisotropy = maxAniso;
            tex.needsUpdate = true;
          }
        }
      });
    }

    const radiusOf = (o) => {
      if (!o.geometry.boundingSphere) {
        try { o.geometry.computeBoundingSphere(); } catch { return 1; }
      }
      return (o.geometry.boundingSphere?.radius ?? 1)
        * (Math.max(Math.abs(o.scale.x), Math.abs(o.scale.y), Math.abs(o.scale.z)) || 1);
    };

    // Shadow-pass diet: tiny clutter casts sub-pixel shadows but still
    // costs a draw call each in the shadow render.
    if (this.shadows) {
      this.group.traverse((o) => {
        if (o.isMesh && o.castShadow && o.geometry && radiusOf(o) < 0.35) o.castShadow = false;
      });
    }

    // Distance culler: small static meshes switch off when they are too
    // far away to see (re-checked every 0.2 s in update()). A mesh that
    // some other system hides for good should set userData.gone = true so
    // the culler never revives it.
    this._dcull = [];
    const v = new Vector3();
    this.group.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.visible || o.userData.noCull) return;
      const r = radiusOf(o);
      if (r >= 0.85) return;
      o.getWorldPosition(v);
      this._dcull.push({ m: o, r, x: v.x, z: v.z });
    });
    console.log(`distance culler: managing ${this._dcull.length} small meshes`);
  }

  // ---------------------------------------------------------- materials

  _mats() {
    const T = this.T;
    this.M = {
      // Depth-bias layering: grass pushed BACK, paths pulled FORWARD.
      // Near-coplanar ground planes z-fight (shimmer) from far away.
      grass: new MeshStandardMaterial({ map: cloneTex(T.grass, 60, 60), roughness: 1, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
      path: new MeshStandardMaterial({ map: cloneTex(T.path, 2, 9), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      planks: new MeshStandardMaterial({ map: cloneTex(T.planks, 6, 5), roughness: 0.78, metalness: 0 }),
      planksUp: new MeshStandardMaterial({ map: cloneTex(T.planks, 1.6, 3.4), roughness: 0.78, metalness: 0 }),
      brick: new MeshStandardMaterial({ map: T.brick, roughness: 0.92 }),
      roof: new MeshStandardMaterial({ color: 0x3b4046, roughness: 0.9 }),
      ceiling: new MeshStandardMaterial({ color: 0x2a231c, roughness: 0.95 }),
      trim: new MeshStandardMaterial({ color: 0x3a2716, roughness: 0.65 }),
      crate: new MeshStandardMaterial({ map: T.crate, roughness: 0.85 }),
      steel: new MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.6 }),
      mug: new MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.4 }),
      book: new MeshStandardMaterial({ color: 0x8b3a3a, roughness: 0.8 }),
      glass: new MeshStandardMaterial({
        color: 0x9fc8dd, roughness: 0.05, metalness: 0.2,
        transparent: true, opacity: 0.28, side: DoubleSide,
      }),
      trunk: new MeshStandardMaterial({ color: 0x5a4128, roughness: 1 }),
      leaf: new MeshStandardMaterial({ color: 0x3f6d2f, roughness: 1, flatShading: true }),
      leaf2: new MeshStandardMaterial({ color: 0x527d33, roughness: 1, flatShading: true }),
      // Lamps: glow with an emissive/basic material instead of adding a
      // PointLight per lamp. Real lights are expensive; keep to a handful.
      glow: new MeshBasicMaterial({ color: 0xffd9a2 }),
    };
    // one repeat of the brick texture covers 1.6 m x 1.2 m on every box,
    // whatever the box's size (see tiledBox)
    this.M.brick.userData.tile = [1.6, 1.2];
  }

  // -------------------------------------------------------- sky & light

  _lightsAndSky(renderer) {
    const skyBottom = new Color(0xf0ddc0);
    this.scene.background = skyBottom.clone();
    this.scene.fog = new Fog(skyBottom.getHex(), 220, 700);

    // gradient dome: vertex colors, repainted when the sun moves
    const sky = new Mesh(
      new SphereGeometry(700, 24, 12),
      new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false })
    );
    const pos = sky.geometry.attributes.position;
    sky.geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
    sky.userData.noCull = true;
    this.group.add(sky);

    const sun = new DirectionalLight(0xffd9a6, 1.45);
    // The potato tier boots with NO shadow pass at all: shadows re-render
    // the whole world into the map and sample it in every fragment.
    renderer.shadowMap.enabled = this.shadows;
    renderer.shadowMap.type = PCFSoftShadowMap;
    sun.castShadow = this.shadows;
    sun.shadow.mapSize.set(1536, 1536); // 2048 costs ~78% more texels for little gain
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
    sc.far = 500;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.group.add(sun);
    const hemi = new HemisphereLight(0xcfdcf0, 0x6e6a58, 0.55);
    this.group.add(hemi);
    const amb = new AmbientLight(0xffe8cc, 0.26);
    this.group.add(amb);

    // stars — points, invisible by day
    const starGeo = new BufferGeometry();
    const sp = [];
    for (let i = 0; i < 350; i++) {
      const a = Math.random() * Math.PI * 2;
      const e2 = Math.random() * Math.PI * 0.45 + 0.08;
      sp.push(Math.cos(e2) * Math.sin(a) * 660, Math.sin(e2) * 660, Math.cos(e2) * Math.cos(a) * 660);
    }
    starGeo.setAttribute('position', new Float32BufferAttribute(sp, 3));
    const stars = new Points(starGeo, new PointsMaterial({
      color: 0xdde8ff, size: 2.2, sizeAttenuation: false,
      transparent: true, opacity: 0, fog: false, depthWrite: false,
    }));
    this.group.add(stars);

    this._dayNight = { sky, sun, hemi, amb, stars, posAttr: pos };
    this._applyDaylight();
  }

  /** Sync sky, sun, fog and stars to the sun's position. */
  _applyDaylight() {
    const dn = this._dayNight;
    if (!dn) return;
    let el, az;
    if (SKY.mode === 'real') {
      ({ el, az } = solarPos(new Date(), SKY.lat, SKY.lon));
    } else {
      el = (SKY.fixedElevationDeg * Math.PI) / 180;
      az = (SKY.fixedAzimuthDeg * Math.PI) / 180;
    }
    const elDeg = (el * 180) / Math.PI;
    // keyframes by solar elevation — ~12 degrees is the golden-hour look
    const K = [
      { e: -90, top: 0x0a1026, bot: 0x141b30, sun: 0xff9a55, si: 0, hi: 0.24, ai: 0.18 },
      { e: -10, top: 0x0a1026, bot: 0x141b30, sun: 0xff9a55, si: 0, hi: 0.24, ai: 0.18 },
      { e: 0, top: 0x2a2f55, bot: 0xd8703e, sun: 0xff9a55, si: 0.35, hi: 0.32, ai: 0.2 },
      { e: 12, top: 0x4a86c8, bot: 0xf0ddc0, sun: 0xffd9a6, si: 1.45, hi: 0.55, ai: 0.26 },
      { e: 35, top: 0x5a9ae0, bot: 0xcfe4f4, sun: 0xfff2dc, si: 1.7, hi: 0.62, ai: 0.3 },
      { e: 90, top: 0x5a9ae0, bot: 0xcfe4f4, sun: 0xfff2dc, si: 1.7, hi: 0.62, ai: 0.3 },
    ];
    let a = K[0], b = K[1];
    for (let i = 0; i < K.length - 1; i++) {
      if (elDeg >= K[i].e && elDeg <= K[i + 1].e) { a = K[i]; b = K[i + 1]; break; }
    }
    const k = clamp((elDeg - a.e) / Math.max(b.e - a.e, 0.001), 0, 1);
    const top = new Color(a.top).lerp(new Color(b.top), k);
    const bot = new Color(a.bot).lerp(new Color(b.bot), k);
    const sunCol = new Color(a.sun).lerp(new Color(b.sun), k);
    const si = a.si + (b.si - a.si) * k;
    const hi = a.hi + (b.hi - a.hi) * k;
    const ai = a.ai + (b.ai - a.ai) * k;
    const posA = dn.posAttr;
    const colA = dn.sky.geometry.attributes.color;
    const c = new Color();
    for (let i = 0; i < posA.count; i++) {
      const t = clamp(posA.getY(i) / 400, 0, 1);
      c.copy(bot).lerp(top, t);
      colA.setXYZ(i, c.r, c.g, c.b);
    }
    colA.needsUpdate = true;
    this.scene.background.copy(bot);
    if (this.scene.fog) this.scene.fog.color.copy(bot);
    dn.sun.color.copy(sunCol);
    dn.sun.intensity = si;
    dn.sun.visible = si > 0.03;
    dn.sun.position
      .set(Math.cos(el) * Math.sin(az), Math.max(Math.sin(el), 0.02), Math.cos(el) * Math.cos(az))
      .multiplyScalar(220);
    dn.hemi.intensity = hi;
    dn.amb.intensity = Math.max(ai, 0.17); // interiors stay playable at night
    dn.stars.material.opacity = clamp((-elDeg - 2) / 8, 0, 1);
  }

  // =========================================================== DEMO SCENE
  // Everything below is example content. Delete it and build your own
  // place with box() / plane() / addCollider() / makeSign().

  _ground() {
    this.plane(420, 420, this.M.grass, 0, -0.02, 0);
    // a path from spawn to the door
    this.plane(3.2, 18, this.M.path, 0, 0, 7);
  }

  /** A hall: four walls with a doorway, a floor, a roof. Interior is
   *  x -12..12, z -22..-2, walls 0.4 thick, 7 m to the ceiling. */
  _hall() {
    const M = this.M;
    const H = 7, T = 0.4;
    const x0 = -12, x1 = 12, z0 = -22, z1 = -2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const W = x1 - x0, D = z1 - z0;

    this.plane(W, D, M.planks, cx, 0.01, cz);

    // north / west / east walls
    this.box(W + 2 * T, H, T, M.brick, cx, H / 2, z0 - T / 2, { collide: true });
    this.box(T, H, D, M.brick, x0 - T / 2, H / 2, cz, { collide: true });
    this.box(T, H, D, M.brick, x1 + T / 2, H / 2, cz, { collide: true });
    // south wall, split around a 3.2 m doorway, with a lintel above it.
    // The lintel's collider starts at head height: the head-bump stops you
    // jumping into it, the pushout ignores it (see resolveCollisions).
    const doorW = 3.2, doorH = 3.0;
    const sideW = (W - doorW) / 2;
    this.box(sideW + T, H, T, M.brick, x0 - T + (sideW + T) / 2, H / 2, z1 + T / 2, { collide: true });
    this.box(sideW + T, H, T, M.brick, x1 + T - (sideW + T) / 2, H / 2, z1 + T / 2, { collide: true });
    this.box(doorW, H - doorH, T, M.brick, cx, doorH + (H - doorH) / 2, z1 + T / 2, { collide: true });
    // door casing
    this.box(0.18, doorH, T + 0.1, M.trim, -doorW / 2 - 0.09, doorH / 2, z1 + T / 2);
    this.box(0.18, doorH, T + 0.1, M.trim, doorW / 2 + 0.09, doorH / 2, z1 + T / 2);
    this.box(doorW + 0.36, 0.18, T + 0.1, M.trim, cx, doorH + 0.09, z1 + T / 2);

    // roof + ceiling
    this.box(W + 2 * T + 0.8, 0.3, D + 2 * T + 0.8, M.roof, cx, H + 0.15, cz, { collide: true });
    const ceil = new Mesh(new PlaneGeometry(W, D), M.ceiling);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, H - 0.01, cz);
    this.group.add(ceil);

    // The roof shadows the interior, so it needs its own light. Three warm
    // point lights (no shadows) plus glowing fixtures that are just emissive
    // boxes. Budget: stay under ~12-16 PointLights in the whole world.
    for (const [lx, lz] of [[-5, -8], [5, -8], [0, -17]]) {
      const pl = new PointLight(0xffdcaa, 46, 26, 1.8);
      pl.position.set(lx, H - 1.4, lz);
      this.group.add(pl);
      this.box(1.4, 0.08, 0.3, M.glow, lx, H - 0.6, lz, { shadow: false });
    }

    // sign over the door (default 8:1 sign = 8 m x 1 m plane)
    const sign = makeSign(SITE.title, { sub: SITE.tagline, mw: 6.4, mh: 0.8 });
    sign.position.set(cx, doorH + 1.1, z1 + T + 0.03);
    this.group.add(sign);
  }

  /** An upper floor reached by a stair — the hardest thing to get right.
   *  Slab top at 3.2 m. Stair: 17 risers of 0.188 m (under the 0.21 step-up
   *  limit), 0.3 m treads, each step a solid block from the floor so its
   *  side is a wall and its top is ground. */
  _upperFloor() {
    const M = this.M;
    const top = 3.2, thick = 0.2;
    const sx0 = -12, sx1 = -6, sz0 = -22, sz1 = -8.9;
    this.box(sx1 - sx0, thick, sz1 - sz0, M.trim, (sx0 + sx1) / 2, top - thick / 2, (sz0 + sz1) / 2, { collide: true });
    const deck = this.plane(sx1 - sx0, sz1 - sz0, M.planksUp, (sx0 + sx1) / 2, top + 0.005, (sz0 + sz1) / 2);
    deck.userData.noCull = true;

    const steps = 17, rise = top / steps, tread = 0.3;
    const stairX0 = -12, stairW = 1.6, zStart = -3.8;
    for (let i = 1; i <= steps; i++) {
      const h = rise * i;
      const zc = zStart - (i - 0.5) * tread;
      this.box(stairW, h, tread, M.trim, stairX0 + stairW / 2, h / 2, zc, { collide: true });
    }

    // Glass rails on the open edges (see-through colliders). Leave the
    // stair opening clear, and ALWAYS walk-test a stair both directions:
    // a rail or planter across the landing is an easy mistake to miss.
    const railH = 1.1;
    this.box(0.06, railH, sz1 - sz0, M.glass, sx1, top + railH / 2, (sz0 + sz1) / 2, { collide: true, seeThrough: true });
    const southLen = sx1 - (stairX0 + stairW);
    this.box(southLen, railH, 0.06, M.glass, sx1 - southLen / 2, top + railH / 2, sz1, { collide: true, seeThrough: true });

    const sign = makeSign('UPPER FLOOR', { mw: 3.2, mh: 0.4, fs: 84 });
    sign.rotation.y = Math.PI / 2;
    sign.position.set(sx0 + 0.03, top + 2.2, -15.5);
    this.group.add(sign);
  }

  /** Things to bump into and jump on. */
  _props() {
    const M = this.M;
    // crate stair: 0.5, 1.0, 1.5 m — each needs a jump (taller than STEP_UP)
    this.box(1, 0.5, 1, M.crate, 7, 0.25, -6, { collide: true });
    this.box(1, 1.0, 1, M.crate, 8.1, 0.5, -6, { collide: true });
    this.box(1, 1.5, 1, M.crate, 8.1, 0.75, -7.1, { collide: true });

    // a table with small clutter — the clutter is what the distance
    // culler exists for (walk 24 m away and it switches off)
    this.box(2.4, 0.08, 1.1, M.trim, 2.5, 0.78, -12, { collide: true });
    for (const [lx, lz] of [[1.4, -11.55], [3.6, -11.55], [1.4, -12.45], [3.6, -12.45]]) {
      this.box(0.08, 0.74, 0.08, M.steel, lx, 0.37, lz);
    }
    for (let i = 0; i < 6; i++) {
      const mug = new Mesh(new CylinderGeometry(0.045, 0.04, 0.1, 10), M.mug);
      mug.position.set(1.7 + i * 0.3, 0.87, -12 + (i % 2 ? 0.2 : -0.15));
      this.group.add(mug);
    }
    this.box(0.3, 0.05, 0.22, M.book, 2.2, 0.845, -12.3);

    // a glass screen: blocks walking, not sightlines — stand behind it and
    // the kiosk labels beyond stay visible instead of ghosting out
    this.box(4, 2.6, 0.08, M.glass, 7, 1.3, -14, { collide: true, seeThrough: true });
    this.box(4.1, 0.1, 0.14, M.steel, 7, 2.65, -14);
  }

  _trees() {
    const M = this.M;
    const spots = [
      [-9, 8], [9, 9], [-16, 2], [17, 1], [-20, -10], [21, -12], [-18, -26],
      [19, -27], [0, -32], [-8, -30], [9, -31], [-26, 14], [27, 13], [0, 30],
    ];
    spots.forEach(([x, z], i) => {
      const s = 0.85 + ((i * 37) % 10) / 20;
      const trunk = new Mesh(new CylinderGeometry(0.22 * s, 0.3 * s, 2.6 * s, 8), M.trunk);
      trunk.position.set(x, 1.3 * s, z);
      const c1 = new Mesh(new ConeGeometry(2.2 * s, 3.4 * s, 9), i % 2 ? M.leaf : M.leaf2);
      c1.position.set(x, 3.6 * s, z);
      const c2 = new Mesh(new ConeGeometry(1.6 * s, 2.8 * s, 9), i % 2 ? M.leaf2 : M.leaf);
      c2.position.set(x, 5.4 * s, z);
      for (const m of [trunk, c1, c2]) {
        if (this.shadows) { m.castShadow = true; m.receiveShadow = true; }
        this.group.add(m);
      }
      this.addCollider(x - 0.3 * s, x + 0.3 * s, z - 0.3 * s, z + 0.3 * s, 0, 2.6 * s);
    });
  }

  // ------------------------------------------------------------ runtime

  /** 1 = light tier, 2 = potato. One-way: main.js only ever steps down. */
  setLowPerf(level = 1) {
    this.lowPerf = level;
  }

  /** Call every frame. t = seconds since boot. */
  update(t, playerPos = null) {
    // distance culler tick (5 Hz)
    if (playerPos && this._dcull && t > (this._dcullAt ?? 0)) {
      this._dcullAt = t + 0.2;
      const far = this.lowPerf ? 16 : 24;
      for (const d of this._dcull) {
        if (d.m.userData.gone) continue;
        const dx = d.x - playerPos.x, dz = d.z - playerPos.z;
        // bigger things stay visible longer
        const lim = far * (0.5 + d.r * 1.2);
        d.m.visible = dx * dx + dz * dz < lim * lim;
      }
    }
    // real-sun mode: re-sync the sky every 30 s
    if (SKY.mode === 'real' && t > (this._skyAt ?? 30)) {
      this._skyAt = t + 30;
      this._applyDaylight();
    }
  }
}
