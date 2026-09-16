const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');
const { explorerCompare } = require('../../src/main/utils/explorer-compare');

const MIXED = { foldersFirst: false };
const onWindows = it.runIf(process.platform === 'win32');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// The root as Explorer lists it by name: file names, and file contents in that order.
const namesInExplorerOrder = (dir) => fs.readdirSync(dir).sort(explorerCompare);
const contentsInExplorerOrder = (dir) => namesInExplorerOrder(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));

async function flatten(dir, options) {
  const plugin = new FlattenFolder();
  const pre = await plugin.preflight({ targets: [dir] });
  const { runOptions } = plugin.buildConfirmMessage({}, pre, options);
  const result = await plugin.run({ targets: [dir], options: runOptions });
  expect(result).toMatchObject({ ok: true, errors: [] });
  return pre.variants[options && options.foldersFirst === false ? 'mixed' : 'tree'];
}

// Shaped after a real course: files in the root next to module folders, and a module where
// a lesson folder sits among lesson files.
const COURSE = {
  '!.1 Приветствие.mkv': 'hello',
  '!.2 Домашнее задание №1.mkv': 'homework',
  'Заключение курса.mkv': 'outro',
  'Модуль 0.  Для новичков - Мобилка/М0. ! Вступление к курсу.mp4': 'm0 intro',
  'Модуль 0.  Для новичков - Мобилка/М0.0 Вступительная часть.mkv': 'm0.0',
  'Модуль 2.  Съёмка/М2.0 Вступительная часть.mkv': 'm2.0',
  'Модуль 2.  Съёмка/М2.3 Как снимать монтажно/Lec 2.2 Sample 1.mp4': 'm2.3 sample',
  'Модуль 2.  Съёмка/М2.3 Как снимать монтажно_.mkv': 'm2.3',
  'Модуль 2.  Съёмка/М2.10 Работа с фокуспуллером.mkv': 'm2.10',
};

