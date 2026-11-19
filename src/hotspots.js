// Hotspots: the things in the world you can open.
//   - kiosk stands with a live retro CRT screen (walk close + [E], or click)
//   - wall posters (click, or [E] when close)
// Each opens either a card with one link, or a menu of links.
//
// Config lives in config.js (HOTSPOTS). Private names/links can be swapped
// in at runtime with applyPrivate() — see README.

import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Raycaster,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
} from 'three';
import { HOTSPOTS, INTERACT, PLAYER } from './config.js';

function colorHexStr(colorHex) {
  return `#${colorHex.toString(16).padStart(6, '0')}`;
}

/** Does the segment a->b pass through any solid collider box? Glass
 *  colliders (seeThrough) don't count. Standard slab test. */
function segBlocked(ax, ay, az, bx, by, bz, boxes) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  for (const c of boxes) {
    if (c.seeThrough) continue;
    let t0 = 0.02, t1 = 0.98; // trim the ends so own kiosk / camera don't self-hit
    let hit = true;
    const o = [ax, ay, az], d = [dx, dy, dz];
    const mn = [c.minX, c.minY, c.minZ], mx = [c.maxX, c.maxY, c.maxZ];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (o[i] < mn[i] || o[i] > mx[i]) { hit = false; break; }
      } else {
        let ta = (mn[i] - o[i]) / d[i];
        let tb = (mx[i] - o[i]) / d[i];
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { hit = false; break; }
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Link-integrity guard: EVERY clickable URL funnels through here before
 *  it touches an href or window.open. Only https/http and same-origin
 *  paths survive, so a bad data source or an editing mistake can never
 *  smuggle a javascript:/data: scheme into something clickable. */
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return s; // same-origin path
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
  } catch { /* not parseable — reject */ }
  return null;
}

