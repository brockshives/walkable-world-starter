// Player controller: drag-to-look (no pointer lock) + Counter-Strike
// movement. Walking is a faithful port of the Source engine's ground
// friction / accelerate / air-accelerate trio (see PLAYER in config.js
// for the sv_* cvar conversions), so it carries momentum, stops with
// friction, and air-strafes exactly like CS. FLY and ORBIT are kept as
// extra camera modes.

import { Euler, MathUtils, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { INTERACT, PLAYER } from './config.js';

export const Mode = {
  WALK: 'walk',
  FLY: 'fly',
  ORBIT: 'orbit',
  LOOK: 'look', // look-only (photo-sphere mode)
};

const _euler = new Euler(0, 0, 0, 'YXZ');
const _v = new Vector3();

export class PlayerControls {
  /**
   * @param {*} opts { isUiOpen: () => bool, onCanvasClick: (x, y) => void }
   */
  constructor(camera, canvas, world, hud, opts = {}) {
    this.camera = camera;
    this.canvas = canvas;
    this.world = world; // needs resolveCollisions / groundHeightAt / ceilingHeightAt
    this.hud = hud;
    this.isUiOpen = opts.isUiOpen ?? (() => false);
    this.onCanvasClick = opts.onCanvasClick ?? (() => {});

    this.mode = Mode.WALK;
    this.enabled = false; // gated until the intro fly-in lands

    this.yaw = 0;
    this.pitch = 0;
    // mouse-look sensitivity multiplier (help-card slider, persisted)
    this.sens = 1;
    try {
      const s = parseFloat(localStorage.getItem('ww_sens'));
      if (Number.isFinite(s) && s >= 0.2 && s <= 3) this.sens = s;
    } catch { /* private mode */ }
    this.vel = new Vector3(); // horizontal momentum (x/z) — CS style
    this.velY = 0;
    this.grounded = false;
    this.bobT = 0;
    this._bobOffset = 0;
    this.flySpeed = 30;

    this.spawn = null;
    this.keys = new Set();
    // analog axes from the touch joystick (touch.js) — merged with the
    // keyboard in _inputAxes so both drive the same CS movement
    this.touch = { f: 0, r: 0, run: false };

    this.orbit = new OrbitControls(camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.maxDistance = 600;
    this.orbit.enabled = false;

    this._bind();
  }

  // ---------- input wiring ----------

  _bind() {
    const { canvas } = this;
    const drag = { on: false, lx: 0, ly: 0, moved: 0 };

    // ---- hold RIGHT mouse = pointer-locked free look ----
    // The cursor disappears and raw movement deltas drive the camera, so
    // you can spin 360s forever without dragging off the screen. Release
    // (or Esc — the browser reserves it) gives the cursor back. If the
    // browser refuses the lock (rapid Esc re-entry throttle, old browser),
    // RMB still works as a plain drag via the fallback below.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('mousedown', (e) => {
      if (this.mode === Mode.ORBIT || this.isUiOpen()) return;
      // toggled mouse-look: the cursor is captured — a left press is
      // always an interact-click at the crosshair, never a look-drag
      if (document.pointerLockElement === canvas && this.lockToggle) return;
      if (e.button === 2) {
        drag.on = true; // fallback drag path if the lock is refused
        drag.lx = e.clientX;
        drag.ly = e.clientY;
        drag.moved = 999; // a right-press is never a click
        canvas.classList.add('dragging');
        try {
          const p = canvas.requestPointerLock?.();
          if (p && p.catch) p.catch(() => { /* fallback drag covers it */ });
        } catch { /* fallback drag covers it */ }
        return;
      }
      if (e.button !== 0) return;
      drag.on = true;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      drag.moved = 0;
      canvas.classList.add('dragging');
    });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      canvas.classList.toggle('dragging', locked || drag.on);
      if (!locked) {
        drag.lx = null; // resync the drag origin on next move
        this.lockToggle = false; // Esc always hands the cursor back
      }
      // crosshair marks the interact point while the cursor is captured
      document.getElementById('crosshair')?.classList.toggle('on', locked);
    });

    window.addEventListener('mousemove', (e) => {
      // pointer-locked: raw deltas, no cursor, no edges
      if (document.pointerLockElement === canvas) {
        if (this.enabled && !this.isUiOpen() && this.mode !== Mode.ORBIT) {
          // targets only — _stepLook eases the camera onto them per frame
          this.yaw -= e.movementX * PLAYER.lookSensX * this.sens;
          this.pitch = MathUtils.clamp(
            this.pitch - e.movementY * PLAYER.lookSensY * this.sens, -PLAYER.pitchClamp, PLAYER.pitchClamp
          );
        }
        return;
      }
      if (!drag.on) return;
      if (drag.lx === null) { drag.lx = e.clientX; drag.ly = e.clientY; return; }
      const dx = e.clientX - drag.lx;
      const dy = e.clientY - drag.ly;
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.enabled && !this.isUiOpen() && this.mode !== Mode.ORBIT) {
        // targets only — _stepLook eases the camera onto them per frame
        this.yaw -= dx * PLAYER.lookSensX * this.sens;
        this.pitch = MathUtils.clamp(
          this.pitch - dy * PLAYER.lookSensY * this.sens, -PLAYER.pitchClamp, PLAYER.pitchClamp
        );
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (document.pointerLockElement === canvas && this.lockToggle) {
        // toggled mode: RMB release keeps the lock; LMB = crosshair click
        if (e.button === 0 && !this.isUiOpen()) {
          this.onCanvasClick(window.innerWidth / 2, window.innerHeight / 2);
        }
        return;
      }
      if (e.button === 2 && document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
      if (!drag.on) return;
      drag.on = false;
      canvas.classList.remove('dragging');
      // a barely-moved LEFT press is a click, not a look-drag
      if (e.button === 0 && drag.moved < INTERACT.clickSlopPx && e.target === canvas && !this.isUiOpen()) {
        this.onCanvasClick(e.clientX, e.clientY);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (this.isUiOpen()) return;
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // mouse-look resume: if a menu stole the lock, the gesture that
    // CLOSES the menu (its ✕ click, the BACK button, Esc…) re-grabs it —
    // no second [C] press needed. Runs at bubble phase, so the close
    // handler has already hidden the UI by the time this checks.
    const tryResumeLock = () => {
      if (!this._resumeLock || !this.enabled || this.isUiOpen()) return;
      if (document.pointerLockElement === canvas) { this._resumeLock = false; return; }
      this._resumeLock = false;
      this.lockToggle = true;
      try {
        const p = canvas.requestPointerLock?.();
        if (p && p.catch) p.catch(() => { this.lockToggle = false; });
      } catch { this.lockToggle = false; }
    };
    document.addEventListener('click', tryResumeLock);
    document.addEventListener('keyup', (e) => { if (e.code === 'Escape') setTimeout(tryResumeLock, 50); });

    canvas.addEventListener('wheel', (e) => {
      if (this.mode !== Mode.FLY) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.flySpeed = MathUtils.clamp(this.flySpeed * factor, 2, 200);
    }, { passive: false });
  }

  clearInputs() {
    this.keys.clear();
    // any UI opening hands the cursor back if mouse-look had it captured —
    // and remembers to grab it again the moment the UI closes
    if (this.lockToggle && document.pointerLockElement === this.canvas) {
      this.lockToggle = false;
      this._resumeLock = true;
      document.exitPointerLock();
    }
  }

  /** [C] — sticky mouse-look: capture the cursor so looking around needs
   *  no held button. Click = interact at the crosshair. C or Esc frees it. */
  toggleMouseLock() {
    this._resumeLock = false; // a manual toggle overrides any pending resume
    if (this.lockToggle && document.pointerLockElement === this.canvas) {
      this.lockToggle = false;
      document.exitPointerLock();
      this.hud?.toast('MOUSE LOOK OFF', 1400);
      return;
    }
    this.lockToggle = true;
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) {
        p.catch(() => {
          this.lockToggle = false;
          this.hud?.toast('MOUSE LOCK REFUSED — CLICK THE WORLD ONCE, THEN [C]', 2400);
        });
      }
      this.hud?.toast('MOUSE LOOK ON — CLICK = INTERACT · [C]/ESC RELEASES', 2800);
    } catch {
      this.lockToggle = false;
    }
  }

  /** Mouse-look sensitivity multiplier (0.2–3), persisted per browser. */
  setSens(v) {
    const s = Math.max(0.2, Math.min(3, Number(v) || 1));
    this.sens = s;
    try { localStorage.setItem('ww_sens', String(s)); } catch { /* private mode */ }
  }

  /** Point the camera (used by the intro sequence). */
  setLook(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = pitch;
    this._applyLook();
  }

  /** Instant snap — spawn, glide, programmatic looks. */
  _applyLook() {
    this._smYaw = this.yaw;
    this._smPitch = this.pitch;
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
  }

  /** Per-frame look easing (~40 ms): mouse events land BETWEEN frames in
   *  uneven slices, so applying them instantly reads as micro-jitter on
   *  slow pans. Easing the camera toward the input target each frame
   *  erases that without perceptible input lag. */
  _stepLook(dt) {
    if (this._smYaw == null) { this._smYaw = this.yaw; this._smPitch = this.pitch; }
    const k = 1 - Math.exp(-dt / 0.04);
    let dy = this.yaw - this._smYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this._smYaw += dy * k;
    this._smPitch += (this.pitch - this._smPitch) * k;
    _euler.set(this._smPitch, this._smYaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
  }

  _syncFromCamera() {
    _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = _euler.y;
    this.pitch = _euler.x;
    this._smYaw = this.yaw;
    this._smPitch = this.pitch;
  }

  // ---------- public API ----------

  setSpawn({ position, yaw, pitch, orbitTarget }) {
    this.spawn = { position: position.clone(), yaw, pitch, orbitTarget: orbitTarget.clone() };
  }

  reset() {
    if (!this.spawn) return;
    if (this.mode === Mode.ORBIT) this.setMode(Mode.WALK);
    this.camera.position.copy(this.spawn.position);
    this.yaw = this.spawn.yaw;
    this.pitch = this.spawn.pitch;
    this.vel.set(0, 0, 0);
    this.velY = 0;
    this.grounded = false;
    this._bobOffset = 0;
    this._applyLook();
    this.orbit.target.copy(this.spawn.orbitTarget);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;

    if (prev === Mode.ORBIT) {
      this.orbit.enabled = false;
      this._syncFromCamera();
    }
    if (mode === Mode.ORBIT) {
      this.orbit.enabled = true;
      if (this.spawn) this.orbit.target.copy(this.spawn.orbitTarget);
    }
    if (mode === Mode.WALK) {
      this.grounded = false; // drops you gently back onto the ground
      this.velY = 0;
    }
  }

  /** Call once the intro fly-in has landed. */
  activate() {
    this.enabled = true;
  }

  update(dt) {
    if (this.mode === Mode.ORBIT) {
      this.orbit.update();
      return;
    }
    if (!this.enabled || this.isUiOpen() || this.mode === Mode.LOOK) return;
    this._stepLook(dt);
    if (this.mode === Mode.FLY) this._updateFly(dt);
    else if (this.mode === Mode.WALK) this._updateWalk(dt);
  }

  // ---------- movement ----------

  _inputAxes() {
    const k = this.keys;
    let f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    f += this.touch.f;
    r += this.touch.r;
    // mag scales wishSpeed so a half-pushed stick strolls; keys are always
    // full deflection (diagonals cap at 1, same as before)
    const mag = Math.min(1, Math.hypot(f, r));
    return { f: MathUtils.clamp(f, -1, 1), r: MathUtils.clamp(r, -1, 1), mag };
  }

  _updateFly(dt) {
    const { f, r } = this._inputAxes();
    const up = (this.keys.has('Space') ? 1 : 0) - (this.keys.has('KeyC') ? 1 : 0);
    if (!f && !r && !up) return;

    const speed = this.flySpeed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1);
    const fwd = this.camera.getWorldDirection(_v).clone();
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const move = fwd.multiplyScalar(f).add(right.multiplyScalar(r));
    move.y += up;
    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(move);
    if (this.camera.position.y < 0.6) this.camera.position.y = 0.6;
  }

  /** Source-engine ground friction: decay toward zero, with a control
   *  floor (sv_stopspeed) so the last bit of speed dies quickly. */
  _friction(dt) {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed < 1e-4) { this.vel.x = 0; this.vel.z = 0; return; }
    const control = Math.max(speed, PLAYER.stopSpeed);
    const newSpeed = Math.max(0, speed - control * PLAYER.friction * dt);
    const k = newSpeed / speed;
    this.vel.x *= k;
    this.vel.z *= k;
  }

  /** Source-engine accelerate: only add speed up to wishSpeed along the
   *  wish direction (projection cap — this is what makes strafing work). */
  _accelerate(wx, wz, wishSpeed, accel, dt) {
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const speed = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += wx * speed;
    this.vel.z += wz * speed;
  }

  /** Air accelerate: the wish speed is capped at ~30 u/s for the
   *  projection test but not for the add rate — the CS air-strafe. */
  _airAccelerate(wx, wz, wishSpeed, dt) {
    const capped = Math.min(wishSpeed, PLAYER.airSpeedCap);
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = capped - cur;
    if (add <= 0) return;
    const speed = Math.min(PLAYER.airAccel * wishSpeed * dt, add);
    this.vel.x += wx * speed;
    this.vel.z += wz * speed;
  }

  _updateWalk(dt) {
    const cam = this.camera;
    const {
      eyeHeight, walkSpeed, runSpeed, jumpVelocity, gravity, headBob, radius,
    } = PLAYER;
    const eye = eyeHeight;

    // strip last frame's head bob + stair-smoothing offset before physics
    cam.position.y -= this._bobOffset;
    this._bobOffset = 0;
    cam.position.y += this._stepSmooth ?? 0;

    // --- wish direction from input + yaw ---
    const { f, r, mag } = this._inputAxes();
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touch.run;
    let wx = 0, wz = 0;
    if (f || r) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      wx = (-sin * f) + (cos * r);
      wz = (-cos * f) + (-sin * r);
      const len = Math.hypot(wx, wz) || 1;
      wx /= len;
      wz /= len;
    }
    const wishSpeed = (f || r) ? (running ? runSpeed : walkSpeed) * mag : 0;

    // --- CS movement: friction + accelerate on ground, air-accel airborne ---
    if (this.grounded) {
      this._friction(dt);
      if (wishSpeed > 0) this._accelerate(wx, wz, wishSpeed, PLAYER.accel, dt);
    } else if (wishSpeed > 0) {
      this._airAccelerate(wx, wz, wishSpeed, dt);
    }

    cam.position.x += this.vel.x * dt;
    cam.position.z += this.vel.z * dt;

    // --- collision pushout against walls/desks/crates/trees ---
    let feet = cam.position.y - eye;
    const preX = cam.position.x, preZ = cam.position.z;
    this.world.resolveCollisions(cam.position, feet, radius);
    // clip velocity along the pushout normal so walls kill momentum into
    // them (Source's ClipVelocity) instead of storing it up
    const pushX = cam.position.x - preX, pushZ = cam.position.z - preZ;
    if (pushX || pushZ) {
      const pl = Math.hypot(pushX, pushZ);
      const nx = pushX / pl, nz = pushZ / pl;
      const into = this.vel.x * nx + this.vel.z * nz;
      if (into < 0) {
        this.vel.x -= nx * into;
        this.vel.z -= nz * into;
      }
    }

    // --- vertical: gravity, jump, land. groundHeightAt also reports
    // collider tops below the feet, so you can jump onto desks/crates
    // like CS crates ---
    const ground = this.world.groundHeightAt(cam.position.x, cam.position.z, feet);
    // stair glue: walking (not jumping) off a tread ≤0.5 m tall sticks you
    // to it instead of a mini free-fall on every step down — the camera
    // offset below eases out the height change so it reads as a glide
    if (this.grounded && this.velY <= 0 && feet > ground + 0.01 && feet - ground <= 0.5) {
      this._stepSmooth = (this._stepSmooth ?? 0) - (feet - ground);
      feet = ground;
    } else if (this.grounded && this.velY <= 0 && feet > ground && feet - ground <= 0.01) {
      feet = ground; // millimeter noise: snap without engaging the smoother
    }
    // tread-detection baseline: BEFORE gravity. At low fps gravity dips
    // the feet centimeters below static ground every frame — comparing
    // post-gravity feet made the climb smoother fire on FLAT floor,
    // vibrating the camera nonstop on slower machines.
    const preFeet = feet;
    this.velY -= gravity * dt;
    feet += this.velY * dt;

    // head bump: cap the jump under overhead slabs (an upper floor's
    // underside) so the camera never enters the floor above
    const ceil = this.world.ceilingHeightAt?.(cam.position.x, cam.position.z, feet) ?? Infinity;
    const headroom = eye + 0.15;
    if (feet + headroom > ceil) {
      feet = Math.max(ground, ceil - headroom);
      if (this.velY > 0) this.velY = 0;
    }

    if (feet <= ground + 0.001 && this.velY <= 0) {
      // climbing a tread while already grounded: smooth the pop-up too
      // (measured against PRE-gravity feet — only a real ground rise counts)
      if (this.grounded && ground - preFeet > 0.01 && ground - preFeet <= 0.5) {
        this._stepSmooth = (this._stepSmooth ?? 0) + (ground - preFeet);
      } else if (!this.grounded && this.velY < -5.5) {
        // landing softener: absorb a few centimeters of the impact
        // through the same smoother — knees, basically
        this._stepSmooth = (this._stepSmooth ?? 0) + Math.min(0.16, (-this.velY - 5.5) * 0.02);
      }
      feet = ground;
      this.velY = 0;
      this.grounded = true;
    } else if (feet > ground + 0.05) {
      this.grounded = false;
    }

    if (this.keys.has('Space') && this.grounded) {
      this.velY = jumpVelocity;
      this.grounded = false;
      this._stepSmooth = 0; // jumps are meant to be felt
    }
    // decay the stair-smoothing offset (~90 ms settle) and apply it: the
    // physics feet snap tread-to-tread, the camera glides
    this._stepSmooth = (this._stepSmooth ?? 0) * Math.exp(-13 * dt);
    if (Math.abs(this._stepSmooth) < 0.001) this._stepSmooth = 0;
    this._stepSmooth = Math.max(-0.55, Math.min(0.55, this._stepSmooth));
    cam.position.y = feet + eye - this._stepSmooth;

    const hSpeed = Math.hypot(this.vel.x, this.vel.z);

    // --- sprint FOV ease: a touch of extra field of view at speed reads
    // as momentum — eases in/out so it never pops ---
    const wantFov = PLAYER.fov + Math.min(7, Math.max(0, hSpeed - walkSpeed) * 0.9);
    const cf = this.camera.fov;
    if (Math.abs(wantFov - cf) > 0.02) {
      this.camera.fov = cf + (wantFov - cf) * (1 - Math.exp(-dt / 0.18));
      this.camera.updateProjectionMatrix();
    }

    // --- head bob (very subtle; scales with actual speed) ---
    this.bobT += dt * (this.grounded ? hSpeed : 0);
    this._bobOffset = (this.grounded && hSpeed > 0.6)
      ? Math.sin(this.bobT * 1.7) * headBob * Math.min(hSpeed / walkSpeed, 1)
      : 0;
    cam.position.y += this._bobOffset;
  }
}
