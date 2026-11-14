'use strict';
/* global layoutRects, codecFromFrame, swapItems */
const $ = (id) => document.getElementById(id);
const comp = $('comp');
const cctx = comp.getContext('2d', { alpha: false });

// ---- saved preferences ---------------------------------------------------------------------

const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };

let order = load('order', []);                 // phone slots, in display order
const hidden = new Set(load('hidden', []));
const mirror = load('mirror', {});
const rot = load('rot', {});
let layout = load('layout', 'grid');
let size = load('size', '1920x1080');

let state = { adb: 'checking', unauthorized: false, devices: [], hub: { port: 8090, mjpegClients: 0, error: null } };
let devBySlot = {};
const streams = {};                            // slot -> decoder + picture
const levels = {};                             // slot -> sound level 0..1
const cards = {};                              // slot -> device card
let lastSaved = null;
let hear = false;
let actx = null;
const play = {};

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- video decoding: one decoder per phone -------------------------------------------------

function getStream(slot) {
  if (!streams[slot]) {
    const canvas = document.createElement('canvas');
    streams[slot] = {
      decoder: null, configuredFor: null, needKey: true, ts: 0, latest: null,
      canvas, ctx: canvas.getContext('2d', { alpha: false }),
      w: 0, h: 0, rendered: 0, fps: 0, dropped: 0
    };
  }
  return streams[slot];
}

function makeDecoder(s, codec) {
  if (s.decoder && s.decoder.state !== 'closed') { try { s.decoder.close(); } catch (_) { /* ignore */ } }
  s.decoder = new VideoDecoder({
    output: (frame) => { if (s.latest) s.latest.close(); s.latest = frame; },
    error: () => { s.configuredFor = null; s.needKey = true; }
  });
  s.decoder.configure({
    codec,
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'annexb' }
  });
  s.configuredFor = codec;
  s.needKey = true;
}

window.studio.onFrame((slot, data, key) => {
  const s = getStream(slot);
  if (key) {
    const codec = codecFromFrame(data);
    const closed = s.decoder && s.decoder.state === 'closed';
    if (codec && (codec !== s.configuredFor || closed)) makeDecoder(s, codec);
  }
  if (!s.decoder || s.decoder.state !== 'configured') return;
  if (s.needKey && !key) return;
  // Falling behind? Skip ahead to the next keyframe instead of building up delay.
  if (s.decoder.decodeQueueSize > 6 && !key) { s.dropped++; s.needKey = true; return; }
  s.needKey = false;
  try {
    s.ts += 33333;
    s.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: s.ts, data }));
  } catch (_) {
    s.configuredFor = null;
    s.needKey = true;
  }
});

function dropStream(slot) {
  const s = streams[slot];
  if (!s) return;
  if (s.decoder && s.decoder.state !== 'closed') { try { s.decoder.close(); } catch (_) { /* ignore */ } }
  if (s.latest) { s.latest.close(); s.latest = null; }
  delete streams[slot];
}

// ---- combined picture ----------------------------------------------------------------------

function visibleSlots() { return order.filter((s) => devBySlot[s] && !hidden.has(s)); }

function drawComposite() {
  const W = comp.width;
  const H = comp.height;
  cctx.fillStyle = '#000';
  cctx.fillRect(0, 0, W, H);
  const slots = visibleSlots();
  const rects = layoutRects(slots.length, W, H, layout);
  slots.forEach((slot, i) => {
    const s = streams[slot];
    const d = devBySlot[slot];
    if (!s || !s.w || !d || d.stream !== 'live') return;     // no frozen pictures in the output
    const r = rects[i];
    const scale = Math.min(r.w / s.w, r.h / s.h);
    const dw = s.w * scale;
    const dh = s.h * scale;
    const dx = r.x + (r.w - dw) / 2;
    const dy = r.y + (r.h - dh) / 2;
    cctx.save();
    cctx.translate(dx + dw / 2, dy + dh / 2);
    if (rot[slot]) cctx.rotate(Math.PI);
    if (mirror[slot]) cctx.scale(-1, 1);
    cctx.drawImage(s.canvas, -dw / 2, -dh / 2, dw, dh);
    cctx.restore();
  });
}

