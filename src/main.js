// Boot, intro fly-in, hotkeys, and the game loop.

import {
  ACESFilmicToneMapping,
  Clock,
  MathUtils,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { World } from './world.js';
import { LOOK_TARGET as LOOK_CFG, PLAYER, SITE, SPAWN as SPAWN_CFG } from './config.js';
import { PlayerControls, Mode } from './controls.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { Hotspots } from './hotspots.js';
import { Hud } from './hud.js';
import { Multiplayer } from './multiplayer.js';
import { Chat } from './chat.js';
import { VoiceChat } from './voice.js';
import { showWebGLFailure } from './overlay.js';

const SPAWN = new Vector3(SPAWN_CFG.x, SPAWN_CFG.y, SPAWN_CFG.z);
const LOOK_TARGET = new Vector3(LOOK_CFG.x, LOOK_CFG.y, LOOK_CFG.z);

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch {
    return false;
  }
}

async function boot() {
  if (!webglOk()) {
    showWebGLFailure();
    return;
  }
  // signs are drawn to canvas at boot — make sure the font is loaded first,
  // or they are painted in the fallback font forever
  try {
    await Promise.race([
      document.fonts.load('58px VT323'),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  } catch { /* fall back to monospace */ }
  init();
}

function init() {
  const app = document.getElementById('app');
  document.title = SITE.title;
  for (const id of ['title-chip', 'intro-title']) {
    const el = document.getElementById(id);
    if (el) el.textContent = SITE.title;
  }
  const taglineEl = document.getElementById('intro-tagline');
  if (taglineEl) taglineEl.textContent = SITE.tagline;

  // ---------- graphics tier ----------
  // Manual pick (ww_gfx: high/med/low) wins; AUTO uses the remembered
  // ratchet tier (ww_perf_tier). Read BEFORE the context exists — MSAA can
  // only be chosen at context creation.
  let gfxPref = 'auto';
  try { gfxPref = localStorage.getItem('ww_gfx') ?? 'auto'; } catch { /* private mode */ }
  if (!['auto', 'high', 'med', 'low'].includes(gfxPref)) gfxPref = 'auto';
  let bootTier = 0;
  try { bootTier = Math.min(2, parseInt(localStorage.getItem('ww_perf_tier') ?? '0', 10) || 0); } catch { /* private mode */ }
  if (gfxPref !== 'auto') bootTier = { high: 0, med: 1, low: 2 }[gfxPref];

  const renderer = new WebGLRenderer({ antialias: bootTier < 2 });
  // Only true SOFTWARE renderers get pre-flagged as weak. Guessing from
  // "integrated GPU" punishes capable machines; real GPUs start at full
  // quality and the fps ratchet below downgrades from measured reality.
  let softwareGl = false;
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    softwareGl = /swiftshader|llvmpipe|software rasterizer|basic render/i.test(gpu);
  } catch { /* keep defaults */ }
  if (gfxPref === 'auto' && softwareGl) bootTier = 2;
  window.__wwTier = bootTier; // label sizing etc. reads this

  // Pixel-ratio cap 1.5: on a 4K screen a DPR-2 backbuffer is 4x the
  // pixels of DPR-1. This cap is the single biggest frame-time lever.
  const ratioCap = bootTier >= 2 ? 1.0 : bootTier === 1 ? 1.25 : 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  app.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new Scene();
  // subtle environment reflections so wood/metal read satin, not dead —
  // three's built-in RoomEnvironment, no HDRI download needed
  {
    const pmrem = new PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.28;
    pmrem.dispose();
  }
  // near 0.25 (not 0.1): depth precision is dominated by the near plane —
  // this alone cuts distant z-fighting, and first-person geometry never
  // gets closer than the 0.45 body radius anyway
  const camera = new PerspectiveCamera(
    PLAYER.fov, window.innerWidth / window.innerHeight, 0.25, 2000
  );

  const hud = new Hud();

  // graphics cycle button: AUTO -> HIGH -> MED -> LOW. Clicks cycle freely;
  // the pick commits (save + one reload) after you stop clicking.
  {
    const gfxBtn = document.getElementById('gfx-btn');
    gfxBtn.textContent = `GFX ${gfxPref.toUpperCase()}`;
    let pending = gfxPref;
    let timer = null;
    gfxBtn.addEventListener('click', () => {
      const order = ['auto', 'high', 'med', 'low'];
      pending = order[(order.indexOf(pending) + 1) % order.length];
      gfxBtn.textContent = `GFX ${pending.toUpperCase()}`;
      clearTimeout(timer);
      if (pending === gfxPref) return;
      timer = setTimeout(() => {
        try {
          localStorage.setItem('ww_gfx', pending);
          if (pending === 'auto') localStorage.removeItem('ww_perf_tier'); // re-measure fresh
        } catch { /* private mode */ }
        hud.toast(`GRAPHICS: ${pending.toUpperCase()} — RELOADING…`, 1400);
        setTimeout(() => location.reload(), 650);
      }, 1100);
    });
  }

  const world = new World(scene, renderer, bootTier);

  // ---------- UI state ----------
  const intro = document.getElementById('intro');
  const errorOverlay = document.getElementById('overlay');
  const enterBtn = document.getElementById('enter-btn');
  let chat = null;
  let hotspots = null;
  // ONE definition of "a UI is open". Movement, hotkeys and touch pads all
  // ask this, so typing in any box can never move the player.
  const isUiOpen = () =>
    !intro.classList.contains('hidden') ||
    (hotspots !== null && hotspots.isModalOpen()) ||
    (chat !== null && chat.isTyping()) ||
    !errorOverlay.classList.contains('hidden');

  // ---------- player / hotspots ----------
  let phase = 'aerial'; // 'aerial' -> 'glide' -> 'play'
  const controls = new PlayerControls(camera, canvas, world, hud, {
    isUiOpen,
    onCanvasClick: (x, y) => {
      if (phase === 'play') hotspots.clickAt(x, y, canvas);
    },
  });
  hotspots = new Hotspots(scene, camera, world, hud, controls);

  // phones/tablets: virtual joystick + look-drag + JUMP/OPEN buttons
  let touchUi = null;
  if (isTouchDevice()) {
    touchUi = new TouchControls(canvas, controls, hud, {
      isUiOpen,
      onTap: (x, y) => { if (phase === 'play') hotspots.clickAt(x, y, canvas); },
      onInteract: () => { if (phase === 'play') hotspots.tryInteract(); },
    });
    document.body.classList.add('touch');
    document.getElementById('hint-bar').textContent =
      'LEFT THUMB — WALK (RIM = RUN) · DRAG — LOOK · TAP — OPEN';
  }

  // multiplayer ghosts (fails silently offline / in plain vite dev)
  const mp = new Multiplayer(scene, () => ({
    x: camera.position.x,
    y: camera.position.y - controls._bobOffset - PLAYER.eyeHeight,
    z: camera.position.z,
    yaw: controls.yaw,
  }));
  // world chat (ENTER/T) + proximity voice (V) ride the same socket
  chat = new Chat(mp, hud, () => controls.clearInputs());
  const voice = new VoiceChat(mp, hud, () => ({
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
  }));

  window.addEventListener('mousemove', (e) => hotspots.onMouseMove(e, canvas));

  // Private overlay: if the server says this visitor is authorised (IP
  // allowlist or unlock cookie), /api/world returns the real names and
  // links for hotspots that carry a privateId. Everyone else gets a 403
  // and the generic public world stands as-is.
  fetch('/api/world')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      hotspots.applyPrivate(data.stations);
      hud.toast('ACCESS GRANTED — PRIVATE LINKS UNLOCKED', 2600);
    })
    .catch(() => { /* offline/dev without server — public mode */ });

  // ---------- spawn + intro fly-in ----------
  const lookDir = LOOK_TARGET.clone().sub(SPAWN).normalize();
  const spawnYaw = Math.atan2(-lookDir.x, -lookDir.z);
  const spawnPitch = 0.04;
  controls.setSpawn({ position: SPAWN, yaw: spawnYaw, pitch: spawnPitch, orbitTarget: LOOK_TARGET });

  // aerial hold behind the intro card
  camera.position.set(60, 46, 50);
  controls.setLook(spawnYaw + 0.35, -0.75);

  // the swoop: a quadratic bezier whose control point is pulled sideways
  // and upward — a banked, curving descent — with an FOV rush that eases
  // into the play fov as you touch down, and a roll that leans into the turn
  const glide = {
    t: 0, dur: 2.4, from: new Vector3(), fromYaw: 0, fromPitch: 0,
    ctrl: new Vector3(), bank: 1, _a: new Vector3(), _b: new Vector3(),
  };

  function startGlide() {
    phase = 'glide';
    glide.t = 0;
    glide.from.copy(camera.position);
    glide.fromYaw = controls.yaw;
    glide.fromPitch = controls.pitch;
    const mid = new Vector3().addVectors(glide.from, SPAWN).multiplyScalar(0.5);
    const dir = new Vector3().subVectors(SPAWN, glide.from);
    const dist = dir.length();
    const side = new Vector3(-dir.z, 0, dir.x).normalize();
    glide.bank = Math.random() < 0.5 ? 1 : -1; // vary the approach each visit
    glide.ctrl.copy(mid)
      .addScaledVector(side, dist * 0.3 * glide.bank)
      .add(new Vector3(0, dist * 0.12, 0));
  }

  function updateGlide(dt) {
    glide.t = Math.min(glide.t + dt / glide.dur, 1);
    const k = glide.t < 0.5
      ? 4 * glide.t ** 3
      : 1 - (-2 * glide.t + 2) ** 3 / 2; // easeInOutCubic
    glide._a.lerpVectors(glide.from, glide.ctrl, k);
    glide._b.lerpVectors(glide.ctrl, SPAWN, k);
    camera.position.lerpVectors(glide._a, glide._b, k);
    // shortest-path yaw lerp
    let dyaw = spawnYaw - glide.fromYaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    controls.setLook(glide.fromYaw + dyaw * k, MathUtils.lerp(glide.fromPitch, spawnPitch, k));
    camera.rotateZ(Math.sin(k * Math.PI) * 0.085 * glide.bank); // lean into it
    camera.fov = MathUtils.lerp(88, PLAYER.fov, k);
    camera.updateProjectionMatrix();
    if (glide.t >= 1) {
      camera.fov = PLAYER.fov;
      camera.updateProjectionMatrix();
      controls.setLook(spawnYaw, spawnPitch);
      controls.activate();
      phase = 'play';
      hud.toast(`WELCOME TO ${SITE.title}`, 2600);
    }
  }

  // ---------- intro button ----------
  // The first render compiles EVERY shader and uploads every canvas
  // texture. On slower laptops that froze the tab for seconds and silently
  // swallowed the first ENTER clicks. Precompile the whole scene before
  // arming the button, with an honest loading label.
  let entered = false;
  const enterLabel = enterBtn.textContent;
  enterBtn.disabled = true;
  enterBtn.classList.add('loading');
  enterBtn.textContent = 'LOADING…';
  const armEnter = () => {
    if (!enterBtn.disabled) return;
    enterBtn.disabled = false;
    enterBtn.classList.remove('loading');
    enterBtn.textContent = enterLabel;
  };
  try {
    const warm = renderer.compileAsync
      ? renderer.compileAsync(scene, camera)
      : Promise.resolve().then(() => renderer.compile(scene, camera));
    warm.then(armEnter, armEnter);
  } catch { armEnter(); }
  setTimeout(armEnter, 12000); // backstop — never leave the door locked
  enterBtn.addEventListener('click', () => {
    intro.classList.add('hidden');
    if (entered) return; // reopened as help — just close
    entered = true;
    enterBtn.textContent = 'BACK TO THE WORLD';
    startGlide();
  });

  // mouse-sense slider on the help card — instant apply, saved per browser
  const sensSlider = document.getElementById('sens-slider');
  const sensVal = document.getElementById('sens-val');
  if (sensSlider && sensVal) {
    const showSens = () => { sensVal.textContent = `${Math.round(controls.sens * 100)}%`; };
    sensSlider.value = String(controls.sens);
    showSens();
    sensSlider.addEventListener('input', () => {
      controls.setSens(parseFloat(sensSlider.value));
      showSens();
    });
  }

  // FOV slider — CS-style HORIZONTAL degrees (90 = the classic default),
  // converted with the 4:3 convention so 90 lands exactly on 73.74 vertical.
  // Mutating PLAYER.fov is the whole trick: the sprint-FOV ease and the
  // intro glide both derive from it every frame.
  const fovSlider = document.getElementById('fov-slider');
  const fovVal = document.getElementById('fov-val');
  if (fovSlider && fovVal) {
    const toVert = (h) => 2 * Math.atan(Math.tan((h * Math.PI) / 360) * 3 / 4) * (180 / Math.PI);
    let hfov = 90;
    try {
      const s = parseFloat(localStorage.getItem('ww_fov'));
      if (Number.isFinite(s) && s >= 80 && s <= 120) hfov = s;
    } catch { /* private mode */ }
    const applyFov = () => {
      PLAYER.fov = toVert(hfov);
      fovVal.textContent = `${Math.round(hfov)}°`;
      camera.fov = PLAYER.fov;
      camera.updateProjectionMatrix();
    };
    fovSlider.value = String(hfov);
    applyFov();
    fovSlider.addEventListener('input', () => {
      hfov = parseFloat(fovSlider.value);
      applyFov();
      try { localStorage.setItem('ww_fov', String(hfov)); } catch { /* private mode */ }
    });
  }

  // ---------- hotkeys ----------
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    // typing anywhere must never trigger world hotkeys. H sits above the
    // isUiOpen guard so it can close the help card — which makes it the
    // one key that can leak, hence the explicit typing check.
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.code === 'KeyH' && entered && !typing) {
      intro.classList.toggle('hidden');
      controls.clearInputs();
      return;
    }
    if (isUiOpen() || phase !== 'play') return;

    if (e.code === 'Enter' || e.code === 'KeyT') {
      e.preventDefault();
      chat.open();
      return;
    }
    switch (e.code) {
      case 'KeyC':
        if (controls.mode !== Mode.FLY) controls.toggleMouseLock(); // C = descend while flying
        break;
      case 'KeyV':
        voice.toggle();
        break;
      case 'KeyE':
        hotspots.tryInteract();
        break;
      case 'KeyR':
        controls.reset();
        hud.toast('BACK TO SPAWN', 1400);
        break;
      case 'KeyF': {
        const m = controls.mode === Mode.FLY ? Mode.WALK : Mode.FLY;
        controls.setMode(m);
        hud.toast(m === Mode.FLY
          ? 'FREE-FLY CAM — WASD + SPACE/C, SCROLL = SPEED'
          : 'WALK MODE', 2600);
        break;
      }
      case 'KeyO': {
        const m = controls.mode === Mode.ORBIT ? Mode.WALK : Mode.ORBIT;
        controls.setMode(m);
        hud.toast(m === Mode.ORBIT ? 'ORBIT CAM — DRAG / SCROLL' : 'WALK MODE', 2200);
        break;
      }
    }
  });

  // ---------- resize ----------
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- auto performance ratchet ----------
  // Stuck under ~48 fps for 2.5 s -> tier 1 (1.25 pixel ratio). Still under
  // ~34 -> tier 2 (1.0). ONE-WAY (stepping back up would oscillate) and
  // REMEMBERED per device, so the next visit boots straight into the tier.
  const perf = { ema: 55, low: 0, steps: [{ fps: 48, cap: 1.25 }, { fps: 34, cap: 1.0 }], next: bootTier };
  function perfCheck(dt) {
    if (gfxPref !== 'auto') return; // a manual pick is final
    if (phase !== 'play' || dt <= 0) return;
    perf.ema += (1 / dt - perf.ema) * 0.08;
    const step = perf.steps[perf.next];
    if (!step) return;
    if (perf.ema < step.fps) {
      perf.low += dt;
      if (perf.low > 2.5) {
        perf.next += 1;
        const target = Math.min(window.devicePixelRatio, step.cap);
        if (target < renderer.getPixelRatio()) renderer.setPixelRatio(target);
        world.setLowPerf(perf.next);
        window.__wwTier = perf.next;
        try { localStorage.setItem('ww_perf_tier', String(perf.next)); } catch { /* private mode */ }
        hud.toast('PERFORMANCE MODE — TUNED FOR SMOOTHNESS', 3200);
        perf.low = 0;
      }
    } else if (perf.ema > step.fps + 8) {
      perf.low = 0;
    }
  }

  // ---------- main loop ----------
  const clock = new Clock();
  // Shadow map at HALF rate: the world is almost entirely static, yet by
  // default the whole scene is re-rendered into the shadow map every frame
  // (roughly doubling draw calls). autoUpdate=false is only safe because
  // needsUpdate is driven below — turn one off without the other and every
  // lit material goes blank. Screenshot-test any change to this.
  renderer.shadowMap.autoUpdate = false;
  let shadowTick = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    perfCheck(dt);
    if (shadowTick++ % (world.lowPerf ? 3 : 2) === 0) renderer.shadowMap.needsUpdate = true;

    if (phase === 'aerial') {
      // slow drift behind the intro card
      camera.position.x = 62 * Math.cos(t * 0.05);
      camera.position.z = -12 + 62 * Math.sin(t * 0.05 + 1.05);
      camera.position.y = 46;
      camera.lookAt(0, 0, -12);
      controls._syncFromCamera();
    } else if (phase === 'glide') {
      updateGlide(dt);
    } else {
      controls.update(dt);
    }

    const uiOpen = isUiOpen() || phase !== 'play';
    world.update(t, camera.position);
    mp.update(dt);
    voice.update();
    touchUi?.update(uiOpen);
    hotspots.update(t, uiOpen, canvas);
    hud.update(dt, {
      mode: phase === 'play' ? controls.mode : 'intro',
      speed: controls.mode === Mode.FLY && phase === 'play' ? controls.flySpeed : null,
      online: mp.count,
    });
    renderer.render(scene, camera);
  });

  // Debug handle: lets you (and headless tests) poke the world from the
  // console — teleport, drive controls.update(1/60), read draw calls from
  // __world.renderer.info.render.calls. Harmless in production.
  window.__world = { camera, controls, world, hotspots, mp, chat, voice, renderer, get phase() { return phase; } };
}

boot();
