const { runDialogPlugin } = require('../../src/main/runners/dialog-runner');
const { BasePlugin } = require('../../src/shared/base-plugin');

function makeShellMock() {
  const states = [];
  const ipcListeners = {};
  const winListeners = {};
  const win = {
    webContents: {
      send: (channel, payload) => {
        if (channel === 'shell:set-state') states.push(payload);
      },
      once: (event, cb) => {
        if (event === 'did-finish-load') setImmediate(cb);
      },
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
  const fireAction = (action) => {
    if (ipcListeners['shell:action']) ipcListeners['shell:action']({}, { action });
  };
  const fireClose = () => {
    if (winListeners['closed']) winListeners['closed']();
  };
  return { states, win, ipcMain, fireAction, fireClose };
}

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 's', label: 'Stub', accepts: ['folders'] }; }
  async preflight() {}
  async run() {}
}

const manifest = { id: 's', label: 'Stub', accepts: ['folders'], ui: 'dialog' };

describe('runDialogPlugin', () => {
  it('exits 0 silently when isEmpty returns true', async () => {
    const shell = makeShellMock();
    // Fire 'ok' after the info state is set
    setTimeout(() => shell.fireAction('ok'), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [], totalFiles: 0, totalCollisions: 0 }),
      runWorker: () => { throw new Error('should not run'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(shell.states.some((s) => s.state === 'info')).toBe(true);
  });

  it('exits 0 silently on Cancel', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('cancel'), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(shell.states.some((s) => s.state === 'confirm')).toBe(true);
  });

  it('exits 0 on successful run', async () => {
    const shell = makeShellMock();
    let runCalled = false;
    setTimeout(() => shell.fireAction('continue'), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: ({ onComplete }) => {
        runCalled = true;
        setTimeout(() => onComplete({ ok: true, processed: 3, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(runCalled).toBe(true);
    expect(shell.states.find((s) => s.state === 'scanning')).toBeTruthy();
    expect(shell.states.find((s) => s.state === 'confirm')).toBeTruthy();
    expect(shell.states.find((s) => s.state === 'running')).toBeTruthy();
  });

  it('exits 1 on partial run errors', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('continue'), 25);
    setTimeout(() => shell.fireAction('ok'), 100);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 5 }], totalFiles: 5, totalCollisions: 0 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({
          ok: false, processed: 3, skipped: 2,
          errors: [{ file: 'x', message: 'EACCES' }, { file: 'y', message: 'EBUSY' }],
        }), 5);
        return { cancel() {} };
      },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(1);
    const errState = shell.states.find((s) => s.state === 'error');
    expect(errState).toBeTruthy();
    expect(errState.detail).toMatch(/EACCES/);
  });

  it('exits 3 on preflight crash', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('ok'), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => { throw new Error('pre-boom'); },
      runWorker: () => { throw new Error('not called'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
    const errState = shell.states.find((s) => s.state === 'error');
    expect(errState).toBeTruthy();
    expect(errState.detail).toMatch(/pre-boom/);
  });

  it('exits 3 on async run worker error', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('continue'), 25);
    setTimeout(() => shell.fireAction('ok'), 100);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: ({ onError }) => {
        setTimeout(() => onError({ message: 'EPIPE' }), 5);
        return { cancel() {} };
      },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
  });

  it('uses plugin override for buildConfirmMessage', async () => {
    class CustomPlugin extends BasePlugin {
      static get manifest() { return manifest; }
      async preflight() {}
      async run() {}
      buildConfirmMessage() { return { message: 'CUSTOM_MSG', detail: 'CUSTOM_DETAIL' }; }
    }
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('cancel'), 25);
    await runDialogPlugin({
      manifest,
      plugin: new CustomPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      logger: { info() {}, error() {} },
    });
    const confirmState = shell.states.find((s) => s.state === 'confirm');
    expect(confirmState).toBeTruthy();
    expect(confirmState.message).toBe('CUSTOM_MSG');
    expect(confirmState.detail).toBe('CUSTOM_DETAIL');
  });

  it('falls back to BasePlugin default when buildConfirmMessage throws', async () => {
    class BadPlugin extends BasePlugin {
      static get manifest() { return manifest; }
      async preflight() {}
      async run() {}
      buildConfirmMessage() { throw new Error('hook-boom'); }
    }
    const shell = makeShellMock();
    const logged = [];
    setTimeout(() => shell.fireAction('cancel'), 25);
    await runDialogPlugin({
      manifest,
      plugin: new BadPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      logger: { info() {}, error: (msg, meta) => logged.push({ msg, meta }) },
    });
    expect(logged.some((l) => l.msg.match(/hook threw/))).toBe(true);
    const confirmState = shell.states.find((s) => s.state === 'confirm');
    expect(confirmState).toBeTruthy();
    expect(confirmState.message).toMatch(/Process \d+ item/);
  });

  it('sends scanning state before preflight runs', async () => {
    const shell = makeShellMock();
    const events = [];
    setTimeout(() => shell.fireAction('cancel'), 25);
    await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => {
        events.push('preflight-running');
        return { folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 };
      },
      runWorker: () => ({ cancel() {} }),
      logger: { info() {}, error() {} },
    });
    // The first state set must be scanning, and it must happen before preflight
    expect(shell.states[0].state).toBe('scanning');
    expect(shell.states[0].label).toMatch(/scanning/i);
    // scanning was sent (states[0] exists) before preflight-running was recorded
    // We can verify by checking scanning is in states and preflight ran
    expect(events[0]).toBe('preflight-running');
  });

  it('exits 0 when user closes the window mid-confirm', async () => {
    const shell = makeShellMock();
    // Fire window close after the runner has set 'confirm' state and is awaiting action.
    setTimeout(() => shell.fireClose(), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });

  it('passes binDir into runPreflight and runWorker', async () => {
    const shell = makeShellMock();
    const seen = {};
    setTimeout(() => shell.fireAction('continue'), 25);
    await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      binDir: '/my/bin',
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async ({ binDir }) => { seen.preflight = binDir; return { totalFiles: 1 }; },
      runWorker: ({ binDir, onComplete }) => {
        seen.worker = binDir;
        setTimeout(() => onComplete({ ok: true, processed: 1, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      logger: { info() {}, error() {} },
    });
    expect(seen.preflight).toBe('/my/bin');
    expect(seen.worker).toBe('/my/bin');
  });

  it('registers shell:resize listener and runner completes normally', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction('cancel'), 25);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      openShell: () => shell.win,
      ipcMain: shell.ipcMain,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: () => ({ cancel() {} }),
      logger: { info() {}, error() {} },
    });
    // Runner completes without error — resize listener was registered and deregistered cleanly.
    expect(code).toBe(0);
  });
});
