const { runWorkerPromise, runPreflightPromise } = require('../../src/main/runners/base-runner');

describe('runWorkerPromise', () => {
  it('resolves with onComplete payload', async () => {
    const mockRunWorker = ({ onComplete }) => {
      setTimeout(() => onComplete({ ok: true, processed: 3 }), 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result).toEqual({ kind: 'complete', result: { ok: true, processed: 3 } });
  });

  it('resolves with onError payload', async () => {
    const mockRunWorker = ({ onError }) => {
      setTimeout(() => onError({ message: 'boom' }), 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result).toEqual({ kind: 'error', error: { message: 'boom' } });
  });

  it('resolves with error when runWorker throws synchronously', async () => {
    const mockRunWorker = () => { throw new Error('sync-fail'); };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result.kind).toBe('error');
    expect(result.error.message).toBe('sync-fail');
  });

  it('settles only once when both onComplete and onError fire', async () => {
    const mockRunWorker = ({ onComplete, onError }) => {
      setTimeout(() => { onComplete({ ok: true }); onError({ message: 'late' }); }, 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result.kind).toBe('complete');
  });
});

describe('runPreflightPromise', () => {
  it('passes through to injected runPreflight', async () => {
    const mockRunPreflight = async ({ workerPath, targets }) => ({ folders: [], totalFiles: 0, totalCollisions: 0, _wp: workerPath, _t: targets });
    const out = await runPreflightPromise(mockRunPreflight, { workerPath: 'x', targets: ['a'], selection: {} });
    expect(out._wp).toBe('x');
    expect(out._t).toEqual(['a']);
  });
});
