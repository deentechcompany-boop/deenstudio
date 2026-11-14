'use strict';
const assert = require('assert');
const { layoutRects, codecFromFrame, swapItems } = require('../renderer/pure');

assert.strictEqual(layoutRects(0, 1920, 1080, 'grid').length, 0);
const one = layoutRects(1, 1920, 1080, 'grid');
assert.deepStrictEqual(one[0], { x: 6, y: 6, w: 1908, h: 1068 });
assert.strictEqual(layoutRects(4, 1920, 1080, 'grid').length, 4);
const g4 = layoutRects(4, 1920, 1080, 'grid');
assert.strictEqual(g4[3].x > g4[0].x && g4[3].y > g4[0].y, true);        // 2x2
const row = layoutRects(3, 1920, 1080, 'row');
assert.ok(row[1].x > row[0].x && row[0].y === row[1].y);
const col = layoutRects(3, 1920, 1080, 'column');
assert.ok(col[1].y > col[0].y && col[0].x === col[1].x);
const main = layoutRects(3, 1920, 1080, 'main');
assert.ok(main[0].w > main[1].w && main[1].x === main[2].x);
assert.strictEqual(layoutRects(1, 1920, 1080, 'main').length, 1);
for (const n of [1, 2, 3, 4, 5, 6]) for (const m of ['grid', 'row', 'column', 'main'])
  for (const r of layoutRects(n, 1920, 1080, m)) assert.ok(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 1920 && r.y + r.h <= 1080);

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xAC]);
assert.strictEqual(codecFromFrame(sps), 'avc1.640028');
assert.strictEqual(codecFromFrame(Buffer.from([0, 0, 0, 1, 0x41, 1, 2, 3, 4, 5, 6])), null);

const a = [0, 1, 2];
assert.ok(swapItems(a, 0, 2));
assert.deepStrictEqual(a, [2, 1, 0]);
assert.ok(!swapItems(a, 0, 9));
console.log('pure helpers: ok');
