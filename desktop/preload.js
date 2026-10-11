'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFrame: (cb) => ipcRenderer.on('frame', (_e, data, key) => cb(data, key)),
  getState: () => ipcRenderer.invoke('get-state'),
  copy: (text) => ipcRenderer.invoke('copy', text)
});
