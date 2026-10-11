'use strict';
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const net = require('net');
const { AnnexBParser } = require('./annexb');

const PHONE_PORT = 8000;   // port the phone app serves on (through the USB tunnel)
const RELAY_PORT = 8001;   // port OBS connects to: tcp://127.0.0.1:8001
const APP_ACTIVITY = 'com.deenstudio.app/.ui.MainActivity';

/**
 * Does everything the user used to do by hand:
 *  - finds the phone with adb
 *  - opens / repairs the USB tunnel
 *  - connects to the phone's video stream, reconnecting forever
 *  - re-serves the video on 127.0.0.1:8001 for OBS
 */
class Bridge extends EventEmitter {
  constructor({ adbPath }) {
    super();
    this.adbPath = adbPath;
    this.state = {
      adb: 'checking',        // checking | ok | missing
      device: 'none',         // none | unauthorized | ready
      serial: null,
      tunnel: false,
      stream: 'idle',         // idle | waiting | live
      relayClients: 0,
      relayError: null,
      error: null,
      kbps: 0,
      fps: 0
    };
    this.sock = null;
    this.parser = null;
    this.gotData = false;
    this.lastData = 0;
    this.bytes = 0;
    this.frames = 0;
    this.gop = [];
    this.clients = new Set();
    this.busy = false;
    this.launchedFor = null;
    this.reconnectTimer = null;
    this.timers = [];
  }

  start() {
    this.startRelay();
    this.adb(['start-server'], 8000).then(() => {
      this.tick();
      this.timers.push(setInterval(() => this.tick(), 1000));
    });
    this.timers.push(setInterval(() => this.statsTick(), 1000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.dropSocket();
    for (const c of this.clients) c.destroy();
    if (this.relay) this.relay.close();
  }

  set(patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (this.state[k] !== patch[k]) { this.state[k] = patch[k]; changed = true; }
    }
    if (changed) this.emit('state', { ...this.state });
  }

  adb(args, timeout = 4000) {
    return new Promise((resolve) => {
      execFile(this.adbPath, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ ok: false, missing: true, out: '', err: '' });
        resolve({ ok: !err, missing: false, out: String(stdout || ''), err: String(stderr || '') });
      });
    });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.adb(['devices']);
      if (r.missing) {
        this.set({ adb: 'missing', device: 'none', serial: null, tunnel: false, stream: 'idle' });
        this.dropSocket();
        return;
      }
      this.set({ adb: 'ok' });

      const devices = r.out.split(/\r?\n/).slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 2)
        .map((p) => ({ serial: p[0], state: p[1] }));
      const ready = devices.find((d) => d.state === 'device');

      if (!ready) {
        const unauthorized = devices.some((d) => d.state === 'unauthorized');
        this.set({ device: unauthorized ? 'unauthorized' : 'none', serial: null, tunnel: false, stream: 'idle' });
        this.dropSocket();
        this.launchedFor = null;
        return;
      }

      if (this.state.serial !== ready.serial) {
        this.dropSocket();
        this.set({ serial: ready.serial });
      }
      this.set({ device: 'ready' });

      // Make sure the tunnel exists (it vanishes if adb restarts or the cable is re-plugged).
      const list = await this.adb(['-s', ready.serial, 'forward', '--list']);
      const hasForward = list.out.split(/\r?\n/).some((l) => l.includes(ready.serial) && l.includes(`tcp:${PHONE_PORT}`));
      if (!hasForward) {
        const made = await this.adb(['-s', ready.serial, 'forward', `tcp:${PHONE_PORT}`, `tcp:${PHONE_PORT}`]);
        if (!made.ok) {
          this.set({ tunnel: false, error: (made.err || 'Could not open the USB tunnel').trim() });
          return;
        }
        this.dropSocket();
      }
      this.set({ tunnel: true, error: null });

      // Open the phone app once per connection so the user does not have to hunt for it.
      if (this.launchedFor !== ready.serial) {
        this.launchedFor = ready.serial;
        this.adb(['-s', ready.serial, 'shell', 'am', 'start', '-n', APP_ACTIVITY]);
      }

      this.ensureSocket();
    } finally {
      this.busy = false;
    }
  }

  ensureSocket() {
    if (this.sock || this.reconnectTimer) return;
    const s = net.connect({ host: '127.0.0.1', port: PHONE_PORT });
    this.sock = s;
    this.gotData = false;
    this.lastData = Date.now();
    this.parser = new AnnexBParser((frame, key) => this.onFrame(frame, key));
    s.setNoDelay(true);
    s.on('data', (chunk) => {
      this.gotData = true;
      this.lastData = Date.now();
      this.bytes += chunk.length;
      this.parser.push(chunk);
    });
    s.on('error', () => {});
    s.on('close', () => {
      if (this.sock !== s) return;
      this.sock = null;
      this.gotData = false;
      this.gop = [];
      if (this.state.tunnel) {
        this.set({ stream: 'waiting' });
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureSocket(); }, 500);
      }
    });
    this.set({ stream: 'waiting' });
  }

  dropSocket() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      s.destroy();
    }
    this.gotData = false;
    this.gop = [];
  }

  onFrame(frame, key) {
    this.frames++;
    if (key) this.gop = [frame];
    else if (this.gop.length) {
      this.gop.push(frame);
      if (this.gop.length > 240) this.gop = [];   // never grow without bound
    }
    for (const c of this.clients) {
      if (c.writableLength > 4 * 1024 * 1024) { c.destroy(); continue; } // OBS too slow: cut it, it will reconnect
      c.write(frame);
    }
    this.emit('frame', frame, key);
  }

  statsTick() {
    const now = Date.now();
    const kbps = Math.round((this.bytes * 8) / 1000);
    const fps = this.frames;
    this.bytes = 0;
    this.frames = 0;

    // Watchdog: socket looks open but nothing arrives => reconnect instead of hanging.
    if (this.sock && this.gotData && now - this.lastData > 4000) {
      this.dropSocket();
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureSocket(); }, 300);
    }

    let stream = 'idle';
    if (this.state.tunnel) {
      stream = this.sock && this.gotData && now - this.lastData < 2500 ? 'live' : 'waiting';
    }
    this.set({ kbps: stream === 'live' ? kbps : 0, fps: stream === 'live' ? fps : 0, stream });
  }

  startRelay() {
    this.relay = net.createServer((c) => {
      c.setNoDelay(true);
      c.on('error', () => {});
      // New viewer starts from the latest keyframe so it shows a picture immediately.
      for (const f of this.gop) c.write(f);
      this.clients.add(c);
      this.set({ relayClients: this.clients.size });
      c.on('close', () => {
        this.clients.delete(c);
        this.set({ relayClients: this.clients.size });
      });
    });
    this.relay.on('error', () => this.set({ relayError: `Port ${RELAY_PORT} is already in use` }));
    this.relay.listen(RELAY_PORT, '127.0.0.1');
  }
}

module.exports = { Bridge, PHONE_PORT, RELAY_PORT };
