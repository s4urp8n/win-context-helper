function runWorkerPromise(runWorker, { workerPath, targets, options, selection, binDir, onProgress }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      runWorker({
        workerPath,
        targets,
        options: options || {},
        selection,
        binDir,
        onProgress: onProgress || (() => {}),
        onComplete: (r) => settle({ kind: 'complete', result: r }),
        onError: (e) => settle({ kind: 'error', error: e }),
      });
    } catch (err) {
      settle({ kind: 'error', error: { message: err.message } });
    }
  });
}

function runPreflightPromise(runPreflight, { workerPath, targets, selection, binDir, onProgress }) {
  return runPreflight({ workerPath, targets, selection, binDir, onProgress });
}

module.exports = { runWorkerPromise, runPreflightPromise };
