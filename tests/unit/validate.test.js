const { validate } = require('../../src/main/selection/validate');

const m = (over = {}) => ({
  id: 'p', label: 'P',
  accepts: ['folders'],
  minSelection: 1, maxSelection: 999,
  ...over,
});
const sel = (over = {}) => ({
  folders: [], files: [], missing: [], exts: [], basenames: [],
  ...over,
});

describe('validate', () => {
  it('passes when all folders match accepts:folders, no skip', () => {
    const r = validate(m(), sel({ folders: ['/a', '/b'], basenames: ['a', 'b'] }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/a', '/b']);
    expect(r.skipped).toEqual([]);
  });

  it('fails MISSING when selection has missing paths', () => {
    const r = validate(m(), sel({ folders: ['/a'], missing: ['/gone'], basenames: ['a', 'gone'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MISSING');
    expect(r.body).toMatch(/no longer exist/i);
  });

  it('skips files when plugin accepts only folders (mixed)', () => {
    const r = validate(m({ accepts: ['folders'] }), sel({ folders: ['/a'], files: ['/f.pdf'], basenames: ['a', 'f.pdf'], exts: ['.pdf'] }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/a']);
    expect(r.skipped).toEqual([{ path: '/f.pdf', basename: 'f.pdf', reason: 'WRONG_TYPE' }]);
  });

  it('skips folders when plugin accepts only files', () => {
    const r = validate(m({ accepts: ['files'] }), sel({ folders: ['/a'], files: ['/f.pdf'], basenames: ['a', 'f.pdf'], exts: ['.pdf'] }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/f.pdf']);
    expect(r.skipped).toEqual([{ path: '/a', basename: 'a', reason: 'WRONG_TYPE' }]);
  });

  it('skips wrong-extension files (files:.pdf vs .jpg)', () => {
    const r = validate(m({ accepts: ['files:.pdf'] }), sel({ files: ['/a.pdf', '/b.jpg'], basenames: ['a.pdf', 'b.jpg'], exts: ['.pdf', '.jpg'] }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/a.pdf']);
    expect(r.skipped).toEqual([{ path: '/b.jpg', basename: 'b.jpg', reason: 'WRONG_EXTENSION' }]);
  });

  it('passes mixed when plugin accepts both (no skip)', () => {
    const r = validate(m({ accepts: ['folders', 'files'] }), sel({ folders: ['/a'], files: ['/f.pdf'], basenames: ['a', 'f.pdf'], exts: ['.pdf'] }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.effectiveTargets).toEqual(['/a', '/f.pdf']);
  });

  it('all-skipped case: ok:true, allSkipped:true, no effective targets', () => {
    const r = validate(m({ accepts: ['folders'] }), sel({ files: ['/f.pdf', '/g.txt'], basenames: ['f.pdf', 'g.txt'], exts: ['.pdf', '.txt'] }));
    expect(r.ok).toBe(true);
    expect(r.allSkipped).toBe(true);
    expect(r.effectiveTargets).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });

  it('COUNT fails when effective below min', () => {
    const r = validate(m({ minSelection: 2 }), sel({ folders: ['/a'], basenames: ['a'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('COUNT');
  });

  it('COUNT fails when effective above max', () => {
    const r = validate(m({ maxSelection: 2 }), sel({ folders: ['/a', '/b', '/c'], basenames: ['a', 'b', 'c'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('COUNT');
  });

  it('COUNT uses effective count (after skip), not raw selection count', () => {
    // 1 folder + 5 files, plugin accepts folders only, minSelection 1 — effective is 1, passes.
    const r = validate(m({ minSelection: 1, accepts: ['folders'] }), sel({
      folders: ['/a'],
      files: ['/f1', '/f2', '/f3', '/f4', '/f5'],
      basenames: ['a', 'f1', 'f2', 'f3', 'f4', 'f5'],
    }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/a']);
    expect(r.skipped).toHaveLength(5);
  });

  it('MISSING wins over partitioning', () => {
    const r = validate(m({ accepts: ['files'] }), sel({ folders: ['/a'], missing: ['/gone'], basenames: ['a', 'gone'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MISSING');
  });

  it('accepts "folder" (singular) treats folders as effective', () => {
    const r = validate(m({ accepts: ['folder'], minSelection: 1, maxSelection: 1 }), sel({ folders: ['/a'], basenames: ['a'] }));
    expect(r.ok).toBe(true);
    expect(r.effectiveTargets).toEqual(['/a']);
  });
});