describe('Flatten folder keeping the hierarchy', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hierarchy-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('prefixes each nested file with its folder path at any depth', async () => {
    tree(tmp, { 'Part A/Lesson 1/Topic/clip.mp4': 'deep', '1/file': 'from 1' });
    const view = await flatten(tmp);
    expect(view.folders[0].numbered).toBe(false);
    expect(namesInExplorerOrder(tmp)).toEqual(['1 - file', 'Part A - Lesson 1 - Topic - clip.mp4']);
  });

  it.each([['folders first', {}], ['mixed', MIXED]])('keeps a course in lesson order without numbers (%s)', async (_, options) => {
    tree(tmp, {
      'Lesson 10/Chapter 1.mp4': 'L10 C1',
      'Lesson 2/Chapter 1.mp4': 'L2 C1',
      'Lesson 1/Chapter 2.mp4': 'L1 C2',
      'Lesson 1/Chapter 1.mp4': 'L1 C1',
    });
    const view = await flatten(tmp, options);
    expect(view.folders[0]).toMatchObject({ numbered: false, renamedInRootCount: 0 });
    expect(namesInExplorerOrder(tmp)).toEqual([
      'Lesson 1 - Chapter 1.mp4',
      'Lesson 1 - Chapter 2.mp4',
      'Lesson 2 - Chapter 1.mp4',
      'Lesson 10 - Chapter 1.mp4',
    ]);
    expect(contentsInExplorerOrder(tmp)).toEqual(['L1 C1', 'L1 C2', 'L2 C1', 'L10 C1']);
  });

  it('lists the folders before the root files, as Explorer did, and numbers every file for that', async () => {
    tree(tmp, COURSE);
    const view = await flatten(tmp);
    expect(view.folders[0]).toMatchObject({ numbered: true, fileCount: 6, renamedInRootCount: 3 });
    expect(namesInExplorerOrder(tmp)).toEqual([
      '001 - Модуль 0.  Для новичков - Мобилка - М0. ! Вступление к курсу.mp4',
      '002 - Модуль 0.  Для новичков - Мобилка - М0.0 Вступительная часть.mkv',
      '003 - Модуль 2.  Съёмка - М2.3 Как снимать монтажно - Lec 2.2 Sample 1.mp4',
      '004 - Модуль 2.  Съёмка - М2.0 Вступительная часть.mkv',
      '005 - Модуль 2.  Съёмка - М2.3 Как снимать монтажно_.mkv',
      '006 - Модуль 2.  Съёмка - М2.10 Работа с фокуспуллером.mkv',
      '007 - !.1 Приветствие.mkv',
      '008 - !.2 Домашнее задание №1.mkv',
      '009 - Заключение курса.mkv',
    ]);
  });

  it('mixes folders and files by name when folders do not come first, and needs no numbers then', async () => {
    tree(tmp, COURSE);
    const view = await flatten(tmp, MIXED);
    expect(view.folders[0]).toMatchObject({ numbered: false, fileCount: 6, renamedInRootCount: 0 });
    expect(contentsInExplorerOrder(tmp)).toEqual([
      'hello', 'homework', 'outro', 'm0 intro', 'm0.0', 'm2.0', 'm2.3 sample', 'm2.3', 'm2.10',
    ]);
    expect(namesInExplorerOrder(tmp).slice(0, 4)).toEqual([
      '!.1 Приветствие.mkv',
      '!.2 Домашнее задание №1.mkv',
      'Заключение курса.mkv',
      'Модуль 0.  Для новичков - Мобилка - М0. ! Вступление к курсу.mp4',
    ]);
  });

  it('numbers a folder whose subfolder sits among its files only when folders come first', async () => {
    tree(tmp, { 'M/a.mp4': 'a', 'M/b/x.mp4': 'bx', 'M/c.mp4': 'c' });
    const first = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(first.variants.tree.folders[0].numbered).toBe(true);
    expect(first.variants.mixed.folders[0].numbered).toBe(false);
    await flatten(tmp);
    expect(contentsInExplorerOrder(tmp)).toEqual(['bx', 'a', 'c']);
  });

  it('keeps root files untouched when their names already come first', async () => {
    tree(tmp, { 'intro.mp4': 'intro', 'Lesson 1/a.mp4': 'a' });
    const view = await flatten(tmp, MIXED);
    expect(view.folders[0].numbered).toBe(false);
    expect(namesInExplorerOrder(tmp)).toEqual(['intro.mp4', 'Lesson 1 - a.mp4']);
  });

  it('keeps root files untouched when their names already come last', async () => {
    tree(tmp, { 'zz outro.mp4': 'outro', 'Lesson 1/a.mp4': 'a' });
    const view = await flatten(tmp);
    expect(view.folders[0]).toMatchObject({ numbered: false, renamedInRootCount: 0 });
    expect(contentsInExplorerOrder(tmp)).toEqual(['a', 'outro']);
  });

  it('numbers only the selected folders whose names cannot keep the order', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hierarchy-second-'));
    try {
      tree(tmp, { 'intro.mp4': 'intro', 'Lesson 1/a.mp4': 'a' });
      tree(second, { 'Lesson 1/a.mp4': 'a' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp, second] });
      const numbered = Object.fromEntries(pre.variants.tree.folders.map((f) => [f.path, f.numbered]));
      expect(numbered).toEqual({ [tmp]: true, [second]: false });
      const result = await plugin.run({ targets: [tmp, second] });
      expect(result.ok).toBe(true);
      expect(namesInExplorerOrder(tmp)).toEqual(['001 - Lesson 1 - a.mp4', '002 - intro.mp4']);
      expect(namesInExplorerOrder(second)).toEqual(['Lesson 1 - a.mp4']);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  onWindows('orders a video before its subtitles, as Windows does', async () => {
    tree(tmp, { 'L/X_en.vtt': 'subtitles', 'L/X.mp4': 'video', '0 intro.txt': 'intro' });
    await flatten(tmp);
    expect(namesInExplorerOrder(tmp)).toEqual(['001 - L - X.mp4', '002 - L - X_en.vtt', '003 - 0 intro.txt']);
  });

  onWindows('needs no numbers for files of one folder whose names compare equal', async () => {
    // Windows ignores a soft hyphen, so the two names compare equal.
    tree(tmp, { 'k/ab.txt': 'plain', 'k/a\u00ADb.txt': 'soft', 'z/c.txt': 'c' });
    expect(explorerCompare('k - ab.txt', 'k - a\u00ADb.txt')).toBe(0);
    const view = await flatten(tmp);
    expect(view.folders[0].numbered).toBe(false);
    expect(contentsInExplorerOrder(tmp).at(-1)).toBe('c');
  });

  it('numbers the files when a name taken in the root would change the order', async () => {
    tree(tmp, { 'v1.2/readme': 'nested', 'v1.2 - readme': 'root' });
    const view = await flatten(tmp);
    expect(view.folders[0].numbered).toBe(true);
    expect(contentsInExplorerOrder(tmp)).toEqual(['nested', 'root']);
  });

  it('adds a (N) suffix when the prefixed name is already taken and the order still holds', async () => {
    tree(tmp, { 'Lesson 1 - a.mp4': 'root', 'Lesson 1/a.mp4': 'nested' });
    const view = await flatten(tmp);
    expect(view).toMatchObject({ totalCollisions: 1 });
    expect(view.folders[0].numbered).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'Lesson 1 - a.mp4'), 'utf8')).toBe('root');
    expect(fs.readFileSync(path.join(tmp, 'Lesson 1 - a (2).mp4'), 'utf8')).toBe('nested');
  });

  it('never gives a numbered name that a root entry already has', async () => {
    tree(tmp, { 'a/x.txt': 'nested', '001 - a - x.txt': 'root' });
    const view = await flatten(tmp);
    expect(view.folders[0].moves.map((m) => [m.from, m.to, m.renamed])).toEqual([
      [path.join('a', 'x.txt'), '001 - a - x (2).txt', true],
      ['001 - a - x.txt', '002 - 001 - a - x.txt', false],
    ]);
    expect(contentsInExplorerOrder(tmp)).toEqual(['nested', 'root']);
  });

  it('does not treat the dot of a folder name as the start of an extension', async () => {
    tree(tmp, { 'v1.2/readme': 'nested' });
    await flatten(tmp);
    expect(namesInExplorerOrder(tmp)).toEqual(['v1.2 - readme']);
  });

  it('treats names that differ only by a final sigma as the same name', async () => {
    // Lower-casing turns the Σ before a space into the final ς, NTFS upper-cases both to Σ.
    tree(tmp, { 'ΑΣ/x.txt': 'upper', 'ασ - x.txt': 'root' });
    const view = await flatten(tmp);
    expect(view.totalCollisions).toBe(1);
    expect(fs.readFileSync(path.join(tmp, 'ΑΣ - x (2).txt'), 'utf8')).toBe('upper');
    expect(fs.readFileSync(path.join(tmp, 'ασ - x.txt'), 'utf8')).toBe('root');
  });

  it('builds the prefix relative to each selected folder', async () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hierarchy-second-'));
    try {
      tree(tmp, { 'x/f.txt': 'first' });
      tree(second, { 'y/f.txt': 'second' });
      await new FlattenFolder().run({ targets: [tmp, second] });
      expect(namesInExplorerOrder(tmp)).toEqual(['x - f.txt']);
      expect(namesInExplorerOrder(second)).toEqual(['y - f.txt']);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('renames nothing in a folder that is already flat', async () => {
    tree(tmp, { 'b.txt': 'b', 'a.txt': 'a' });
    const plugin = new FlattenFolder();
    const pre = await plugin.preflight({ targets: [tmp] });
    expect(plugin.isEmpty({}, pre)).toBe(true);
    expect(pre.variants.tree).toMatchObject({ totalRows: 0, totalRenamedInRoot: 0 });
    const result = await plugin.run({ targets: [tmp] });
    expect(result).toMatchObject({ ok: true, processed: 0 });
    expect(namesInExplorerOrder(tmp)).toEqual(['a.txt', 'b.txt']);
  });

  it('flattens a folder that was already partly flattened', async () => {
    tree(tmp, {
      'Модуль 0 - 1. Вступление.mp4': 'm0.1',
      'Модуль 0 - 2. Интерфейс.mp4': 'm0.2',
      'Заключение курса.mp4': 'outro',
      'Модуль 1/1. Монтаж.mp4': 'm1.1',
      'Модуль 1/2. Звук/Принципы.mp4': 'm1.2',
    });
    const view = await flatten(tmp);
    expect(view.folders[0].numbered).toBe(true);
    expect(contentsInExplorerOrder(tmp)).toEqual(['m1.2', 'm1.1', 'outro', 'm0.1', 'm0.2']);
  });
});

