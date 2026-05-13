const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/plugin-api');

contextBridge.exposeInMainWorld('shell', {
  onSetState: (cb) => ipcRenderer.on(IPC.SHELL_SET_STATE, (_e, payload) => cb(payload)),
  send: (payload) => {
    if (typeof payload === 'string') {
      ipcRenderer.send(IPC.SHELL_ACTION, { action: payload });
    } else if (payload && typeof payload === 'object') {
      ipcRenderer.send(IPC.SHELL_ACTION, payload);
    }
  },
  minimize: () => ipcRenderer.send(IPC.SHELL_MIN),
  close: () => ipcRenderer.send(IPC.SHELL_CLOSE),
  resize: (height) => ipcRenderer.send(IPC.SHELL_RESIZE, { height }),
});
