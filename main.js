'use strict';
const { app, BrowserWindow, ipcMain, clipboard, desktopCapturer, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { DeviceManager } = require('./lib/manager');
const { Hub } = require('./lib/hub');
const { Store } = require('./lib/store');

const HUB_PORT = 8090;

// Keep decoding and drawing even when the window is behind OBS or minimised.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null;
let manager = null;
let hub = null;
let pendingSourceId = null;

function resolveAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    path.join(process.resourcesPath || '', 'adb', exe),
    path.join(__dirname, 'adb', exe)
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'adb';
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function hubInfo() {
  return { port: HUB_PORT, mjpegClients: hub ? hub.mjpeg.size : 0, error: hub ? hub.error : null };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0A0C10',
    title: 'Deenstudio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function picturesDir() {
  const dir = path.join(app.getPath('pictures'), 'Deenstudio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();

    manager = new DeviceManager({
      adbPath: resolveAdb(),
      store: new Store(path.join(app.getPath('userData'), 'devices.json'))
    });
    hub = new Hub(HUB_PORT);
    hub.start();

    manager.on('state', (s) => send('state', { ...s, hub: hubInfo() }));
    manager.on('frame', (slot, data, key) => send('frame', slot, data, key));
    manager.on('audio', (slot, pcm) => { hub.pushPcm(slot, pcm); send('audio', slot, pcm); });
    hub.on('clients', () => send('hub', hubInfo()));
    hub.on('error-state', () => send('hub', hubInfo()));
    manager.start();

    ipcMain.handle('get-state', () => ({ ...manager.state, hub: hubInfo() }));
    ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
    ipcMain.handle('set-mute', (_e, slot, muted) => manager.setMute(Number(slot), !!muted));
    ipcMain.on('combined-jpeg', (_e, bytes) => hub.pushJpeg(Buffer.from(bytes)));

    ipcMain.handle('save-image', (_e, prefix, ext, bytes) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safe = String(prefix).replace(/[^\w-]/g, '_');
      const file = path.join(picturesDir(), `${safe}-${stamp}.${ext === 'png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, Buffer.from(bytes));
      return file;
    });
    ipcMain.handle('show-file', (_e, file) => {
      if (file && fs.existsSync(file)) shell.showItemInFolder(file); else shell.openPath(picturesDir());
    });

    // Visual screen: pick a window or screen, then the page asks for it with getDisplayMedia.
    ipcMain.handle('list-sources', async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false
      });
      return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen:') }));
    });
    ipcMain.handle('select-source', (_e, id) => { pendingSourceId = id; });
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const src = sources.find((s) => s.id === pendingSourceId) || sources[0];
        callback(src ? { video: src } : {});
      } catch (_) {
        callback({});
      }
    });
  });

  app.on('window-all-closed', () => {
    if (manager) manager.stop();
    if (hub) hub.stop();
    app.quit();
  });
}
