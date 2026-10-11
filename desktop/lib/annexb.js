'use strict';
// Splits a raw H.264 Annex-B byte stream into frames (access units).
// Each emitted frame = [SPS/PPS/SEI if any] + one slice, with 4-byte start codes.

const START = Buffer.from([0, 0, 0, 1]);
const MARK = Buffer.from([0, 0, 1]);

class AnnexBParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
    this.pending = [];
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    const starts = [];
    let i = 0;
    for (;;) {
      const j = this.buf.indexOf(MARK, i);
      if (j < 0) break;
      starts.push(j);
      i = j + 3;
    }

    if (starts.length < 2) {
      // Not even one complete NAL yet. Guard against garbage that never has start codes.
      if (this.buf.length > (4 << 20)) this.reset();
      return;
    }

    for (let k = 0; k < starts.length - 1; k++) {
      const begin = starts[k] + 3;
      let end = starts[k + 1];
      while (end > begin && this.buf[end - 1] === 0) end--; // zero from a 4-byte start code
      if (end > begin) this.handleNal(this.buf.subarray(begin, end));
    }
    // Keep the last (possibly incomplete) NAL for the next chunk.
    this.buf = Buffer.from(this.buf.subarray(starts[starts.length - 1]));
  }

  handleNal(nal) {
    const type = nal[0] & 0x1f;
    if (type === 9) return;                      // access unit delimiter
    if (type === 1 || type === 5) {              // coded slice
      const parts = [];
      for (const p of this.pending) parts.push(START, p);
      parts.push(START, nal);
      this.pending = [];
      this.onFrame(Buffer.concat(parts), type === 5);
    } else {
      this.pending.push(Buffer.from(nal));       // SPS, PPS, SEI...
      if (this.pending.length > 16) this.pending.shift();
    }
  }

  reset() {
    this.buf = Buffer.alloc(0);
    this.pending = [];
  }
}

module.exports = { AnnexBParser };
