// Touch controls for phones/tablets (iPhone, iPad, Android): dynamic
// left-thumb joystick for CS walking (push to the rim = run), drag
// anywhere else to look, quick tap = interact-click at the tap point,
// and emulator-style JUMP / OPEN buttons parked bottom-right.
// Mounts only on coarse-pointer devices — desktop never sees any of it.
// The joystick feeds analog axes into PlayerControls.touch, so the same
// Source-engine accelerate/friction path drives both input styles.

import { MathUtils } from 'three';
import { PLAYER } from './config.js';

export const isTouchDevice = () =>
  (window.matchMedia?.('(pointer: coarse)')?.matches ?? false) || 'ontouchstart' in window;

const STICK_RADIUS = 56; // px from origin to full deflection
const DEADZONE = 0.14; // thumb wobble below this is "standing still"
const RUN_EDGE = 0.92; // rim push = sprint, like clicking a thumbstick
const TAP_MS = 280; // quicker than this…
const TAP_SLOP = 12; // …and stiller than this = a tap, not a look-drag

export class TouchControls {
  /**
   * @param {*} opts { isUiOpen: () => bool, onTap: (x, y) => void, onInteract: () => void }
   */
  constructor(canvas, controls, hud, opts = {}) {
    this.canvas = canvas;
    this.controls = controls;
    this.hud = hud;
    this.isUiOpen = opts.isUiOpen ?? (() => false);
    this.onTap = opts.onTap ?? (() => {});
    this.onInteract = opts.onInteract ?? (() => {});

    // one finger may own the stick and one the camera, tracked by
    // Touch.identifier so a second thumb never steals either
    this.stickId = null;
    this.lookId = null;
    this.stick = { ox: 0, oy: 0, t: 0, moved: 0 };
    this.look = { lx: 0, ly: 0, t: 0, moved: 0, sx: 0, sy: 0 };
    // finger-drag needs more gain than a mouse — same slider multiplies on top
    this.lookScale = 2.2;
    this._hidden = false;

    this._buildDom();
    this._bind();
  }

  _buildDom() {
    const ui = document.createElement('div');
    ui.id = 'touch-ui';
    ui.innerHTML = `
      <div id="stick-base"><div id="stick-nub"></div></div>
      <div id="touch-btns">
        <button id="tbtn-open" class="tbtn" type="button">OPEN<span>[E]</span></button>
        <button id="tbtn-jump" class="tbtn" type="button">JUMP</button>
      </div>`;
    document.body.appendChild(ui);
    this.ui = ui;
    this.base = ui.querySelector('#stick-base');
    this.nub = ui.querySelector('#stick-nub');
  }

  _bind() {
    const { canvas, controls } = this;

    canvas.addEventListener('touchstart', (e) => {
      if (this.isUiOpen()) return;
      e.preventDefault(); // no scroll, no double-tap zoom, no ghost mouse events
      for (const t of e.changedTouches) {
        // left 45% of the screen = movement thumb, everywhere else = camera
        if (this.stickId === null && t.clientX < window.innerWidth * 0.45) {
          this.stickId = t.identifier;
          this.stick.ox = t.clientX;
          this.stick.oy = t.clientY;
          this.stick.t = performance.now();
          this.stick.moved = 0;
          this.base.style.left = `${t.clientX}px`;
          this.base.style.top = `${t.clientY}px`;
          this.base.classList.add('on');
          this._setNub(0, 0);
        } else if (this.lookId === null) {
          this.lookId = t.identifier;
          this.look.lx = this.look.sx = t.clientX;
          this.look.ly = this.look.sy = t.clientY;
          this.look.t = performance.now();
          this.look.moved = 0;
        }
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          const dx = t.clientX - this.stick.ox;
          const dy = t.clientY - this.stick.oy;
          this.stick.moved += 1;
          const len = Math.hypot(dx, dy);
          const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
          this._setNub(dx * k, dy * k);
          const fx = (dx * k) / STICK_RADIUS;
          const fy = (dy * k) / STICK_RADIUS;
          const mag = Math.hypot(fx, fy);
          if (mag < DEADZONE) {
            controls.touch.f = 0;
            controls.touch.r = 0;
            controls.touch.run = false;
          } else {
            // rescale so the deadzone edge = 0, the rim = 1 — no dead jump
            const g = (mag - DEADZONE) / (1 - DEADZONE) / mag;
            controls.touch.f = -fy * g; // screen-up = forward
            controls.touch.r = fx * g;
            controls.touch.run = mag >= RUN_EDGE;
          }
        } else if (t.identifier === this.lookId) {
          const dx = t.clientX - this.look.lx;
          const dy = t.clientY - this.look.ly;
          this.look.lx = t.clientX;
          this.look.ly = t.clientY;
          this.look.moved += Math.abs(dx) + Math.abs(dy);
          if (controls.enabled && !this.isUiOpen()) {
            const s = this.lookScale * controls.sens;
            controls.yaw -= dx * PLAYER.lookSensX * s;
            controls.pitch = MathUtils.clamp(
              controls.pitch - dy * PLAYER.lookSensY * s,
              -PLAYER.pitchClamp, PLAYER.pitchClamp
            );
          }
        }
      }
    }, { passive: false });

    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          this.stickId = null;
          this.base.classList.remove('on');
          controls.touch.f = 0;
          controls.touch.r = 0;
          controls.touch.run = false;
          // a barely-moved quick press on the walk side still opens things
          if (e.type === 'touchend'
            && performance.now() - this.stick.t < TAP_MS && this.stick.moved < 3
            && !this.isUiOpen()) {
            this.onTap(this.stick.ox, this.stick.oy);
          }
        } else if (t.identifier === this.lookId) {
          this.lookId = null;
          if (e.type === 'touchend'
            && performance.now() - this.look.t < TAP_MS && this.look.moved < TAP_SLOP
            && !this.isUiOpen()) {
            this.onTap(this.look.sx, this.look.sy);
          }
        }
      }
    };
    canvas.addEventListener('touchend', end, { passive: false });
    canvas.addEventListener('touchcancel', end, { passive: false });

    // JUMP presses Space for real — seat-stand, bunny hop, fly-up all ride
    // the existing key path. OPEN mirrors [E] (nearest prompt interact).
    const press = (btn, down, up) => {
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        down();
      }, { passive: false });
      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('pressed');
        up?.();
      };
      btn.addEventListener('touchend', release, { passive: false });
      btn.addEventListener('touchcancel', release, { passive: false });
    };
    press(this.ui.querySelector('#tbtn-jump'),
      () => controls.keys.add('Space'),
      () => controls.keys.delete('Space'));
    press(this.ui.querySelector('#tbtn-open'),
      () => { if (!this.isUiOpen()) this.onInteract(); });
  }

  _setNub(x, y) {
    this.nub.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  /** Per-frame from the main loop: park the pads while any UI is up. */
  update(uiOpen) {
    if (uiOpen === this._hidden) return;
    this._hidden = uiOpen;
    this.ui.classList.toggle('ui-hidden', uiOpen);
    if (uiOpen) {
      this.stickId = null;
      this.lookId = null;
      this.base.classList.remove('on');
      this.controls.touch.f = 0;
      this.controls.touch.r = 0;
      this.controls.touch.run = false;
    }
  }
}
