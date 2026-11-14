'use strict';
const fs = require('fs');

const MAX_SLOTS = 6;

/** Remembers which slot (1-6) each phone had, so its OBS ports stay the same every time. */
class Store {
  constructor(file) {
    this.file = file;
    this.data = { slots: {} };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && d.slots) this.data = d;
    } catch (_) { /* first run */ }
  }

  slotFor(serial, inUse) {
    const current = this.data.slots[serial];
    if (current !== undefined && !inUse.has(current)) return current;

    const reserved = new Set(
      Object.entries(this.data.slots).filter(([s]) => s !== serial).map(([, v]) => v)
    );
    let slot = -1;
    for (let i = 0; i < MAX_SLOTS; i++) if (!inUse.has(i) && !reserved.has(i)) { slot = i; break; }
    if (slot < 0) for (let i = 0; i < MAX_SLOTS; i++) if (!inUse.has(i)) { slot = i; break; }
    if (slot < 0) return -1;

    for (const k of Object.keys(this.data.slots)) {
      if (this.data.slots[k] === slot && k !== serial) delete this.data.slots[k];
    }
    this.data.slots[serial] = slot;
    this.save();
    return slot;
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (_) { /* ignore */ }
  }
}

module.exports = { Store, MAX_SLOTS };
