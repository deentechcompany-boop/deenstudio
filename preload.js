'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onHub: (cb) => ipcRenderer.on('hub', (_e, h) => cb(h)),
  onFrame: (cb) => ipcRenderer.on('frame', (_e, slot, data, key) => cb(slot, data, key)),
  onAudio: (cb) => ipcRenderer.on('audio', (_e, slot, pcm) => cb(slot, pcm)),
  getState: () => ipcRenderer.invoke('get-state'),
  setMute: (slot, muted) => ipcRenderer.invoke('set-mute', slot, muted),
  sendJpeg: (bytes) => ipcRenderer.send('combined-jpeg', bytes),
  saveImage: (prefix, ext, bytes) => ipcRenderer.invoke('save-image', prefix, ext, bytes),
  showFile: (file) => ipcRenderer.invoke('show-file', file),
  listSources: () => ipcRenderer.invoke('list-sources'),
  selectSource: (id) => ipcRenderer.invoke('select-source', id),
  copy: (text) => ipcRenderer.invoke('copy', text)
});
