'use strict';
const net = require('net');

// Talks to Apple's usbmuxd service, which is installed with iTunes or the "Apple Devices" app.
// On Windows it listens on 127.0.0.1:27015; on macOS / Linux on /var/run/usbmuxd.
function muxAddress() {
  if (process.env.DEENSTUDIO_MUX_PORT) return { host: '127.0.0.1', port: Number(process.env.DEENSTUDIO_MUX_PORT) };
  if (process.platform === 'win32') return { host: '127.0.0.1', port: 27015 };
  return { path: '/var/run/usbmuxd' };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function packet(obj, tag) {
  const entries = Object.entries(obj).map(([k, v]) =>
    `<key>${esc(k)}</key>` + (typeof v === 'number' ? `<integer>${v}</integer>` : `<string>${esc(v)}</string>`)
  ).join('');
  const body = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0"><dict>${entries}</dict></plist>\n`
  );
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0);
  head.writeUInt32LE(1, 4);      // version 1 = plist protocol
  head.writeUInt32LE(8, 8);      // request type: plist message
  head.writeUInt32LE(tag, 12);
  return Buffer.concat([head, body]);
}

/** Sends one request and resolves with the first reply. The socket stays open for the caller. */
function request(obj) {
  return new Promise((resolve, reject) => {
    const s = net.connect(muxAddress());
    let buf = Buffer.alloc(0);
    let done = false;
    const fail = (e) => { if (done) return; done = true; s.destroy(); reject(e); };
    s.setTimeout(3000, () => fail(new Error('usbmuxd did not answer')));
    s.on('error', (e) => { if (!done) fail(e); });
    s.on('connect', () => s.write(packet(obj, 1)));
    s.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      done = true;
      s.setTimeout(0);
      s.removeAllListeners('data');
      const rest = buf.subarray(len);
      if (rest.length) s.unshift(rest);
      resolve({ xml: buf.subarray(16, len).toString('utf8'), socket: s });
    });
  });
}

const client = { MessageType: '', ClientVersionString: 'deenstudio', ProgName: 'Deenstudio' };

/** USB-connected iPhones / iPads: [{ deviceId, serial }] */
async function listDevices() {
  const { xml, socket } = await request({ ...client, MessageType: 'ListDevices' });
  socket.destroy();
  const out = [];
  const re = /<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let m;
  while ((m = re.exec(xml))) {
    const p = m[1];
    const id = /<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/.exec(p);
    const serial = /<key>SerialNumber<\/key>\s*<string>([^<]*)<\/string>/.exec(p);
    const type = /<key>ConnectionType<\/key>\s*<string>([^<]*)<\/string>/.exec(p);
    if (id && serial && (!type || type[1] === 'USB')) out.push({ deviceId: Number(id[1]), serial: serial[1] });
  }
  return out;
}

const htons = (port) => ((port & 0xff) << 8) | ((port >> 8) & 0xff);

/** Opens a raw tunnel to a TCP port inside the app on the iPhone. Resolves with a net.Socket. */
async function connectDevice(deviceId, port) {
  const { xml, socket } = await request({ ...client, MessageType: 'Connect', DeviceID: deviceId, PortNumber: htons(port) });
  const r = /<key>Number<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
  if (!r || Number(r[1]) !== 0) {
    socket.destroy();
    throw new Error('The app on the iPhone is not listening yet');
  }
  socket.on('error', () => {});
  return socket;
}

module.exports = { listDevices, connectDevice, htons };
