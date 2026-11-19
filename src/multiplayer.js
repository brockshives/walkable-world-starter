// Multiplayer presence: everyone on the site at the same time shows up
// as a "ghost" avatar walking around.
//
// Protocol (tiny JSON over a same-origin WebSocket at /ws):
//   client -> server @10Hz : { t:'p', x, y, z, yaw }        (y = feet height)
//   server -> client on join: { t:'hi', id, names }
//   server -> everyone @10Hz: { t:'s', p: [[id, x, y, z, yaw, voice], ...] }
//   chat:   { t:'n', name }  { t:'c', text }
//   voice:  { t:'vs', on }   { t:'rtc', to, d }   (WebRTC signaling relay)
//   games:  { t:'g', r, d }  (opaque room-tagged payloads, fanned out)
//
// The server piece lives in /server.js (node + ws) and also serves the
// built site, so production is one container. In dev, vite proxies /ws to
// localhost:8080 if you run `npm run serve` — and if no server is listening
// the client just retries quietly, so single-player never breaks.

import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
} from 'three';

const SEND_MS = 100;      // outbound pose rate
const GHOST_LIMIT = 32;   // render at most this many ghosts

/** Avatar material set. opacity 1 = solid; ghosts use slightly translucent
 *  so they read as "presence". Recolor these to dress your visitors. */
export function avatarMats(opacity = 1) {
  const mat = (color) => new MeshStandardMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    roughness: 0.75,
  });
  return {
    shirt: mat(0x2f6f8f),
    pants: mat(0x4a4f5a),
    skin: mat(0xd8c2a8),
    hat: mat(0x23405a),
    shoe: mat(0x23262b),
  };
}

/** Full avatar body (feet at y=0, forward = -Z, matching the player's yaw
 *  convention — so the hat brim points at -Z). */
export function buildAvatarBody(M) {
  const g = new Group();
  const mk = (geo, mat, x, y, z) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.renderOrder = 8;
    return m;
  };
  const pelvis = mk(new BoxGeometry(0.32, 0.18, 0.22), M.pants, 0, 0.96, 0);
  const leg = (x) => {
    const l = new Group();
    l.position.set(x, 0.92, 0);
    l.add(mk(new CylinderGeometry(0.085, 0.092, 0.62, 10), M.pants, 0, -0.35, 0));
    l.add(mk(new BoxGeometry(0.15, 0.09, 0.26), M.shoe, 0, -0.71, -0.05));
    return l;
  };
  const arm = (x) => {
    const a = new Group();
    a.position.set(x, 1.48, 0);
    a.add(mk(new CapsuleGeometry(0.055, 0.2, 4, 10), M.shirt, 0, -0.12, 0));
    a.add(mk(new CapsuleGeometry(0.045, 0.24, 4, 10), M.skin, 0, -0.42, 0));
    return a;
  };
  const legL = leg(-0.09), legR = leg(0.09);
  const armL = arm(-0.28), armR = arm(0.28);
  const body = mk(new CapsuleGeometry(0.19, 0.5, 6, 14), M.shirt, 0, 1.26, 0);
  const head = mk(new SphereGeometry(0.14, 18, 14), M.skin, 0, 1.78, 0);
  const hat = mk(new SphereGeometry(0.15, 18, 14), M.hat, 0, 1.84, 0.01);
  hat.scale.set(1, 0.58, 1);
  const brim = mk(new SphereGeometry(0.13, 14, 10), M.hat, 0, 1.82, -0.13);
  brim.scale.set(0.85, 0.1, 1.1);
  const label = ghostLabel();
  label.position.y = 2.18;
  g.add(pelvis, legL, legR, armL, armR, body, head, hat, brim, label);
  return { group: g, legL, legR, armL, armR, label };
}

