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

  it('preflight counts files and collisions for a single folder', async () => {
    tree(tmp, { 'a/x.txt': '1', 'a/y.txt': '2', 'b/x.txt': '3', 'c/z.txt': '4' });
    const result = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({
      basename: path.basename(tmp), path: tmp, fileCount: 4, collisionCount: 1,
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

  it('isEmpty is true only when there are no files to move and no empty subfolders', () => {
    const p = new FlattenFolder();
    expect(p.isEmpty({}, { totalFiles: 0, totalEmptyDirs: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3, totalEmptyDirs: 0 })).toBe(false);
    expect(p.isEmpty({}, { totalFiles: 0, totalEmptyDirs: 2 })).toBe(false);
  });

  it('buildConfirmMessage includes skip-list when ctx.selection.skipped is non-empty', () => {
    const p = new FlattenFolder();
    const ctx = { manifest: FlattenFolder.manifest, targets: ['/a'], selection: {
      folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'],
      skipped: [{ path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' }],
    } };
    const out = p.buildConfirmMessage(ctx, { folders: [{ basename: 'a', fileCount: 3, moves: [] }], totalFiles: 3, totalCollisions: 0 });
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

    it('ignores hyphens like Explorer does (Cook before Co-op)', async () => {
      tree(tmp, { 'Co-op/x.txt': 'coop', 'Cook/x.txt': 'cook' });
      await new FlattenFolder().run({ targets: [tmp] });
      expect(readFile(tmp, 'x.txt')).toBe('cook');
      expect(readFile(tmp, 'x (2).txt')).toBe('coop');
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

    it('puts the moved files back when a file vanished mid-run', async () => {
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
      expect(result).toMatchObject({ ok: false, processed: 0, moved: 1, notRestored: [] });
      expect(result.errors).toEqual([{ folder: path.basename(tmp), file: path.join('a', '2.txt'), message: 'The file was moved or deleted (ENOENT)' }]);
      expect(listFiles(tmp)).toEqual([]);
      expect(listFiles(path.join(tmp, 'a'))).toEqual(['1.txt', '3.txt']);
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
    const folder = (basename, fileCount, extra = {}) => ({
      basename, path: `/x/${basename}`, fileCount, collisionCount: 0, shortenedCount: 0, emptyDirCount: 0,
      numbered: false, moves: [], blocked: [], blockedCount: 0, ...extra,
    });
    const move = (from, to, flags = {}) => ({ from, to, shortened: false, renamed: false, ...flags });

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

    it('confirm lists at most 10 skipped items', () => {
      const ctx = { selection: { skipped: skippedItems(11) } };
      const out = new FlattenFolder().buildConfirmMessage(ctx, { folders: [folder('a', 1)], totalFiles: 1, totalCollisions: 0 });
      expect(bullets(out.detail)).toHaveLength(10);
      expect(out.detail).toMatch(/… and 1 more/);
    });

    it('confirm for one folder names it and shows every planned move as a table row', async () => {
      tree(tmp, { 'Lesson 1/Chapter 1.mp4': '', 'Lesson 1/Chapter 2.mp4': '', 'x/Chapter 1.mp4': '' });
      const plugin = new FlattenFolder();
      const out = plugin.buildConfirmMessage({}, await plugin.preflight({ targets: [tmp] }));
      expect(out.message).toBe('Flatten this folder?');
      expect(out.detail.split('\n')).toEqual([
        `Folder: ${tmp}`,
        '3 files will be moved into the folder root.',
        '2 subfolders will be removed (empty after the move).',
        '1 name collision will be resolved with "(N)" suffix.',
        'If any file cannot be moved, all files are put back.',
      ]);
      expect(out.table).toEqual({
        columns: ['From', 'New name'],
        rows: [
          { cells: [path.join('Lesson 1', 'Chapter 1.mp4'), 'Chapter 1.mp4'], badges: [] },
          { cells: [path.join('Lesson 1', 'Chapter 2.mp4'), 'Chapter 2.mp4'], badges: [] },
          { cells: [path.join('x', 'Chapter 1.mp4'), 'Chapter 1 (2).mp4'], badges: ['suffix added'] },
        ],
      });
    });

    it('names a drive root by its path', async () => {
      tree(tmp, { 'a/1.txt': '1' });
      vi.spyOn(path, 'basename').mockReturnValue('');
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      vi.restoreAllMocks();
      expect(pre.folders[0].basename).toBe(tmp);
    });

    it('confirm for several folders groups the rows by folder', () => {
      const pre = {
        folders: [
          folder('a', 1, { moves: [move('s/1.txt', '1.txt')] }),
          folder('b', 2, { emptyDirCount: 1, numbered: true, moves: [move('s/2.txt', '001 - 2.txt', { shortened: true })] }),
        ],
        totalFiles: 3, totalCollisions: 0, totalShortened: 1, totalEmptyDirs: 1,
      };
      const out = new FlattenFolder().buildConfirmMessage({}, pre);
      expect(out.message).toBe('Flatten 2 folders?');
      expect(out.detail.split('\n')).toEqual([
        '3 files from 2 folders will be moved, each folder into its own root.',
        '1 subfolder will be removed (empty after the move).',
        '1 name is too long for Windows and will be shortened.',
        'In 1 folder files get a number prefix (001, 002…) so the shortened names keep their order.',
        'If any file cannot be moved, all files are put back.',
      ]);
      expect(out.table.rows).toEqual([
        { group: 'a — 1 file' },
        { cells: ['s/1.txt', '1.txt'], badges: [] },
        { group: 'b — 2 files, numbered' },
        { cells: ['s/2.txt', '001 - 2.txt'], badges: ['shortened'] },
      ]);
      expect(out.table.footer).toBe('… and 1 more file');
    });

    it('confirm uses plural forms for bigger numbers', () => {
      const pre = {
        folders: [
          folder('a', 2, { emptyDirCount: 2, numbered: true, moves: [move('s/1.txt', '001 - 1.txt')] }),
          folder('b', 1, { numbered: true }),
        ],
        totalFiles: 3, totalCollisions: 2, totalShortened: 2, totalEmptyDirs: 2,
      };
      const out = new FlattenFolder().buildConfirmMessage({}, pre);
      const lines = out.detail.split('\n');
      expect(lines).toContain('2 subfolders will be removed (empty after the move).');
      expect(lines).toContain('2 name collisions will be resolved with "(N)" suffix.');
      expect(lines).toContain('2 names are too long for Windows and will be shortened.');
      expect(lines).toContain('In 2 folders files get a number prefix (001, 002…) so the shortened names keep their order.');
      expect(out.table.rows[0]).toEqual({ group: 'a — 2 files, numbered' });
      expect(out.table.footer).toBe('… and 2 more files');
    });

    it('confirm for one numbered folder explains the number prefix', () => {
      const pre = { folders: [folder('a', 1, { numbered: true })], totalFiles: 1, totalCollisions: 0, totalShortened: 1 };
      const lines = new FlattenFolder().buildConfirmMessage({}, pre).detail.split('\n');
      expect(lines).toContain('Files get a number prefix (001, 002…) so the shortened names keep their order.');
    });

    it('confirm without files to move only announces the empty subfolders', () => {
      const pre = { folders: [folder('a', 0, { emptyDirCount: 3 })], totalFiles: 0, totalCollisions: 0, totalEmptyDirs: 3 };
      const out = new FlattenFolder().buildConfirmMessage({}, pre);
      expect(out.detail).toBe('Folder: /x/a\n3 empty subfolders will be removed.');
      expect(out.table).toBeUndefined();
    });

    it('confirm says which subfolders stay because they hold links', () => {
      const one = { folders: [folder('a', 1)], totalFiles: 1, totalCollisions: 0, totalKeptDirs: 1 };
      const two = { ...one, totalKeptDirs: 2 };
      expect(new FlattenFolder().buildConfirmMessage({}, one).detail.split('\n'))
        .toContain('1 subfolder stays: it holds links or other items that are not moved.');
      expect(new FlattenFolder().buildConfirmMessage({}, two).detail.split('\n'))
        .toContain('2 subfolders stay: they hold links or other items that are not moved.');
    });

    it('nothing-to-do explains subfolders that stay because they hold links', () => {
      const out = new FlattenFolder().buildNothingToDoBody({}, { folders: [], totalFiles: 0, totalKeptDirs: 2 });
      expect(out).toEqual({
        message: 'Nothing to do.',
        detail: 'Nothing to move. 2 subfolders stay: they hold links or other items that are not moved.',
      });
    });

    it('confirm names the selected folders that lie inside another selected folder', () => {
      const pre = {
        folders: [folder('A', 1, { moves: [move('x/1.txt', '1.txt')] })],
        insideOthers: ['B', 'C'],
        totalFiles: 1, totalCollisions: 0,
      };
      const lines = new FlattenFolder().buildConfirmMessage({}, pre).detail.split('\n');
      expect(lines).toContain('Also selected, but inside another selected folder (flattened with it): B, C');
    });

    it('preflight sends at most 1000 table rows across all folders', async () => {
      const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-rows-'));
      try {
        tree(tmp, Object.fromEntries(Array.from({ length: 990 }, (_, i) => [`s/${i}.txt`, ''])));
        tree(second, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s/${i}.txt`, ''])));
        const plugin = new FlattenFolder();
        const pre = await plugin.preflight({ targets: [tmp, second] });
        expect(pre.totalFiles).toBe(1010);
        expect(pre.folders.map((f) => f.moves.length).reduce((a, b) => a + b)).toBe(1000);
        expect(plugin.buildConfirmMessage({}, pre).table.footer).toBe('… and 10 more files');
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });

    it('blocked body is empty when every name fits', () => {
      const plugin = new FlattenFolder();
      expect(plugin.buildBlockedBody({}, { folders: [], totalBlocked: 0 })).toBeNull();
      expect(plugin.buildBlockedBody({}, undefined)).toBeNull();
    });

    it('blocked body lists the files that cannot get a name', () => {
      const pre = { folders: [folder('a', 0, { blocked: [{ file: 'x.txt', message: 'No room' }], blockedCount: 1 })], totalBlocked: 1 };
      const out = new FlattenFolder().buildBlockedBody({}, pre);
      expect(out.message).toBe('Flatten folder — cannot start');
      expect(out.detail.split('\n')).toEqual([
        '1 file cannot be given a name: the folder path is too long for Windows (259 characters max).',
        'Move the folder closer to the drive root (for example D:\\Temp) and try again.',
        'Nothing was changed.',
      ]);
      expect(out.table).toEqual({ columns: ['File', 'Problem'], rows: [{ cells: ['x.txt', 'No room'] }] });
    });

    it('blocked body groups several folders and caps the rows', () => {
      const many = Array.from({ length: 1000 }, (_, i) => ({ file: `${i}.txt`, message: 'No room' }));
      const pre = {
        folders: [folder('a', 0, { blocked: many, blockedCount: 1001 }), folder('b', 0)],
        totalBlocked: 1001,
      };
      const out = new FlattenFolder().buildBlockedBody({}, pre);
      expect(out.detail).toMatch(/^1001 files cannot/);
      expect(out.table.rows[0]).toEqual({ group: 'a' });
      expect(out.table.rows).toHaveLength(1001);
      expect(out.table.footer).toBe('… and 1 more file');
    });

    describe('error body', () => {
      const failure = { folder: 'a', file: path.join('s', '1.txt'), message: 'The file is open in another program (EBUSY)' };

      it('says nothing changed when the files were put back', () => {
        const out = new FlattenFolder().buildErrorBody({}, [failure], 0, 5, { moved: 2, notRestored: [] });
        expect(out.message).toBe('Flatten folder — nothing was changed');
        expect(out.detail.split('\n')).toEqual([
          'A file could not be moved, so the operation was stopped.',
          'All 2 files moved before that were put back — the folders are exactly as they were.',
        ]);
        expect(out.table).toEqual({ columns: ['File', 'Problem'], rows: [{ cells: [failure.file, failure.message] }] });
      });

      it('says nothing was moved when the first file failed', () => {
        const out = new FlattenFolder().buildErrorBody({}, [failure], 0, 5, { moved: 0, notRestored: [] });
        expect(out.detail.split('\n')[1]).toBe('No files were moved — the folders are exactly as they were.');
      });

      it('uses the singular form for one put-back file', () => {
        const out = new FlattenFolder().buildErrorBody({}, [failure], 0, 5, { moved: 1, notRestored: [] });
        expect(out.detail.split('\n')[1]).toBe('The 1 file moved before that was put back — the folders are exactly as they were.');
      });

      it('lists the files that could not be put back', () => {
        const stuck = [
          { folder: 'a', file: path.join('s', '0.txt'), location: '0.txt', message: 'Access denied (EACCES)' },
          { folder: 'b', file: path.join('t', '9.txt'), location: '9.txt', message: 'Access denied (EACCES)' },
        ];
        const out = new FlattenFolder().buildErrorBody({}, [failure], 2, 5, { moved: 3, notRestored: stuck });
        expect(out.message).toBe('Flatten folder — some files were not put back');
        expect(out.detail.split('\n')).toEqual([
          'A file could not be moved, so the operation was stopped.',
          `Stopped at ${failure.file}: ${failure.message}`,
          'Put back 1 of 3 moved files; 2 could not be put back.',
          'They are still in the folder root under the new name — move them back by hand:',
        ]);
        expect(out.table).toEqual({
          columns: ['Original place', 'Name in the root now', 'Problem'],
          rows: [
            { group: 'a' },
            { cells: [stuck[0].file, '0.txt', stuck[0].message] },
            { group: 'b' },
            { cells: [stuck[1].file, '9.txt', stuck[1].message] },
          ],
        });
      });

      it('uses singular forms for one file that stayed', () => {
        const stuck = [{ folder: 'a', file: '0.txt', location: '0.txt', message: 'm' }];
        const out = new FlattenFolder().buildErrorBody({}, [failure], 1, 5, { moved: 1, notRestored: stuck });
        expect(out.detail.split('\n')).toEqual([
          'A file could not be moved, so the operation was stopped.',
          `Stopped at ${failure.file}: ${failure.message}`,
          'Put back 0 of 1 moved file; 1 could not be put back.',
          'It is still in the folder root under the new name — move it back by hand:',
        ]);
      });

      it('caps a long list of files that stayed', () => {
        const stuck = Array.from({ length: 1002 }, (_, i) => ({ folder: 'a', file: `${i}.txt`, location: `${i}.txt`, message: 'm' }));
        const out = new FlattenFolder().buildErrorBody({}, [failure], 1002, 1003, { moved: 1002, notRestored: stuck });
        expect(out.table.rows).toHaveLength(1000);
        expect(out.table.footer).toBe('… and 2 more files');
      });

      it('explains a run that was refused because names do not fit', () => {
        const blocked = [{ folder: 'a', file: 'x.txt', message: 'No room' }];
        const out = new FlattenFolder().buildErrorBody({}, blocked, 0, 1, { blocked: true });
        expect(out.message).toBe('Flatten folder — nothing was changed');
        expect(out.detail.split('\n')).toEqual([
          'Some files cannot be given a name within the Windows path limit, so nothing was moved.',
          'Move the folder closer to the drive root (for example D:\\Temp) and try again.',
        ]);
        expect(out.table.rows).toEqual([{ cells: ['x.txt', 'No room'] }]);
      });

      it('explains a run that was refused because the folder changed after the preview', () => {
        const out = new FlattenFolder().buildErrorBody({}, [], 0, 1, { stale: true });
        expect(out.message).toBe('Flatten folder — nothing was changed');
        expect(out.detail.split('\n')).toEqual([
          'The folder changed after the preview, so nothing was moved.',
          'Run the command again to see the new plan.',
        ]);
        expect(out.table).toBeUndefined();
      });

      it('shows no table when a failed run reports no details', () => {
        const out = new FlattenFolder().buildErrorBody({}, [], 0, 0, {});
        expect(out.message).toBe('Flatten folder — nothing was changed');
        expect(out.table).toBeUndefined();
      });

      it('works without the run result', () => {
        const out = new FlattenFolder().buildErrorBody({}, [failure], 0, 5);
        expect(out.message).toBe('Flatten folder — nothing was changed');
      });
    });
  });
});
