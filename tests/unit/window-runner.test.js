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

  describe('shared dialog contract', () => {
    // Answers each dialog state as soon as the runner shows it.
    function repliesTo(shell, replies) {
      const send = shell.win.webContents.send;
      shell.win.webContents.send = (channel, payload) => {
        send(channel, payload);
        const action = channel === 'shell:set-state' && replies[payload.state];
        if (action) setImmediate(() => shell.fireAction(action));
      };
    }
    const table = { columns: ['File', 'Problem'], rows: [{ cells: ['x', 'y'] }] };

    it('stops with the blocked body before the form and exits 2', async () => {
      class BlockedPlugin extends StubPlugin {
        buildBlockedBody() { return { message: 'Cannot start', detail: 'd', table }; }
      }
      const shell = makeShellMock();
      repliesTo(shell, { error: { action: 'ok' } });
      const code = await runWindowPlugin({
        manifest, plugin: new BlockedPlugin(), pluginDir: '/fake',
        targets: ['/a'], selection, binDir: '/bin',
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1 }),
        runWorker: () => { throw new Error('not called'); },
        readUiHtml: () => '',
        logger: { info() {}, error() {} },
      });
      expect(code).toBe(2);
      expect(shell.states.map((s) => s.state)).toEqual(['scanning', 'error']);
      expect(shell.states[1]).toEqual({ state: 'error', message: 'Cannot start', detail: 'd', table });
    });

    it('shows an error body object, hands over the run result and logs the failure', async () => {
      const seen = [];
      class TablePlugin extends StubPlugin {
        buildErrorBody(_ctx, errors, processed, total, result) {
          seen.push({ errors, processed, total, result });
          return { detail: 'put back', table };
        }
      }
      const result = { ok: false, processed: 0, errors: [{ file: 'x', message: 'EBUSY' }] };
      const logged = [];
      const shell = makeShellMock();
      repliesTo(shell, { form: { action: 'start', options: {} }, error: { action: 'ok' } });
      const code = await runWindowPlugin({
        manifest, plugin: new TablePlugin(), pluginDir: '/fake',
        targets: ['/a'], selection, binDir: '/bin',
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalItems: 4 }),
        runWorker: ({ onComplete }) => { setImmediate(() => onComplete(result)); return {}; },
        readUiHtml: () => '',
        logger: { info() {}, error: (msg, meta) => logged.push({ msg, meta }) },
      });
      expect(code).toBe(1);
      expect(seen).toEqual([{ errors: result.errors, processed: 0, total: 4, result }]);
      expect(shell.states.find((s) => s.state === 'error'))
        .toEqual({ state: 'error', message: 'Stub — completed with errors', detail: 'put back', table });
      expect(logged).toContainEqual({ msg: 'window-runner: run failed', meta: { plugin: 's', errors: result.errors, notRestored: [] } });
    });
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
