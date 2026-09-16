const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');
const { loadAll } = require('../../src/main/registry/plugin-loader');
const { explorerCompare } = require('../../src/main/utils/explorer-compare');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');
const FLAT = { keepHierarchy: false };
const MIXED = { foldersFirst: false };

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

// A preview built by hand: one view shared by every variant.
const folderView = (basename, fileCount, extra = {}) => ({
  basename, path: `/x/${basename}`, fileCount, rowCount: fileCount, renamedInRootCount: 0,
  collisionCount: 0, shortenedCount: 0, numbered: false, blockedCount: 0, moves: [], blocked: [], ...extra,
});
function preWith(folders, totals = {}, extra = {}) {
  const view = {
    planId: 'plan', folders, totalRows: folders.reduce((n, f) => n + f.rowCount, 0),
    totalRenamedInRoot: 0, totalCollisions: 0, totalShortened: 0, totalBlocked: 0, ...totals,
  };
  return {
    folderCount: folders.length, insideOthers: [], totalFiles: folders.reduce((n, f) => n + f.fileCount, 0),
    totalEmptyDirs: 0, totalKeptDirs: 0, variants: { tree: view, mixed: view, flat: view }, ...extra,
  };
}
const move = (from, to, flags = {}) => ({ from, to, shortened: false, renamed: false, ...flags });
const fact = (label, value, tone) => (tone ? { label, value, tone } : { label, value });
// Table rows without the folder headers.
const fileRows = (table) => table.rows.filter((r) => !r.group);

