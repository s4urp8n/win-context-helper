const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');

const FLAT = { keepHierarchy: false };

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content !== null) fs.writeFileSync(full, content);
    else fs.mkdirSync(full);
  }
}

// Every file and folder under `dir` as "rel/path=content" or "rel/path/", sorted.
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.isDirectory()) { out.push(`${rel}/`); walk(full); } else out.push(`${rel}=${fs.readFileSync(full, 'utf8')}`);
    }
  })(dir);
  return out.sort();
}

const busy = (message = 'EBUSY: resource busy or locked') => Object.assign(new Error(message), { code: 'EBUSY' });

describe('Flatten folder is all-or-nothing', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-safe-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('puts every moved file back when a later file cannot be moved', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2', 'b/3.txt': '3', 'empty': null });
    const before = snapshot(tmp);
    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls === 3) throw busy();
      return realRename(from, to);
    });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result).toMatchObject({ ok: false, processed: 0, moved: 2, notRestored: [] });
    expect(result.errors).toEqual([{ folder: path.basename(tmp), file: path.join('b', '3.txt'), message: 'The file is open in another program (EBUSY)' }]);
    expect(snapshot(tmp)).toEqual(before);
  });

  it('gives renamed root files their old names back when a later rename fails', async () => {
    tree(tmp, { '0 a.txt': 'a', '0 b.txt': 'b', 'x/1.txt': '1' });
    const before = snapshot(tmp);
    const realRename = fs.renameSync;
    const renamed = [];
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (++calls === 3) throw busy();
      renamed.push(path.basename(to));
      return realRename(from, to);
    });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(renamed).toEqual(['001 - x - 1.txt', '002 - 0 a.txt', '0 a.txt', '1.txt']);
    expect(result).toMatchObject({ ok: false, processed: 0, moved: 2, notRestored: [] });
    expect(result.errors).toEqual([{ folder: path.basename(tmp), file: '0 b.txt', message: 'The file is open in another program (EBUSY)' }]);
    expect(snapshot(tmp)).toEqual(before);
  });

  it('rolls back the folders that were already done when a later folder fails', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-safe-second-'));
    try {
      tree(tmp, { 'x/1.txt': '1', 'keep-me': null });
      tree(second, { 'y/2.txt': '2' });
      const before = [snapshot(tmp), snapshot(second)];
      const realRename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (from.startsWith(second)) throw busy();
        return realRename(from, to);
      });
      const result = await new FlattenFolder().run({ targets: [tmp, second] });
      expect(result.ok).toBe(false);
      expect([snapshot(tmp), snapshot(second)]).toEqual(before);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('reports where a file stayed when it cannot be put back', async () => {
    tree(tmp, { 'Lesson 1/a.txt': 'a', 'Lesson 1/b.txt': 'b' });
    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls >= 2) throw busy();
      return realRename(from, to);
    });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result).toMatchObject({ ok: false, processed: 1, moved: 1 });
    expect(result.notRestored).toEqual([{
      folder: path.basename(tmp),
      file: path.join('Lesson 1', 'a.txt'),
      location: 'Lesson 1 - a.txt',
      message: 'The file is open in another program (EBUSY)',
    }]);
    expect(fs.readFileSync(path.join(tmp, 'Lesson 1 - a.txt'), 'utf8')).toBe('a');
    expect(fs.readFileSync(path.join(tmp, 'Lesson 1', 'b.txt'), 'utf8')).toBe('b');
  });

  it('never overwrites a file that appeared in the root after planning', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    let created = false;
    const result = await new FlattenFolder().run({
      targets: [tmp],
      options: FLAT,
      onProgress: () => {
        if (created) return;
        created = true;
        fs.writeFileSync(path.join(tmp, '2.txt'), 'newcomer');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{ folder: path.basename(tmp), file: path.join('a', '2.txt'), message: 'A file with this name already exists (EEXIST)' }]);
    expect(fs.readFileSync(path.join(tmp, '2.txt'), 'utf8')).toBe('newcomer');
    expect(snapshot(tmp)).toEqual(['2.txt=newcomer', 'a/', 'a/1.txt=1', 'a/2.txt=2']);
  });

  it('never overwrites a newcomer whose name differs only by case', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/photo.jpg': 'nested' });
    let created = false;
    const result = await new FlattenFolder().run({
      targets: [tmp],
      options: FLAT,
      onProgress: () => {
        if (created) return;
        created = true;
        fs.writeFileSync(path.join(tmp, 'PHOTO.JPG'), 'newcomer');
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'PHOTO.JPG'), 'utf8')).toBe('newcomer');
    expect(fs.readFileSync(path.join(tmp, 'a', 'photo.jpg'), 'utf8')).toBe('nested');
  });

  it('never replaces a dangling link that took a target name', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-gone-'));
    let linked = false;
    const result = await new FlattenFolder().run({
      targets: [tmp],
      options: FLAT,
      onProgress: () => {
        if (linked) return;
        linked = true;
        fs.symlinkSync(gone, path.join(tmp, '2.txt'), 'junction');
        fs.rmdirSync(gone);
      },
    });
    expect(result.errors[0].message).toBe('A file with this name already exists (EEXIST)');
    expect(fs.lstatSync(path.join(tmp, '2.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'a', '2.txt'), 'utf8')).toBe('2');
  });

  it('moves nothing when it cannot tell whether a target name is free', async () => {
    tree(tmp, { 'a/1.txt': '1' });
    const before = snapshot(tmp);
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, lstat'), { code: 'EPERM' });
    });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    vi.restoreAllMocks();
    expect(result.errors[0].message).toBe('Access denied — the file may be open or read-only (EPERM)');
    expect(snapshot(tmp)).toEqual(before);
  });

  it('does not pick a name that is the short 8.3 alias of a root file', async () => {
    tree(tmp, { 'longfilename-number-one.txt': 'root', 'sub/LONGFI~1.TXT': 'nested' });
    const alias = path.join(tmp, 'LONGFI~1.TXT');
    const realLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p, options) => (p === alias ? realLstat(tmp) : realLstat(p, options)));
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(pre.variants.flat.folders[0].moves[0]).toMatchObject({ to: 'LONGFI~1 (2).TXT', renamed: true });
    const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
    vi.restoreAllMocks();
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'LONGFI~1 (2).TXT'), 'utf8')).toBe('nested');
    expect(fs.readFileSync(path.join(tmp, 'longfilename-number-one.txt'), 'utf8')).toBe('root');
  });

  it('does not put a file back over one that took its old place', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls === 1) {
        realRename(from, to);
        fs.writeFileSync(from, 'intruder');
        return undefined;
      }
      throw busy();
    });
    const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
    expect(result.notRestored).toEqual([{ folder: path.basename(tmp), file: path.join('a', '1.txt'), location: '1.txt', message: 'A file with this name already exists (EEXIST)' }]);
    expect(fs.readFileSync(path.join(tmp, 'a', '1.txt'), 'utf8')).toBe('intruder');
    expect(fs.readFileSync(path.join(tmp, '1.txt'), 'utf8')).toBe('1');
  });

  it('recreates a source folder that disappeared before putting the file back', async () => {
    tree(tmp, { 'a/1.txt': '1', 'b/2.txt': '2' });
    const realRename = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls === 2) {
        fs.rmdirSync(path.join(tmp, 'a'));
        throw busy();
      }
      return realRename(from, to);
    });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result.notRestored).toEqual([]);
    expect(snapshot(tmp)).toEqual(['a/', 'a/1.txt=1', 'b/', 'b/2.txt=2']);
  });

  it('shows an unknown error as is', async () => {
    tree(tmp, { 'a/1.txt': '1' });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk on fire'); });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result.errors).toEqual([{ folder: path.basename(tmp), file: path.join('a', '1.txt'), message: 'disk on fire' }]);
  });

  const failWith = (code, reason) => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error(`${code}: ${reason}, rename 'x' -> 'y'`), { code });
    });
  };

  it.each([
    ['EPERM', 'Access denied — the file may be open or read-only (EPERM)'],
    ['EACCES', 'Access denied (EACCES)'],
    ['ENOENT', 'The file was moved or deleted (ENOENT)'],
    ['ENAMETOOLONG', 'The name is too long (ENAMETOOLONG)'],
  ])('describes %s in plain words', async (code, text) => {
    tree(tmp, { 'a/1.txt': '1' });
    failWith(code, 'some reason');
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result.errors[0].message).toBe(text);
  });

  it('keeps only the reason of an unknown error code', async () => {
    tree(tmp, { 'a/1.txt': '1' });
    failWith('EXDEV', 'cross-device link not permitted');
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result.errors[0].message).toBe('EXDEV: cross-device link not permitted');
  });

  it('reports success when leftover folders cannot be cleaned up', async () => {
    tree(tmp, { 'a/1.txt': '1' });
    const realReaddir = fs.readdirSync;
    let moving = false;
    vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (moving) throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' });
      return realReaddir(...args);
    });
    const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT, onProgress: () => { moving = true; } });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ ok: true, processed: 1, errors: [] });
    expect(fs.readFileSync(path.join(tmp, '1.txt'), 'utf8')).toBe('1');
  });
});