// Send the combined picture to OBS (Browser Source) only while someone is watching.
let encoding = false;
let lastEnc = 0;
function pushComposite() {
  if (encoding || !state.hub || state.hub.mjpegClients < 1) return;
  const now = performance.now();
  if (now - lastEnc < 33) return;
  lastEnc = now;
  encoding = true;
  comp.toBlob(async (blob) => {
    try {
      if (blob) window.studio.sendJpeg(new Uint8Array(await blob.arrayBuffer()));
    } finally {
      encoding = false;
    }
  }, 'image/jpeg', 0.85);
}

function paint() {
  for (const slot of Object.keys(streams)) {
    const s = streams[slot];
    if (!s.latest) continue;
    const f = s.latest;
    s.latest = null;
    if (s.canvas.width !== f.displayWidth || s.canvas.height !== f.displayHeight) {
      s.canvas.width = f.displayWidth;
      s.canvas.height = f.displayHeight;
    }
    s.w = f.displayWidth;
    s.h = f.displayHeight;
    s.ctx.drawImage(f, 0, 0);
    f.close();
    s.rendered++;
  }
  drawComposite();
  pushComposite();
  for (const slot of Object.keys(levels)) {
    levels[slot] *= 0.93;
    const c = cards[slot];
    if (c) c.meter.style.width = Math.min(100, Math.round(levels[slot] * 100)) + '%';
  }
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);

function fitStage() {
  const st = $('stage');
  const aw = st.clientWidth;
  const ah = st.clientHeight;
  if (!aw || !ah) return;
  const ar = comp.width / comp.height;
  let w = aw;
  let h = aw / ar;
  if (h > ah) { h = ah; w = ah * ar; }
  $('wrap').style.width = Math.floor(w) + 'px';
  $('wrap').style.height = Math.floor(h) + 'px';
}
window.addEventListener('resize', fitStage);

// ---- draggable tiles over the combined picture ---------------------------------------------

let tilesSig = '';
function rebuildTiles(force) {
  const slots = visibleSlots();
  const rects = layoutRects(slots.length, comp.width, comp.height, layout);
  const sig = JSON.stringify([slots, slots.map((s) => [devBySlot[s].stream, devBySlot[s].name]), layout, comp.width, comp.height]);
  if (!force && sig === tilesSig) return;
  tilesSig = sig;

  const host = $('tiles');
  host.innerHTML = '';
  slots.forEach((slot, i) => {
    const r = rects[i];
    const d = devBySlot[slot];
    const live = d.stream === 'live';
    const div = document.createElement('div');
    div.className = 'tile';
    div.draggable = true;
    div.style.left = (r.x / comp.width * 100) + '%';
    div.style.top = (r.y / comp.height * 100) + '%';
    div.style.width = (r.w / comp.width * 100) + '%';
    div.style.height = (r.h / comp.height * 100) + '%';
    div.innerHTML = `<div class="tag"><span class="dot ${live ? 'ok' : 'warn'}"></span>${esc(d.name)}</div>` +
      (live ? '' : '<div class="wait">Waiting for the stream…</div>');
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(slot));
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.classList.add('over'); });
    div.addEventListener('dragleave', () => div.classList.remove('over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      swapSlots(Number(e.dataTransfer.getData('text/plain')), slot);
    });
    host.appendChild(div);
  });
}

function swapSlots(a, b) {
  if (swapItems(order, a, b)) {
    store('order', order);
    rebuildTiles(true);
    renderDevices();
  }
}

function moveSlot(slot, dir) {
  const slots = order.filter((s) => devBySlot[s]);
  const i = slots.indexOf(slot);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= slots.length) return;
  swapSlots(slot, slots[j]);
}

// ---- device cards --------------------------------------------------------------------------

