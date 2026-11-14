'use strict';
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const net = require('net');
const { AnnexBParser } = require('./annexb');
const usbmux = require('./usbmux');

const PHONE_VIDEO_PORT = 8000;      // ports the phone app listens on
const PHONE_AUDIO_PORT = 8002;
const PC_TUNNEL_BASE = 9000;        // Android slot s: video tunnel 9000+2s, audio tunnel 9001+2s
const RELAY_BASE = 8001;            // slot s: raw H.264 for OBS on 127.0.0.1:(8001+s)
const APP_ACTIVITY = 'com.deenstudio.app/.ui.MainActivity';

function runAdb(adbPath, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(adbPath, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ ok: false, missing: true, out: '', err: '' });
      resolve({ ok: !err, missing: false, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

/**
 * One connected phone (Android through adb, or iPhone through usbmuxd):
 * its video and sound sockets, and its OBS relay port.
 */
class DeviceLink extends EventEmitter {
  constructor({ kind, adbPath, serial, slot, deviceId }) {
    super();
    this.kind = kind;                 // 'android' | 'ios'
    this.adbPath = adbPath;
    this.serial = serial;
    this.slot = slot;
    this.deviceId = deviceId;
    this.vPort = PC_TUNNEL_BASE + slot * 2;
    this.aPort = this.vPort + 1;
    this.relayPort = RELAY_BASE + slot;
    this.alive = true;
    this.state = {
      serial, slot, kind,
      name: kind === 'ios' ? `iPhone ${serial.slice(-4)}` : serial,
      tunnel: false, stream: 'waiting', audio: false, muted: false,
      kbps: 0, fps: 0, relayPort: this.relayPort, relayClients: 0, relayError: null, error: null
    };
    this.vsock = null; this.asock = null;
    this.vRetry = null; this.aRetry = null;
    this.vOpening = false; this.aOpening = false;
    this.parser = null; this.aPending = null;
    this.gotVideo = false;
    this.lastVideo = 0; this.lastAudio = 0;
    this.bytes = 0; this.frames = 0;
    this.gop = [];
    this.clients = new Set();
    this.launched = false;
    this.timers = [setInterval(() => this.statsTick(), 1000)];
    this.startRelay();
    if (kind === 'android') this.fetchName();
  }

  set(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (this.state[k] !== patch[k]) { this.state[k] = patch[k]; changed = true; }
    }
    if (changed) this.emit('state');
  }

  adb(args, timeout) { return runAdb(this.adbPath, ['-s', this.serial, ...args], timeout); }

  async fetchName() {
    const r = await this.adb(['shell', 'getprop', 'ro.product.model']);
    const model = r.out.trim();
    if (r.ok && model) this.set({ name: model });
  }

  setMuted(muted) { this.set({ muted: !!muted }); }

  setDeviceId(id) {
    if (id === this.deviceId) return;
    this.deviceId = id;
    this.dropVideo();
    this.dropAudio();
  }

  async ensureTunnel() {
    if (!this.alive) return;

    if (this.kind === 'ios') {
      // usbmuxd gives us a direct tunnel per connection; nothing to set up in advance.
      this.set({ tunnel: true, error: null });
      this.ensureVideo();
      this.ensureAudio();
      return;
    }

    const list = await this.adb(['forward', '--list']);
    const lines = list.out.split(/\r?\n/);
    const has = (pc, phone) => lines.some((l) => l.includes(this.serial) && l.includes(`tcp:${pc} tcp:${phone}`));
    let ok = true;
    let err = null;

    if (!has(this.vPort, PHONE_VIDEO_PORT)) {
      const r = await this.adb(['forward', `tcp:${this.vPort}`, `tcp:${PHONE_VIDEO_PORT}`]);
      if (!r.ok) { ok = false; err = r.err.trim() || 'Could not open the USB tunnel'; }
      this.dropVideo();
    }
    if (!has(this.aPort, PHONE_AUDIO_PORT)) {
      const r = await this.adb(['forward', `tcp:${this.aPort}`, `tcp:${PHONE_AUDIO_PORT}`]);
      if (!r.ok) { ok = false; err = r.err.trim() || 'Could not open the USB tunnel'; }
      this.dropAudio();
    }
    this.set({ tunnel: ok, error: ok ? null : err });
    if (!ok || !this.alive) return;

    if (!this.launched) {
      this.launched = true;
      this.adb(['shell', 'am', 'start', '-n', APP_ACTIVITY]);
    }
    this.ensureVideo();
    this.ensureAudio();
  }

  /** Opens the socket to the phone's video (which = 'video') or sound ('audio') port, or null. */
  async openSocket(which) {
    const video = which === 'video';
    if (this.kind === 'android') {
      return net.connect({ host: '127.0.0.1', port: video ? this.vPort : this.aPort });
    }
    try {
      return await usbmux.connectDevice(this.deviceId, video ? PHONE_VIDEO_PORT : PHONE_AUDIO_PORT);
    } catch (_) {
      return null;
    }
  }

  // --- video ----------------------------------------------------------------------------

  retryVideo(ms) {
    if (this.vRetry || !this.alive) return;
    this.vRetry = setTimeout(() => { this.vRetry = null; this.ensureVideo(); }, ms);
  }

  async ensureVideo() {
    if (this.vsock || this.vRetry || this.vOpening || !this.alive) return;
    this.vOpening = true;
    const s = await this.openSocket('video');
    this.vOpening = false;
    if (!s) { this.retryVideo(1000); return; }
    if (!this.alive) { s.destroy(); return; }

    this.vsock = s;
    this.gotVideo = false;
    this.lastVideo = Date.now();
    this.parser = new AnnexBParser((frame, key) => this.onFrame(frame, key));
    s.setNoDelay(true);
    s.on('data', (chunk) => {
      this.gotVideo = true;
      this.lastVideo = Date.now();
      this.bytes += chunk.length;
      this.parser.push(chunk);
    });
    s.on('error', () => {});
    s.on('close', () => {
      if (this.vsock !== s) return;
      this.vsock = null;
      this.gotVideo = false;
      this.gop = [];
      if (this.state.tunnel) this.retryVideo(500);
    });
  }

  dropVideo() {
    if (this.vRetry) { clearTimeout(this.vRetry); this.vRetry = null; }
    if (this.vsock) { const s = this.vsock; this.vsock = null; s.destroy(); }
    this.gotVideo = false;
    this.gop = [];
  }

  onFrame(frame, key) {
    this.frames++;
    if (key) this.gop = [frame];
    else if (this.gop.length) {
      this.gop.push(frame);
      if (this.gop.length > 240) this.gop = [];
    }
    for (const c of this.clients) {
      if (c.writableLength > 4 * 1024 * 1024) { c.destroy(); continue; } // OBS too slow: it will reconnect
      c.write(frame);
    }
    this.emit('frame', frame, key);
  }

  // --- audio ----------------------------------------------------------------------------

  retryAudio(ms) {
    if (this.aRetry || !this.alive) return;
    this.aRetry = setTimeout(() => { this.aRetry = null; this.ensureAudio(); }, ms);
  }

  async ensureAudio() {
    if (this.asock || this.aRetry || this.aOpening || !this.alive) return;
    this.aOpening = true;
    const s = await this.openSocket('audio');
    this.aOpening = false;
    if (!s) { this.retryAudio(1500); return; }
    if (!this.alive) { s.destroy(); return; }

    this.asock = s;
    this.aPending = null;
    s.setNoDelay(true);
    s.on('data', (chunk) => this.onAudio(chunk));
    s.on('error', () => {});
    s.on('close', () => {
      if (this.asock !== s) return;
      this.asock = null;
      // The phone only serves sound when its microphone is on, so retry gently.
      if (this.state.tunnel) this.retryAudio(1500);
    });
  }

  dropAudio() {
    if (this.aRetry) { clearTimeout(this.aRetry); this.aRetry = null; }
    if (this.asock) { const s = this.asock; this.asock = null; s.destroy(); }
    this.aPending = null;
  }

  onAudio(chunk) {
    this.lastAudio = Date.now();
    const buf = this.aPending ? Buffer.concat([this.aPending, chunk]) : chunk;
    const even = buf.length & ~1;                       // keep whole 16-bit samples only
    this.aPending = even < buf.length ? Buffer.from(buf.subarray(even)) : null;
    if (even === 0) return;
    const pcm = this.state.muted ? Buffer.alloc(even) : Buffer.from(buf.subarray(0, even));
    this.emit('audio', pcm);
  }

  // --- stats / watchdog -----------------------------------------------------------------

  statsTick() {
    const now = Date.now();
    const kbps = Math.round((this.bytes * 8) / 1000);
    const fps = this.frames;
    this.bytes = 0;
    this.frames = 0;

    // Socket looks open but nothing arrives: reconnect instead of hanging.
    if (this.vsock && this.gotVideo && now - this.lastVideo > 4000) {
      this.dropVideo();
      this.retryVideo(300);
    }
    const live = !!(this.vsock && this.gotVideo && now - this.lastVideo < 2500);
    const audioLive = !!(this.asock && now - this.lastAudio < 2500);
    this.set({ stream: live ? 'live' : 'waiting', kbps: live ? kbps : 0, fps: live ? fps : 0, audio: audioLive });
  }

  // --- OBS relay (raw H.264) ------------------------------------------------------------

  startRelay() {
    this.relay = net.createServer((c) => {
      c.setNoDelay(true);
      c.on('error', () => {});
      for (const f of this.gop) c.write(f);               // start from the latest keyframe
      this.clients.add(c);
      this.set({ relayClients: this.clients.size });
      c.on('close', () => { this.clients.delete(c); this.set({ relayClients: this.clients.size }); });
    });
    this.relay.on('error', () => this.set({ relayError: `Port ${this.relayPort} is already in use` }));
    this.relay.listen(this.relayPort, '127.0.0.1');
  }

  dispose() {
    this.alive = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.dropVideo();
    this.dropAudio();
    for (const c of this.clients) c.destroy();
    try { this.relay.close(); } catch (_) { /* ignore */ }
    if (this.kind === 'android') {
      this.adb(['forward', '--remove', `tcp:${this.vPort}`]);
      this.adb(['forward', '--remove', `tcp:${this.aPort}`]);
    }
  }
}

/** Watches adb (Android) and usbmuxd (iPhone) and keeps one DeviceLink per plugged-in phone. */
class DeviceManager extends EventEmitter {
  constructor({ adbPath, store }) {
    super();
    this.adbPath = adbPath;
    this.store = store;
    this.links = new Map();
    this.state = { adb: 'checking', ios: 'checking', unauthorized: false, devices: [] };
    this.busy = false;
    this.timer = null;
    this.lastSig = '';
  }

  start() {
    runAdb(this.adbPath, ['start-server'], 8000).then(() => {
      this.tick();
      this.timer = setInterval(() => this.tick(), 1000);
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const l of this.links.values()) l.dispose();
    this.links.clear();
  }

  setMute(slot, muted) {
    for (const l of this.links.values()) if (l.slot === slot) l.setMuted(muted);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const desired = new Map();                          // serial -> { kind, deviceId }

      // Android
      const r = await runAdb(this.adbPath, ['devices']);
      if (r.missing) {
        this.state.adb = 'missing';
        this.state.unauthorized = false;
      } else {
        this.state.adb = 'ok';
        const found = r.out.split(/\r?\n/)
          .map((l) => l.match(/^([^\s*]\S*)\s+(device|unauthorized|offline)\b/))
          .filter(Boolean)
          .map((m) => ({ serial: m[1], state: m[2] }));
        for (const d of found) if (d.state === 'device') desired.set(d.serial, { kind: 'android' });
        this.state.unauthorized = found.some((d) => d.state === 'unauthorized');
      }

      // iPhone
      try {
        const list = await usbmux.listDevices();
        this.state.ios = 'ok';
        for (const d of list) desired.set(d.serial, { kind: 'ios', deviceId: d.deviceId });
      } catch (_) {
        this.state.ios = 'missing';                       // Apple's service is not installed or not running
      }

      for (const [serial, link] of [...this.links]) {
        const want = desired.get(serial);
        if (!want) { link.dispose(); this.links.delete(serial); }
        else if (link.kind === 'ios') link.setDeviceId(want.deviceId);
      }
      for (const [serial, want] of desired) {
        if (this.links.has(serial)) continue;
        const inUse = new Set([...this.links.values()].map((l) => l.slot));
        const slot = this.store.slotFor(serial, inUse);
        if (slot < 0) continue;                           // more phones than slots
        const link = new DeviceLink({ kind: want.kind, adbPath: this.adbPath, serial, slot, deviceId: want.deviceId });
        link.on('state', () => this.emitState());
        link.on('frame', (f, k) => this.emit('frame', link.slot, f, k));
        link.on('audio', (p) => this.emit('audio', link.slot, p));
        this.links.set(serial, link);
      }
      for (const link of this.links.values()) await link.ensureTunnel();
      this.emitState();
    } finally {
      this.busy = false;
    }
  }

  emitState() {
    this.state.devices = [...this.links.values()].map((l) => ({ ...l.state })).sort((a, b) => a.slot - b.slot);
    const sig = JSON.stringify(this.state);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.emit('state', JSON.parse(sig));
  }
}

module.exports = { DeviceManager, DeviceLink, PHONE_VIDEO_PORT, PHONE_AUDIO_PORT, RELAY_BASE, PC_TUNNEL_BASE };
