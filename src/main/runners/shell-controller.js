const { IPC } = require('../../shared/plugin-api');

const MIN_HEIGHT = 180;
const FALLBACK_MAX_HEIGHT = 800;
const FALLBACK_MAX_WIDTH = 1000;

// Hooks return either plain text or { message, detail, table }; only those fields reach the shell.
function asBody(value, message) {
  if (typeof value === 'string') return { message, detail: value };
  const { message: own, detail, table } = value || {};
  return { message: own || message, detail, table };
}

function workAreaLimits() {
  try {
    const { screen } = require('electron');
    const { workAreaSize } = screen.getPrimaryDisplay();
    return { maxHeight: Math.floor(workAreaSize.height * 0.8), maxWidth: Math.floor(workAreaSize.width * 0.9) };
  } catch (_) {
    return { maxHeight: FALLBACK_MAX_HEIGHT, maxWidth: FALLBACK_MAX_WIDTH };
  }
}

// Bridges one shell window and a runner: sends states, waits for the user's action
// ({ action, options? }), and sizes the window. While the "running" state is shown the
// operation cannot be cancelled, so the close button and Alt+F4 are ignored.
function makeShellController({ shellWindow, ipcMain }) {
  let pendingResolver = null;
  let closed = false;
  let running = false;

  const resolvePending = (payload) => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(payload); }
  };
  const actionHandler = (_e, payload) => resolvePending(payload);
  const minHandler = () => { try { shellWindow.minimize(); } catch (_) {} };
  const closeHandler = () => {
    if (running) return;
    resolvePending({ action: 'cancel' });
    try { shellWindow.destroy(); } catch (_) {}
  };
  // The renderer may ask for more width (tables); the window only grows sideways, never shrinks.
  const resizeHandler = (_e, size) => {
    try {
      const { height, width } = size || {};
      const { maxHeight, maxWidth } = workAreaLimits();
      const h = Math.max(MIN_HEIGHT, Math.min(Number(height) || MIN_HEIGHT, maxHeight));
      const [currentW] = shellWindow.getContentSize();
      const w = Math.max(currentW, Math.min(Number(width) || 0, maxWidth));
      shellWindow.setContentSize(w, h);
      if (w !== currentW) shellWindow.center();
    } catch (_) {}
  };

  ipcMain.on(IPC.SHELL_ACTION, actionHandler);
  ipcMain.on(IPC.SHELL_MIN, minHandler);
  ipcMain.on(IPC.SHELL_CLOSE, closeHandler);
  ipcMain.on(IPC.SHELL_RESIZE, resizeHandler);

  shellWindow.on('close', (event) => { if (running) event.preventDefault(); });
  shellWindow.on('closed', () => {
    closed = true;
    resolvePending({ action: 'cancel' });
  });

  const sendState = (payload) => {
    running = payload.state === 'running';
    try { shellWindow.webContents.send(IPC.SHELL_SET_STATE, payload); } catch (_) {}
  };
  const waitForAction = () => {
    if (closed) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => { pendingResolver = resolve; });
  };
  const close = () => {
    try { ipcMain.removeListener(IPC.SHELL_ACTION, actionHandler); } catch (_) {}
    try { ipcMain.removeListener(IPC.SHELL_MIN, minHandler); } catch (_) {}
    try { ipcMain.removeListener(IPC.SHELL_CLOSE, closeHandler); } catch (_) {}
    try { ipcMain.removeListener(IPC.SHELL_RESIZE, resizeHandler); } catch (_) {}
    try { shellWindow.destroy(); } catch (_) {}
  };
  const onReady = (cb) => {
    try { shellWindow.webContents.once('did-finish-load', cb); } catch (_) { cb(); }
  };

  return { sendState, waitForAction, close, onReady };
}

module.exports = { makeShellController, asBody };
