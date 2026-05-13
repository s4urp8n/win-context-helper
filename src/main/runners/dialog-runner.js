const { safeHook } = require('./safe-hook');
const { runWorkerPromise, runPreflightPromise } = require('./base-runner');
const { IPC } = require('../../shared/plugin-api');

function isValidPreflightShape(pre) {
  return pre && typeof pre === 'object';
}

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

function makeShellController({ shellWindow, ipcMain }) {
  let pendingResolver = null;
  let closed = false;

  const actionHandler = (_e, { action }) => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(action); }
  };
  const minHandler = () => { try { shellWindow.minimize(); } catch (_) {} };
  const closeHandler = () => {
    // Programmatic close from renderer's X button. Treat as cancel: resolve pending,
    // then destroy the window (which will also fire the 'closed' event for the flag).
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r('cancel'); }
    try { shellWindow.destroy(); } catch (_) {}
  };
  const resizeHandler = (_e, { height }) => {
    try {
      let maxH = 800;
      try {
        const { screen } = require('electron');
        const primary = screen.getPrimaryDisplay();
        maxH = Math.floor(primary.workAreaSize.height * 0.8);
      } catch (_) {}
      const clamped = Math.max(180, Math.min(Number(height) || 180, maxH));
      const [w] = shellWindow.getContentSize();
      shellWindow.setContentSize(w, clamped);
    } catch (_) {}
  };

  ipcMain.on(IPC.SHELL_ACTION, actionHandler);
  ipcMain.on(IPC.SHELL_MIN, minHandler);
  ipcMain.on(IPC.SHELL_CLOSE, closeHandler);
  ipcMain.on(IPC.SHELL_RESIZE, resizeHandler);

  shellWindow.on('closed', () => {
    closed = true;
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r('cancel'); }
  });

  const sendState = (payload) => {
    try { shellWindow.webContents.send(IPC.SHELL_SET_STATE, payload); } catch (_) {}
  };
  const waitForAction = () => {
    if (closed) return Promise.resolve('cancel');
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
    try {
      shellWindow.webContents.once('did-finish-load', cb);
    } catch (_) { cb(); }
  };

  return { sendState, waitForAction, close, onReady };
}

async function runDialogPlugin({
  manifest, plugin, pluginDir, targets, selection, binDir,
  openShell, ipcMain, runPreflight, runWorker, logger,
}) {
  const label = manifest.label;
  const ctx = { manifest, targets, selection };
  const workerPath = pathJoin(pluginDir, 'plugin.js');

  const scanningLabel = safeHook(plugin, 'buildScanningLabel', () => 'Scanning…', logger, ctx);
  const runningLabel  = safeHook(plugin, 'buildRunningLabel',  () => 'Working…',  logger, ctx);

  let shellWindow;
  try {
    shellWindow = openShell();
  } catch (err) {
    logger.error('dialog-runner: shell window failed to open', { message: err.message });
    return 3;
  }
  const shell = makeShellController({ shellWindow, ipcMain });

  // Wait for the renderer to be ready before sending the first state.
  await new Promise((resolve) => shell.onReady(resolve));
  shell.sendState({ state: 'scanning', label: scanningLabel });

  // 1. Preflight
  let pre;
  try {
    pre = await runPreflightPromise(runPreflight, {
      workerPath, targets, selection, binDir,
      onProgress: (p) => {
        shell.sendState({ state: 'scanning', label: scanningLabel, progress: p });
      },
    });
  } catch (err) {
    logger.error('dialog-runner: preflight crashed', { plugin: manifest.id, message: err.message });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: err.message });
    await shell.waitForAction();
    shell.close();
    return 3;
  }
  if (!isValidPreflightShape(pre)) {
    logger.error('dialog-runner: preflight returned invalid shape', { plugin: manifest.id });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: 'Preflight returned invalid data' });
    await shell.waitForAction();
    shell.close();
    return 3;
  }

  // 2. Nothing to do?
  const empty = safeHook(plugin, 'isEmpty', (_c, p) => !!(p && p.totalFiles === 0), logger, ctx, pre);
  if (empty) {
    const body = safeHook(plugin, 'buildNothingToDoBody',
      (_c, _p) => ({ message: 'Nothing to do.', detail: '' }),
      logger, ctx, pre);
    shell.sendState({ state: 'info', message: body.message, detail: body.detail });
    await shell.waitForAction();
    shell.close();
    return 0;
  }

  // 3. Confirm
  const confirm = safeHook(plugin, 'buildConfirmMessage',
    (_c, p) => ({ message: `Process ${(p && p.folders && p.folders.length) || 1} item(s)?`, detail: '' }),
    logger, ctx, pre);
  shell.sendState({ state: 'confirm', message: confirm.message, detail: confirm.detail });
  const action = await shell.waitForAction();
  if (action !== 'continue') { shell.close(); return 0; }

  // 4. Run
  shell.sendState({ state: 'running', label: runningLabel });
  const outcome = await runWorkerPromise(runWorker, {
    workerPath, targets, options: {}, selection, binDir,
    onProgress: (p) => {
      shell.sendState({ state: 'running', label: runningLabel, progress: p });
    },
  });

  // 5. Result
  if (outcome.kind === 'error') {
    logger.error('dialog-runner: worker error', { plugin: manifest.id, error: outcome.error });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: outcome.error.message || 'unknown error' });
    await shell.waitForAction();
    shell.close();
    return 3;
  }
  const result = outcome.result || {};
  const errors = result.errors || [];
  if (result.ok && errors.length === 0) { shell.close(); return 0; }
  const body = safeHook(plugin, 'buildErrorBody',
    (_c, errs, processed, total) => `${processed} of ${total} processed.\n${errs.length} could not be processed.\n${errs.slice(0, 10).map((e) => `  • ${e.file} — ${e.message}`).join('\n')}`,
    logger, ctx, errors, result.processed || 0, pre.totalFiles || 0);
  shell.sendState({ state: 'error', message: `${label} — completed with errors`, detail: body });
  await shell.waitForAction();
  shell.close();
  return 1;
}

module.exports = { runDialogPlugin };
