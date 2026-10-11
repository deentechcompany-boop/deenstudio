'use strict';
const $ = (id) => document.getElementById(id);
const canvas = $('video');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

let decoder = null;
let configuredFor = null;
let needKey = true;
let ts = 0;
let latest = null;
let dropped = 0;
let rendered = 0;
let shownFps = 0;
let resolution = '–';
let mirror = false;
let flip = false;
let state = null;
let lastPaint = 0;

// ---- video decoding (WebCodecs, hardware when available) --------------------------------

function codecFromFrame(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
      const h = (n) => n.toString(16).padStart(2, '0');
      return 'avc1.' + h(data[i + 4]) + h(data[i + 5]) + h(data[i + 6]);
    }
  }
  return null;
}

function makeDecoder(codec) {
  if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch (_) {} }
  decoder = new VideoDecoder({
    output: (frame) => { if (latest) latest.close(); latest = frame; },
    error: () => { configuredFor = null; needKey = true; }
  });
  decoder.configure({
    codec,
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'annexb' }
  });
  configuredFor = codec;
  needKey = true;
}

window.studio.onFrame((data, key) => {
  if (key) {
    const codec = codecFromFrame(data);
    const closed = decoder && decoder.state === 'closed';
    if (codec && (codec !== configuredFor || closed)) makeDecoder(codec);
  }
  if (!decoder || decoder.state !== 'configured') return;
  if (needKey && !key) return;
  // Falling behind? Skip ahead to the next keyframe instead of building up delay.
  if (decoder.decodeQueueSize > 6 && !key) { dropped++; needKey = true; return; }
  needKey = false;
  try {
    ts += 33333;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data }));
  } catch (_) {
    configuredFor = null;
    needKey = true;
  }
});

function paint() {
  if (latest) {
    const f = latest;
    latest = null;
    if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
      canvas.width = f.displayWidth;
      canvas.height = f.displayHeight;
      resolution = `${f.displayWidth}×${f.displayHeight}`;
    }
    ctx.drawImage(f, 0, 0);
    f.close();
    rendered++;
    lastPaint = performance.now();
  }
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);

// ---- status UI ---------------------------------------------------------------------------

function setDot(id, cls) { $(id).className = 'dot ' + cls; }

function render() {
  const s = state;
  if (!s) return;

  // checklist
  if (s.adb === 'missing') { setDot('dAdb', 'bad'); $('tAdb').textContent = 'adb was not found. Re-download the app.'; }
  else if (s.adb === 'ok') { setDot('dAdb', 'ok'); $('tAdb').textContent = 'Ready'; }
  else { setDot('dAdb', 'warn'); $('tAdb').textContent = 'Checking…'; }

  if (s.device === 'ready') { setDot('dDev', 'ok'); $('tDev').textContent = 'Connected (' + s.serial + ')'; }
  else if (s.device === 'unauthorized') { setDot('dDev', 'warn'); $('tDev').textContent = 'Tap “Allow” on the phone to trust this PC'; }
  else { setDot('dDev', 'bad'); $('tDev').textContent = 'Plug in your phone and turn on USB debugging'; }

  if (s.tunnel) { setDot('dTun', 'ok'); $('tTun').textContent = 'Open'; }
  else { setDot('dTun', s.device === 'ready' ? 'warn' : 'bad'); $('tTun').textContent = s.error || 'Waiting for the phone'; }

  if (s.stream === 'live') { setDot('dStr', 'ok'); $('tStr').textContent = 'Receiving from the phone'; }
  else if (s.stream === 'waiting') { setDot('dStr', 'warn'); $('tStr').textContent = 'Open Deenstudio on the phone and tap Start stream'; }
  else { setDot('dStr', 'bad'); $('tStr').textContent = 'Not connected'; }

  // stats
  $('sRes').textContent = s.stream === 'live' ? resolution : '–';
  $('sFps').textContent = s.stream === 'live' ? shownFps + ' fps' : '–';
  $('sBit').textContent = s.stream === 'live' ? (s.kbps / 1000).toFixed(1) + ' Mbps' : '–';
  $('sDrop').textContent = String(dropped);
  $('sObs').textContent = String(s.relayClients) + (s.relayError ? ' (port busy)' : '');

  // LED + overlay
  const live = s.stream === 'live';
  $('stage').classList.toggle('live', live);
  const led = $('led');
  led.className = 'led';
  let pill, title = '', body = '';
  if (live) { led.classList.add('green'); pill = 'Live'; }
  else if (s.adb === 'missing') { pill = 'Tools missing'; title = 'Desktop tools are missing'; body = 'The built-in adb tool could not be found. Download the app again.'; }
  else if (s.device === 'none') { pill = 'No phone'; title = 'Plug in your phone'; body = 'Use a USB cable and turn on USB debugging in Developer options.'; }
  else if (s.device === 'unauthorized') { led.classList.add('amber'); pill = 'Allow on phone'; title = 'Tap “Allow” on your phone'; body = 'A prompt asks you to trust this computer. Tick “Always allow” and tap Allow.'; }
  else if (!s.tunnel) { led.classList.add('amber'); pill = 'Connecting'; title = 'Opening the USB tunnel…'; body = s.error || 'One moment.'; }
  else { led.classList.add('amber'); pill = 'Waiting for video'; title = 'Start the stream on your phone'; body = 'Deenstudio is opening on the phone. Tap “Start stream”.'; }
  $('pillText').textContent = pill;
  $('overlay').classList.toggle('hidden', live);
  if (!live) { $('overlayTitle').textContent = title; $('overlayBody').textContent = body; }
  $('readout').textContent = live ? `${resolution} · ${shownFps} fps` : '';
}

setInterval(() => {
  shownFps = rendered;
  rendered = 0;
  // Picture frozen while the stream claims to be live: force a clean restart of decoding.
  if (state && state.stream === 'live' && lastPaint && performance.now() - lastPaint > 3000) {
    configuredFor = null;
    needKey = true;
  }
  render();
}, 1000);

window.studio.onState((s) => { state = s; render(); });
window.studio.getState().then((s) => { state = s; render(); });

// ---- controls ----------------------------------------------------------------------------

function applyTransform() {
  const parts = [];
  if (mirror) parts.push('scaleX(-1)');
  if (flip) parts.push('rotate(180deg)');
  canvas.style.transform = parts.join(' ');
  $('bMirror').classList.toggle('on', mirror);
  $('bFlip').classList.toggle('on', flip);
}
$('bMirror').onclick = () => { mirror = !mirror; applyTransform(); };
$('bFlip').onclick = () => { flip = !flip; applyTransform(); };

function toggleClean() { document.body.classList.toggle('clean'); }
$('bClean').onclick = toggleClean;
canvas.ondblclick = toggleClean;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.body.classList.remove('clean');
  if (e.key === 'F11') { e.preventDefault(); toggleClean(); }
});

document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = () => {
    window.studio.copy(b.dataset.copy);
    const t = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = t; }, 1200);
  };
});