export function ghostLabel(name = 'VISITOR') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(11,14,20,0.72)';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = 'rgba(98,216,255,0.85)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 252, 60);
  let fs = 38;
  g.font = `${fs}px VT323, monospace`;
  while (g.measureText(name).width > 224 && fs > 20) {
    fs -= 2;
    g.font = `${fs}px VT323, monospace`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#9fd8ff';
  g.fillText(name, 128, 34);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({
    map: tex, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  sprite.scale.set(0.95, 0.24, 1);
  sprite.renderOrder = 9;
  return sprite;
}

export class Multiplayer {
  /**
   * @param {*} scene three.js scene
   * @param {() => {x,y,z,yaw}} getPose returns our feet position + yaw
   */
  constructor(scene, getPose) {
    this.getPose = getPose;
    this.group = new Group();
    scene.add(this.group);

    this.ghosts = new Map(); // id -> ghost record
    this.count = 0;          // players online (incl. self); 0 = offline
    this.id = null;
    this.ws = null;
    this.onGame = null;      // (senderId, room, data)
    this.onChat = null;      // (id, name, text)
    this.onRtc = null;       // (fromId, data) — voice signaling relay
    this.names = new Map();  // id -> display name (roster + live updates)
    this.voicePeers = new Set(); // ids currently voice-enabled
    this.myName = '';        // set via setName(); resent on reconnect
    this._sendAcc = 0;
    this._retryMs = 4000;
    this._mats = avatarMats(0.92);

    this._connect();
  }

  _connect() {
    let url;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${location.host}/ws`;
    } catch {
      return;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => { this._retryMs = 4000; };
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.count = 0;
      this._clearGhosts();
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    setTimeout(() => { if (!this.ws) this._connect(); }, this._retryMs);
    this._retryMs = Math.min(this._retryMs * 1.7, 30000);
  }

  _onMessage(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m) return;
    if (m.t === 'hi') {
      this.id = m.id;
      if (m.names) for (const [id, name] of Object.entries(m.names)) this.names.set(Number(id), name);
      if (this.myName) this.setName(this.myName); // re-announce after reconnect
      return;
    }
    if (m.t === 'g') {
      this.onGame?.(m.id, m.r, m.d);
      return;
    }
    if (m.t === 'n') {
      this.names.set(m.id, m.name);
      const gh = this.ghosts.get(m.id);
      if (gh) this._setGhostLabel(gh, m.name);
      return;
    }
    if (m.t === 'c') {
      this.onChat?.(m.id, m.name, m.text);
      return;
    }
    if (m.t === 'rtc') {
      this.onRtc?.(m.from, m.d);
      return;
    }
    if (m.t === 's' && Array.isArray(m.p)) {
      this.count = m.p.length;
      const seen = new Set();
      this.voicePeers.clear();
      let rendered = 0;
      for (const row of m.p) {
        if (!Array.isArray(row) || row.length < 5) continue;
        const [id, x, y, z, yaw, voice] = row;
        if (voice) this.voicePeers.add(id);
        if (id === this.id) continue;
        if (rendered++ >= GHOST_LIMIT) break;
        seen.add(id);
        let gh = this.ghosts.get(id);
        if (!gh) {
          gh = this._makeGhost();
          gh.group.position.set(x, y, z);
          gh.yaw = yaw;
          this.ghosts.set(id, gh);
          const known = this.names.get(id);
          if (known) this._setGhostLabel(gh, known);
        }
        gh.tx = x;
        gh.ty = y;
        gh.tz = z;
        gh.tyaw = yaw;
      }
      for (const [id, gh] of this.ghosts) {
        if (!seen.has(id)) {
          this.group.remove(gh.group);
          this.ghosts.delete(id);
        }
      }
    }
  }

  /** Swap a ghost's floating name label. */
  _setGhostLabel(gh, name) {
    if (gh.label) {
      gh.group.remove(gh.label);
      gh.label.material.map?.dispose();
      gh.label.material.dispose();
    }
    gh.label = ghostLabel(name);
    gh.label.position.y = 2.18;
    gh.group.add(gh.label);
  }

  /** World position of a peer's ghost (or null if not rendered). */
  peerPos(id) {
    return this.ghosts.get(id)?.group.position ?? null;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  /** Announce/refresh our display name (also kept for reconnects). */
  setName(name) {
    this.myName = name;
    return this._send({ t: 'n', name });
  }

  sendChat(text) {
    return this._send({ t: 'c', text });
  }

  sendVoiceState(on) {
    return this._send({ t: 'vs', on: on ? 1 : 0 });
  }

  sendRtc(to, d) {
    return this._send({ t: 'rtc', to, d });
  }

  /** Fire-and-forget game payload to everyone else in the world. Use it
   *  for shared mini-games: pick one client as host (lowest id), let it
   *  simulate, and stream the state through this relay. */
  sendGame(room, data) {
    return this._send({ t: 'g', r: room, d: data });
  }

  /** Is this presence id still connected (as far as we can see)? */
  hasPeer(id) {
    return this.ghosts.has(id);
  }

  _clearGhosts() {
    for (const gh of this.ghosts.values()) this.group.remove(gh.group);
    this.ghosts.clear();
  }

  _makeGhost() {
    const rec = buildAvatarBody(this._mats);
    this.group.add(rec.group);
    return {
      ...rec,
      tx: 0, ty: 0, tz: 0, tyaw: 0,
      yaw: 0, phase: Math.random() * 6.28,
    };
  }

  /** Call every frame: sends our pose (throttled) + animates ghosts. */
  update(dt) {
    this._sendAcc += dt * 1000;
    if (this.ws && this.ws.readyState === 1 && this._sendAcc >= SEND_MS) {
      this._sendAcc = 0;
      const p = this.getPose();
      this._send({
        t: 'p',
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        yaw: Math.round(p.yaw * 100) / 100,
      });
    }

    // ghosts ease toward their last reported pose; the walk cycle is
    // driven by how fast they are actually moving
    const k = 1 - Math.exp(-10 * dt);
    for (const gh of this.ghosts.values()) {
      const pos = gh.group.position;
      const dx = gh.tx - pos.x, dy = gh.ty - pos.y, dz = gh.tz - pos.z;
      pos.x += dx * k;
      pos.y += dy * k;
      pos.z += dz * k;
      let dyaw = gh.tyaw - gh.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      gh.yaw += dyaw * k;
      gh.group.rotation.y = gh.yaw;

      const speed = Math.hypot(dx, dz) * k / Math.max(dt, 1e-3);
      const stride = Math.min(speed / 4, 1);
      gh.phase += dt * (2 + speed * 1.4);
      const swing = Math.sin(gh.phase) * 0.5 * stride;
      gh.legL.rotation.x = swing;
      gh.legR.rotation.x = -swing;
      gh.armL.rotation.x = -swing * 0.7;
      gh.armR.rotation.x = swing * 0.7;
    }
  }
}
