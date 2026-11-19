// Headless end-to-end check. Run it before you deploy:
//
//   npm install -g playwright && npx playwright install chromium   (once)
//   npm run build && npm run verify
//
// It starts the real server, opens the world in headless Chromium, and
// walks it: doorway, walls, stairs up AND down, head-bump under the upper
// floor, jumping onto a crate, the [E] prompt and its floor guard, the
// private-link unlock, and two browsers seeing each other and chatting.
// It also saves verify-render.png — LOOK at it after any renderer change.
//
// The trick that makes this reliable: headless Chromium renders at a few
// fps, far too slow to climb stairs in real time. So the tests do not wait
// for frames — they call controls.update(1/60) in a tight loop inside the
// page. Deterministic, and fast.

import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    const globalRoot = execSync('npm root -g').toString().trim();
    ({ chromium } = require(join(globalRoot, 'playwright')));
  } catch {
    console.error('Playwright not found. Install it once:\n  npm install -g playwright\n  npx playwright install chromium');
    process.exit(2);
  }
}

const PORT = 8137;
const TOKEN = 'verify-token-not-a-real-secret';
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), UNLOCK_TOKEN: TOKEN, PRIVATE_FILE: 'private.example/world-links.json' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start')), 8000);
  server.stdout.on('data', (d) => { if (String(d).includes('world server on')) { clearTimeout(t); res(); } });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function enterWorld(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // the anonymous /api/world 403 is expected
    if (m.type() === 'error' && !/403/.test(m.text())) errors.push(m.text());
  });
  // "networkidle" never settles with a live WebSocket — use domcontentloaded
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__world, null, { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById('enter-btn').disabled, null, { timeout: 30000 });
  await page.click('#enter-btn');
  await page.waitForFunction(() => window.__world.phase === 'play', null, { timeout: 60000 });
  return { page, errors };
}

/** Teleport, hold keys, and step the physics n times at 60 Hz. */
const drive = (page, o) => page.evaluate((o) => {
  const w = window.__world;
  const c = w.controls;
  if (o.pos) {
    w.camera.position.set(o.pos[0], o.pos[1] + 1.7, o.pos[2]);
    c.vel.set(0, 0, 0);
    c.velY = 0;
    c.grounded = false;
    c._stepSmooth = 0;
    c._bobOffset = 0;
  }
  if (o.yaw != null) c.setLook(o.yaw, 0);
  c.keys.clear();
  for (let i = 0; i < 30; i++) c.update(1 / 60); // settle onto the floor
  for (const k of o.keys ?? []) c.keys.add(k);
  let maxY = -Infinity;
  for (let i = 0; i < (o.steps ?? 0); i++) {
    if (o.jumpAt === i) c.keys.add('Space');
    if (o.jumpAt != null && i === o.jumpAt + 2) c.keys.delete('Space');
    if (o.releaseAt === i) for (const k of o.keys ?? []) c.keys.delete(k);
    c.update(1 / 60);
    maxY = Math.max(maxY, w.camera.position.y);
  }
  c.keys.clear();
  for (let i = 0; i < (o.settle ?? 40); i++) c.update(1 / 60);
  const p = w.camera.position;
  return { x: p.x, y: p.y, z: p.z, feet: p.y - c._bobOffset - 1.7, maxY, grounded: c.grounded };
}, o);

const near = (a, b, eps) => Math.abs(a - b) <= eps;