describe('FlattenFolder', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('static manifest is well-formed', () => {
    expect(FlattenFolder.manifest).toMatchObject({
      id: 'flatten-folder',
      label: 'Flatten folder',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    });
  });

  it('is the only flatten command in the menu', () => {
    const ids = [...loadAll(PLUGINS_DIR).keys()].filter((id) => id.startsWith('flatten'));
    expect(ids).toEqual(['flatten-folder']);
  });

  it('keeps the hierarchy in the names unless told otherwise', async () => {
    tree(tmp, { 'Lesson 1/a.mp4': 'a' });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
    expect(listFiles(tmp)).toEqual(['Lesson 1 - a.mp4']);
  });

  it('buildRunningLabel returns Flattening…', () => {
    expect(new FlattenFolder().buildRunningLabel({})).toBe('Flattening…');
  });

  describe('without the hierarchy', () => {
    it('moves all nested files to the root under their own names', async () => {
      tree(tmp, { 'a/1.txt': '1', 'a/b/2.txt': '2', 'c/3.txt': '3' });
      const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT, onProgress: () => {} });
      expect(result.ok).toBe(true);
      expect(listFiles(tmp)).toEqual(['1.txt', '2.txt', '3.txt']);
      expect(result.processed).toBe(3);
    });

    it('resolves name collisions with a (N) suffix', async () => {
      tree(tmp, { 'a/photo.jpg': 'A', 'b/photo.jpg': 'B', 'c/photo.jpg': 'C' });
      await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      expect(listFiles(tmp)).toEqual(['photo (2).jpg', 'photo (3).jpg', 'photo.jpg']);
    });

    it('removes empty subfolders after flattening', async () => {
      tree(tmp, { 'a/b/c/deep.txt': 'x' });
      await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      expect(fs.existsSync(path.join(tmp, 'a'))).toBe(false);
    });

    it('leaves an already flat folder unchanged', async () => {
      tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
      const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      expect(listFiles(tmp)).toEqual(['a.txt', 'b.txt']);
      expect(result.processed).toBe(0);
    });

    it('reports progress up to the total', async () => {
      tree(tmp, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`sub/f${i}.txt`, 'x'])));
      const events = [];
      await new FlattenFolder().run({ targets: [tmp], options: FLAT, onProgress: (p) => events.push(p) });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.at(-1)).toEqual({ processed: 50, total: 50 });
    });

    describe('collision naming follows Explorer order', () => {
      it('the first folder keeps the plain name: 1\\file → file, 2\\file → file (2)', async () => {
        tree(tmp, { '1/file': 'from 1', '2/file': 'from 2' });
        await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(readFile(tmp, 'file')).toBe('from 1');
        expect(readFile(tmp, 'file (2)')).toBe('from 2');
      });

      it('compares numbers in folder names by value (Lesson 2 before Lesson 10)', async () => {
        tree(tmp, { 'Lesson 10/x.txt': '10', 'Lesson 2/x.txt': '2', 'Lesson 1/x.txt': '1' });
        await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(readFile(tmp, 'x.txt')).toBe('1');
        expect(readFile(tmp, 'x (2).txt')).toBe('2');
        expect(readFile(tmp, 'x (3).txt')).toBe('10');
      });

      it('sorts a hyphenated name like Explorer does (Cook before Co-op)', async () => {
        tree(tmp, { 'Co-op/x.txt': 'coop', 'Cook/x.txt': 'cook' });
        await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(readFile(tmp, 'x.txt')).toBe('cook');
        expect(readFile(tmp, 'x (2).txt')).toBe('coop');
      });

      it('visits subfolders before the files of the same folder', async () => {
        tree(tmp, { 'a/x.txt': 'a file', 'a/sub/x.txt': 'sub file' });
        await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(readFile(tmp, 'x.txt')).toBe('sub file');
        expect(readFile(tmp, 'x (2).txt')).toBe('a file');
      });

      it('ignores the folders-first choice', async () => {
        tree(tmp, { 'a/x.txt': 'a file', 'a/sub/x.txt': 'sub file' });
        await new FlattenFolder().run({ targets: [tmp], options: { ...FLAT, foldersFirst: false } });
        expect(readFile(tmp, 'x.txt')).toBe('sub file');
      });
    });

    describe('collision detection', () => {
      it('treats names differing only by case as a collision instead of overwriting', async () => {
        tree(tmp, { 'a/photo.jpg': 'A', 'b/PHOTO.jpg': 'B' });
        const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(result.ok).toBe(true);
        expect(readFile(tmp, 'photo.jpg')).toBe('A');
        expect(readFile(tmp, 'PHOTO (2).jpg')).toBe('B');
      });

      it('does not move a file onto a root subfolder with the same name', async () => {
        tree(tmp, { 'a/b/a': 'deep' });
        const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
        expect(readFile(tmp, 'a (2)')).toBe('deep');
      });

      it('preflight reports exactly the collisions that run resolves', async () => {
        tree(tmp, { 'a/x.txt': '1', 'b/x.txt': '2', 'c/x (2).txt': '3' });
        const pre = await new FlattenFolder().preflight({ targets: [tmp] });
        expect(pre.variants.flat.totalCollisions).toBe(2);
        expect(pre.variants.flat.folders[0].collisionCount).toBe(2);
        await new FlattenFolder().run({ targets: [tmp], options: FLAT });
        expect(listFiles(tmp)).toEqual(['x (2) (2).txt', 'x (2).txt', 'x.txt']);
      });
    });

    it('puts the moved files back when a file vanished mid-run', async () => {
      tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2', 'a/3.txt': '3' });
      let removed = false;
      const result = await new FlattenFolder().run({
        targets: [tmp],
        options: FLAT,
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
      const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
      expect(readFile(tmp, 'x.txt')).toBe('x');
      expect(fs.existsSync(path.join(tmp, 'a'))).toBe(true);
    });
  });

  describe('preflight', () => {
    it('plans every combination of options with its own plan id', async () => {
      tree(tmp, { 'a/x.txt': '1', 'a/y.txt': '2', 'b/x.txt': '3', 'c/z.txt': '4', '0.txt': 'r' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(Object.keys(pre.variants).sort()).toEqual(['flat', 'mixed', 'tree']);
      expect(pre).toMatchObject({ folderCount: 1, totalFiles: 4, totalEmptyDirs: 3, totalKeptDirs: 0, insideOthers: [] });
      expect(pre.variants.flat).toMatchObject({ totalCollisions: 1, totalRows: 4, totalRenamedInRoot: 0 });
      expect(pre.variants.tree).toMatchObject({ totalCollisions: 0, totalRows: 5, totalRenamedInRoot: 1 });
      expect(pre.variants.mixed).toMatchObject({ totalCollisions: 0, totalRows: 4, totalRenamedInRoot: 0 });
      expect(pre.variants.flat.folders[0]).toMatchObject({ basename: path.basename(tmp), path: tmp, fileCount: 4, collisionCount: 1 });
      const ids = new Set(Object.values(pre.variants).map((v) => v.planId));
      expect(ids.size).toBe(3);
    });

    it('aggregates several folders', async () => {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-b-'));
      try {
        tree(tmp, { 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
        tree(tmp2, { 'sub/c.txt': 'c' });
        const pre = await new FlattenFolder().preflight({ targets: [tmp, tmp2] });
        expect(pre).toMatchObject({ folderCount: 2, totalFiles: 3 });
        expect(pre.variants.tree.folders).toHaveLength(2);
      } finally {
        fs.rmSync(tmp2, { recursive: true, force: true });
      }
    });

    it('finds nothing to move in an already flat folder', async () => {
      tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.totalFiles).toBe(0);
      expect(pre.variants.tree).toMatchObject({ totalRows: 0, totalRenamedInRoot: 0 });
    });

    it('does not change the file system', async () => {
      tree(tmp, { 'a/x.txt': 'X', 'a/b/y.txt': 'Y', 'r.txt': 'R' });
      const before = fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs;
      await new FlattenFolder().preflight({ targets: [tmp] });
      expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(before);
      expect(fs.existsSync(path.join(tmp, 'a', 'b'))).toBe(true);
      expect(listFiles(tmp)).toEqual(['r.txt']);
    });

    it('lists the folders by name in every variant', async () => {
      const tmps = ['zzz', 'aaa', 'mmm'].map((name) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ch-flatten-${name}-`));
        tree(path.join(dir, name), { 'sub/f.txt': 'x' });
        return path.join(dir, name);
      });
      try {
        const pre = await new FlattenFolder().preflight({ targets: tmps });
        for (const view of Object.values(pre.variants)) {
          expect(view.folders.map((f) => f.basename)).toEqual(['aaa', 'mmm', 'zzz']);
        }
      } finally {
        for (const t of tmps) fs.rmSync(path.dirname(t), { recursive: true, force: true });
      }
    });

    it('reports scan progress', async () => {
      tree(tmp, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`sub/f${i}.txt`, 'x'])));
      const events = [];
      const pre = await new FlattenFolder().preflight({ targets: [tmp], onProgress: (p) => events.push(p) });
      expect(pre.totalFiles).toBe(300);
      expect(events.at(-1).scanned).toBe(300);
    });

    it('scan progress never goes backwards across folders', async () => {
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

    it('sends at most 1000 table rows per variant across all folders', async () => {
      const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-rows-'));
      try {
        tree(tmp, Object.fromEntries(Array.from({ length: 990 }, (_, i) => [`s/${i}.txt`, ''])));
        tree(second, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s/${i}.txt`, ''])));
        const plugin = new FlattenFolder();
        const pre = await plugin.preflight({ targets: [tmp, second] });
        expect(pre.totalFiles).toBe(1010);
        for (const view of Object.values(pre.variants)) {
          expect(view.folders.map((f) => f.moves.length).reduce((a, b) => a + b)).toBe(1000);
          expect(view.totalRows).toBe(1010);
        }
        expect(plugin.buildConfirmMessage({}, pre).table.footer).toBe('… and 10 more files');
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });

    it('names a drive root by its path', async () => {
      tree(tmp, { 'a/1.txt': '1' });
      vi.spyOn(path, 'basename').mockReturnValue('');
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      vi.restoreAllMocks();
      expect(pre.variants.tree.folders[0].basename).toBe(tmp);
    });
  });

  describe('nothing to do', () => {
    it('isEmpty is true only when there are no files to move and no empty subfolders', () => {
      const p = new FlattenFolder();
      expect(p.isEmpty({}, { totalFiles: 0, totalEmptyDirs: 0 })).toBe(true);
      expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
      expect(p.isEmpty({}, { totalFiles: 3, totalEmptyDirs: 0 })).toBe(false);
      expect(p.isEmpty({}, { totalFiles: 0, totalEmptyDirs: 2 })).toBe(false);
    });

    it('says the folders are already flat when nothing was skipped', () => {
      const out = new FlattenFolder().buildNothingToDoBody({}, { totalFiles: 0 });
      expect(out).toEqual({ message: 'Nothing to do.', detail: 'Selected folder(s) are already flat.' });
    });

    it('explains subfolders that stay because they hold links', () => {
      const out = new FlattenFolder().buildNothingToDoBody({}, { totalFiles: 0, totalKeptDirs: 2 });
      expect(out).toEqual({
        message: 'Nothing to do.',
        detail: 'Nothing to move. 2 subfolders stay: they hold links or other items that are not moved.',
      });
    });

    it('mentions every skipped item when the selection has no folder', () => {
      const ctx = { selection: { skipped: [
        { path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' },
        { path: '/y.pdf', basename: 'y.pdf', reason: 'WRONG_TYPE' },
      ] } };
      const out = new FlattenFolder().buildNothingToDoBody(ctx, { totalFiles: 0 });
      expect(out.message).toBe('Nothing to process.');
      expect(out.detail.split('\n')).toEqual([
        'Flatten folder works only with folders.',
        'Selection contains 2 items that are not a folder:',
        '  • x.txt',
        '  • y.pdf',
      ]);
    });

    it('uses the singular for one skipped item and lists at most 10', () => {
      const one = { selection: { skipped: [{ path: '/x', basename: 'x' }] } };
      expect(new FlattenFolder().buildNothingToDoBody(one, {}).detail.split('\n')[1]).toBe('Selection contains 1 item that is not a folder:');
      const many = { selection: { skipped: Array.from({ length: 12 }, (_, i) => ({ path: `/f${i}`, basename: `f${i}` })) } };
      const lines = new FlattenFolder().buildNothingToDoBody(many, {}).detail.split('\n');
      expect(lines.filter((l) => l.startsWith('  • '))).toHaveLength(10);
      expect(lines.at(-1)).toBe('  … and 2 more');
    });
  });

  describe('confirm dialog', () => {
    it('offers both options, switched on', async () => {
      tree(tmp, { 'a/1.txt': '1' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      const out = plugin.buildConfirmMessage({}, pre);
      expect(out.options).toEqual([
        { name: 'keepHierarchy', label: 'Keep hierarchy — put folder names into file names', checked: true },
        { name: 'foldersFirst', label: 'Folders before files, as Explorer lists them', checked: true, disabled: false, nested: true },
      ]);
      expect(out).toMatchObject({ canContinue: true, runOptions: { keepHierarchy: true, foldersFirst: true, planId: pre.variants.tree.planId } });
    });

    it('greys out "folders first" while the hierarchy is off and keeps its value', async () => {
      tree(tmp, { 'a/1.txt': '1' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      const on = plugin.buildConfirmMessage({}, pre, FLAT);
      expect(on.options[1]).toMatchObject({ checked: true, disabled: true });
      const off = plugin.buildConfirmMessage({}, pre, { keepHierarchy: false, foldersFirst: false });
      expect(off.options.map((o) => o.checked)).toEqual([false, false]);
      expect(off.runOptions).toEqual({ keepHierarchy: false, foldersFirst: false, planId: pre.variants.flat.planId });
    });

    it('runs the variant that is shown', async () => {
      tree(tmp, { 'a/1.txt': '1', 'r.txt': 'r' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      const mixed = plugin.buildConfirmMessage({}, pre, MIXED);
      expect(mixed.runOptions).toEqual({ keepHierarchy: true, foldersFirst: false, planId: pre.variants.mixed.planId });
      expect(fileRows(mixed.table).map((r) => r.cells)).toEqual([[path.join('a', '1.txt'), 'a - 1.txt']]);
      const result = await plugin.run({ targets: [tmp], options: mixed.runOptions });
      expect(result.ok).toBe(true);
      expect(listFiles(tmp)).toEqual(['a - 1.txt', 'r.txt']);
    });

    it('shows no options when there is nothing to move', async () => {
      fs.mkdirSync(path.join(tmp, 'old', 'older'), { recursive: true });
      const plugin = new FlattenFolder();
      const out = plugin.buildConfirmMessage({}, await plugin.preflight({ targets: [tmp] }));
      expect(out.options).toBeUndefined();
      expect(out.table).toBeUndefined();
      expect(out.detail).toBeUndefined();
      expect(out.facts).toEqual([fact('Folder', tmp), fact('Subfolders', '2 empty, removed')]);
    });

    it('names one folder and shows every planned move as a table row', async () => {
      tree(tmp, { 'Lesson 1/Chapter 1.mp4': '', 'Lesson 1/Chapter 2.mp4': '', 'x/Chapter 1.mp4': '' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      const flat = plugin.buildConfirmMessage({}, pre, FLAT);
      expect(flat.message).toBe('Flatten this folder?');
      expect(flat.facts).toEqual([
        fact('Folder', tmp),
        fact('Files', '3 to move'),
        fact('Subfolders', '2 removed'),
        fact('Names', '1 gets a (N) suffix'),
        fact('On error', 'everything is put back'),
      ]);
      expect(flat.tableTitle).toBeUndefined();
      expect(flat.table).toEqual({
        columns: ['From', 'New name'],
        rows: [
          { group: `${path.basename(tmp)} — 3 files` },
          { cells: [path.join('Lesson 1', 'Chapter 1.mp4'), 'Chapter 1.mp4'], badges: [] },
          { cells: [path.join('Lesson 1', 'Chapter 2.mp4'), 'Chapter 2.mp4'], badges: [] },
          { cells: [path.join('x', 'Chapter 1.mp4'), 'Chapter 1 (2).mp4'], badges: ['suffix added'] },
        ],
      });
      const kept = plugin.buildConfirmMessage({}, pre);
      expect(fileRows(kept.table).map((r) => r.cells[1])).toEqual(['Lesson 1 - Chapter 1.mp4', 'Lesson 1 - Chapter 2.mp4', 'x - Chapter 1.mp4']);
      expect(kept.facts.map((f) => f.label)).toEqual(['Folder', 'Files', 'Subfolders', 'On error']);
    });

    it('explains the numbers and counts the renamed root files', async () => {
      tree(tmp, { 'intro.mp4': 'i', 'Lesson 1/a.mp4': 'a' });
      const plugin = new FlattenFolder();
      const out = plugin.buildConfirmMessage({}, await plugin.preflight({ targets: [tmp] }));
      expect(out.facts).toEqual([
        fact('Folder', tmp),
        fact('Files', '1 to move'),
        fact('Subfolders', '1 removed'),
        fact('Numbering', '001, 002… — names alone would change the order; 1 root file renamed too'),
        fact('On error', 'everything is put back'),
      ]);
      expect(out.table.rows[0]).toEqual({ group: `${path.basename(tmp)} — 1 file, numbered` });
      expect(fileRows(out.table).map((r) => r.cells)).toEqual([
        [path.join('Lesson 1', 'a.mp4'), '001 - Lesson 1 - a.mp4'],
        ['intro.mp4', '002 - intro.mp4'],
      ]);
    });

    it('groups the rows of several folders under a header per folder', () => {
      const pre = preWith([
        folderView('a', 1, { moves: [move('s/1.txt', '1.txt')] }),
        folderView('b', 2, { numbered: true, rowCount: 2, moves: [move('s/2.txt', '001 - 2.txt', { shortened: true })] }),
      ], { totalShortened: 1 }, { totalEmptyDirs: 1 });
      const out = new FlattenFolder().buildConfirmMessage({}, pre);
      expect(out.message).toBe('Flatten 2 folders?');
      expect(out.facts).toEqual([
        fact('Folders', '2'),
        fact('Files', '3 to move'),
        fact('Subfolders', '1 removed'),
        fact('Numbering', '1 of 2 folders: 001, 002… — names alone would change the order'),
        fact('Names', '1 shortened to fit'),
        fact('On error', 'everything is put back'),
      ]);
      expect(out.table.rows).toEqual([
        { group: 'a — 1 file' },
        { cells: ['s/1.txt', '1.txt'], badges: [] },
        { group: 'b — 2 files, numbered' },
        { cells: ['s/2.txt', '001 - 2.txt'], badges: ['shortened'] },
      ]);
      expect(out.table.footer).toBe('… and 1 more file');
    });

    it('groups real folders by name', async () => {
      const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-group-'));
      try {
        tree(tmp, { 'x/1.txt': '' });
        tree(second, { 'y/2.txt': '', 'y/3.txt': '' });
        const plugin = new FlattenFolder();
        const { table } = plugin.buildConfirmMessage({}, await plugin.preflight({ targets: [tmp, second] }));
        const groups = table.rows.filter((r) => r.group).map((r) => r.group);
        const expected = [[path.basename(tmp), '1 file'], [path.basename(second), '2 files']]
          .sort((a, b) => explorerCompare(a[0], b[0]))
          .map(([name, files]) => `${name} — ${files}`);
        expect(groups).toEqual(expected);
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });

    it('uses plural forms for bigger numbers', () => {
      const pre = preWith([
        folderView('a', 2, { numbered: true, moves: [move('s/1.txt', '001 - 1.txt')] }),
        folderView('b', 1, { numbered: true }),
      ], { totalCollisions: 2, totalShortened: 2, totalRenamedInRoot: 2 }, { totalEmptyDirs: 2 });
      const out = new FlattenFolder().buildConfirmMessage({}, pre);
      expect(out.facts).toContainEqual(fact('Subfolders', '2 removed'));
      expect(out.facts).toContainEqual(fact('Numbering', '2 of 2 folders: 001, 002… — names alone would change the order; 2 root files renamed too'));
      expect(out.facts).toContainEqual(fact('Names', '2 shortened to fit, 2 get a (N) suffix'));
      expect(out.table.rows[0]).toEqual({ group: 'a — 2 files, numbered' });
      expect(out.table.footer).toBe('… and 2 more files');
    });

    it('says which subfolders stay because they hold links', () => {
      const facts = (extra) => new FlattenFolder().buildConfirmMessage({}, preWith([folderView('a', 1)], {}, extra)).facts;
      expect(facts({ totalKeptDirs: 1 })).toContainEqual(fact('Subfolders', '1 kept (holds links)'));
      expect(facts({ totalKeptDirs: 2, totalEmptyDirs: 3 })).toContainEqual(fact('Subfolders', '3 removed, 2 kept (hold links)'));
    });

    it('names the selected folders that lie inside another selected folder', () => {
      const pre = preWith([folderView('A', 1)], {}, { insideOthers: ['B', 'C'] });
      expect(new FlattenFolder().buildConfirmMessage({}, pre).facts)
        .toContainEqual(fact('Included', 'B, C — inside another selected folder'));
    });

    it('names at most five skipped items', () => {
      const skipped = Array.from({ length: 7 }, (_, i) => ({ path: `/file${i}`, basename: `file${i}`, reason: 'WRONG_TYPE' }));
      const out = new FlattenFolder().buildConfirmMessage({ selection: { skipped } }, preWith([folderView('a', 1)]));
      expect(out.facts.at(-1)).toEqual(fact('Skipped', '7 not folders: file0, file1, file2, file3, file4 +2 more'));
    });

    it('uses the singular for one skipped item', () => {
      const skipped = [{ path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' }];
      const out = new FlattenFolder().buildConfirmMessage({ selection: { skipped } }, preWith([folderView('a', 1)]));
      expect(out.facts.at(-1)).toEqual(fact('Skipped', '1 not a folder: x.txt'));
    });

    describe('when the chosen names do not fit', () => {
      // Leaves 10 characters for a name in the root.
      const shortRoot = () => path.join(tmp, 'r'.repeat(248 - tmp.length - 1));

      it('blocks Continue and suggests turning the hierarchy off when that helps', async () => {
        const root = shortRoot();
        tree(root, { 'folderA/z.txt': 'z', 'folderB/a.txt': 'a' });
        const plugin = new FlattenFolder();
        const pre = await plugin.preflight({ targets: [root] });
        const out = plugin.buildConfirmMessage({}, pre);
        expect(out.canContinue).toBe(false);
        expect(out.message).toBe('Flatten this folder?');
        expect(out.facts).toEqual([
          fact('Folder', root),
          fact('Problem', '2 files do not fit the 259-character path limit', 'warn'),
          fact('Fix', 'turn off "Keep hierarchy"'),
        ]);
        expect(out.tableTitle).toBe('Files that do not fit');
        expect(out.table.columns).toEqual(['File', 'Problem']);
        expect(out.table.rows[0]).toEqual({ group: path.basename(root) });
        expect(fileRows(out.table).map((r) => r.cells[0])).toEqual([path.join('folderA', 'z.txt'), path.join('folderB', 'a.txt')]);
        expect(out.options).toHaveLength(2);
        const flat = plugin.buildConfirmMessage({}, pre, FLAT);
        expect(flat.canContinue).toBe(true);
        expect(fileRows(flat.table).map((r) => r.cells[1])).toEqual(['z.txt', 'a.txt']);
      });

      it('suggests a shorter folder path when no option helps', async () => {
        const root = shortRoot();
        tree(root, { 'sub/b.abcdefghijklmn': 'b' });
        const plugin = new FlattenFolder();
        const pre = await plugin.preflight({ targets: [root] });
        for (const options of [{}, FLAT]) {
          const out = plugin.buildConfirmMessage({ selection: { skipped: [{ basename: 'f.txt' }] } }, pre, options);
          expect(out.canContinue).toBe(false);
          expect(out.facts).toEqual([
            fact('Folder', root),
            fact('Problem', '1 file does not fit the 259-character path limit', 'warn'),
            fact('Fix', 'move the folder closer to the drive root, e.g. D:\\Temp'),
            fact('Skipped', '1 not a folder: f.txt'),
          ]);
        }
      });

      it('groups the problems of several folders and caps the rows', () => {
        const many = Array.from({ length: 1000 }, (_, i) => ({ file: `${i}.txt`, message: 'No room' }));
        const blocked = preWith([folderView('a', 0, { blocked: many, blockedCount: 1001 }), folderView('b', 0)], { totalBlocked: 1001 });
        const out = new FlattenFolder().buildConfirmMessage({}, blocked);
        expect(out.facts.slice(0, 2)).toEqual([
          fact('Folders', '2'),
          fact('Problem', '1001 files do not fit the 259-character path limit', 'warn'),
        ]);
        expect(out.table.rows[0]).toEqual({ group: 'a' });
        expect(out.table.rows).toHaveLength(1001);
        expect(out.table.footer).toBe('… and 1 more file');
      });
    });
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
      expect(out.table).toEqual({ columns: ['File', 'Problem'], rows: [{ group: 'a' }, { cells: [failure.file, failure.message] }] });
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
      expect(out.table.rows).toHaveLength(1001);
      expect(out.table.rows[0]).toEqual({ group: 'a' });
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
      expect(out.table.rows).toEqual([{ group: 'a' }, { cells: ['x.txt', 'No room'] }]);
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