describe('Flatten folder with overlapping selections', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-overlap-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flattens a folder once when its subfolder is selected too', async () => {
    tree(tmp, { 'A/B/C/1.txt': '1', 'A/B/2.txt': '2', 'A/x/3.txt': '3', 'A/B/empty': null });
    const targets = [path.join(tmp, 'A', 'B'), path.join(tmp, 'A')];
    const plugin = new FlattenFolder();
    const pre = await plugin.preflight({ targets });
    expect(pre.totalFiles).toBe(3);
    expect(pre.variants.flat.folders.map((f) => f.basename)).toEqual(['A']);
    expect(pre.insideOthers).toEqual(['B']);
    const result = await plugin.run({ targets, options: FLAT });
    expect(result).toMatchObject({ ok: true, processed: 3 });
    expect(snapshot(path.join(tmp, 'A'))).toEqual(['1.txt=1', '2.txt=2', '3.txt=3']);
  });

  it('flattens a folder once when it is selected twice', async () => {
    tree(tmp, { 'A/x/1.txt': '1' });
    const folder = path.join(tmp, 'A');
    const targets = [folder, `${folder.toUpperCase()}${path.sep}`];
    const pre = await new FlattenFolder().preflight({ targets });
    expect(pre).toMatchObject({ totalFiles: 1, insideOthers: [] });
    const result = await new FlattenFolder().run({ targets, options: FLAT });
    expect(result).toMatchObject({ ok: true, processed: 1 });
    expect(snapshot(folder)).toEqual(['1.txt=1']);
  });

  it('flattens both folders whose names differ only by ß and ss', async () => {
    tree(tmp, { 'Straße/x/1.txt': '1', 'Strasse/y/2.txt': '2' });
    const targets = [path.join(tmp, 'Straße'), path.join(tmp, 'Strasse')];
    const pre = await new FlattenFolder().preflight({ targets });
    expect(pre).toMatchObject({ totalFiles: 2, insideOthers: [] });
    const result = await new FlattenFolder().run({ targets, options: FLAT });
    expect(result).toMatchObject({ ok: true, processed: 2 });
    expect(snapshot(tmp)).toEqual(['Strasse/', 'Strasse/2.txt=2', 'Straße/', 'Straße/1.txt=1']);
  });

  it('treats a subfolder reached through a junction as part of the selected folder', async () => {
    tree(tmp, { 'A/sub/1.txt': '1' });
    const link = path.join(tmp, 'link');
    fs.symlinkSync(path.join(tmp, 'A'), link, 'junction');
    const targets = [path.join(tmp, 'A'), path.join(link, 'sub')];
    const pre = await new FlattenFolder().preflight({ targets });
    expect(pre).toMatchObject({ totalFiles: 1, insideOthers: ['sub'] });
    const result = await new FlattenFolder().run({ targets, options: FLAT });
    expect(result).toMatchObject({ ok: true, processed: 1 });
    expect(snapshot(path.join(tmp, 'A'))).toEqual(['1.txt=1']);
  });

  describe('where the file system reports no file ids', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    function withoutFileIds(unreadable = () => false) {
      const realStat = fs.statSync;
      vi.spyOn(fs, 'statSync').mockImplementation((p, options) => {
        if (unreadable(p)) throw Object.assign(new Error('EACCES: permission denied, stat'), { code: 'EACCES' });
        const stats = realStat(p, options);
        return options && options.bigint ? { dev: stats.dev, ino: 0n } : stats;
      });
    }

    it('compares the folder paths instead', async () => {
      tree(tmp, { 'A/B/1.txt': '1', 'A/x/2.txt': '2' });
      withoutFileIds();
      const folder = path.join(tmp, 'A');
      const pre = await new FlattenFolder().preflight({ targets: [folder, `${folder}${path.sep}`, path.join(folder, 'B')] });
      expect(pre).toMatchObject({ totalFiles: 2, insideOthers: ['B'] });
      expect(pre.variants.tree.folders.map((f) => f.basename)).toEqual(['A']);
    });

    it('still recognizes a nested folder when an outer parent cannot be read', async () => {
      tree(tmp, { 'A/B/1.txt': '1' });
      withoutFileIds((p) => p === tmp);
      const targets = [path.join(tmp, 'A'), path.join(tmp, 'A', 'B')];
      const pre = await new FlattenFolder().preflight({ targets });
      expect(pre).toMatchObject({ totalFiles: 1, insideOthers: ['B'] });
    });
  });

  it('flattens folders that only share the beginning of their names', async () => {
    tree(tmp, { 'A/x/1.txt': '1', 'AB/y/2.txt': '2' });
    const targets = [path.join(tmp, 'A'), path.join(tmp, 'AB')];
    const result = await new FlattenFolder().run({ targets, options: FLAT });
    expect(result).toMatchObject({ ok: true, processed: 2 });
    expect(snapshot(tmp)).toEqual(['A/', 'A/1.txt=1', 'AB/', 'AB/2.txt=2']);
  });
});