describe('Flatten folder at any depth', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-deep-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // Twelve levels; every level has files before and after its subfolder by name, and every
  // other level a second branch. Each file holds its own relative path.
  function deepLayout(depth, part = (i) => `L${i}`) {
    const layout = { 'root a.txt': '', 'root z.txt': '' };
    let dir = '';
    for (let i = 1; i <= depth; i++) {
      dir = dir ? `${dir}/${part(i)}` : part(i);
      layout[`${dir}/A${i}.txt`] = '';
      layout[`${dir}/Z${i}.txt`] = '';
      if (i % 2 === 0) layout[`${dir}/B${i} branch/b${i}.txt`] = '';
    }
    for (const rel of Object.keys(layout)) layout[rel] = path.join(...rel.split('/'));
    return layout;
  }

  // The order Explorer shows level by level, read from disk before the run.
  function originalOrder(root, foldersFirst) {
    const out = [];
    (function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => explorerCompare(a.name, b.name));
      const ordered = foldersFirst ? [...entries.filter((e) => e.isDirectory()), ...entries.filter((e) => e.isFile())] : entries;
      for (const e of ordered) {
        if (e.isDirectory()) walk(path.join(dir, e.name)); else out.push(path.relative(root, path.join(dir, e.name)));
      }
    })(root);
    return out;
  }

  const onlyFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).every((e) => e.isFile());

  it.each([
    ['folders first', {}, true],
    ['mixed', MIXED, false],
  ])('keeps the original order through twelve levels (%s)', async (_, options, foldersFirst) => {
    tree(tmp, deepLayout(12));
    const expected = originalOrder(tmp, foldersFirst);
    expect(expected).toHaveLength(2 + 12 * 2 + 6);
    await flatten(tmp, options);
    expect(onlyFiles(tmp)).toBe(true);
    expect(contentsInExplorerOrder(tmp)).toEqual(expected);
    const deepest = namesInExplorerOrder(tmp).find((n) => n.includes('Z12.txt'));
    expect(deepest).toContain(Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join(' - '));
  });

  it('moves every file of a deep tree when the names stay plain', async () => {
    tree(tmp, deepLayout(12));
    const result = await new FlattenFolder().run({ targets: [tmp], options: { keepHierarchy: false } });
    expect(result).toMatchObject({ ok: true, processed: 2 + 12 * 2 + 6 - 2 });
    expect(onlyFiles(tmp)).toBe(true);
    expect(fs.readdirSync(tmp)).toHaveLength(2 + 12 * 2 + 6);
  });

  it('cuts the folder names of a deep tree to fit and still keeps the order', async () => {
    tree(tmp, deepLayout(12, (i) => `Уровень ${i} с довольно длинным названием папки`));
    const expected = originalOrder(tmp, true);
    const view = await flatten(tmp);
    expect(view.totalShortened).toBeGreaterThan(0);
    const names = namesInExplorerOrder(tmp);
    expect(names.every((n) => n.length <= 255 && Buffer.byteLength(n) <= 255 && path.join(tmp, n).length <= 259)).toBe(true);
    expect(contentsInExplorerOrder(tmp)).toEqual(expected);
  });
});
