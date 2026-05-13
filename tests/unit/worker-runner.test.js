const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWorker } = require('../../src/main/worker-runner');

const BASE_PLUGIN_PATH = path.resolve(__dirname, '..', '..', 'src', 'shared', 'base-plugin');

function writeClassPlugin(dir, name, body) {
  const src = `
const { BasePlugin } = require(${JSON.stringify(BASE_PLUGIN_PATH)});
class ${name} extends BasePlugin {
  static get manifest() { return { id: 'stub', label: 'Stub', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'dialog' }; }
  ${body}
}
module.exports = ${name};
`;
  const p = path.join(dir, 'stub.js');
  fs.writeFileSync(p, src);
  return p;
}

describe('runWorker', () => {
  it('runs a stub worker end-to-end via fork', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-worker-runner-'));
    const stubPath = writeClassPlugin(tmp, 'StubPlugin', `
      async preflight() { return {}; }
      async run({ targets, onProgress }) {
        onProgress({ processed: 1, total: 2 });
        onProgress({ processed: 2, total: 2 });
        return { ok: true, processed: 2, skipped: 0, errors: [] };
      }
    `);

    const progresses = [];
    const completion = await new Promise((resolve, reject) => {
      runWorker({
        workerPath: stubPath,
        targets: ['x'],
        options: {},
        onProgress: (p) => progresses.push(p),
        onComplete: resolve,
        onError: reject,
      });
    });
    expect(progresses).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
    expect(completion).toEqual({ ok: true, processed: 2, skipped: 0, errors: [] });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('relays a worker-thrown error via onError', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-worker-runner-err-'));
    const stubPath = writeClassPlugin(tmp, 'BoomPlugin', `
      async preflight() { return {}; }
      async run() { throw new Error('boom'); }
    `);
    const errorPayload = await new Promise((resolve, reject) => {
      runWorker({
        workerPath: stubPath,
        targets: ['x'],
        options: {},
        onProgress: () => {},
        onComplete: () => reject(new Error('should not complete')),
        onError: resolve,
      });
    });
    expect(errorPayload.message).toBe('boom');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('cancel() flips signal.aborted in the worker', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-worker-runner-cancel-'));
    const stubPath = writeClassPlugin(tmp, 'CancelPlugin', `
      async preflight() { return {}; }
      async run({ onProgress, signal }) {
        let i = 0;
        while (i < 100 && !signal.aborted) {
          onProgress({ processed: i, total: 100 });
          await new Promise((r) => setTimeout(r, 10));
          i++;
        }
        return { ok: !signal.aborted, processed: i, skipped: 0, errors: [] };
      }
    `);
    const result = await new Promise((resolve, reject) => {
      const handle = runWorker({
        workerPath: stubPath,
        targets: ['x'],
        options: {},
        onProgress: (p) => {
          if (p.processed === 3) handle.cancel();
        },
        onComplete: resolve,
        onError: reject,
      });
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBeLessThan(100);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runPreflight resolves with plugin.preflight result', async () => {
    const { runPreflight } = require('../../src/main/worker-runner');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-preflight-'));
    const stubPath = writeClassPlugin(tmp, 'PreflightPlugin', `
      async preflight({ targets }) {
        return { folders: targets.map(t => ({ basename: t, fileCount: 1, collisionCount: 0 })), totalFiles: targets.length, totalCollisions: 0 };
      }
      async run() { throw new Error('should not run'); }
    `);
    const result = await runPreflight({ workerPath: stubPath, targets: ['a', 'b'] });
    expect(result.totalFiles).toBe(2);
    expect(result.folders).toHaveLength(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runPreflight rejects when preflight throws', async () => {
    const { runPreflight } = require('../../src/main/worker-runner');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-preflight-err-'));
    const stubPath = writeClassPlugin(tmp, 'BadPreflightPlugin', `
      async preflight() { throw new Error('nope'); }
      async run() {}
    `);
    await expect(runPreflight({ workerPath: stubPath, targets: ['a'] })).rejects.toThrow('nope');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
