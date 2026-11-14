'use strict';
const http = require('http');
const { EventEmitter } = require('events');

const BOUNDARY = 'deenframe';
const PAGE = `<!doctype html><meta charset="utf-8"><title>Deenstudio</title>
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
img{width:100%;height:100%;object-fit:contain;display:block}</style>
<img id="v" src="/combined.mjpg">
<script>var v=document.getElementById('v');
v.onerror=function(){setTimeout(function(){v.src='/combined.mjpg?'+Date.now();},1000);};</script>`;

function wavHeader() {
  // Endless 48 kHz / 16-bit / mono WAV: sizes set to "unknown" so players keep reading.
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(0xFFFFFFFF, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);       // PCM
  h.writeUInt16LE(1, 22);       // mono
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

/**
 * Local web server for OBS / Prism on 127.0.0.1:
 *   /                  page showing the combined picture (use as a Browser Source)
 *   /combined.mjpg     the combined picture as a motion-JPEG stream
 *   /audio/N.wav       sound of phone N as an endless WAV (use as a Media Source)
 */
class Hub extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.mjpeg = new Set();
    this.audio = new Map();
    this.error = null;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('error', () => {
      this.error = `Port ${this.port} is already in use`;
      this.emit('error-state', this.error);
    });
    this.server.listen(this.port, '127.0.0.1');
  }

  stop() {
    for (const r of this.mjpeg) r.destroy();
    for (const set of this.audio.values()) for (const r of set) r.destroy();
    if (this.server) this.server.close();
  }

  handle(req, res) {
    const url = (req.url || '/').split('?')[0];
    let m;
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(PAGE);
    } else if (url === '/combined.mjpg') {
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-cache, no-store',
        Pragma: 'no-cache',
        Connection: 'close'
      });
      this.mjpeg.add(res);
      this.emitClients();
      req.on('close', () => { this.mjpeg.delete(res); this.emitClients(); });
    } else if ((m = url.match(/^\/audio\/(\d+)\.wav$/))) {
      const slot = Number(m[1]) - 1;
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-cache', Connection: 'close' });
      res.write(wavHeader());
      if (!this.audio.has(slot)) this.audio.set(slot, new Set());
      this.audio.get(slot).add(res);
      req.on('close', () => { const s = this.audio.get(slot); if (s) s.delete(res); });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  emitClients() { this.emit('clients', this.mjpeg.size); }

  pushJpeg(buf) {
    if (!this.mjpeg.size) return;
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
    for (const res of this.mjpeg) {
      if (res.writableLength > 2 * 1024 * 1024) continue; // viewer is behind: skip this picture
      res.write(head);
      res.write(buf);
      res.write('\r\n');
    }
  }

  pushPcm(slot, buf) {
    const set = this.audio.get(slot);
    if (!set || !set.size) return;
    for (const res of set) {
      if (res.writableLength > 1024 * 1024) continue;
      res.write(buf);
    }
  }
}

module.exports = { Hub };
