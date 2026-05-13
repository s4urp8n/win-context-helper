const { runWindowPlugin } = require('../../src/main/runners/window-runner');
const { BasePlugin } = require('../../src/shared/base-plugin');

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 's', label: 'Stub', accepts: ['folders'] }; }
  async preflight() { return { totalFiles: 1 }; }
  async run() {}
}

function makeShellMock() {
  const states = [];
  const ipcListeners = {};
  const winListeners = {};
  const win = {
    webContents: {
      send: (channel, payload) => { if (channel === 'shell:set-state') states.push(payload); },
      once: (event, cb) => { if (event === 'did-finish-load') setImmediate(cb); },
    },
    on: (event, fn) => { winListeners[event] = fn; },
    destroy: () => {},
    minimize: () => {},
    getContentSize: () => [460, 180],
    setContentSize: () => {},
  };
  const ipcMain = {
    on: (channel, fn) => { ipcListeners[channel] = fn; },
    removeListener: (channel) => { delete ipcListeners[channel]; },
  };
  const fireAction = (payload) => {
    if (ipcListeners['shell:action']) ipcListeners['shell:action']({}, payload);
  };
  const fireClose = () => { if (winListeners['closed']) winListeners['closed'](); };
  return { states, win, ipcMain, fireAction, fireClose };
}

const manifest = { id: 's', label: 'Stub', accepts: ['folders'], ui: 'window' };
const selection = { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] };

describe('runWindowPlugin', () => {
  it('opens shell, runs preflight, sends form state, returns 0 on cancel', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'cancel' }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 3 }),
      runWorker: () => { throw new Error('should not run'); },
      readUiHtml: () => '<input name="x" />',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(shell.states.find((s) => s.state === 'form')).toBeTruthy();
    expect(shell.states.find((s) => s.state === 'form').uiHtml).toBe('<input name="x" />');
  });

  it('runs worker with options from start payload, exits 0 on success', async () => {
    const shell = makeShellMock();
    let workerCalled = null;
    setTimeout(() => shell.fireAction({ action: 'start', options: { fmt: 'png', q: 90 } }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 3 }),
      runWorker: ({ options, onComplete }) => {
        workerCalled = options;
        setTimeout(() => onComplete({ ok: true, processed: 3, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(workerCalled).toEqual({ fmt: 'png', q: 90 });
  });

  it('exits 1 on partial run errors after start', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'start', options: {} }), 25);
    setTimeout(() => shell.fireAction({ action: 'ok' }), 100);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 5 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: false, processed: 3, skipped: 2, errors: [{ file: 'x', message: 'EACCES' }] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(1);
  });

  it('exits 3 on preflight crash', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'ok' }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => { throw new Error('pre-boom'); },
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
    expect(shell.states.find((s) => s.state === 'error')).toBeTruthy();
  });

  it('passes binDir to runPreflight and runWorker', async () => {
    const shell = makeShellMock();
    const seen = {};
    setTimeout(() => shell.fireAction({ action: 'start', options: {} }), 25);
    await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/my/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async ({ binDir }) => { seen.preflight = binDir; return { totalFiles: 1 }; },
      runWorker: ({ binDir, onComplete }) => {
        seen.worker = binDir;
        setTimeout(() => onComplete({ ok: true, processed: 1, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(seen.preflight).toBe('/my/bin');
    expect(seen.worker).toBe('/my/bin');
  });

  it('exits 0 when window closes mid-form', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireClose(), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });
});
