'use strict';
const assert = require('assert');
const { AnnexBParser } = require('../lib/annexb');

const sc4 = Buffer.from([0, 0, 0, 1]);
const nal = (type, len, fill) => Buffer.concat([Buffer.from([type]), Buffer.alloc(len, fill)]);
const sps = nal(0x67, 8, 0xAA), pps = nal(0x68, 4, 0xBB);
const idr = nal(0x65, 50, 0xCC), p1 = nal(0x41, 20, 0xDD), p2 = nal(0x41, 20, 0xEE);

// Phone sends: [SPS PPS IDR] [P] [P] (config only before keyframes)
const stream = Buffer.concat([sc4, sps, sc4, pps, sc4, idr, sc4, p1, sc4, p2, sc4, nal(0x41, 5, 0x11)]);

for (const chunkSize of [1, 3, 7, 64, stream.length]) {
  const got = [];
  const p = new AnnexBParser((f, key) => got.push({ f, key }));
  for (let i = 0; i < stream.length; i += chunkSize) p.push(stream.subarray(i, i + chunkSize));
  assert.strictEqual(got.length, 3, `frames @${chunkSize}`);
  assert.strictEqual(got[0].key, true);
  assert.strictEqual(got[1].key, false);
  assert.deepStrictEqual(got[0].f, Buffer.concat([sc4, sps, sc4, pps, sc4, idr]));
  assert.deepStrictEqual(got[1].f, Buffer.concat([sc4, p1]));
  assert.deepStrictEqual(got[2].f, Buffer.concat([sc4, p2]));
}
console.log('annexb parser: ok');
