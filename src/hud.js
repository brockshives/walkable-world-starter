// HUD: FPS/mode readout, toasts, and the yellow [E] prompt.

const el = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.hud = el('hud');
    this.promptEl = el('prompt');
    this._fpsEma = 60;
    this._lastRefresh = 0;
  }

  /** Call every frame. */
  update(dt, { mode, speed, online = 0 }) {
    if (dt > 0) {
      const fps = 1 / dt;
      this._fpsEma += (fps - this._fpsEma) * 0.08;
    }
    const now = performance.now();
    if (now - this._lastRefresh > 250) {
      this._lastRefresh = now;
      const speedTxt = speed != null ? ` · <b>${speed.toFixed(0)}M/S</b>` : '';
      const onlineTxt = online > 0 ? ` · <b>${online} ONLINE</b>` : '';
      this.hud.innerHTML =
        `<b>${this._fpsEma.toFixed(0)}</b>FPS · <b>${mode.toUpperCase()}</b>${speedTxt}${onlineTxt}`;
    }
  }

  /** Show the yellow bottom prompt; pass null/empty to hide. */
  prompt(text) {
    if (text) {
      this.promptEl.textContent = text;
      this.promptEl.classList.remove('hidden');
    } else {
      this.promptEl.classList.add('hidden');
    }
  }

  toast(message, ms = 3500) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
    el('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, ms);
    setTimeout(() => t.remove(), ms + 600);
  }
}