describe('Flatten folder runs only the plan shown in the preview', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-plan-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('runs the plan that was previewed', async () => {
    tree(tmp, { 'a/1.txt': '1', 'b/c': null });
    const plugin = new FlattenFolder();
    const { planId } = (await plugin.preflight({ targets: [tmp] })).variants.tree;
    const result = await plugin.run({ targets: [tmp], options: { planId } });
    expect(result).toMatchObject({ ok: true, processed: 1 });
    expect(snapshot(tmp)).toEqual(['a - 1.txt=1']);
  });

  it('moves nothing when the options differ from the previewed ones', async () => {
    tree(tmp, { 'a/1.txt': '1' });
    const plugin = new FlattenFolder();
    const { planId } = (await plugin.preflight({ targets: [tmp] })).variants.tree;
    const before = snapshot(tmp);
    const result = await plugin.run({ targets: [tmp], options: { keepHierarchy: false, planId } });
    expect(result).toMatchObject({ ok: false, stale: true, moved: 0 });
    expect(snapshot(tmp)).toEqual(before);
  });

  it.each([
    ['a file was added', (dir) => tree(dir, { 'a/2.txt': '2' })],
    ['an empty folder was added', (dir) => tree(dir, { 'd': null })],
    ['a root file took a planned name', (dir) => tree(dir, { 'a - 1.txt': 'root' })],
  ])('moves nothing when %s after the preview', async (_, change) => {
    tree(tmp, { 'a/1.txt': '1' });
    const plugin = new FlattenFolder();
    const { planId } = (await plugin.preflight({ targets: [tmp] })).variants.tree;
    change(tmp);
    const before = snapshot(tmp);
    const result = await plugin.run({ targets: [tmp], options: { planId } });
    expect(result).toMatchObject({ ok: false, stale: true, processed: 0, errors: [], moved: 0, notRestored: [] });
    expect(snapshot(tmp)).toEqual(before);
  });
});

