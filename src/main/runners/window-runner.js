const { safeHook } = require('./safe-hook');
const { runWorkerPromise, runPreflightPromise } = require('./base-runner');
const { IPC } = require('../../shared/plugin-api');

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

function makeShellController({ shellWindow, ipcMain }) {
  let pendingResolver = null;
  let closed = false;

  const actionHandler = (_e, payload) => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(payload); }
  };
  const minHandler = () => { try { shellWindow.minimize(); } catch {} };
  const closeHandler = () => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r({ action: 'cancel' }); }
    try { shellWindow.destroy(); } catch {}
  };
  const resizeHandler = (_e, { height }) => {
    try {
      let maxH = 800;
      try {
        const { screen } = require('electron');
        const primary = screen.getPrimaryDisplay();
        maxH = Math.floor(primary.workAreaSize.height * 0.8);
      } catch {}
      const clamped = Math.max(180, Math.min(Number(height) || 180, maxH));
      const [w] = shellWindow.getContentSize();
      shellWindow.setContentSize(w, clamped);
    } catch {}
  };
  ipcMain.on(IPC.SHELL_ACTION, actionHandler);
  ipcMain.on(IPC.SHELL_MIN, minHandler);
  ipcMain.on(IPC.SHELL_CLOSE, closeHandler);
  ipcMain.on(IPC.SHELL_RESIZE, resizeHandler);
  shellWindow.on('closed', () => {
    closed = true;
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r({ action: 'cancel' }); }
  });

  const sendState = (payload) => {
    try { shellWindow.webContents.send(IPC.SHELL_SET_STATE, payload); } catch {}
  };
  const waitForAction = () => {
    if (closed) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => { pendingResolver = resolve; });
  };
  const close = () => {
    try { ipcMain.removeListener(IPC.SHELL_ACTION, actionHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_MIN, minHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_CLOSE, closeHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_RESIZE, resizeHandler); } catch {}
    try { shellWindow.destroy(); } catch {}
  };
  const onReady = (cb) => {
    try { shellWindow.webContents.once('did-finish-load', cb); } catch { cb(); }
  };
  return { sendState, waitForAction, close, onReady };
}

async function runWindowPlugin({
  manifest, plugin, pluginDir, targets, selection, binDir,
  openShell, ipcMain, runPreflight, runWorker, readUiHtml, logger,
}) {
  const label = manifest.label;
  const ctx = { manifest, targets, selection };
  const workerPath = pathJoin(pluginDir, 'plugin.js');

  let shellWindow;
  try { shellWindow = openShell(); }
  catch (err) {
    logger.error('window-runner: shell window failed to open', { message: err.message });
    return 3;
  }
  const shell = makeShellController({ shellWindow, ipcMain });
  await new Promise((resolve) => shell.onReady(resolve));

  const scanningLabel = safeHook(plugin, 'buildScanningLabel', () => 'Scanning…', logger, ctx);
  shell.sendState({ state: 'scanning', label: scanningLabel });

  // 1. Preflight
  let pre;
  try {
    pre = await runPreflightPromise(runPreflight, {
      workerPath, targets, selection, binDir,
      onProgress: (p) => shell.sendState({ state: 'scanning', label: scanningLabel, progress: p }),
    });
  } catch (err) {
    logger.error('window-runner: preflight crashed', { plugin: manifest.id, message: err.message });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: err.message });
    await shell.waitForAction();
    shell.close();
    return 3;
  }

  // 2. Form
  const dynamicUi = safeHook(plugin, 'buildFormHtml', () => null, logger, ctx, pre);
  const uiHtml = (typeof dynamicUi === 'string' && dynamicUi.length > 0) ? dynamicUi : readUiHtml(pluginDir);
  const summary = safeHook(plugin, 'buildFormSummary', () => '', logger, ctx, pre);
  const formMessage = safeHook(plugin, 'buildFormMessage', () => label, logger, ctx, pre);
  shell.sendState({ state: 'form', message: formMessage, summary, uiHtml });

  const actionPayload = await shell.waitForAction();
  if (!actionPayload || actionPayload.action !== 'start') {
    shell.close();
    return 0;
  }
  const options = actionPayload.options || {};

  // 3. Run
  const runningLabel = safeHook(plugin, 'buildRunningLabel', () => 'Working…', logger, ctx);
  shell.sendState({ state: 'running', label: runningLabel });

  const outcome = await runWorkerPromise(runWorker, {
    workerPath, targets, options, selection, binDir,
    onProgress: (p) => shell.sendState({ state: 'running', label: runningLabel, progress: p }),
  });

  // 4. Result
  if (outcome.kind === 'error') {
    logger.error('window-runner: worker error', { plugin: manifest.id, error: outcome.error });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: outcome.error.message || 'unknown error' });
    await shell.waitForAction();
    shell.close();
    return 3;
  }
  const result = outcome.result || {};
  const errors = result.errors || [];
  if (result.ok && errors.length === 0) { shell.close(); return 0; }
  const body = safeHook(plugin, 'buildErrorBody',
    (_c, errs, processed, total) => `${processed} of ${total} processed.\n${errs.length} could not be processed.\n${errs.slice(0,10).map(e => `  • ${e.file} — ${e.message}`).join('\n')}`,
    logger, ctx, errors, result.processed || 0, pre.totalFiles || pre.totalItems || 0);
  shell.sendState({ state: 'error', message: `${label} — completed with errors`, detail: body });
  await shell.waitForAction();
  shell.close();
  return 1;
}

function readUiHtmlFromDisk(pluginDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(pluginDir, 'ui.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

module.exports = { runWindowPlugin, readUiHtmlFromDisk, makeShellController };
