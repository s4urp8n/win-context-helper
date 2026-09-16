const path = require('node:path');
const { fork } = require('node:child_process');
const { WORKER_MSG } = require('../shared/plugin-api');

const SHIM = path.join(__dirname, '..', 'worker', 'worker-shim.js');

function runWorker({ workerPath, targets, options, selection, binDir, onProgress, onComplete, onError }) {
  const child = fork(SHIM, [], { silent: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  child.on('message', (msg) => {
    if (msg.kind === WORKER_MSG.PROGRESS) onProgress?.(msg.payload);
    else if (msg.kind === WORKER_MSG.COMPLETE) onComplete?.(msg.payload);
    else if (msg.kind === WORKER_MSG.ERROR) onError?.(msg.payload);
  });

  child.on('exit', (code) => {
    if (code !== 0) onError?.({ message: `Worker exited with code ${code}` });
  });
  // The process may fail to start at all (missing executable, blocked by antivirus).
  child.on('error', (err) => onError?.({ message: err.message }));

  child.send({ type: 'start', workerPath, targets, options, selection, binDir });

  return {
    cancel() {
      child.send({ type: 'cancel' });
    },
  };
}

function runPreflight({ workerPath, targets, selection, binDir, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = fork(SHIM, [], { silent: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    child.on('message', (msg) => {
      if (msg.kind === WORKER_MSG.PROGRESS) {
        if (onProgress) try { onProgress(msg.payload); } catch {}
      } else if (msg.kind === WORKER_MSG.PREFLIGHT_COMPLETE) settle(resolve, msg.payload);
      else if (msg.kind === WORKER_MSG.PREFLIGHT_ERROR) {
        settle(reject, new Error(msg.payload?.message || 'preflight failed'));
      }
    });
    child.on('exit', (code) => {
      if (!settled && code !== 0) settle(reject, new Error(`Preflight worker exited with code ${code}`));
      else if (!settled) settle(reject, new Error('Preflight worker exited without result'));
    });
    child.on('error', (err) => settle(reject, err));

    child.send({ type: 'preflight', workerPath, targets, selection, binDir });
  });
}

module.exports = { runWorker, runPreflight };
