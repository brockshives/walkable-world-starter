// Proximity voice chat: WebRTC mesh over the presence socket's signaling
// relay, with distance-based volume through WebAudio.
//
// Deliberately intimate ranges (desk-conversation scale):
//   FULL  ≤ 2.5m — full volume
//   fades to silent by 9m
//   pairs only CONNECT within 14m and tear down past 18m (hysteresis),
//   so the mesh stays small even on a busy server.
//
// V toggles your mic. Both sides must have voice on to connect. The
// lower presence id makes the offer (no glare). STUN only — corp NATs
// that need TURN just won't pair; everything else keeps working.

const FULL_RADIUS = 2.5;
const SILENT_RADIUS = 9;
const CONNECT_RADIUS = 14;
const DROP_RADIUS = 18;
const MAX_PEERS = 8; // nearest N voice users get connections

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export class VoiceChat {
  /**
   * @param {*} mp Multiplayer (signaling + peer positions)
   * @param {*} hud Hud (toasts)
   * @param {() => {x,y,z}} getPose our feet position
   */
  constructor(mp, hud, getPose) {
    this.mp = mp;
    this.hud = hud;
    this.getPose = getPose;
    this.enabled = false;
    this.mic = null;        // MediaStream
    this.ctx = null;        // AudioContext (lazy — needs a user gesture)
    this.peers = new Map(); // id -> {pc, gain, el, pending:[]}
    this._chip = document.getElementById('voice-chip');

    mp.onRtc = (from, d) => this._onSignal(from, d);
  }

  async toggle() {
    if (this.enabled) {
      this.disable();
      return;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.hud.toast('MIC BLOCKED — ALLOW MICROPHONE ACCESS TO USE VOICE', 3400);
      return;
    }
    this.ctx = this.ctx ?? new (window.AudioContext ?? window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.extMuted) for (const tr of this.mic.getAudioTracks()) tr.enabled = false;
    this.enabled = true;
    this.mp.sendVoiceState(true);
    this._chip?.classList.remove('hidden');
    this.hud.toast('🎤 VOICE ON — PEOPLE NEARBY CAN HEAR YOU · V TO TURN OFF', 3200);
  }

  /** Externally mute/unmute our mic (e.g. while the player is dictating
   *  to some other feature) so nearby players don't overhear it. */
  setExternalMute(muted) {
    this.extMuted = muted;
    if (this.mic) for (const tr of this.mic.getAudioTracks()) tr.enabled = !muted;
    if (this._chip && this.enabled) {
      this._chip.textContent = muted ? '🎤 MUTED' : '🎤 VOICE ON · V TO MUTE';
    }
  }

  disable() {
    this.enabled = false;
    this.mp.sendVoiceState(false);
    for (const id of [...this.peers.keys()]) this._drop(id);
    if (this.mic) {
      for (const tr of this.mic.getTracks()) tr.stop();
      this.mic = null;
    }
    this._chip?.classList.add('hidden');
    this.hud.toast('VOICE OFF', 1600);
  }

  _pcFor(id, createIfMissing = true) {
    let p = this.peers.get(id);
    if (p || !createIfMissing) return p;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    p = { pc, gain: null, el: null, pending: [], born: performance.now() };
    this.peers.set(id, p);
    if (this.mic) for (const tr of this.mic.getTracks()) pc.addTrack(tr, this.mic);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.mp.sendRtc(id, { ice: e.candidate });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      // Chrome quirk: remote streams only flow into WebAudio if they are
      // also attached to a (muted) media element.
      const el = new Audio();
      el.srcObject = stream;
      el.muted = true;
      el.play().catch(() => { /* resumes on next gesture */ });
      const src = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      gain.gain.value = 0; // silent until the distance loop says otherwise
      src.connect(gain).connect(this.ctx.destination);
      p.el = el;
      p.gain = gain;
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this._drop(id);
    };
    // we are the polite side unless our id is lower
    if (this.mp.id !== null && this.mp.id < id) {
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          this.mp.sendRtc(id, { sdp: pc.localDescription });
        } catch { /* peer vanished mid-offer */ }
      };
    }
    return p;
  }

  async _onSignal(from, d) {
    if (!this.enabled || !d) return;
    const p = this._pcFor(from);
    const pc = p.pc;
    try {
      if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.mp.sendRtc(from, { sdp: pc.localDescription });
        }
        for (const ice of p.pending) await pc.addIceCandidate(ice).catch(() => {});
        p.pending = [];
      } else if (d.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(d.ice).catch(() => {});
        else p.pending.push(d.ice);
      }
    } catch { /* mid-teardown signaling races are fine to ignore */ }
  }

  _drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* already closed */ }
    try { p.gain?.disconnect(); } catch { /* already gone */ }
    if (p.el) { p.el.srcObject = null; }
  }

  /** Call every frame: manage the mesh + set per-peer volume by distance. */
  update() {
    if (!this.enabled || this.mp.id === null) return;
    const me = this.getPose();

    // candidates: voice-enabled peers, sorted by distance
    const cands = [];
    for (const id of this.mp.voicePeers) {
      if (id === this.mp.id) continue;
      const pos = this.mp.peerPos(id);
      if (!pos) continue;
      // 3D distance — floors are only a few meters apart, so without the y term two
      // people stacked on different levels hear each other at full volume
      const dist = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z);
      cands.push([id, dist]);
    }
    cands.sort((a, b) => a[1] - b[1]);

    const wanted = new Set();
    for (const [id, dist] of cands.slice(0, MAX_PEERS)) {
      if (dist <= CONNECT_RADIUS) wanted.add(id);
    }
    // connect the near ones (only the lower id dials out)
    for (const id of wanted) {
      if (!this.peers.has(id) && this.mp.id < id) this._pcFor(id);
    }
    // volume by distance; hard-drop pairs that wandered far apart
    for (const [id, p] of this.peers) {
      const pos = this.mp.peerPos(id);
      const inVoice = this.mp.voicePeers.has(id);
      const dist = pos ? Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z) : Infinity;
      if (!inVoice || dist > DROP_RADIUS) { this._drop(id); continue; }
      // handshake watchdog: a pair stuck negotiating for 12s gets torn
      // down so the dialing side can retry fresh — and the failure gets
      // SAID out loud (STUN-only means corp VPNs/firewalls block pairing
      // silently; people just thought voice was broken)
      if (p.pc.connectionState !== 'connected' && performance.now() - p.born > 12000) {
        this._drop(id);
        if (!this._failAt || performance.now() - this._failAt > 90000) {
          this._failAt = performance.now();
          this.hud.toast('VOICE PAIR BLOCKED — A FIREWALL/VPN ON ONE SIDE IS EATING THE P2P LINK', 4600);
        }
        continue;
      }
      if (p.gain) {
        const k = dist <= FULL_RADIUS ? 1
          : dist >= SILENT_RADIUS ? 0
          : 1 - (dist - FULL_RADIUS) / (SILENT_RADIUS - FULL_RADIUS);
        p.gain.gain.value = k * k; // squared falloff feels natural indoors
      }
    }
  }
}
