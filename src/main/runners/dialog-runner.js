const { safeHook } = require('./safe-hook');
const { runWorkerPromise, runPreflightPromise } = require('./base-runner');
const { makeShellController, asBody, asConfirmBody } = require('./shell-controller');

function isValidPreflightShape(pre) {
  return pre && typeof pre === 'object';
}

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
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
  const showAndClose = async (state) => {
    shell.sendState(state);
    await shell.waitForAction();
    shell.close();
  };

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
    await showAndClose({ state: 'error', message: `${label} — internal error`, detail: err.message });
    return 3;
  }
  if (!isValidPreflightShape(pre)) {
    logger.error('dialog-runner: preflight returned invalid shape', { plugin: manifest.id });
    await showAndClose({ state: 'error', message: `${label} — internal error`, detail: 'Preflight returned invalid data' });
    return 3;
  }

  // 2. Blocked? The plugin found something that makes the run impossible.
  const blocked = safeHook(plugin, 'buildBlockedBody', () => null, logger, ctx, pre);
  if (blocked) {
    logger.info('dialog-runner: run blocked by preflight', { plugin: manifest.id });
    await showAndClose({ ...asBody(blocked, `${label} — cannot start`), state: 'error' });
    return 2;
  }

  // 3. Nothing to do?
  const empty = safeHook(plugin, 'isEmpty', (_c, p) => !!(p && p.totalFiles === 0), logger, ctx, pre);
  if (empty) {
    const body = safeHook(plugin, 'buildNothingToDoBody',
      (_c, _p) => ({ message: 'Nothing to do.', detail: '' }),
      logger, ctx, pre);
    await showAndClose({ ...asBody(body, 'Nothing to do.'), state: 'info' });
    return 0;
  }

  // 4. Confirm. Changing an option in the dialog rebuilds the confirm body from the same
  // preflight; the body that was on screen when Continue was pressed decides the run options.
  let options = {};
  let runOptions;
  for (;;) {
    const confirm = safeHook(plugin, 'buildConfirmMessage',
      (_c, p) => ({ message: `Process ${(p && p.folders && p.folders.length) || 1} item(s)?`, detail: '' }),
      logger, ctx, pre, options);
    const body = asConfirmBody(confirm, 'Continue?');
    shell.sendState({ ...body, state: 'confirm' });
    const reply = await shell.waitForAction();
    if (reply.action === 'options') {
      options = { ...options, ...reply.options };
      continue;
    }
    if (reply.action !== 'continue') { shell.close(); return 0; }
    if (!body.canContinue) continue;
    // The plan id lets the plugin refuse a plan that differs from the confirmed one.
    runOptions = (confirm && confirm.runOptions) || (pre.planId ? { planId: pre.planId } : {});
    break;
  }

  // 5. Run.
  shell.sendState({ state: 'running', label: runningLabel });
  const outcome = await runWorkerPromise(runWorker, {
    workerPath, targets, options: runOptions, selection, binDir,
    onProgress: (p) => {
      shell.sendState({ state: 'running', label: runningLabel, progress: p });
    },
  });

  // 6. Result
  if (outcome.kind === 'error') {
    logger.error('dialog-runner: worker error', { plugin: manifest.id, error: outcome.error });
    await showAndClose({ state: 'error', message: `${label} — internal error`, detail: outcome.error.message || 'unknown error' });
    return 3;
  }
  const result = outcome.result || {};
  const errors = result.errors || [];
  if (result.ok && errors.length === 0) { shell.close(); return 0; }
  // The log keeps what the run left behind even if nobody reads the dialog.
  logger.error('dialog-runner: run failed', { plugin: manifest.id, errors, notRestored: result.notRestored || [] });
  const body = safeHook(plugin, 'buildErrorBody',
    (_c, errs, processed, total) => `${processed} of ${total} processed.\n${errs.length} could not be processed.\n${errs.slice(0, 10).map((e) => `  • ${e.file} — ${e.message}`).join('\n')}`,
    logger, ctx, errors, result.processed || 0, pre.totalFiles || 0, result);
  await showAndClose({ ...asBody(body, `${label} — completed with errors`), state: 'error' });
  return 1;
}

module.exports = { runDialogPlugin };
