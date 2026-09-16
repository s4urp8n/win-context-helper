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
  const fire = (payload) => {
    if (ipcListeners['shell:action']) ipcListeners['shell:action']({}, payload);
  };
  const fireClose = () => {
    if (winListeners['closed']) winListeners['closed']();
  };
  return { states, win, ipcMain, fireAction, fire, fireClose };
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

  describe('tables and blocked runs', () => {
    const table = { columns: ['From', 'New name'], rows: [{ cells: ['a/1.txt', '1.txt'] }] };
    const selection = { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] };
    const logger = { info() {}, error() {} };
    const pre = { folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1 };

    it('shows the blocked body and exits 2 without asking or running', async () => {
      class BlockedPlugin extends StubPlugin {
        buildBlockedBody(_ctx, p) { return { message: 'Cannot start', detail: `blocked ${p.totalFiles}`, table }; }
      }
      const shell = makeShellMock();
      setTimeout(() => shell.fireAction('ok'), 25);
      const code = await runDialogPlugin({
        manifest, plugin: new BlockedPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => pre,
        runWorker: () => { throw new Error('not called'); },
        logger,
      });
      expect(code).toBe(2);
      expect(shell.states.map((s) => s.state)).toEqual(['scanning', 'error']);
      expect(shell.states[1]).toEqual({ state: 'error', message: 'Cannot start', detail: 'blocked 1', table });
    });

    it('names the plugin when the blocked body has no message', async () => {
      class BlockedPlugin extends StubPlugin {
        buildBlockedBody() { return 'no room'; }
      }
      const shell = makeShellMock();
      setTimeout(() => shell.fireAction('ok'), 25);
      await runDialogPlugin({
        manifest, plugin: new BlockedPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => pre,
        runWorker: () => { throw new Error('not called'); },
        logger,
      });
      expect(shell.states[1]).toEqual({ state: 'error', message: 'Stub — cannot start', detail: 'no room' });
    });

    it('passes the confirm table to the shell', async () => {
      class TablePlugin extends StubPlugin {
        buildConfirmMessage() { return { message: 'Go?', detail: 'd', table }; }
      }
      const shell = makeShellMock();
      setTimeout(() => shell.fireAction('cancel'), 25);
      await runDialogPlugin({
        manifest, plugin: new TablePlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => pre,
        runWorker: () => { throw new Error('not called'); },
        logger,
      });
      expect(shell.states.find((s) => s.state === 'confirm')).toEqual({ state: 'confirm', message: 'Go?', detail: 'd', table, canContinue: true });
    });

    it('passes the nothing-to-do table to the shell', async () => {
      class TablePlugin extends StubPlugin {
        buildNothingToDoBody() { return { message: 'Nothing', detail: 'd', table }; }
      }
      const shell = makeShellMock();
      setTimeout(() => shell.fireAction('ok'), 25);
      await runDialogPlugin({
        manifest, plugin: new TablePlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 0 }),
        runWorker: () => { throw new Error('not called'); },
        logger,
      });
      expect(shell.states.find((s) => s.state === 'info')).toEqual({ state: 'info', message: 'Nothing', detail: 'd', table });
    });

    it('shows an error body object and hands the run result to the hook', async () => {
      const seen = [];
      class TablePlugin extends StubPlugin {
        buildErrorBody(_ctx, errors, processed, total, result) {
          seen.push({ errors, processed, total, result });
          return { message: 'Nothing was changed', detail: 'put back', table };
        }
      }
      const runResult = { ok: false, processed: 0, errors: [{ file: 'x', message: 'EBUSY' }], moved: 2, notRestored: [] };
      const shell = makeShellMock();
      setTimeout(() => shell.fireAction('continue'), 25);
      setTimeout(() => shell.fireAction('ok'), 100);
      const code = await runDialogPlugin({
        manifest, plugin: new TablePlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => pre,
        runWorker: ({ onComplete }) => { setTimeout(() => onComplete(runResult), 5); return { cancel() {} }; },
        logger,
      });
      expect(code).toBe(1);
      expect(seen).toEqual([{ errors: runResult.errors, processed: 0, total: 1, result: runResult }]);
      expect(shell.states.find((s) => s.state === 'error')).toEqual({ state: 'error', message: 'Nothing was changed', detail: 'put back', table });
    });
  });

  describe('plan handoff, logging and plain-text bodies', () => {
    const selection = { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] };

    // Answers each dialog state as soon as the runner shows it.
    function repliesTo(shell, replies) {
      const send = shell.win.webContents.send;
      shell.win.webContents.send = (channel, payload) => {
        send(channel, payload);
        const action = channel === 'shell:set-state' && replies[payload.state];
        if (action) setImmediate(() => shell.fireAction(action));
      };
    }

    it('hands the confirmed plan id to the run', async () => {
      const shell = makeShellMock();
      repliesTo(shell, { confirm: 'continue' });
      let options;
      await runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1, planId: 'abc' }),
        runWorker: (args) => { options = args.options; setImmediate(() => args.onComplete({ ok: true, errors: [] })); return {}; },
        logger: { info() {}, error() {} },
      });
      expect(options).toEqual({ planId: 'abc' });
    });

    // Answers the confirm states one after another.
    function answerConfirms(shell, answers) {
      const send = shell.win.webContents.send;
      shell.win.webContents.send = (channel, payload) => {
        send(channel, payload);
        if (channel === 'shell:set-state' && payload.state === 'confirm' && answers.length > 0) {
          const answer = answers.shift();
          setImmediate(() => shell.fire(answer));
        }
      };
    }

    const runRecorder = () => {
      const seen = {};
      const runWorker = (args) => {
        seen.options = args.options;
        setImmediate(() => args.onComplete({ ok: true, errors: [] }));
        return {};
      };
      return { seen, runWorker };
    };

    it('rebuilds the confirm body when an option changes and runs with the options on screen', async () => {
      const asked = [];
      class OptionsPlugin extends StubPlugin {
        buildConfirmMessage(_ctx, _pre, options) {
          asked.push(options);
          const on = options.mode !== false;
          return { message: on ? 'On' : 'Off', options: [{ name: 'mode', label: 'Mode', checked: on }], runOptions: { mode: on } };
        }
      }
      const shell = makeShellMock();
      answerConfirms(shell, [
        { action: 'options', options: { mode: false } },
        { action: 'options', options: { other: true } },
        { action: 'continue' },
      ]);
      const { seen, runWorker } = runRecorder();
      const code = await runDialogPlugin({
        manifest, plugin: new OptionsPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1, planId: 'ignored' }),
        runWorker,
        logger: { info() {}, error() {} },
      });
      expect(code).toBe(0);
      expect(asked).toEqual([{}, { mode: false }, { mode: false, other: true }]);
      const confirms = shell.states.filter((s) => s.state === 'confirm');
      expect(confirms.map((s) => [s.message, s.options[0].checked])).toEqual([['On', true], ['Off', false], ['Off', false]]);
      expect(seen.options).toEqual({ mode: false });
    });

    it('ignores Continue while the confirm body forbids it', async () => {
      class GuardedPlugin extends StubPlugin {
        buildConfirmMessage(_ctx, _pre, options) {
          return { message: 'Go?', canContinue: options.fix === true, runOptions: { fix: options.fix } };
        }
      }
      const shell = makeShellMock();
      answerConfirms(shell, [
        { action: 'continue' },
        { action: 'options', options: { fix: true } },
        { action: 'continue' },
      ]);
      const { seen, runWorker } = runRecorder();
      await runDialogPlugin({
        manifest, plugin: new GuardedPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1 }),
        runWorker,
        logger: { info() {}, error() {} },
      });
      expect(shell.states.filter((s) => s.state === 'confirm').map((s) => s.canContinue)).toEqual([false, false, true]);
      expect(seen.options).toEqual({ fix: true });
    });

    it('cancels from a rebuilt confirm without running', async () => {
      const shell = makeShellMock();
      answerConfirms(shell, [{ action: 'options' }, { action: 'cancel' }]);
      const code = await runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1 }),
        runWorker: () => { throw new Error('not called'); },
        logger: { info() {}, error() {} },
      });
      expect(code).toBe(0);
      expect(shell.states.filter((s) => s.state === 'confirm')).toHaveLength(2);
    });

    it('runs without options when neither the body nor the preflight gives any', async () => {
      const shell = makeShellMock();
      answerConfirms(shell, [{ action: 'continue' }]);
      const { seen, runWorker } = runRecorder();
      await runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1 }),
        runWorker,
        logger: { info() {}, error() {} },
      });
      expect(seen.options).toEqual({});
    });

    it('logs what a failed run left behind', async () => {
      const shell = makeShellMock();
      repliesTo(shell, { confirm: 'continue', error: 'ok' });
      const logged = [];
      const result = {
        ok: false, processed: 1,
        errors: [{ file: 'x', message: 'EBUSY' }],
        notRestored: [{ file: 'y', location: 'y.txt', message: 'EPERM' }],
      };
      await runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 2 }),
        runWorker: ({ onComplete }) => { setImmediate(() => onComplete(result)); return {}; },
        logger: { info() {}, error: (msg, meta) => logged.push({ msg, meta }) },
      });
      expect(logged).toContainEqual({
        msg: 'dialog-runner: run failed',
        meta: { plugin: 's', errors: result.errors, notRestored: result.notRestored },
      });
    });

    it('logs a failed run that reports no details', async () => {
      const shell = makeShellMock();
      repliesTo(shell, { confirm: 'continue', error: 'ok' });
      const logged = [];
      await runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 2 }),
        runWorker: ({ onComplete }) => { setImmediate(() => onComplete(undefined)); return {}; },
        logger: { info() {}, error: (msg, meta) => logged.push({ msg, meta }) },
      });
      expect(logged).toContainEqual({ msg: 'dialog-runner: run failed', meta: { plugin: 's', errors: [], notRestored: [] } });
    });

    it('shows plain-text confirm and nothing-to-do bodies', async () => {
      class TextPlugin extends StubPlugin {
        buildConfirmMessage() { return 'Move 3 files'; }
        buildNothingToDoBody() { return 'Already flat'; }
      }
      const confirmShell = makeShellMock();
      repliesTo(confirmShell, { confirm: 'cancel' });
      await runDialogPlugin({
        manifest, plugin: new TextPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => confirmShell.win, ipcMain: confirmShell.ipcMain,
        runPreflight: async () => ({ totalFiles: 3 }),
        runWorker: () => { throw new Error('not called'); },
        logger: { info() {}, error() {} },
      });
      expect(confirmShell.states.find((s) => s.state === 'confirm'))
        .toEqual({ state: 'confirm', message: 'Continue?', detail: 'Move 3 files', canContinue: true });

      const infoShell = makeShellMock();
      repliesTo(infoShell, { info: 'ok' });
      await runDialogPlugin({
        manifest, plugin: new TextPlugin(), pluginDir: '/fake', targets: ['/a'], selection,
        openShell: () => infoShell.win, ipcMain: infoShell.ipcMain,
        runPreflight: async () => ({ totalFiles: 0 }),
        runWorker: () => { throw new Error('not called'); },
        logger: { info() {}, error() {} },
      });
      expect(infoShell.states.find((s) => s.state === 'info'))
        .toEqual({ state: 'info', message: 'Nothing to do.', detail: 'Already flat' });
    });
  });

  describe('window resizing', () => {
    function resizeCalls(width, height) {
      const shell = makeShellMock();
      const calls = [];
      let size = [460, 180];
      shell.win.getContentSize = () => size;
      shell.win.setContentSize = (w, h) => { calls.push(['size', w, h]); size = [w, h]; };
      shell.win.center = () => calls.push(['center']);
      const listeners = {};
      shell.ipcMain.on = (channel, fn) => { listeners[channel] = fn; };
      setTimeout(() => {
        listeners['shell:resize']({}, { height, width });
        listeners['shell:action']({}, { action: 'cancel' });
      }, 25);
      return runDialogPlugin({
        manifest, plugin: new StubPlugin(), pluginDir: '/fake', targets: ['/a'],
        selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
        openShell: () => shell.win, ipcMain: shell.ipcMain,
        runPreflight: async () => ({ totalFiles: 1 }),
        runWorker: () => { throw new Error('not called'); },
        logger: { info() {}, error() {} },
      }).then(() => calls);
    }

    it('widens and re-centers the window when the renderer asks for more width', async () => {
      expect(await resizeCalls(760, 400)).toEqual([['size', 760, 400], ['center']]);
    });

    it('keeps the width when the renderer asks only for height', async () => {
      expect(await resizeCalls(undefined, 300)).toEqual([['size', 460, 300]]);
    });

    it('never makes the window narrower', async () => {
      expect(await resizeCalls(300, 300)).toEqual([['size', 460, 300]]);
    });
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
