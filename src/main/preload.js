'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('snap', {
  state: () => ipcRenderer.invoke('state'),
  sendFiles: (peerId, paths) => ipcRenderer.invoke('send-files', peerId, paths),
  sendText: (peerId, text) => ipcRenderer.invoke('send-text', peerId, text),
  addManual: (address) => ipcRenderer.invoke('add-manual', address),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  untrust: (peerId) => ipcRenderer.invoke('untrust', peerId),
  resetPhoneLink: () => ipcRenderer.invoke('reset-phone-link'),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  clearPending: () => ipcRenderer.invoke('clear-pending'),
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
  setPinned: (v) => ipcRenderer.invoke('pin', v),
  // Electron 32+ removed File.path; this is the supported way to get a dropped file's path.
  pathFor: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => {
    const allowed = ['peers', 'progress', 'pending', 'state', 'toast'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.off(channel, h);
  },
});
