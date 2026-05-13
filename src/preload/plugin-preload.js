const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/plugin-api');

contextBridge.exposeInMainWorld('ch', {
  onInit: (cb) => ipcRenderer.on(IPC.INIT, (_e, payload) => cb(payload)),
  onProgress: (cb) => ipcRenderer.on(IPC.PROGRESS, (_e, payload) => cb(payload)),
  onComplete: (cb) => ipcRenderer.on(IPC.COMPLETE, (_e, payload) => cb(payload)),
  start: (options) => ipcRenderer.send(IPC.START, { options }),
  cancel: () => ipcRenderer.send(IPC.CANCEL),
});
