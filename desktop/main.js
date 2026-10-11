'use strict';
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Bridge } = require('./lib/bridge');

let win = null;
let bridge = null;

function resolveAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    path.join(process.resourcesPath || '', 'adb', exe),
    path.join(__dirname, 'adb', exe)
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'adb'; // fall back to PATH
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0A0C10',
    title: 'Deenstudio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false   // keep decoding when the window is behind OBS
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    createWindow();
    bridge = new Bridge({ adbPath: resolveAdb() });
    bridge.on('state', (s) => win && win.webContents.send('state', s));
    bridge.on('frame', (data, key) => win && win.webContents.send('frame', data, key));
    ipcMain.handle('get-state', () => bridge.state);
    ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
    bridge.start();
  });

  app.on('window-all-closed', () => {
    if (bridge) bridge.stop();
    app.quit();
  });
}
