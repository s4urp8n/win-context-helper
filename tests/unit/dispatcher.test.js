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
