const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

describe('FlattenFolder', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = FlattenFolder.manifest;
    expect(m).toMatchObject({
      id: 'flatten-folder',
      label: 'Flatten folder',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    });
  });

  it('run moves all nested files to root', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/b/2.txt': '2', 'c/3.txt': '3' });
    const result = await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(result.ok).toBe(true);
    expect(listFiles(tmp)).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(result.processed).toBe(3);
  });

  it('run resolves name collisions with (N) suffix', async () => {
    tree(tmp, { 'a/photo.jpg': 'A', 'b/photo.jpg': 'B', 'c/photo.jpg': 'C' });
    await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['photo (2).jpg', 'photo (3).jpg', 'photo.jpg']);
  });

  it('run removes empty subfolders after flattening', async () => {
    tree(tmp, { 'a/b/c/deep.txt': 'x' });
    await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(fs.existsSync(path.join(tmp, 'a'))).toBe(false);
  });

  it('run preserves already-flat folder unchanged', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const result = await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['a.txt', 'b.txt']);
    expect(result.processed).toBe(0);
  });

  it('run emits progress events', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    const events = [];
    await new FlattenFolder().run({ targets: [tmp], onProgress: (p) => events.push(p) });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ processed: 2, total: 2 });
  });

  it('run respects abort signal mid-run', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2', 'a/3.txt': '3', 'a/4.txt': '4' });
    const controller = new AbortController();
    // Abort immediately when the first progress event fires (throttle may batch early events)
    const promise = new FlattenFolder().run({
      targets: [tmp],
      onProgress: () => { controller.abort(); },
      signal: controller.signal,
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.processed).toBeLessThan(4);
  });

  it('preflight counts files and collisions for a single folder', async () => {
    tree(tmp, { 'a/x.txt': '1', 'a/y.txt': '2', 'b/x.txt': '3', 'c/z.txt': '4' });
    const result = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({
      basename: path.basename(tmp), fileCount: 4, collisionCount: 1,
    });
    expect(result.totalFiles).toBe(4);
    expect(result.totalCollisions).toBe(1);
  });

  it('preflight aggregates across multiple folders', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-b-'));
    try {
      tree(tmp, { 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
      tree(tmp2, { 'sub/c.txt': 'c' });
      const result = await new FlattenFolder().preflight({ targets: [tmp, tmp2] });
      expect(result.folders).toHaveLength(2);
      expect(result.totalFiles).toBe(3);
      expect(result.totalCollisions).toBe(0);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('preflight returns totalFiles: 0 for an already-flat folder', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const result = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(tmp, { 'a/x.txt': 'X', 'a/b/y.txt': 'Y' });
    const before = fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs;
    await new FlattenFolder().preflight({ targets: [tmp] });
    expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(tmp, 'a', 'b'))).toBe(true);
  });

  it('isEmpty returns true when totalFiles is 0', () => {
    const p = new FlattenFolder();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
  });

  it('buildConfirmMessage handles single folder', () => {
    const p = new FlattenFolder();
    const out = p.buildConfirmMessage({}, { folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }], totalFiles: 3, totalCollisions: 0 });
    expect(out.message).toBe('Flatten this folder?');
    expect(out.detail).toMatch(/You selected 1 folder/);
  });

  it('buildConfirmMessage handles multiple folders', () => {
    const p = new FlattenFolder();
    const out = p.buildConfirmMessage({}, {
      folders: [{ basename: 'a', fileCount: 2, collisionCount: 0 }, { basename: 'b', fileCount: 3, collisionCount: 1 }],
      totalFiles: 5,
      totalCollisions: 1,
    });
    expect(out.message).toBe('Flatten 2 folders?');
    expect(out.detail).toMatch(/independently/);
    expect(out.detail).toMatch(/• a/);
    expect(out.detail).toMatch(/• b/);
    expect(out.detail).toMatch(/5 files total/);
    expect(out.detail).toMatch(/1 name collision/);
  });

  it('buildConfirmMessage includes skip-list when ctx.selection.skipped is non-empty', () => {
    const p = new FlattenFolder();
    const ctx = { manifest: FlattenFolder.manifest, targets: ['/a'], selection: {
      folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'],
      skipped: [{ path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' }],
    } };
    const out = p.buildConfirmMessage(ctx, { folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }], totalFiles: 3, totalCollisions: 0 });
    expect(out.detail).toMatch(/will be skipped/);
    expect(out.detail).toMatch(/• x\.txt/);
  });

  it('buildNothingToDoBody mentions all skipped items when allSkipped', () => {
    const p = new FlattenFolder();
    const ctx = { manifest: FlattenFolder.manifest, targets: [], selection: {
      folders: [], files: [], missing: [], exts: [], basenames: [],
      skipped: [
        { path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' },
        { path: '/y.pdf', basename: 'y.pdf', reason: 'WRONG_TYPE' },
      ],
    } };
    const out = p.buildNothingToDoBody(ctx, { folders: [], totalFiles: 0, totalCollisions: 0 });
    expect(out.message).toBe('Nothing to process.');
    expect(out.detail).toMatch(/works only with folders/);
    expect(out.detail).toMatch(/• x\.txt/);
    expect(out.detail).toMatch(/• y\.pdf/);
  });

  it('preflight returns folders sorted alphabetically by basename', async () => {
    const tmps = ['zzz', 'aaa', 'mmm'].map((name) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ch-flatten-${name}-`));
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'f.txt'), 'x');
      return path.join(dir, name);
    });
    try {
      const result = await new FlattenFolder().preflight({ targets: tmps });
      const names = result.folders.map((f) => f.basename);
      expect(names).toEqual(['aaa', 'mmm', 'zzz']);
    } finally {
      for (const t of tmps) fs.rmSync(path.dirname(t), { recursive: true, force: true });
    }
  });

  it('preflight emits scan progress events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-progress-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, 'sub', `f${i}.txt`), 'x');
      const events = [];
      const result = await new FlattenFolder().preflight({
        targets: [dir],
        onProgress: (p) => events.push(p),
      });
      expect(result.totalFiles).toBe(300);
      // Final emit always fires
      expect(events.length).toBeGreaterThanOrEqual(1);
      // Final event should reach the total
      expect(events.at(-1).scanned).toBe(300);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run emits processed/total progress events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-runprog-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, 'sub', `f${i}.txt`), 'x');
      const events = [];
      await new FlattenFolder().run({
        targets: [dir],
        onProgress: (p) => events.push(p),
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events.at(-1);
      expect(last.processed).toBe(50);
      expect(last.total).toBe(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildRunningLabel returns Flattening…', () => {
    const p = new FlattenFolder();
    expect(p.buildRunningLabel({})).toBe('Flattening…');
  });
});
