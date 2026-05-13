const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const SHIM = path.resolve(__dirname, '..', '..', 'src', 'worker', 'worker-shim.js');
const BASE_PLUGIN_PATH = path.resolve(__dirname, '..', '..', 'src', 'shared', 'base-plugin');

function runShim(message) {
  return new Promise((resolve, reject) => {
    const child = fork(SHIM, [], { silent: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages = [];
    child.on('message', (m) => messages.push(m));
    child.on('exit', (code) => resolve({ code, messages }));
    child.on('error', reject);
    child.send(message);
  });
}

function writeClassPlugin(dir, body) {
  const src = `
const { BasePlugin } = require(${JSON.stringify(BASE_PLUGIN_PATH)});
class P extends BasePlugin {
  static get manifest() { return { id: 'p', label: 'P', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'dialog' }; }
  ${body}
}
module.exports = P;
`;
  const p = path.join(dir, 'plugin.js');
  fs.writeFileSync(p, src);
  return p;
}

describe('worker-shim', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shim-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('routes start to instance.run() of a class plugin', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { return {}; }
      async run({ targets }) { return { ok: true, processed: targets.length, skipped: 0, errors: [] }; }
    `);
    const { code, messages } = await runShim({ type: 'start', workerPath, targets: ['a', 'b'], options: {} });
    expect(code).toBe(0);
    const complete = messages.find((m) => m.kind === 'worker:complete');
    expect(complete?.payload).toMatchObject({ ok: true, processed: 2 });
  });

  it('routes preflight to instance.preflight()', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight({ targets }) { return { folders: [{ basename: 'x', fileCount: 1, collisionCount: 0 }], totalFiles: 1, totalCollisions: 0 }; }
      async run() { throw new Error('should not run'); }
    `);
    const { code, messages } = await runShim({ type: 'preflight', workerPath, targets: ['x'] });
    expect(code).toBe(0);
    const result = messages.find((m) => m.kind === 'worker:preflight-complete');
    expect(result?.payload?.totalFiles).toBe(1);
  });

  it('reports ERROR when plugin export is not a class', async () => {
    const p = path.join(tmp, 'plugin.js');
    fs.writeFileSync(p, 'module.exports = { foo: 1 };');
    const { messages } = await runShim({ type: 'start', workerPath: p, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toMatch(/does not export a class/);
  });

  it('reports ERROR when run() throws', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { return {}; }
      async run() { throw new Error('run-boom'); }
    `);
    const { messages } = await runShim({ type: 'start', workerPath, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toBe('run-boom');
  });

  it('reports PREFLIGHT_ERROR when preflight() throws', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { throw new Error('pre-boom'); }
      async run() {}
    `);
    const { messages } = await runShim({ type: 'preflight', workerPath, targets: [] });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toBe('pre-boom');
  });

  it('reports PREFLIGHT_ERROR when plugin does not implement preflight', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async run() {}
    `);
    const { messages } = await runShim({ type: 'preflight', workerPath, targets: [] });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toMatch(/implement preflight/i);
  });

  it('reports ERROR when require fails (syntax error)', async () => {
    const p = path.join(tmp, 'plugin.js');
    fs.writeFileSync(p, 'syntax error;');
    const { messages } = await runShim({ type: 'start', workerPath: p, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toBeTruthy();
  });
});
