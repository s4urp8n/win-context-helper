const { BasePlugin } = require('../../src/shared/base-plugin');

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 'stub', label: 'Stub' }; }
}

describe('BasePlugin', () => {
  it('static manifest must be overridden', () => {
    expect(() => BasePlugin.manifest).toThrow(/subclass must declare static get manifest/);
  });

  it('preflight() must be overridden', async () => {
    const p = new StubPlugin();
    await expect(p.preflight({})).rejects.toThrow(/must implement preflight/);
  });

  it('run() must be overridden', async () => {
    const p = new StubPlugin();
    await expect(p.run({})).rejects.toThrow(/must implement run/);
  });

  it('isEmpty default returns true when totalFiles === 0', () => {
    const p = new StubPlugin();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
    expect(p.isEmpty({}, null)).toBeFalsy();
  });

  it('buildNothingToDoBody default returns { message, detail }', () => {
    const p = new StubPlugin();
    const out = p.buildNothingToDoBody({}, {});
    expect(out).toHaveProperty('message');
    expect(out).toHaveProperty('detail');
  });

  it('buildConfirmMessage default returns { message, detail }', () => {
    const p = new StubPlugin();
    const out = p.buildConfirmMessage({}, { folders: [{}, {}, {}] });
    expect(out.message).toMatch(/3/);
  });

  it('buildRejectedBody default lists basenames', () => {
    const p = new StubPlugin();
    const body = p.buildRejectedBody({}, [{ basename: 'a' }, { basename: 'b' }]);
    expect(body).toMatch(/• a/);
    expect(body).toMatch(/• b/);
  });

  it('buildErrorBody default lists first 10 errors', () => {
    const p = new StubPlugin();
    const errors = Array.from({ length: 15 }, (_, i) => ({ file: `f${i}`, message: 'err' }));
    const body = p.buildErrorBody({}, errors, 5, 20);
    expect(body).toMatch(/5 of 20/);
    expect(body).toMatch(/• f0 — err/);
    expect(body).toMatch(/• f9 — err/);
    expect(body).not.toMatch(/• f10 —/);
    expect(body).toMatch(/and 5 more/);
  });

  it('buildScanningLabel default', () => {
    const p = new StubPlugin();
    expect(p.buildScanningLabel({})).toBe('Scanning…');
  });

  it('buildRunningLabel default', () => {
    const p = new StubPlugin();
    expect(p.buildRunningLabel({})).toBe('Working…');
  });
});