function createCard(slot) {
  const n = slot + 1;
  const el = document.createElement('section');
  el.className = 'card';
  el.innerHTML = `
    <div class="dev-head">
      <span class="dot"></span>
      <div class="dev-title"><b class="dname"></b><small class="dstatus"></small></div>
      <div class="dev-move">
        <button class="mini" data-act="up" title="Move earlier">↑</button>
        <button class="mini" data-act="down" title="Move later">↓</button>
      </div>
    </div>
    <div class="meter"><i></i></div>
    <div class="btnrow">
      <button class="warn" data-act="mute">Mute</button>
      <button data-act="mirror">Mirror</button>
      <button data-act="rotate">Rotate 180°</button>
      <button data-act="snap">Snap photo</button>
      <button data-act="hide">Hide</button>
    </div>
    <details>
      <summary>Add this phone on its own in OBS</summary>
      <p class="hint">Media Source, untick Local File, input format <code>h264</code>:</p>
      <div class="copyrow"><code>tcp://127.0.0.1:${8001 + slot}</code><button data-copy="tcp://127.0.0.1:${8001 + slot}">Copy</button></div>
      <p class="hint">For its sound, add a second Media Source (leave the format empty):</p>
      <div class="copyrow"><code>http://127.0.0.1:8090/audio/${n}.wav</code><button data-copy="http://127.0.0.1:8090/audio/${n}.wav">Copy</button></div>
    </details>`;
  const q = (sel) => el.querySelector(sel);
  const c = {
    el,
    dot: q('.dot'), name: q('.dname'), status: q('.dstatus'), meter: q('.meter i'),
    mute: q('[data-act=mute]'), mirror: q('[data-act=mirror]'), rotate: q('[data-act=rotate]'), hide: q('[data-act=hide]')
  };
  el.addEventListener('click', (e) => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (!act) return;
    const d = devBySlot[slot];
    if (act === 'mute' && d) window.studio.setMute(slot, !d.muted);
    if (act === 'mirror') { mirror[slot] = !mirror[slot]; store('mirror', mirror); renderDevices(); }
    if (act === 'rotate') { rot[slot] = !rot[slot]; store('rot', rot); renderDevices(); }
    if (act === 'hide') {
      if (hidden.has(slot)) hidden.delete(slot); else hidden.add(slot);
      store('hidden', [...hidden]);
      rebuildTiles(true);
      renderDevices();
    }
    if (act === 'up') moveSlot(slot, -1);
    if (act === 'down') moveSlot(slot, 1);
    if (act === 'snap') snapDevice(slot);
  });
  return c;
}

function renderDevices() {
  const host = $('devices');
  const present = new Set(state.devices.map((d) => d.slot));
  for (const key of Object.keys(cards)) {
    if (!present.has(Number(key))) { cards[key].el.remove(); delete cards[key]; }
  }
  order.filter((s) => present.has(s)).forEach((slot, i) => {
    const d = devBySlot[slot];
    let c = cards[slot];
    if (!c) c = cards[slot] = createCard(slot);
    if (host.children[i] !== c.el) host.insertBefore(c.el, host.children[i] || null);

    const s = streams[slot];
    const live = d.stream === 'live';
    c.dot.className = 'dot ' + (live ? 'ok' : (d.tunnel ? 'warn' : ''));
    c.name.textContent = `${d.name}  ·  phone ${slot + 1}` + (d.muted ? '  ·  muted' : '');
    if (live) {
      const res = s && s.w ? `${s.w}×${s.h} · ` : '';
      c.status.textContent = `Live · ${res}${s ? s.fps : 0} fps · ${(d.kbps / 1000).toFixed(1)} Mbps · ${d.audio ? 'sound on' : 'no sound'}`;
    } else if (!d.tunnel) {
      c.status.textContent = d.error || 'Opening the USB tunnel…';
    } else {
      c.status.textContent = 'Open Deenstudio on this phone and tap Start stream';
    }
    c.mute.textContent = d.muted ? 'Unmute' : 'Mute';
    c.mute.classList.toggle('on', !!d.muted);
    c.mirror.classList.toggle('on', !!mirror[slot]);
    c.rotate.classList.toggle('on', !!rot[slot]);
    c.hide.textContent = hidden.has(slot) ? 'Show' : 'Hide';
  });
}

// ---- state from the main process -----------------------------------------------------------

function applyState(s) {
  state = s;
  devBySlot = {};
  for (const d of s.devices) {
    devBySlot[d.slot] = d;
    if (!order.includes(d.slot)) { order.push(d.slot); store('order', order); }
  }
  for (const key of Object.keys(streams)) if (!devBySlot[key]) dropStream(key);
  render();
}

