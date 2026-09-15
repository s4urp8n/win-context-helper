const { dispatch } = require('../../src/main/dispatcher');

function makeDeps(overrides = {}) {
  return {
    parseCli: () => ({ kind: 'run', action: 'p', targets: ['/a'] }),
    loadAll:  () => new Map([['p', { Cls: class { async run() {} }, manifest: { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 }, dir: '/fake' }]]),
    aggregateTargets: async ({ myTarget }) => ({ role: 'leader', targets: [myTarget] }),
    classify: () => ({ folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] }),
    validate: () => ({ ok: true, effectiveTargets: ['/a'], skipped: [] }),
    createRunner: () => ({ execute: async () => 0 }),
    dialog: { showErrorBox: () => {} },
    fs: {},
    logger: { info() {}, error() {} },
    ...overrides,
  };
}

describe('dispatch', () => {
  it('happy path returns runner exit code', async () => {
    const code = await dispatch({ argv: [] }, makeDeps());
    expect(code).toBe(0);
  });

  it('returns 0 silently when cli.kind === none', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({ parseCli: () => ({ kind: 'none' }) }));
    expect(code).toBe(0);
  });

  it('returns 4 with error dialog on unknown action', async () => {
    const dlg = { calls: [], showErrorBox: function (t, b) { this.calls.push({ t, b }); } };
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => new Map(),
      dialog: dlg,
    }));
    expect(code).toBe(4);
    expect(dlg.calls[0].b).toMatch(/Unknown action/);
  });

  it('returns 4 when loadAll throws', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => { throw new Error('boom'); },
    }));
    expect(code).toBe(4);
  });

  it('returns 4 when instantiation throws', async () => {
    class Bad { constructor() { throw new Error('ctor-boom'); } async run() {} }
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => new Map([['p', { Cls: Bad, manifest: { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 }, dir: '/fake' }]]),
    }));
    expect(code).toBe(4);
  });

  it('returns 2 when validate fails (missing)', async () => {
    const dlg = { calls: [], showErrorBox: function (t, b) { this.calls.push({ t, b }); } };
    const code = await dispatch({ argv: [] }, makeDeps({
      classify: () => ({ folders: [], files: [], missing: ['/gone'], exts: [], basenames: ['gone'] }),
      validate: () => ({ ok: false, reason: 'MISSING', body: 'gone' }),
      dialog: dlg,
    }));
    expect(code).toBe(2);
    expect(dlg.calls[0].b).toBe('gone');
  });

  it('returns 3 when runner.execute throws', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({
      createRunner: () => ({ execute: async () => { throw new Error('runner-boom'); } }),
    }));
    expect(code).toBe(3);
  });

  it('uses aggregator when targets.length === 1', async () => {
    const seen = [];
    await dispatch({ argv: [] }, makeDeps({
      aggregateTargets: async ({ myTarget }) => { seen.push(myTarget); return { role: 'leader', targets: [myTarget, '/extra'] }; },
      validate: () => ({ ok: true, effectiveTargets: ['/a', '/extra'], skipped: [] }),
      createRunner: () => ({ execute: async ({ targets }) => { seen.push(targets.length); return 0; } }),
    }));
    expect(seen[0]).toBe('/a');
    expect(seen[1]).toBe(2);
  });

  it('skips aggregator when targets.length > 1', async () => {
    let called = false;
    await dispatch({ argv: [] }, makeDeps({
      parseCli: () => ({ kind: 'run', action: 'p', targets: ['/a', '/b'] }),
      aggregateTargets: async () => { called = true; return { role: 'leader', targets: [] }; },
      validate: () => ({ ok: true, effectiveTargets: ['/a', '/b'], skipped: [] }),
    }));
    expect(called).toBe(false);
  });

  it('passes binDir into runner.execute ctx', async () => {
    let seenBinDir = null;
    await dispatch({ argv: [] }, makeDeps({
      createRunner: () => ({ execute: async (ctx) => { seenBinDir = ctx.binDir; return 0; } }),
    }));
    expect(typeof seenBinDir).toBe('string');
  });
});

