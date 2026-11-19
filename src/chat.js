// World chat: one shared channel for everyone on the server.
// ENTER (or T) opens the input; first use asks for a display name, which
// is kept in localStorage and announced over the presence socket so it
// also shows on your ghost's floating label. ESC cancels.

const MAX_LINES = 60;   // kept in the DOM
const FADE_AFTER = 12;  // seconds before an idle line fades out

export class Chat {
  /**
   * @param {*} mp    Multiplayer instance (socket + names)
   * @param {*} hud   Hud (toasts)
   * @param {() => void} onFocusChange called when input opens/closes
   */
  constructor(mp, hud, onFocusChange) {
    this.mp = mp;
    this.hud = hud;
    this.onFocusChange = onFocusChange;
    this.active = false;
    this._nameMode = false;

    this.root = document.getElementById('chat');
    this.log = document.getElementById('chat-log');
    this.row = document.getElementById('chat-row');
    this.input = document.getElementById('chat-input');
    this.tag = document.getElementById('chat-tag');

    try { this.name = localStorage.getItem('ww_name') ?? ''; } catch { this.name = ''; }
    if (this.name) mp.setName(this.name);

    mp.onChat = (id, name, text) => {
      this.addLine(name, text, id === mp.id);
    };

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must never move the player
      if (e.code === 'Escape') this.close();
      else if (e.code === 'Enter') this._submit();
    });
    // clicks outside the input while chatting just close it
    this.input.addEventListener('blur', () => {
      if (this.active) setTimeout(() => { if (this.active) this.close(); }, 80);
    });
  }

  /** True while the text input is focused (movement keys disabled). */
  isTyping() {
    return this.active;
  }

  open() {
    if (this.active) return;
    this.active = true;
    this.row.classList.remove('hidden');
    this._nameMode = !this.name;
    this.tag.textContent = this._nameMode ? 'NAME ▸' : `${this.name} ▸`;
    this.input.placeholder = this._nameMode
      ? 'PICK A DISPLAY NAME FIRST…'
      : 'SAY SOMETHING… (ENTER TO SEND · ESC TO CLOSE)';
    this.input.value = '';
    this.root.classList.add('chat-open');
    setTimeout(() => this.input.focus(), 0);
    this.onFocusChange?.();
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.row.classList.add('hidden');
    this.root.classList.remove('chat-open');
    this.input.blur();
    this.onFocusChange?.();
  }

  _submit() {
    const raw = this.input.value.trim();
    if (!raw) { this.close(); return; }
    if (this._nameMode) {
      const name = raw.replace(/[^\x20-\x7E]/g, '').slice(0, 16).trim();
      if (!name) return;
      this.name = name;
      try { localStorage.setItem('ww_name', name); } catch { /* private mode */ }
      const ok = this.mp.setName(name);
      this.addSystem(ok
        ? `NAME SET: ${name} — SAY SOMETHING!`
        : `NAME SET: ${name} (OFFLINE — CHAT NEEDS THE LIVE SERVER)`);
      this._nameMode = false;
      this.tag.textContent = `${name} ▸`;
      this.input.placeholder = 'SAY SOMETHING… (ENTER TO SEND · ESC TO CLOSE)';
      this.input.value = '';
      return;
    }
    // /name NewName — change your display name any time (it was
    // one-shot before; people change their minds)
    const rename = raw.match(/^\/name\s+(.{1,16})/i);
    if (rename) {
      const name = rename[1].replace(/[^\x20-\x7E]/g, '').slice(0, 16).trim();
      if (name) {
        this.name = name;
        try { localStorage.setItem('ww_name', name); } catch { /* private mode */ }
        this.mp.setName(name);
        this.tag.textContent = `${name} ▸`;
        this.addSystem(`NAME CHANGED: ${name}`);
      }
      this.input.value = '';
      return;
    }
    if (raw === '/name') {
      this.addSystem('USAGE: /name YourNewName');
      this.input.value = '';
      return;
    }
    const sent = this.mp.sendChat(raw);
    if (!sent) this.addSystem('CHAT OFFLINE — NOBODY ELSE IS CONNECTED RIGHT NOW.');
    this.input.value = '';
    this.close();
  }

  addLine(name, text, mine) {
    const div = document.createElement('div');
    div.className = `chat-line${mine ? ' mine' : ''}`;
    const who = document.createElement('b');
    who.textContent = name;
    div.appendChild(who);
    div.appendChild(document.createTextNode(` ${text}`));
    this._push(div);
  }

  addSystem(text) {
    const div = document.createElement('div');
    div.className = 'chat-line sys';
    div.textContent = text;
    this._push(div);
  }

  _push(div) {
    this.log.appendChild(div);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    // idle lines fade; reopening chat (chat-open class) shows them again
    setTimeout(() => div.classList.add('faded'), FADE_AFTER * 1000);
  }
}
