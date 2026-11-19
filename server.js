// One small server: serves the built site from dist/, relays multiplayer
// presence over a WebSocket at /ws, and (optionally) hands private link
// data to authorised visitors.
//
//   npm run build && node server.js        -> http://localhost:8080
//
// Environment variables (all optional):
//   PORT          listen port (default 8080)
//   UNLOCK_TOKEN  long random secret. Visiting /unlock/<token> sets a cookie
//                 that authorises this browser for /api/world.
//   ALLOW_IPS     comma-separated IPs / IPv4 CIDRs that are always authorised
//   TRUST_PROXY_HEADER  name of the header your host sets to the real client
//                 IP (e.g. "fly-client-ip", "cf-connecting-ip"). Leave unset
//                 when the server is reached directly.
//
// Presence state is IN MEMORY: run exactly one instance, or people on
// different machines will not see each other.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = resolve(process.cwd(), 'dist');
const MAX_CLIENTS = 64;

// hardening headers on every response
const SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // microphone=(self): proximity voice needs the mic on our own origin.
  // "microphone=()" here silently blocks getUserMedia for your own page.
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  // CSP: only our own bundle runs. Google Fonts is the one external origin;
  // data:/blob: images cover canvas textures; ws/wss cover the socket.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------- private-data gate ----------------
// The public JavaScript bundle must contain nothing you would mind a
// stranger reading. Real names/links for hotspots that carry a `privateId`
// live in private/world-links.json (git-ignored) and are only sent to
// visitors who pass the checks below.

const UNLOCK_TOKEN = (process.env.UNLOCK_TOKEN ?? '').trim();
const ALLOW_IPS = (process.env.ALLOW_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PROXY_HEADER = (process.env.TRUST_PROXY_HEADER ?? '').trim().toLowerCase();
const COOKIE = 'ww_access';

// PRIVATE_FILE overrides the location (the test script points it at the example)
const PRIVATE_FILE = resolve(process.cwd(), process.env.PRIVATE_FILE || join('private', 'world-links.json'));
let PRIVATE_WORLD = null;
try {
  PRIVATE_WORLD = JSON.parse(await readFile(PRIVATE_FILE, 'utf8'));
  console.log('private gate: private link data loaded');
} catch {
  console.log('private gate: no private/world-links.json — /api/world disabled');
}

/** The real client IP. X-Forwarded-For is CLIENT-SPOOFABLE (anyone can send
 *  their own), so it is never trusted. Only a header your hosting platform
 *  sets authoritatively is used, and only if you name it. */
function clientIp(req) {
  if (PROXY_HEADER) {
    const v = req.headers[PROXY_HEADER];
    if (typeof v === 'string' && v) return v.trim();
  }
  return req.socket.remoteAddress ?? '';
}

/** constant-time token comparison — no string-compare timing oracle */
function tokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// throttle /unlock guessing: 20 attempts per IP per minute
const unlockAttempts = new Map();
function unlockAllowed(ip) {
  const now = Date.now();
  if (unlockAttempts.size > 10000) unlockAttempts.clear();
  let rec = unlockAttempts.get(ip);
  if (!rec || now > rec.reset) {
    rec = { count: 0, reset: now + 60000 };
    unlockAttempts.set(ip, rec);
  }
  rec.count += 1;
  return rec.count <= 20;
}

function ip4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** entry = "1.2.3.4" exact, or "1.2.3.0/24" CIDR (IPv4); IPv6 exact-match only. */
function ipMatches(ip, entry) {
  const bare = ip.replace(/^::ffff:/i, ''); // node reports v4 as ::ffff:a.b.c.d
  if (bare === entry || ip === entry) return true;
  const [net, bitsStr] = entry.split('/');
  if (bitsStr === undefined) return false;
  const bits = Number(bitsStr);
  const ipInt = ip4ToInt(bare);
  const netInt = ip4ToInt(net);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

function readCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthorised(req) {
  const ip = clientIp(req);
  if (ip && ALLOW_IPS.some((entry) => ipMatches(ip, entry))) return true;
  return tokenEqual(readCookies(req)[COOKIE], UNLOCK_TOKEN);
}

// ---------------- http ----------------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);

    // private overlay for authorised visitors; 403 for everyone else
    if (path === '/api/world') {
      const ok = PRIVATE_WORLD && isAuthorised(req);
      res.writeHead(ok ? 200 : 403, { ...SEC_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(ok ? PRIVATE_WORLD : { locked: true }));
      return;
    }

    // /unlock/<token>: sets the access cookie, then bounces home
    if (path.startsWith('/unlock/')) {
      const ip = clientIp(req);
      const given = path.slice('/unlock/'.length);
      if (!unlockAllowed(ip)) {
        res.writeHead(429, SEC_HEADERS);
        res.end('slow down');
        return;
      }
      if (UNLOCK_TOKEN && tokenEqual(given, UNLOCK_TOKEN)) {
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(302, {
          ...SEC_HEADERS,
          'Set-Cookie': `${COOKIE}=${UNLOCK_TOKEN}; Path=/; Max-Age=${180 * 86400}; HttpOnly; SameSite=Lax${secure}`,
          Location: '/',
        });
      } else {
        res.writeHead(302, { ...SEC_HEADERS, Location: '/' });
      }
      res.end();
      return;
    }

    // static files from dist/
    if (path === '/' || path === '') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403, SEC_HEADERS);
      res.end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, {
      ...SEC_HEADERS,
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // hashed build assets cache forever; index.html always revalidates
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    // unknown path -> index (harmless for a single-page world)
    try {
      const data = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404, SEC_HEADERS);
      res.end('not found — run "npm run build" first');
    }
  }
});