describe('dispatch and the Explorer menu', () => {
  const inSync = { ok: true, changes: [], lines: [], remaining: [], remainingLines: [], error: null, exportErrors: [] };
  const failed = { ok: false, changes: [], lines: [], remaining: [{}], remainingLines: ['x'], error: 'denied', exportErrors: [] };
  const P_MANIFEST = { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 };
  const recordingLogger = () => ({ infos: [], errors: [], info(m) { this.infos.push(m); }, error(m) { this.errors.push(m); } });

  describe('menu click', () => {
    it('syncs the menu with the loaded plugin manifests in the packaged app', async () => {
      const calls = [];
      const code = await dispatch({ argv: [] }, makeDeps({ isPackaged: true, syncShellMenu: async (arg) => { calls.push(arg); return inSync; } }));
      expect(code).toBe(0);
      expect(calls).toEqual([{ manifests: [P_MANIFEST] }]);
    });

    it('leaves the menu alone in a dev run', async () => {
      let called = false;
      await dispatch({ argv: [] }, makeDeps({ isPackaged: false, syncShellMenu: async () => { called = true; return inSync; } }));
      expect(called).toBe(false);
    });

    it('does not sync from an aggregator follower', async () => {
      let called = false;
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        aggregateTargets: async () => ({ role: 'follower', targets: [] }),
        syncShellMenu: async () => { called = true; return inSync; },
      }));
      expect(code).toBe(0);
      expect(called).toBe(false);
    });

    it('keeps the plugin exit code when the sync throws, and logs it', async () => {
      const logger = recordingLogger();
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        logger,
        createRunner: () => ({ execute: async () => 1 }),
        syncShellMenu: async () => { throw new Error('reg.exe missing'); },
      }));
      expect(code).toBe(1);
      expect(logger.errors).toContain('shell-menu: failed');
    });

    it('logs in-sync, repaired and failed results', async () => {
      for (const [result, bucket, message] of [
        [inSync, 'infos', 'shell-menu: in sync'],
        [{ ...inSync, changes: [{}], lines: ['Added menu item "P"'] }, 'infos', 'shell-menu: repaired'],
        [failed, 'errors', 'shell-menu: failed'],
      ]) {
        const logger = recordingLogger();
        await dispatch({ argv: [] }, makeDeps({ isPackaged: true, logger, syncShellMenu: async () => result }));
        expect(logger[bucket]).toContain(message);
      }
    });

    it('waits for a running sync before returning', async () => {
      const order = [];
      await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        createRunner: () => ({ execute: async () => { order.push('plugin'); return 0; } }),
        syncShellMenu: () => new Promise((resolve) => setTimeout(() => { order.push('sync'); resolve(inSync); }, 30)),
      }));
      order.push('returned');
      expect(order).toEqual(['plugin', 'sync', 'returned']);
    });

    it('stops waiting for a hung sync after the timeout', async () => {
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        menuSyncTimeoutMs: 20,
        syncShellMenu: () => new Promise(() => {}),
      }));
      expect(code).toBe(0);
    });
  });

  describe('no arguments (Start menu)', () => {
    const none = { parseCli: () => ({ kind: 'none' }) };

    it('shows the menu status and returns 0 when the menu is fine', async () => {
      const shown = [];
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none,
        isPackaged: true,
        syncShellMenu: async () => inSync,
        showMenuStatus: async (result, info) => { shown.push({ result, info }); },
      }));
      expect(code).toBe(0);
      expect(shown).toEqual([{ result: inSync, info: { itemCount: 1 } }]);
    });

    it('returns 5 when the menu cannot be registered', async () => {
      let shownResult = null;
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none,
        isPackaged: true,
        syncShellMenu: async () => failed,
        showMenuStatus: async (result) => { shownResult = result; },
      }));
      expect(code).toBe(5);
      expect(shownResult).toBe(failed);
    });

    it('reports a plugin load failure as a failed registration', async () => {
      let shownResult = null;
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none,
        isPackaged: true,
        loadAll: () => { throw new Error('boom'); },
        showMenuStatus: async (result) => { shownResult = result; },
      }));
      expect(code).toBe(5);
      expect(shownResult).toMatchObject({ ok: false, error: 'boom' });
    });

    it('exits 0 without a window in a dev run', async () => {
      let shown = false;
      const code = await dispatch({ argv: [] }, makeDeps({ ...none, isPackaged: false, showMenuStatus: async () => { shown = true; } }));
      expect(code).toBe(0);
      expect(shown).toBe(false);
    });
  });

  describe('--register and --unregister', () => {
    const register = { parseCli: () => ({ kind: 'register' }) };
    const unregister = { parseCli: () => ({ kind: 'unregister' }) };

    it('return 4 outside the packaged app', async () => {
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: false }))).toBe(4);
      expect(await dispatch({ argv: [] }, makeDeps({ ...unregister, isPackaged: false }))).toBe(4);
    });

    it('--register returns 0 when the menu is in place and 5 when it is not', async () => {
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: true, syncShellMenu: async () => inSync }))).toBe(0);
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: true, syncShellMenu: async () => failed }))).toBe(5);
    });

    it('--unregister returns 0 when every key is gone and 5 otherwise', async () => {
      const deps = (unregisterShellMenu) => makeDeps({ ...unregister, isPackaged: true, unregisterShellMenu });
      expect(await dispatch({ argv: [] }, deps(async () => ({ ok: true, remaining: [], error: null })))).toBe(0);
      expect(await dispatch({ argv: [] }, deps(async () => ({ ok: false, remaining: ['k'], error: null })))).toBe(5);
      expect(await dispatch({ argv: [] }, deps(async () => { throw new Error('boom'); }))).toBe(5);
    });
  });
});
