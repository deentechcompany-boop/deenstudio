'use strict';
// Small pure helpers (no DOM) so they can be tested outside the app.

/** Rectangles (in canvas pixels) for n pictures in the chosen layout. */
function layoutRects(n, W, H, mode) {
  if (n <= 0) return [];
  const pad = 6;
  const cells = [];
  if (mode === 'row') {
    const w = W / n;
    for (let i = 0; i < n; i++) cells.push({ x: i * w, y: 0, w, h: H });
  } else if (mode === 'column') {
    const h = H / n;
    for (let i = 0; i < n; i++) cells.push({ x: 0, y: i * h, w: W, h });
  } else if (mode === 'main' && n > 1) {
    const mw = Math.round(W * 0.7);
    cells.push({ x: 0, y: 0, w: mw, h: H });
    const sh = H / (n - 1);
    for (let i = 1; i < n; i++) cells.push({ x: mw, y: (i - 1) * sh, w: W - mw, h: sh });
  } else {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = W / cols;
    const h = H / rows;
    for (let i = 0; i < n; i++) cells.push({ x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
  }
  return cells.map((c) => ({ x: c.x + pad, y: c.y + pad, w: c.w - 2 * pad, h: c.h - 2 * pad }));
}

/** 'avc1.PPCCLL' from the first SPS found in an Annex-B frame, or null. */
function codecFromFrame(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
      const h = (n) => n.toString(16).padStart(2, '0');
      return 'avc1' + '.' + h(data[i + 4]) + h(data[i + 5]) + h(data[i + 6]);
    }
  }
  return null;
}

/** Swap two items of an array in place (by value). Returns true if swapped. */
function swapItems(arr, a, b) {
  const i = arr.indexOf(a);
  const j = arr.indexOf(b);
  if (i < 0 || j < 0 || i === j) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

if (typeof module !== 'undefined') module.exports = { layoutRects, codecFromFrame, swapItems };