function render() {
  renderDevices();
  rebuildTiles(false);

  const devs = state.devices;
  const live = devs.filter((d) => d.stream === 'live');
  const shownLive = visibleSlots().filter((sl) => devBySlot[sl].stream === 'live');

  $('topLed').className = 'led ' + (live.length ? 'green' : (devs.length ? 'amber' : ''));
  $('topText').textContent = devs.length
    ? `${live.length} of ${devs.length} phone${devs.length === 1 ? '' : 's'} live`
    : 'No phone connected';
  $('stage').classList.toggle('live', shownLive.length > 0);
  const allMuted = devs.length > 0 && devs.every((d) => d.muted);
  $('qMuteAll').textContent = allMuted ? 'Unmute all' : 'Mute all';
  $('qMuteAll').classList.toggle('on', allMuted);

  let title = '';
  let body = '';
  if (state.adb === 'missing') { title = 'Desktop tools are missing'; body = 'The built-in adb tool could not be found. Download the app again.'; }
  else if (!devs.length && state.unauthorized) { title = 'Tap “Allow” on your phone'; body = 'A prompt asks you to trust this computer. Tick “Always allow” and tap Allow.'; }
  else if (!devs.length) { title = 'Plug in your phone'; body = 'Use a USB cable and turn on USB debugging in Developer options. You can plug in more than one phone.'; }
  else if (!live.length) { title = 'Start the stream on your phone'; body = 'Deenstudio is opening on the phone. Tap Start stream. Each phone shows up here by itself.'; }
  else if (!shownLive.length) { title = 'All pictures are hidden'; body = 'Press Show on a phone card to bring it back.'; }
  $('overlay').classList.toggle('hidden', !title);
  if (title) { $('ovTitle').textContent = title; $('ovBody').textContent = body; }

  let help = devs.length
    ? `${devs.length} phone${devs.length === 1 ? '' : 's'} connected. Plug in another phone to add it. Each phone keeps the same OBS address every time.`
    : 'No phones yet. Plug one in with a USB cable.';
  if (state.unauthorized && devs.length) help += ' Another phone is waiting for you to tap Allow on it.';
  if (state.ios === 'missing') help += ' To use an iPhone, install “Apple Devices” from the Microsoft Store (or iTunes), then plug the iPhone in and tap Trust.';
  $('helpText').textContent = help;

  const h = state.hub || {};
  $('hubInfo').textContent = h.error
    ? h.error
    : `Width 1920, height 1080. OBS is watching the combined screen: ${h.mjpegClients || 0}`;
}

window.studio.onState(applyState);
window.studio.onHub((h) => { state.hub = h; render(); });
window.studio.getState().then(applyState);

setInterval(() => {
  for (const slot of Object.keys(streams)) {
    const s = streams[slot];
    s.fps = s.rendered;
    s.rendered = 0;
  }
  renderDevices();
}, 1000);

// ---- sound -----------------------------------------------------------------------------------

window.studio.onAudio((slot, data) => {
  const len = data.byteLength - (data.byteLength % 2);
  if (!len) return;
  const i16 = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + len));
  let sum = 0;
  for (let k = 0; k < i16.length; k++) { const v = i16[k] / 32768; sum += v * v; }
  levels[slot] = Math.max(Math.min(1, Math.sqrt(sum / i16.length) * 4), levels[slot] || 0);
  if (!hear || !actx) return;

  const f = new Float32Array(i16.length);
  for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 32768;
  const buf = actx.createBuffer(1, f.length, 48000);
  buf.copyToChannel(f, 0);
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.connect(actx.destination);
  const p = play[slot] || (play[slot] = { next: 0 });
  const now = actx.currentTime;
  if (p.next < now + 0.02) p.next = now + 0.08;             // small cushion against jitter
  src.start(p.next);
  p.next += buf.duration;
});

$('hear').addEventListener('change', (e) => {
  hear = e.target.checked;
  if (hear) {
    if (!actx) actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    actx.resume();
  }
});

// ---- photos and screenshots ------------------------------------------------------------------

const toastEl = $('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 6000);
}
toastEl.addEventListener('click', () => { window.studio.showFile(lastSaved); toastEl.classList.add('hidden'); });

async function saveCanvas(canvas, prefix, ext, quiet) {
  const blob = await new Promise((res) => canvas.toBlob(res, ext === 'png' ? 'image/png' : 'image/jpeg', 0.95));
  if (!blob) { toast('Could not make the picture'); return null; }
  const file = await window.studio.saveImage(prefix, ext, new Uint8Array(await blob.arrayBuffer()));
  lastSaved = file;
  if (!quiet) toast('Saved: ' + file + '   (click to open the folder)');
  return file;
}