describe('Flatten folder removes empty subfolders', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-empty-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('removes subfolders that were already empty', async () => {
    tree(tmp, { 'a/1.txt': '1', 'old': null, 'deep/er/est': null, 'root.txt': 'r' });
    const plugin = new FlattenFolder();
    const pre = await plugin.preflight({ targets: [tmp] });
    expect(pre.totalEmptyDirs).toBe(5);
    await plugin.run({ targets: [tmp], options: FLAT });
    expect(snapshot(tmp)).toEqual(['1.txt=1', 'root.txt=r']);
  });

  it('keeps the selected folder itself when it held only empty subfolders', async () => {
    tree(tmp, { 'old/older': null });
    const result = await new FlattenFolder().run({ targets: [tmp] });
    expect(result.ok).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('still has work when the only thing to do is removing empty subfolders', async () => {
    tree(tmp, { 'root.txt': 'r', 'old/older': null });
    const plugin = new FlattenFolder();
    const pre = await plugin.preflight({ targets: [tmp] });
    expect(pre).toMatchObject({ totalFiles: 0, totalEmptyDirs: 2 });
    expect(plugin.isEmpty({}, pre)).toBe(false);
    const result = await plugin.run({ targets: [tmp] });
    expect(result).toMatchObject({ ok: true, processed: 0, errors: [] });
    expect(snapshot(tmp)).toEqual(['root.txt=r']);
  });

  it('keeps a subfolder that holds something other than files and folders', async () => {
    tree(tmp, { 'target/t.txt': 't', 'holder/inner': null });
    fs.symlinkSync(path.join(tmp, 'target'), path.join(tmp, 'holder', 'link'), 'junction');
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(pre.totalEmptyDirs).toBe(2);
    expect(pre.totalKeptDirs).toBe(1);
    await new FlattenFolder().run({ targets: [tmp] });
    expect(fs.lstatSync(path.join(tmp, 'holder', 'link')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'holder', 'inner'))).toBe(false);
  });
});