function makeLabelSprite(name, colorHex) {
  const scale = 2; // supersample for crisp text
  const font = `${58 * scale}px VT323, monospace`;
  const subFont = `${26 * scale}px VT323, monospace`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const padX = 36 * scale;
  const w = Math.ceil(Math.max(measure.measureText(name).width, 180 * scale) + padX * 2);
  const h = 110 * scale;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(11, 14, 20, 0.92)';
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 6 * scale;
  ctx.strokeStyle = colorHexStr(colorHex);
  ctx.strokeRect(3 * scale, 3 * scale, w - 6 * scale, h - 6 * scale);
  ctx.font = font;
  ctx.fillStyle = colorHexStr(colorHex);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, w / 2, h * 0.38);
  ctx.font = subFont;
  ctx.fillStyle = '#9fc4d8';
  ctx.fillText('CLICK · [E] OPEN', w / 2, h * 0.78);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new Sprite(new SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false, // readable through walls — doubles as wayfinding
    depthWrite: false,
  }));
  // the potato tier renders at 1.0 pixel ratio with no MSAA — thin pixel
  // font strokes starve for pixels, so labels get a little bigger there
  const worldH = (window.__wwTier ?? 0) >= 2 ? 1.32 : 1.05;
  sprite.scale.set((w / h) * worldH, worldH, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Framed wall-poster texture: title, tagline, footer, retro border. */
function makePosterTexture(cfg) {
  const c = document.createElement('canvas');
  c.width = 360; c.height = 500;
  const g = c.getContext('2d');
  const col = colorHexStr(cfg.color ?? 0xffc233);
  g.fillStyle = '#0d1117';
  g.fillRect(0, 0, 360, 500);
  g.strokeStyle = col;
  g.lineWidth = 8;
  g.strokeRect(10, 10, 340, 480);
  g.globalAlpha = 0.16;
  g.fillStyle = col;
  g.fillRect(24, 24, 312, 150);
  g.globalAlpha = 1;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = col;
  let fs = 64;
  g.font = `${fs}px VT323, monospace`;
  while (fs > 22 && g.measureText(cfg.name).width > 300) { fs -= 2; g.font = `${fs}px VT323, monospace`; }
  g.fillText(cfg.name, 180, 100);
  g.fillStyle = '#e8edf4';
  g.font = '28px VT323, monospace';
  const words = String(cfg.tagline ?? cfg.desc ?? '').toUpperCase().split(' ');
  let line = '', y = 240;
  for (const wd of words) {
    if (g.measureText(`${line} ${wd}`).width > 290 && line) {
      g.fillText(line, 180, y); y += 32; line = wd;
    } else line = line ? `${line} ${wd}` : wd;
  }
  if (line) g.fillText(line, 180, y);
  g.fillStyle = '#9fc4d8';
  g.font = '24px VT323, monospace';
  g.fillText('CLICK · [E] OPEN', 180, 452);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Live phosphor CRT face for the kiosks: header, the links inside this
 *  kiosk, a blinking cursor, a rolling refresh band, scanlines, and the
 *  occasional flicker. Redrawn ~3 fps by Hotspots.update. */
function drawTerminal(g, w, h, cfg, t) {
  const col = colorHexStr(cfg.color ?? 0xffc233);
  g.fillStyle = '#040709';
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 0.18;
  g.fillStyle = col;
  g.fillRect(5, 5, w - 10, 24);
  g.globalAlpha = 1;
  g.font = '17px VT323, monospace';
  g.textAlign = 'left';
  g.fillStyle = col;
  g.fillText('▸ TERMINAL // ONLINE', 11, 22);
  g.fillText('─'.repeat(30), 8, 40);
  // the directory shows the ACTUAL links inside this kiosk
  let labels = [];
  if (cfg.menu) {
    for (const s of cfg.menu.sections) for (const it of s.items) labels.push(it.label);
  } else if (cfg.url) {
    try { labels = [new URL(cfg.url).host.toUpperCase()]; } catch { labels = []; }
  }
  let locked = false;
  if (!labels.length) {
    locked = true;
    labels = ['ACCESS REQUIRED', '', 'THIS TERMINAL IS', 'LOCKED'];
  }
  const rows = 7;
  const overflow = Math.max(0, labels.length - rows);
  const shown = labels.slice(0, overflow > 0 ? rows - 1 : rows);
  g.font = '16px VT323, monospace';
  shown.forEach((lb, i) => {
    const cy = 56 + i * 16;
    if (lb) {
      g.globalAlpha = locked ? 0.75 : 0.55;
      g.fillText('·', 10, cy);
    }
    g.globalAlpha = 1;
    g.fillText(String(lb).toUpperCase().slice(0, 26), 18, cy);
  });
  if (overflow > 0) {
    g.globalAlpha = 0.8;
    g.fillText(`+${overflow + 1} MORE INSIDE…`, 10, 56 + shown.length * 16);
    g.globalAlpha = 1;
  }
  const blink = Math.floor(t * 2.4) % 2 === 0;
  g.font = '19px VT323, monospace';
  g.fillStyle = '#e8edf4';
  g.fillText('ACCESS: [E] OR CLICK', 10, h - 22);
  if (blink) {
    g.fillStyle = col;
    g.fillRect(188, h - 36, 11, 18);
  }
  const band = ((t * 34) % (h + 60)) - 30;
  const grad = g.createLinearGradient(0, band - 14, 0, band + 14);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, band - 14, w, 28);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  g.strokeStyle = col;
  g.lineWidth = 2;
  g.strokeRect(2, 2, w - 4, h - 4);
  if (Math.sin(t * 12.7) > 0.982) {
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(0, 0, w, h);
  }
}

export class Hotspots {
  constructor(scene, camera, world, hud, controls) {
    this.camera = camera;
    this.world = world;
    this.hud = hud;
    this.controls = controls;
    this.group = new Group();
    scene.add(this.group);

    this.spots = [];
    this.clickables = []; // meshes the click/hover raycast tests
    this._terms = [];     // live CRT canvases
    this.raycaster = new Raycaster();
    this.mouseNdc = new Vector2(-2, -2); // offscreen until the mouse moves
    this.hovered = null;
    this.nearSpot = null;

    for (const cfg of HOTSPOTS) this._build(cfg);
    this._bindModals();
  }

  _build(cfg) {
    const color = cfg.color ?? 0xffc233;
    const g = new Group();
    // cfg.y has TWO meanings: for a kiosk it is the floor it stands on;
    // for a poster it is the height on the wall. Applying it to both the
    // outer group and the poster doubles every wall sign's height.
    const wallMounted = cfg.type === 'poster';
    g.position.set(cfg.x, wallMounted ? 0 : (cfg.y ?? 0), cfg.z);
    const spot = { cfg, group: g, label: null, baseLabelScale: null, phase: Math.random() * Math.PI * 2 };

    if (cfg.type === 'poster') {
      const w = cfg.w ?? 1.55, h = cfg.h ?? 2.15;
      const frameG = new Group();
      frameG.position.y = cfg.y ?? 2.6;
      frameG.rotation.y = cfg.ry ?? 0;
      const frame = new Mesh(
        new BoxGeometry(w + 0.14, h + 0.14, 0.05),
        new MeshStandardMaterial({ color: 0x191d24, roughness: 0.5, metalness: 0.4 })
      );
      frame.position.z = -0.02;
      const posterTex = makePosterTexture(cfg);
      const print = new Mesh(
        new PlaneGeometry(w, h),
        new MeshStandardMaterial({
          map: posterTex, emissive: 0xffffff, emissiveMap: posterTex,
          emissiveIntensity: 0.34, roughness: 0.65,
        })
      );
      print.position.z = 0.012;
      frameG.add(frame, print);
      g.add(frameG);
      print.userData.spot = spot;
      frame.userData.spot = spot;
      spot.print = print; // kept so applyPrivate can redraw the poster
      this.clickables.push(print, frame);
      this.spots.push(spot);
      this.group.add(g);
      return;
    }

    // Kiosks can face any direction — ALWAYS set ry so the screen greets
    // the player, not the wall behind it. Default faces +Z.
    g.rotation.y = cfg.ry ?? 0;

    const bodyMat = new MeshStandardMaterial({ color: 0x14171d, roughness: 0.5, metalness: 0.45 });
    const trimMat = new MeshBasicMaterial({ color });
    const foot = new Mesh(new BoxGeometry(0.58, 0.07, 0.48), bodyMat);
    foot.position.y = 0.035;
    const column = new Mesh(new BoxGeometry(0.4, 0.9, 0.32), bodyMat);
    column.position.y = 0.5;
    column.castShadow = true;
    g.add(foot, column);
    for (const side of [-1, 1]) {
      const stripe = new Mesh(new BoxGeometry(0.025, 0.52, 0.02), trimMat);
      stripe.position.set(side * 0.165, 0.36, 0.165);
      g.add(stripe);
    }

    // tilted console head with the CRT
    const head = new Group();
    head.position.set(0, 1.02, 0.05);
    head.rotation.x = -0.4;
    const housing = new Mesh(new BoxGeometry(0.7, 0.52, 0.15), bodyMat);
    housing.position.y = 0.24;
    housing.castShadow = true;
    head.add(housing);
    const sc = document.createElement('canvas');
    sc.width = 256; sc.height = 200;
    const stex = new CanvasTexture(sc);
    stex.colorSpace = SRGBColorSpace;
    const screen = new Mesh(
      new PlaneGeometry(0.58, 0.42),
      new MeshStandardMaterial({
        map: stex, emissive: 0xffffff, emissiveMap: stex,
        emissiveIntensity: 0.85, roughness: 0.35,
      })
    );
    screen.position.set(0, 0.24, 0.078);
    head.add(screen);
    g.add(head);

    // keyboard deck
    const kbBody = new Mesh(new BoxGeometry(0.52, 0.035, 0.22), bodyMat);
    kbBody.position.set(0, 0.955, 0.3);
    kbBody.rotation.x = -0.12;
    g.add(kbBody);

    // Light beacon OUTDOORS ONLY — indoors an additive cylinder reads as a
    // pale slab smeared across the walls.
    if (!cfg.indoor) {
      const beaconH = 20;
      const beacon = new Mesh(
        new CylinderGeometry(0.22, 0.22, beaconH, 10, 1, true),
        new MeshBasicMaterial({
          color, transparent: true, opacity: 0.16,
          blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
        })
      );
      beacon.position.y = beaconH / 2 + 1.0;
      beacon.renderOrder = 9;
      g.add(beacon);
    }

    if (!cfg.noLabel) {
      const label = makeLabelSprite(cfg.name, color);
      label.position.y = 2.35;
      g.add(label);
      spot.label = label;
      spot.baseLabelScale = label.scale.clone();
      label.userData.spot = spot;
      this.clickables.push(label);
    }
    for (const m of [screen, housing, column, kbBody]) {
      m.userData.spot = spot;
      this.clickables.push(m);
    }
    // the kiosk is solid, at its own floor height
    const half = 0.36;
    const footY = cfg.y ?? 0;
    this.world.addCollider(cfg.x - half, cfg.x + half, cfg.z - half, cfg.z + half, footY, footY + 1.4);
    this._terms.push({ g: sc.getContext('2d'), tex: stex, cfg, seed: Math.random() * 9 });

    this.spots.push(spot);
    this.group.add(g);
  }

  // ------------------------------------------------------------ modals

  _bindModals() {
    const close = (id) => () => document.getElementById(id).classList.add('hidden');
    document.getElementById('card-close').addEventListener('click', close('portal-modal'));
    document.getElementById('menu-close').addEventListener('click', close('menu-modal'));
    document.getElementById('menu-x').addEventListener('click', close('menu-modal'));
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      close('portal-modal')();
      close('menu-modal')();
    });
  }

  /** True while a hotspot modal is on screen (main.js folds this into
   *  isUiOpen so walking pauses). */
  isModalOpen() {
    return !document.getElementById('portal-modal').classList.contains('hidden')
      || !document.getElementById('menu-modal').classList.contains('hidden');
  }

  /** Open a hotspot. Everything that opens one goes through here. */
  activate(cfg) {
    if (cfg.menu) {
      this._openMenu(cfg);
      return;
    }
    if (!cfg.url) {
      this.hud.toast(cfg.toast ?? `${cfg.name} — COMING SOON`, 2800);
      return;
    }
    this.controls.clearInputs();
    document.getElementById('card-title').textContent = cfg.name;
    document.getElementById('card-desc').textContent = cfg.desc ?? '';
    document.getElementById('card-link').href = safeUrl(cfg.url) ?? '#';
    document.getElementById('portal-modal').classList.remove('hidden');
  }

  /** Link-list modal. Built with DOM nodes + textContent only — never
   *  innerHTML — so labels from a data file can't inject markup. */
  _openMenu(cfg) {
    this.controls.clearInputs();
    const menu = cfg.menu;
    document.getElementById('menu-title').textContent = menu.title ?? cfg.name;
    const body = document.getElementById('menu-body');
    body.textContent = '';
    for (const section of menu.sections ?? []) {
      const h = document.createElement('div');
      h.className = 'menu-section';
      h.textContent = section.title ?? '';
      body.appendChild(h);
      for (const item of section.items ?? []) {
        const row = document.createElement('div');
        row.className = 'menu-row';
        const name = document.createElement('span');
        name.className = 'menu-label';
        name.textContent = item.label;
        row.appendChild(name);
        const href = safeUrl(item.url);
        if (href) {
          const a = document.createElement('a');
          a.className = 'menu-btn';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'OPEN ↗';
          row.appendChild(a);
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'menu-btn ghost';
          copy.textContent = '⧉ COPY';
          copy.addEventListener('click', () => {
            navigator.clipboard?.writeText(href).then(
              () => this.hud.toast('LINK COPIED', 1200),
              () => this.hud.toast('COPY BLOCKED BY THE BROWSER', 1600)
            );
          });
          row.appendChild(copy);
        }
        body.appendChild(row);
      }
    }
    document.getElementById('menu-modal').classList.remove('hidden');
  }

  // ---------------------------------------------------- pointer + keys

  onMouseMove(e, canvas) {
    // mouse-look mode: the cursor is captured, so hover/interact tracks
    // the screen-center crosshair instead of stale client coordinates
    if (document.pointerLockElement === canvas) {
      this.mouseNdc.set(0, 0);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    this.mouseNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  /** Click at screen coords — open whatever hotspot is under it. */
  clickAt(clientX, clientY, canvas) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const spot = this._pick(ndc);
    if (spot) {
      this.activate(spot.cfg);
      return true;
    }
    return false;
  }

  _pick(ndc) {
    if (!this.group.visible || !this.clickables.length) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickables, false);
    if (hits.length && hits[0].distance <= INTERACT.clickMaxDist) {
      return hits[0].object.userData.spot;
    }
    return null;
  }

  /** E key — the nearest kiosk in range, else whatever is under the cursor. */
  tryInteract() {
    const spot = this.nearSpot ?? this.hovered;
    if (!spot) return false;
    this.activate(spot.cfg);
    return true;
  }

  /** Let a mesh you built elsewhere (a wall screen, a statue…) act as a
   *  click target for an existing hotspot, matched by privateId or name. */
  registerClickable(mesh, idOrName) {
    const spot = this.spots.find((s) => s.cfg.privateId === idOrName || s.cfg.name === idOrName);
    if (!spot) return false;
    mesh.userData.spot = spot;
    this.clickables.push(mesh);
    return true;
  }

  // ------------------------------------------------------------ frame

  update(elapsed, uiOpen, canvas) {
    const dt = Math.min(Math.max(elapsed - (this._lastT ?? elapsed), 0), 0.1);
    this._lastT = elapsed;
    const cam = this.camera.position;

    // Labels: gentle float + a size clamp by distance (a fixed-size sprite
    // fills the screen when you walk up to it) + fade to a ghost when a
    // wall blocks the sightline.
    for (const spot of this.spots) {
      if (!spot.label) continue;
      spot.label.position.y = 2.35 + Math.sin(elapsed * 1.8 + spot.phase) * 0.08;
      const gp = spot.group.position;
      const ly = gp.y + spot.label.position.y;
      const dist = Math.hypot(gp.x - cam.x, ly - cam.y, gp.z - cam.z);
      const k = Math.min(Math.max(dist / 7, 0.3), 1) * (spot === this.hovered ? 1.12 : 1);
      spot.label.scale.copy(spot.baseLabelScale).multiplyScalar(k);
      const m = spot.label.material;
      const target = spot._occBlocked ? 0.08 : 1;
      m.opacity += (target - m.opacity) * Math.min(1, dt * 9);
    }
    // Occlusion is round-robined: testing every label against every
    // collider every frame is a lot of slab tests. A few per frame keeps
    // staleness around 100 ms, and the opacity ease hides the rest.
    if (!this._occList || this._occListN !== this.spots.length) {
      this._occList = this.spots.filter((s) => s.label);
      this._occListN = this.spots.length;
      this._occI = 0;
    }
    const occN = this._occList.length;
    if (occN) {
      const budget = Math.min((window.__wwTier ?? 0) >= 2 ? 4 : 8, occN);
      for (let n = 0; n < budget; n++) {
        this._occI = (this._occI + 1) % occN;
        const s = this._occList[this._occI];
        const gp = s.group.position;
        s._occBlocked = segBlocked(
          cam.x, cam.y, cam.z,
          gp.x, gp.y + s.label.position.y, gp.z,
          this.world.colliders
        );
      }
    }

    // CRT screens refresh ~3 fps — only the ones close enough to READ, and
    // never all in the same frame. Repainting every screen in one tick is a
    // metronomic main-thread spike that feels choppy even at a high fps.
    if (elapsed > (this._termAt ?? 0)) {
      this._termAt = elapsed + 0.33;
      const low = this.world?.lowPerf;
      let budget = low ? 2 : 4;
      const maxD2 = low ? 400 : 784; // 20 m on light tiers, 28 m on high
      for (let n = 0; n < this._terms.length && budget > 0; n++) {
        this._termI = ((this._termI ?? 0) + 1) % this._terms.length;
        const tm = this._terms[this._termI];
        const d2 = (tm.cfg.x - cam.x) ** 2 + (tm.cfg.z - cam.z) ** 2;
        if (d2 > maxD2 && tm.painted) continue;
        drawTerminal(tm.g, 256, 200, tm.cfg, elapsed + tm.seed);
        tm.tex.needsUpdate = true;
        tm.painted = true;
        budget -= 1;
      }
    }

    if (uiOpen) {
      this.hud.prompt(null);
      canvas.classList.remove('hot');
      return;
    }

    // hover (mouse-position raycast)
    this.hovered = this._pick(this.mouseNdc);
    canvas.classList.toggle('hot', !!this.hovered);

    // proximity prompt: the nearest hotspot within its prompt radius
    const feet = cam.y - PLAYER.eyeHeight;
    let near = null;
    let bestScore = 1; // d^2 / promptRadius^2 — spots can widen their own reach
    for (const spot of this.spots) {
      // FLOOR GUARD: a kiosk one storey up or down must not raise the
      // prompt (xz distance alone can't tell floors apart). cfg.floorY
      // covers wall-mounted spots, whose group.y stays 0.
      const fy = spot.cfg.floorY ?? spot.group.position.y;
      if (Math.abs(fy - feet) > 1.6) continue;
      const dx = spot.group.position.x - cam.x;
      const dz = spot.group.position.z - cam.z;
      const pr = spot.cfg.promptRadius ?? INTERACT.promptRadius;
      const score = (dx * dx + dz * dz) / (pr * pr);
      if (score < bestScore) { bestScore = score; near = spot; }
    }
    this.nearSpot = near;
    const promptFor = near ?? this.hovered;
    let promptTxt = null;
    if (promptFor) {
      const c = promptFor.cfg;
      promptTxt = `[E] ${c.url || c.menu ? 'OPEN ' : ''}${c.name}`;
    }
    this.hud.prompt(promptTxt);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  // ---------------------------------------------------- private overlay

  /** Swap real names/links into the generic public hotspots.
   *  `stations` = { [privateId]: { name?, desc?, url?, menu? } } — it comes
   *  from the server's /api/world for authorised visitors only, so none of
   *  it is in the JavaScript bundle. */
  applyPrivate(stations) {
    if (!stations) return;
    for (const spot of this.spots) {
      const id = spot.cfg.privateId;
      const data = id ? stations[id] : null;
      if (!data) continue;
      for (const key of ['name', 'desc', 'url', 'menu', 'tagline']) {
        if (data[key] !== undefined) spot.cfg[key] = data[key];
      }
      spot.cfg.toast = undefined;
      if (spot.label) {
        // redraw the floating label with the real name
        const old = spot.label;
        const label = makeLabelSprite(spot.cfg.name, spot.cfg.color ?? 0xffc233);
        label.position.copy(old.position);
        label.userData.spot = spot;
        spot.group.remove(old);
        old.material.map?.dispose();
        old.material.dispose();
        this.clickables.splice(this.clickables.indexOf(old), 1, label);
        spot.group.add(label);
        spot.label = label;
        spot.baseLabelScale = label.scale.clone();
      }
      if (spot.print) {
        const tex = makePosterTexture(spot.cfg);
        spot.print.material.map?.dispose();
        spot.print.material.map = tex;
        spot.print.material.emissiveMap = tex;
        spot.print.material.needsUpdate = true;
      }
    }
    this._occList = null; // labels changed — rebuild the occlusion list
  }
}