async function snapDevice(slot, quiet) {
  const s = streams[slot];
  const d = devBySlot[slot];
  if (!s || !s.w || !d || d.stream !== 'live') { if (!quiet) toast('No picture from that phone yet'); return null; }
  return saveCanvas(s.canvas, `Phone${slot + 1}-${d.name}`, 'jpg', quiet);
}

async function snapAllPhones() {
  const live = state.devices.filter((d) => d.stream === 'live');
  if (!live.length) { toast('No phone is live yet'); return; }
  let n = 0;
  for (const d of live) if (await snapDevice(d.slot, true)) n++;
  toast(`Saved ${n} photo${n === 1 ? '' : 's'} in Pictures › Deenstudio   (click to open the folder)`);
}

function muteAll() {
  if (!state.devices.length) return;
  const mute = state.devices.some((d) => !d.muted);        // anyone unmuted -> mute all, else unmute all
  state.devices.forEach((d) => window.studio.setMute(d.slot, mute));
}

$('snapComp').addEventListener('click', () => saveCanvas(comp, 'Combined', 'png'));

// ---- layout controls -------------------------------------------------------------------------

function syncLayoutButtons() {
  document.querySelectorAll('#layoutBtns button').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout));
}
document.querySelectorAll('#layoutBtns button').forEach((b) => {
  b.addEventListener('click', () => { layout = b.dataset.layout; store('layout', layout); syncLayoutButtons(); rebuildTiles(true); });
});

function applySize() {
  const [w, h] = size.split('x').map(Number);
  comp.width = w;
  comp.height = h;
  $('resSel').value = size;
  fitStage();
  rebuildTiles(true);
}
$('resSel').addEventListener('change', (e) => { size = e.target.value; store('size', size); applySize(); });

$('stage').addEventListener('dblclick', () => { document.body.classList.add('clean'); fitStage(); rebuildTiles(true); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { document.body.classList.remove('clean'); fitStage(); rebuildTiles(true); }
});

// ---- tabs ------------------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    $('view-devices').classList.toggle('hidden', t.dataset.tab !== 'devices');
    $('view-screen').classList.toggle('hidden', t.dataset.tab !== 'screen');
    fitStage();
  });
});

// ---- visual screen (OBS / Prism / any window) ------------------------------------------------

let screenStream = null;

function closeModal() { $('modal').classList.add('hidden'); }
$('closeModal').addEventListener('click', closeModal);

$('pickSource').addEventListener('click', async () => {
  const list = await window.studio.listSources();
  const host = $('sources');
  host.innerHTML = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'src';
    b.innerHTML = `<img src="${s.thumb}" alt=""><span>${s.screen ? 'Screen: ' : ''}${esc(s.name)}</span>`;
    b.addEventListener('click', () => chooseSource(s.id, s.name));
    host.appendChild(b);
  }
  $('modal').classList.remove('hidden');
});

async function chooseSource(id, name) {
  closeModal();
  try {
    await window.studio.selectSource(id);
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const v = $('screenVideo');
    v.srcObject = screenStream;
    await v.play().catch(() => {});
    $('screenOverlay').classList.add('hidden');
    $('screenInfo').textContent = 'Showing: ' + name;
    screenStream.getVideoTracks()[0].onended = () => {
      $('screenOverlay').classList.remove('hidden');
      $('screenInfo').textContent = 'That window was closed. Choose again.';
    };
  } catch (_) {
    toast('Could not capture that window. Try another one.');
  }
}

function snapScreenNow() {
  const v = $('screenVideo');
  if (!screenStream || !v.videoWidth) {
    document.querySelector('.tab[data-tab=screen]').click();     // take the user to the picker
    toast('Choose your OBS or Prism window first, then press Snap again');
    return;
  }
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  saveCanvas(c, 'Screenshot', 'png');
}
$('snapScreen').addEventListener('click', snapScreenNow);
$('qSnapScreen').addEventListener('click', snapScreenNow);
$('qSnapPhones').addEventListener('click', snapAllPhones);
$('qMuteAll').addEventListener('click', muteAll);

// ---- copy buttons ----------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-copy]');
  if (!b) return;
  window.studio.copy(b.dataset.copy);
  const t = b.textContent;
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = t; }, 1200);
});

// ---- start -----------------------------------------------------------------------------------

syncLayoutButtons();
applySize();
render();
