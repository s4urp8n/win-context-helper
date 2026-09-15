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

function readFile(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
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

  describe('collision naming follows Explorer order', () => {
    it('the first folder keeps the plain name: 1\\file → file, 2\\file → file (2)', async () => {
      tree(tmp, { '1/file': 'from 1', '2/file': 'from 2' });
      await new FlattenFolder().run({ targets: [tmp] });
      expect(readFile(tmp, 'file')).toBe('from 1');
      expect(readFile(tmp, 'file (2)')).toBe('from 2');
    });

    it('compares numbers in folder names by value (Lesson 2 before Lesson 10)', async () => {
      tree(tmp, { 'Lesson 10/x.txt': '10', 'Lesson 2/x.txt': '2', 'Lesson 1/x.txt': '1' });
      await new FlattenFolder().run({ targets: [tmp] });
      expect(readFile(tmp, 'x.txt')).toBe('1');
      expect(readFile(tmp, 'x (2).txt')).toBe('2');
      expect(readFile(tmp, 'x (3).txt')).toBe('10');
    });

    it('visits subfolders before the files of the same folder', async () => {
      tree(tmp, { 'a/x.txt': 'a file', 'a/sub/x.txt': 'sub file' });
      await new FlattenFolder().run({ targets: [tmp] });
      expect(readFile(tmp, 'x.txt')).toBe('sub file');
      expect(readFile(tmp, 'x (2).txt')).toBe('a file');
    });
  });

  describe('collision detection', () => {
    it('treats names differing only by case as a collision instead of overwriting', async () => {
      tree(tmp, { 'a/photo.jpg': 'A', 'b/PHOTO.jpg': 'B' });
      const result = await new FlattenFolder().run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(readFile(tmp, 'photo.jpg')).toBe('A');
      expect(readFile(tmp, 'PHOTO (2).jpg')).toBe('B');
    });

    it('does not move a file onto a root subfolder with the same name', async () => {
      tree(tmp, { 'a/b/a': 'deep' });
      const result = await new FlattenFolder().run({ targets: [tmp] });
      expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
      expect(readFile(tmp, 'a (2)')).toBe('deep');
    });

    it('preflight reports exactly the collisions that run resolves', async () => {
      tree(tmp, { 'a/x.txt': '1', 'b/x.txt': '2', 'c/x (2).txt': '3' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.totalCollisions).toBe(2);
      expect(pre.folders[0].collisionCount).toBe(2);
      await new FlattenFolder().run({ targets: [tmp] });
      expect(listFiles(tmp)).toEqual(['x (2) (2).txt', 'x (2).txt', 'x.txt']);
    });
  });

  it('preflight scan progress never goes backwards across folders', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-second-'));
    try {
      const layout = { 'root-1.txt': 'r', 'root-2.txt': 'r' };
      for (let i = 0; i < 100; i++) layout[`sub/f${i}.txt`] = 'x';
      tree(tmp, layout);
      tree(second, { 'sub/only.txt': 'x' });
      const events = [];
      await new FlattenFolder().preflight({ targets: [tmp, second], onProgress: (p) => events.push(p.scanned) });
      for (let i = 1; i < events.length; i++) expect(events[i]).toBeGreaterThanOrEqual(events[i - 1]);
      expect(events.at(-1)).toBe(103);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  describe('failures during run', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('records a file that vanished mid-run and keeps moving the rest', async () => {
      tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2', 'a/3.txt': '3' });
      let removed = false;
      const result = await new FlattenFolder().run({
        targets: [tmp],
        onProgress: () => {
          if (removed) return;
          removed = true;
          fs.unlinkSync(path.join(tmp, 'a', '2.txt'));
        },
      });
      expect(result).toMatchObject({ ok: false, processed: 2, skipped: 1 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe(path.join('a', '2.txt'));
      expect(result.errors[0].message).toMatch(/ENOENT/);
      expect(listFiles(tmp)).toEqual(['1.txt', '3.txt']);
    });

    it('leaves an emptied subfolder in place when it cannot be removed', async () => {
      tree(tmp, { 'a/x.txt': 'x' });
      vi.spyOn(fs, 'rmdirSync').mockImplementation(() => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      });
      const result = await new FlattenFolder().run({ targets: [tmp] });
      expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
      expect(readFile(tmp, 'x.txt')).toBe('x');
      expect(fs.existsSync(path.join(tmp, 'a'))).toBe(true);
    });
  });

  describe('dialog texts', () => {
    const names = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
    const skippedItems = (n) => names(n, 'file').map((b) => ({ path: `/${b}`, basename: b, reason: 'WRONG_TYPE' }));
    const bullets = (text) => text.split('\n').filter((l) => l.startsWith('  • '));

    it('nothing-to-do says the folders are already flat when nothing was skipped', () => {
      const out = new FlattenFolder().buildNothingToDoBody({}, { folders: [], totalFiles: 0 });
      expect(out.message).toBe('Nothing to do.');
      expect(out.detail).not.toMatch(/works only with folders/);
    });

    it('nothing-to-do lists at most 10 skipped items', () => {
      const ctx = { selection: { skipped: skippedItems(12) } };
      const out = new FlattenFolder().buildNothingToDoBody(ctx, { folders: [], totalFiles: 0 });
      expect(bullets(out.detail)).toHaveLength(10);
      expect(out.detail).toMatch(/… and 2 more/);
    });

    it('confirm lists at most 10 folders', () => {
      const folders = names(12, 'dir').map((basename) => ({ basename, fileCount: 1, collisionCount: 0 }));
      const out = new FlattenFolder().buildConfirmMessage({}, { folders, totalFiles: 12, totalCollisions: 0 });
      expect(bullets(out.detail)).toHaveLength(10);
      expect(out.detail).toMatch(/… and 2 more/);
    });

    it('confirm lists at most 10 skipped items', () => {
      const ctx = { selection: { skipped: skippedItems(11) } };
      const pre = { folders: [{ basename: 'a', fileCount: 1, collisionCount: 0 }], totalFiles: 1, totalCollisions: 0 };
      const out = new FlattenFolder().buildConfirmMessage(ctx, pre);
      expect(bullets(out.detail)).toHaveLength(1 + 10);
      expect(out.detail).toMatch(/… and 1 more/);
    });

    it('confirm in the plain mode shows no rename examples', async () => {
      tree(tmp, { 'Lesson 1/Chapter 1.mp4': '' });
      const plugin = new FlattenFolder();
      const out = plugin.buildConfirmMessage({}, await plugin.preflight({ targets: [tmp] }));
      expect(out.message).toBe('Flatten this folder?');
      expect(out.detail).not.toMatch(/→/);
    });

    it('error body lists every failed file with its reason', () => {
      const errors = [{ file: path.join('a', '1.txt'), message: 'EBUSY' }, { file: 'b.txt', message: 'EPERM' }];
      const body = new FlattenFolder().buildErrorBody({}, errors, 3, 5);
      expect(body.split('\n')).toEqual([
        '3 of 5 files moved.',
        '2 files could not be moved:',
        `  • ${path.join('a', '1.txt')} — EBUSY`,
        '  • b.txt — EPERM',
      ]);
    });

    it('error body uses singular forms and caps the list at 10', () => {
      const one = new FlattenFolder().buildErrorBody({}, [{ file: 'x', message: 'm' }], 0, 1);
      expect(one.split('\n').slice(0, 2)).toEqual(['0 of 1 file moved.', '1 file could not be moved:']);

      const many = names(13, 'f').map((file) => ({ file, message: 'm' }));
      const body = new FlattenFolder().buildErrorBody({}, many, 0, 13);
      expect(bullets(body)).toHaveLength(10);
      expect(body).toMatch(/… and 3 more/);
    });
  });
});
