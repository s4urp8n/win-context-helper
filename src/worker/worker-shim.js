// Forked entry. Receives one IPC message of either:
//   { type: 'start',     workerPath, targets, options, selection }
//   { type: 'preflight', workerPath, targets, selection }
//   { type: 'cancel' }
// Plugin module shape: a class with run() (and optionally preflight()) on its prototype.
const path = require('node:path');
const { WORKER_MSG } = require('../shared/plugin-api');

let _logger = null;
function getLogger() {
  if (_logger) return _logger;
  try { _logger = require('../main/logger'); } catch { _logger = { info() {}, warn() {}, error() {} }; }
  return _logger;
}

const cancelState = { aborted: false };
const signal = { get aborted() { return cancelState.aborted; } };

function loadPluginInstance(workerPath) {
  const Cls = require(workerPath);
  if (typeof Cls !== 'function' || !Cls.prototype || typeof Cls.prototype.run !== 'function') {
    throw new Error(`Plugin at ${workerPath} does not export a class with run()`);
  }
  return new Cls();
}

function pluginIdFromPath(workerPath) {
  try { return path.basename(path.dirname(workerPath)); } catch { return '?'; }
}

async function handleStart(msg) {
  const { workerPath, targets, options, selection, binDir } = msg;
  const log = getLogger();
  const id = pluginIdFromPath(workerPath);
  log.info(`worker: start ${id}`, { targets: targets && targets.length, options, binDir: !!binDir });
  let reported = false;
  try {
    const instance = loadPluginInstance(workerPath);
    const result = await instance.run({
      targets,
      options,
      selection,
      binDir,
      onProgress: (p) => { try { process.send({ kind: WORKER_MSG.PROGRESS, payload: p }); } catch {} },
      signal,
    });
    log.info(`worker: complete ${id}`, { ok: result && result.ok, processed: result && result.processed, skipped: result && result.skipped, errorCount: result && result.errors ? result.errors.length : 0 });
    try { process.send({ kind: WORKER_MSG.COMPLETE, payload: result }); reported = true; } catch (e) { log.error(`worker: send COMPLETE failed ${id}`, { message: e.message }); }
  } catch (err) {
    log.error(`worker: run() threw ${id}`, { message: err.message, stack: err.stack });
    try {
      process.send({ kind: WORKER_MSG.ERROR, payload: { message: err.message, stack: err.stack } });
      reported = true;
    } catch (e) { log.error(`worker: send ERROR failed ${id}`, { message: e.message }); }
  } finally {
    process.exit(reported ? 0 : 1);
  }
}

async function handlePreflight(msg) {
  const { workerPath, targets, selection, binDir } = msg;
  const log = getLogger();
  const id = pluginIdFromPath(workerPath);
  log.info(`worker: preflight ${id}`, { targets: targets && targets.length, binDir: !!binDir });
  let reported = false;
  try {
    const instance = loadPluginInstance(workerPath);
    if (typeof instance.preflight !== 'function') {
      throw new Error(`Plugin at ${workerPath} does not implement preflight()`);
    }
    const result = await instance.preflight({
      targets,
      selection,
      binDir,
      signal,
      onProgress: (p) => { try { process.send({ kind: WORKER_MSG.PROGRESS, payload: p }); } catch {} },
    });
    log.info(`worker: preflight-complete ${id}`, { resultKeys: result ? Object.keys(result) : null });
    try { process.send({ kind: WORKER_MSG.PREFLIGHT_COMPLETE, payload: result }); reported = true; } catch (e) { log.error(`worker: send PREFLIGHT_COMPLETE failed ${id}`, { message: e.message }); }
  } catch (err) {
    log.error(`worker: preflight() threw ${id}`, { message: err.message, stack: err.stack });
    try {
      process.send({ kind: WORKER_MSG.PREFLIGHT_ERROR, payload: { message: err.message, stack: err.stack } });
      reported = true;
    } catch (e) { log.error(`worker: send PREFLIGHT_ERROR failed ${id}`, { message: e.message }); }
  } finally {
    process.exit(reported ? 0 : 1);
  }
}

process.on('message', (msg) => {
  if (msg.type === 'cancel') { cancelState.aborted = true; return; }
  if (msg.type === 'start') return void handleStart(msg);
  if (msg.type === 'preflight') return void handlePreflight(msg);
});