// ---------------- presence ----------------

// 16 KB payload cap: pose/chat messages are tiny, but WebRTC voice
// signaling (SDP offers) runs 2-8 KB. Each message type has its own cap too.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
const players = new Map(); // ws -> state
let nextId = 1;

const num = (v, lim) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(-lim, Math.min(lim, v)) : 0;

/** printable ASCII only, collapsed whitespace, hard length cap */
const cleanText = (v, max) =>
  String(v ?? '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const sendTo = (ws, obj) => {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* close event follows */ }
  }
};
const broadcast = (obj, except = null) => {
  let out;
  try { out = JSON.stringify(obj); } catch { return; }
  for (const peer of players.keys()) {
    if (peer !== except && peer.readyState === 1) {
      try { peer.send(out); } catch { /* close event follows */ }
    }
  }
};

wss.on('connection', (ws) => {
  if (players.size >= MAX_CLIENTS) {
    ws.close(1013, 'full');
    return;
  }
  const st = {
    id: nextId++, x: 0, y: 0, z: 0, yaw: 0,
    name: '', voice: false,
    gCount: 0, gReset: 0, cCount: 0, cReset: 0,
  };
  players.set(ws, st);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (!m) return;
    // pose
    if (m.t === 'p') {
      st.x = num(m.x, 500);
      st.y = num(m.y, 300);
      st.z = num(m.z, 500);
      st.yaw = num(m.yaw, 10);
      return;
    }
    // display name (chosen in the chat box, kept in localStorage)
    if (m.t === 'n') {
      const name = cleanText(m.name, 16);
      if (!name) return;
      st.name = name;
      broadcast({ t: 'n', id: st.id, name });
      return;
    }
    // world chat: one shared channel, name required, 6 msgs / 10 s
    if (m.t === 'c') {
      if (!st.name) return;
      const now = Date.now();
      if (now > st.cReset) { st.cReset = now + 10000; st.cCount = 0; }
      if (++st.cCount > 6) return;
      const text = cleanText(m.text, 200);
      if (!text) return;
      broadcast({ t: 'c', id: st.id, name: st.name, text });
      return;
    }
    // voice presence flag — who is discoverable for proximity audio
    if (m.t === 'vs') {
      st.voice = !!m.on;
      return;
    }
    // WebRTC signaling relay: {t:'rtc', to, d} -> that peer as {from, d}.
    // Payloads are opaque SDP/ICE blobs; 10 KB cap, no inspection.
    if (m.t === 'rtc' && Number.isInteger(m.to)) {
      let size = 0;
      try { size = JSON.stringify(m.d).length; } catch { return; }
      if (size > 10240) return;
      for (const [peer, pst] of players) {
        if (pst.id === m.to) {
          sendTo(peer, { t: 'rtc', from: st.id, d: m.d });
          return;
        }
      }
      return;
    }
    // game relay: opaque room-tagged payloads fanned out to everyone else,
    // stamped with the sender's id. No game logic lives server-side.
    if (m.t === 'g' && typeof m.r === 'string' && m.r.length <= 8) {
      const now = Date.now();
      if (now > st.gReset) { st.gReset = now + 1000; st.gCount = 0; }
      if (++st.gCount > 40) return; // per-connection flood guard
      let out;
      try { out = JSON.stringify({ t: 'g', id: st.id, r: m.r, d: m.d ?? null }); } catch { return; }
      if (out.length > 2000) return;
      for (const peer of players.keys()) {
        if (peer !== ws && peer.readyState === 1) {
          try { peer.send(out); } catch { /* close event follows */ }
        }
      }
    }
  });
  ws.on('close', () => players.delete(ws));
  ws.on('error', () => { /* close event follows */ });
  // greet with id + the roster of names already in the world
  const names = {};
  for (const pst of players.values()) if (pst.name) names[pst.id] = pst.name;
  sendTo(ws, { t: 'hi', id: st.id, names });
});

// state broadcast @10 Hz — rows: [id, x, y, z, yaw, voiceFlag]
setInterval(() => {
  if (players.size === 0) return;
  const p = [];
  for (const st of players.values()) p.push([st.id, st.x, st.y, st.z, st.yaw, st.voice ? 1 : 0]);
  const msg = JSON.stringify({ t: 's', p });
  for (const ws of players.keys()) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { /* close event follows */ }
    }
  }
}, 100);

// reap dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* terminated */ }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`world server on http://localhost:${PORT}  (unlock ${UNLOCK_TOKEN ? 'enabled' : 'disabled'}, ${ALLOW_IPS.length} allowlisted range(s))`);
});