try {
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const { page, errors } = await enterWorld(ctxA);

  // ---- render check ----
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'verify-render.png' });
  const info = await page.evaluate(() => {
    const w = window.__world;
    const gl = w.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      calls: w.renderer.info.render.calls,
      tris: w.renderer.info.render.triangles,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
      tier: window.__wwTier,
    };
  });
  console.log(`render: ${info.calls} draw calls, ${info.tris} triangles, tier ${info.tier}, ${info.gpu}`);
  check('scene renders something', info.calls > 5 && info.tris > 500, `${info.calls} calls`);

  // ---- movement + collision ----
  let r = await drive(page, { pos: [0, 0, 14], yaw: 0, steps: 0 });
  check('spawn: standing on the ground', near(r.feet, 0, 0.02) && r.grounded, `feet ${r.feet.toFixed(3)}`);

  r = await drive(page, { pos: [0, 0, 6], yaw: 0, keys: ['KeyW'], steps: 150 });
  check('walks through the doorway into the hall', r.z < -4 && near(r.feet, 0, 0.02), `z ${r.z.toFixed(2)}`);

  r = await drive(page, { pos: [8, 0, -10], yaw: -Math.PI / 2, keys: ['KeyW', 'ShiftLeft'], steps: 180 });
  check('east wall stops a sprint', r.x <= 12 - 0.45 + 0.02 && r.x > 11, `x ${r.x.toFixed(3)}`);

  r = await drive(page, { pos: [-3, 0, 0.5], yaw: 0, keys: ['KeyW'], steps: 150 });
  check('solid wall beside the door blocks entry', r.z > -1.6, `z ${r.z.toFixed(2)}`);

  r = await drive(page, { pos: [-11.2, 0, -3.0], yaw: 0, keys: ['KeyW'], steps: 200 });
  check('stairs: climbs to the upper floor', near(r.feet, 3.2, 0.03) && r.z < -8.9, `feet ${r.feet.toFixed(3)} z ${r.z.toFixed(2)}`);

  r = await drive(page, { pos: [-11.2, 3.2, -10.5], yaw: Math.PI, keys: ['KeyW'], steps: 220 });
  check('stairs: walks back down', near(r.feet, 0, 0.03) && r.z > -3.8, `feet ${r.feet.toFixed(3)} z ${r.z.toFixed(2)}`);

  r = await drive(page, { pos: [-9, 3.2, -15], yaw: -Math.PI / 2, keys: ['KeyW'], steps: 120 });
  check('glass rail keeps you on the upper floor', near(r.feet, 3.2, 0.03) && r.x < -6, `x ${r.x.toFixed(2)}`);

  r = await drive(page, { pos: [-9, 0, -15], yaw: 0, steps: 60, jumpAt: 0 });
  check('head-bump: jump under the upper floor stays below the slab', r.maxY <= 3.0 - 0.14 && near(r.feet, 0, 0.03), `max eye ${r.maxY.toFixed(3)}`);

  r = await drive(page, { pos: [3, 0, -8], yaw: 0, steps: 60, jumpAt: 0 });
  check('open-floor jump reaches full height', r.maxY > 1.7 + 1.3, `apex ${(r.maxY - 1.7).toFixed(3)} m`);

  // a short run-up, jump, let go: air control is deliberately tiny (the
  // 0.76 m/s air cap), so the run-up speed is what carries you onto it
  r = await drive(page, { pos: [7, 0, -4.6], yaw: 0, keys: ['KeyW'], steps: 60, jumpAt: 4, releaseAt: 5, settle: 60 });
  check('jump lands on the 0.5 m crate', near(r.feet, 0.5, 0.03), `feet ${r.feet.toFixed(3)} z ${r.z.toFixed(2)}`);

  r = await drive(page, { pos: [7, 0, -4.6], yaw: 0, keys: ['KeyW'], steps: 90 });
  check('crate blocks you without a jump', near(r.feet, 0, 0.03) && r.z > -5.6, `z ${r.z.toFixed(2)}`);

  // two more pictures: inside the hall, and from the upper floor
  await drive(page, { pos: [3, 0, -4.5], yaw: 0.45 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'verify-interior.png' });
  await drive(page, { pos: [-7, 3.2, -20.5], yaw: Math.PI + 0.9 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'verify-upstairs.png' });

  // ---- hotspots ----
  const prompt = async () => page.evaluate(() => {
    const w = window.__world;
    w.hotspots.update(performance.now() / 1000, false, w.renderer.domElement);
    return w.hotspots.nearSpot?.cfg.name ?? null;
  });
  await drive(page, { pos: [4, 0, 8], yaw: 0 });
  check('[E] prompt appears near the outdoor kiosk', (await prompt()) === 'WELCOME');
  await page.evaluate(() => window.__world.hotspots.tryInteract());
  check('E opens the link card', await page.evaluate(() =>
    !document.getElementById('portal-modal').classList.contains('hidden')
    && document.getElementById('card-link').href.startsWith('https://')));
  await page.click('#card-close');

  await drive(page, { pos: [-9, 0, -15.5], yaw: 0 });
  check('floor guard: upstairs kiosk does not prompt from below', (await prompt()) !== 'UPSTAIRS');
  await drive(page, { pos: [-8, 3.2, -15.5], yaw: 0 });
  check('upstairs kiosk prompts on its own floor', (await prompt()) === 'UPSTAIRS');

  await drive(page, { pos: [-3, 0, -19], yaw: 0 });
  check('[E] prompt appears near the menu kiosk', (await prompt()) === 'LINK LIBRARY');
  await page.evaluate(() => window.__world.hotspots.tryInteract());
  check('menu kiosk opens a link list', await page.evaluate(() =>
    !document.getElementById('menu-modal').classList.contains('hidden')
    && document.querySelectorAll('#menu-body .menu-row a').length >= 4));
  const before = await page.evaluate(() => window.__world.camera.position.z);
  await page.evaluate(() => {
    const c = window.__world.controls;
    c.keys.add('KeyW');
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    c.keys.clear();
  });
  check('an open menu freezes movement', near(await page.evaluate(() => window.__world.camera.position.z), before, 0.001));
  await page.keyboard.press('Escape');

  // ---- private-link gate ----
  const locked = await page.evaluate(() => fetch('/api/world').then((x) => x.status));
  check('private data: anonymous visitor gets 403', locked === 403);
  const bundle = await page.evaluate(async () => {
    const src = [...document.scripts].map((s) => s.src).filter(Boolean)[0];
    return (await (await fetch(src)).text()).includes('MEMBERS LOUNGE');
  });
  check('private data: names are not in the public bundle', bundle === false);
  await page.goto(`${BASE}/unlock/wrong-token`, { waitUntil: 'domcontentloaded' });
  check('private data: wrong token unlocks nothing', (await page.evaluate(() => fetch('/api/world').then((x) => x.status))) === 403);
  await page.goto(`${BASE}/unlock/${TOKEN}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__world, null, { timeout: 30000 });
  await page.waitForFunction(
    () => window.__world.hotspots.spots.some((s) => s.cfg.name === 'MEMBERS LOUNGE'), null, { timeout: 15000 }
  ).then(() => check('private data: unlock link swaps in the real kiosk', true),
    () => check('private data: unlock link swaps in the real kiosk', false));

  // ---- multiplayer: two browsers ----
  await page.close(); // one page per context: background tabs throttle their frame loop
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const a = await enterWorld(ctxA);
  const b = await enterWorld(ctxB);
  await a.page.waitForFunction(() => window.__world.mp.count >= 2 && window.__world.mp.ghosts.size >= 1, null, { timeout: 15000 })
    .then(() => check('multiplayer: second visitor appears as a ghost', true),
      () => check('multiplayer: second visitor appears as a ghost', false));
  await a.page.evaluate(() => {
    window.__world.mp.setName('ALPHA');
    window.__world.mp.sendChat('hello from A');
  });
  await b.page.waitForFunction(() => /hello from A/.test(document.getElementById('chat-log').textContent), null, { timeout: 8000 })
    .then(() => check('multiplayer: chat reaches the other browser', true),
      () => check('multiplayer: chat reaches the other browser', false));
  await a.page.bringToFront();
  await a.page.evaluate(() => window.__world.camera.position.set(5, 1.7, 10));
  await a.page.waitForTimeout(600);
  await b.page.bringToFront();
  await b.page.waitForFunction(() => [...window.__world.mp.ghosts.values()].some(
    (g) => Math.abs(g.tx - 5) < 0.3 && Math.abs(g.tz - 10) < 0.3
  ), null, { timeout: 8000 })
    .then(() => check('multiplayer: ghost follows the other player', true),
      () => check('multiplayer: ghost follows the other player', false));

  const allErrors = [...errors, ...a.errors, ...b.errors];
  check('no page errors', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('test run completed', false, String(e).slice(0, 300));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
