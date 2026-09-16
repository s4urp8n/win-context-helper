const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');
const { planFolder, shorten, largestCap } = require('../../plugins/flatten-folder/plan');
const { explorerCompare } = require('../../src/main/utils/explorer-compare');

const FLAT = { keepHierarchy: false };

// Windows limits: 255 UTF-16 units per name, 259 characters per full path (MAX_PATH without NUL).
const roomIn = (root) => Math.min(255, 259 - (path.join(root, 'x').length - 1));
const pad = (tag, length, fill = 'x') => `${tag} ${fill.repeat(length - tag.length - 1)}`;
const explorerSort = (names) => [...names].sort(explorerCompare);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const rootFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
const rootDirs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const contentsInNameOrder = (dir) => explorerSort(rootFiles(dir)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));

describe('shorten', () => {
  it('keeps text that fits', () => {
    expect(shorten('Lesson 1', 8)).toBe('Lesson 1');
  });

  it('cuts the end and marks it with an ellipsis within the limit', () => {
    expect(shorten('Introduction', 6)).toBe('Intro…');
  });

  it('never splits a surrogate pair', () => {
    const text = shorten('😀😀😀😀', 4);
    expect(text).toBe('😀…');
    expect(text).not.toMatch(LONE_SURROGATE);
  });

  it('drops the spaces in front of the ellipsis', () => {
    expect(shorten('ab cd', 4)).toBe('ab…');
  });

  it('leaves only the ellipsis when one character is allowed', () => {
    expect(shorten('abc', 1)).toBe('…');
  });
});

describe('largestCap', () => {
  it('is unlimited when the parts fit untouched', () => {
    expect(largestCap([8, 4], 12)).toBe(Infinity);
    expect(largestCap([], 0)).toBe(Infinity);
  });

  it('cuts the longest parts first and keeps short ones intact', () => {
    expect(largestCap([8, 50, 4], 24)).toBe(12);
  });

  it('never lets the cut parts take more room than allowed', () => {
    const lengths = [22, 120, 26, 5];
    for (let room = 4; room <= 172; room++) {
      const cap = largestCap(lengths, room);
      expect(lengths.reduce((sum, n) => sum + Math.min(n, cap), 0)).toBeLessThanOrEqual(room);
    }
  });

  it('falls back to one character per part when even that does not fit', () => {
    expect(largestCap([5, 5, 5], 2)).toBe(1);
  });
});

describe('Flatten folder with names that do not fit Windows limits', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-long-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  describe('keeping the hierarchy', () => {
    it('moves every file when a joined name would pass 255 characters', async () => {
      tree(tmp, {
        [`${pad('A', 95)}/short.txt`]: 'a',
        [`${pad('B', 95)}/${pad('C', 95)}/${pad('D', 95)}/deep.txt`]: 'deep',
        [`${pad('E', 95)}/other.txt`]: 'e',
      });
      const result = await new FlattenFolder().run({ targets: [tmp] });
      expect(result).toMatchObject({ ok: true, processed: 3, errors: [] });
      expect(rootDirs(tmp)).toEqual([]);
      expect(contentsInNameOrder(tmp)).toEqual(['a', 'deep', 'e']);
      const deep = rootFiles(tmp).find((n) => n.startsWith('B '));
      expect(deep).toMatch(/…/);
      expect(deep.endsWith(' - deep.txt')).toBe(true);
    });

    it('keeps every moved file within the full-path limit', async () => {
      tree(tmp, { [`${pad('Part', 120)}/${pad('Lesson', 120)}/clip.mp4`]: 'clip' });
      await new FlattenFolder().run({ targets: [tmp] });
      const [name] = rootFiles(tmp);
      expect(name.length).toBeGreaterThanOrEqual(roomIn(tmp) - 1);
      expect(path.join(tmp, name).length).toBeLessThanOrEqual(259);
    });

    it('shortens only the long folder name and keeps the short ones', async () => {
      tree(tmp, { [`Lesson 1/${pad('Topic', 250)}/clip.mp4`]: 'clip' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      const [row] = pre.variants.tree.folders[0].moves;
      expect(row.to).toMatch(/^Lesson 1 - Topic x+… - clip\.mp4$/);
      expect(row).toMatchObject({ shortened: true, renamed: false });
      expect(pre.variants.tree.totalShortened).toBe(1);
      expect(pre.variants.tree.folders[0].numbered).toBe(false);
    });

    it('cuts a folder name the same way for every file inside it', async () => {
      const course = pad('Module 01', 200);
      tree(tmp, {
        [`${course}/Lesson 01 short.mp4`]: 'L1',
        [`${course}/${pad('Lesson 02', 100)}.mp4`]: 'L2',
        [`${course}/${pad('Lesson 03', 60)}.mp4`]: 'L3',
      });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      const heads = pre.variants.tree.folders[0].moves.map((m) => m.to.split(' - ')[0]);
      expect(new Set(heads).size).toBe(1);
      expect(heads[0]).toMatch(/^Module 01 x+…$/);
      expect(pre.variants.tree.folders[0].numbered).toBe(false);
      await new FlattenFolder().run({ targets: [tmp] });
      expect(contentsInNameOrder(tmp)).toEqual(['L1', 'L2', 'L3']);
    });

    it('shortens a long file name before touching its folder names', async () => {
      const course = pad('Module 01', Math.min(120, roomIn(tmp) - 90));
      const lesson = pad('Lesson 01', 200);
      tree(tmp, { [`${course}/${lesson}.mp4`]: 'L1' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      const [row] = pre.variants.tree.folders[0].moves;
      expect(row.to.startsWith(`${course} - Lesson 01 x`)).toBe(true);
      expect(row.to).toMatch(/x…\.mp4$/);
      expect(row.to.length).toBe(roomIn(tmp));
    });

    it('keeps at least 40 characters of a long file name', async () => {
      const course = pad('Module 01', 250);
      const lesson = pad('Lesson 01', 120);
      tree(tmp, { [`${course}/${lesson}.mp4`]: 'L1' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      const [row] = pre.variants.tree.folders[0].moves;
      const [head, base] = row.to.split(' - Lesson');
      expect(head).toMatch(/^Module 01 x+…$/);
      expect(head.length).toBe(roomIn(tmp) - ' - '.length - 40 - '.mp4'.length);
      expect(`Lesson${base}`).toMatch(/^Lesson 01 x+…\.mp4$/);
      expect(`Lesson${base}`.length).toBe(40 + '.mp4'.length);
    });

    it('keeps the lesson order when shortened names still sort the same way', async () => {
      const layout = {};
      for (const n of [1, 2, 10]) {
        layout[`${pad(`Lesson ${n}`, 240)}/a.mp4`] = `L${n}a`;
        layout[`${pad(`Lesson ${n}`, 240)}/b.mp4`] = `L${n}b`;
      }
      tree(tmp, layout);
      const result = await new FlattenFolder().run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(contentsInNameOrder(tmp)).toEqual(['L1a', 'L1b', 'L2a', 'L2b', 'L10a', 'L10b']);
      expect(rootFiles(tmp).every((n) => n.startsWith('Lesson '))).toBe(true);
    });

    it('numbers the files when shortening would change their order', async () => {
      const common = 'q'.repeat(240);
      tree(tmp, { [`${common} A/z.txt`]: 'first', [`${common} B/a.txt`]: 'second' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      expect(pre.variants.tree.folders[0].numbered).toBe(true);
      expect(pre.variants.tree.folders[0].moves.map((m) => m.to.slice(0, 6))).toEqual(['001 - ', '002 - ']);
      const result = await plugin.run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(contentsInNameOrder(tmp)).toEqual(['first', 'second']);
      expect(rootFiles(tmp).every((n) => n.length <= roomIn(tmp))).toBe(true);
    });

    it('numbers the files in the order the full names would sort', async () => {
      const common = 'w'.repeat(240);
      tree(tmp, {
        [`${common} 10/x.txt`]: 'ten',
        [`${common} 9/y.txt`]: 'nine',
        [`${common} 9/z.txt`]: 'nine-z',
      });
      await new FlattenFolder().run({ targets: [tmp] });
      expect(contentsInNameOrder(tmp)).toEqual(['nine', 'nine-z', 'ten']);
      expect(explorerSort(rootFiles(tmp)).map((n) => n.slice(0, 3))).toEqual(['001', '002', '003']);
    });

    it('widens the number when there are more than 999 files', async () => {
      const common = 'v'.repeat(240);
      const layout = { [`${common} B/a0000.txt`]: 'last' };
      for (let i = 0; i < 1000; i++) layout[`${common} A/z${String(i).padStart(4, '0')}.txt`] = '';
      tree(tmp, layout);
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.variants.tree.folders[0].numbered).toBe(true);
      expect(pre.variants.tree.folders[0].moves[0].to.startsWith('0001 - ')).toBe(true);
    });

    it('still names files when shortened folders collide and the file names are short', async () => {
      const course = pad('Course', Math.min(roomIn(tmp), 240) - 3);
      tree(tmp, { [`${course} Part 1/01.mp4`]: 'p1', [`${course} Part 2/01.mp4`]: 'p2' });
      const plugin = new FlattenFolder();
      const pre = await plugin.preflight({ targets: [tmp] });
      expect(pre.variants.tree.totalBlocked).toBe(0);
      expect(pre.variants.tree.folders[0].numbered).toBe(true);
      const result = await plugin.run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(contentsInNameOrder(tmp)).toEqual(['p1', 'p2']);
    });

    it('adds a suffix when a numbered name is already taken in the root', async () => {
      const common = 'q'.repeat(Math.min(roomIn(tmp), 240));
      tree(tmp, { [`${common} A/z.txt`]: 'first', [`${common} B/a.txt`]: 'second' });
      const plugin = new FlattenFolder();
      const taken = (await plugin.preflight({ targets: [tmp] })).variants.tree.folders[0].moves[0].to;
      fs.writeFileSync(path.join(tmp, taken), 'root');
      const pre = await plugin.preflight({ targets: [tmp] });
      const { moves } = pre.variants.tree.folders[0];
      expect(pre.variants.tree.totalBlocked).toBe(0);
      expect(moves[0].renamed).toBe(true);
      expect(moves[0].to).not.toBe(taken);
      const result = await plugin.run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(contentsInNameOrder(tmp)).toEqual(['first', 'second', 'root']);
      expect(rootFiles(tmp).every((n) => n.length <= roomIn(tmp))).toBe(true);
    });

    it('keeps plain names when one full name only extends another', async () => {
      tree(tmp, { 'k/b': 'b', 'k/b1': 'b1', [`${pad('Z', 250)}/c.txt`]: 'c' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.variants.tree.totalShortened).toBe(1);
      expect(pre.variants.tree.folders[0].numbered).toBe(false);
      expect(pre.variants.tree.folders[0].moves.map((m) => m.to).slice(0, 2)).toEqual(['k - b', 'k - b1']);
    });

    it('shortens a long name whose last dot starts no real extension', async () => {
      const name = `1. Introduction to the topic ${'y'.repeat(200)}`;
      tree(tmp, { [`Lesson 1/${name}`]: 'intro' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.variants.tree.totalBlocked).toBe(0);
      const [row] = pre.variants.tree.folders[0].moves;
      expect(row.to).toMatch(/^Lesson 1 - 1\. Introduction to the topic y+…$/);
      expect(row.to.length).toBe(roomIn(tmp));
    });
  });

  describe('plain mode', () => {
    it('shortens a name whose full path would pass 259 characters', async () => {
      const name = `${'n'.repeat(240)}.txt`;
      tree(tmp, { [`a/${name}`]: 'long' });
      const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      expect(result.ok).toBe(true);
      const [moved] = rootFiles(tmp);
      expect(moved.length).toBe(roomIn(tmp));
      expect(moved).toMatch(/^n+…\.txt$/);
    });

    it('shortens the name when the (N) suffix would push it past the limit', async () => {
      const name = `${'m'.repeat(roomIn(tmp) - 4)}.txt`;
      tree(tmp, { [name]: 'root', [`a/${name}`]: 'nested' });
      const pre = await new FlattenFolder().preflight({ targets: [tmp] });
      expect(pre.variants.flat.folders[0].moves[0]).toMatchObject({ shortened: true, renamed: true });
      await new FlattenFolder().run({ targets: [tmp], options: FLAT });
      const renamed = rootFiles(tmp).find((n) => n !== name);
      expect(renamed).toMatch(/^m+… \(2\)\.txt$/);
      expect(renamed.length).toBeLessThanOrEqual(roomIn(tmp));
      expect(fs.readFileSync(path.join(tmp, renamed), 'utf8')).toBe('nested');
      expect(fs.readFileSync(path.join(tmp, name), 'utf8')).toBe('root');
    });
  });

  describe('when the folder path itself is too long', () => {
    let root;
    beforeEach(() => {
      root = path.join(tmp, 'r'.repeat(250));
      tree(root, { 'sub/file.txt': 'data' });
    });

    it('preflight reports the files that cannot get a name', async () => {
      const pre = await new FlattenFolder().preflight({ targets: [root] });
      expect(pre.variants.tree.totalBlocked).toBe(1);
      expect(pre.variants.flat.totalBlocked).toBe(1);
      expect(pre.variants.tree.folders[0].blocked).toEqual([
        { file: path.join('sub', 'file.txt'), message: expect.stringMatching(/folder path/i) },
      ]);
    });

    it('run refuses to move anything', async () => {
      const result = await new FlattenFolder().run({ targets: [root] });
      expect(result).toMatchObject({ ok: false, processed: 0, blocked: true });
      expect(result.errors).toEqual([{ folder: path.basename(root), file: path.join('sub', 'file.txt'), message: expect.stringMatching(/folder path/i) }]);
      expect(fs.readFileSync(path.join(root, 'sub', 'file.txt'), 'utf8')).toBe('data');
    });
  });

  it('blocks a file when not even the (N) suffix fits next to its extension', async () => {
    const root = path.join(tmp, 'r'.repeat(248 - tmp.length - 1)); // leaves 10 characters for a name
    tree(root, { 'ab.abcdef': 'root', 'sub/ab.abcdef': 'nested' });
    const pre = await new FlattenFolder().preflight({ targets: [root] });
    expect(pre.variants.flat.totalBlocked).toBe(1);
  });

  it('moves none of the files when only some of them cannot get a name', async () => {
    const root = path.join(tmp, 'r'.repeat(248 - tmp.length - 1)); // leaves 10 characters for a name
    tree(root, { 'sub/a.txt': 'a', 'sub/b.abcdefghijklmn': 'b' });
    const pre = await new FlattenFolder().preflight({ targets: [root] });
    expect(pre.totalFiles).toBe(2);
    expect(pre.variants.flat).toMatchObject({ totalBlocked: 1, totalRows: 1 });
    const result = await new FlattenFolder().run({ targets: [root], options: FLAT });
    expect(result).toMatchObject({ ok: false, blocked: true });
    expect(fs.readdirSync(path.join(root, 'sub')).sort()).toEqual(['a.txt', 'b.abcdefghijklmn']);
  });
});

describe('planning speed', () => {
  const root = path.join('C:', 'virtual', 'course');
  afterEach(() => { vi.restoreAllMocks(); });

  // Serves a folder tree from memory: { 'dir/file': ... } paths relative to root.
  function virtualTree(files) {
    const dirs = new Map();
    const add = (dir, name, isDir) => {
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir).set(name, isDir);
    };
    for (const rel of files) {
      let dir = root;
      rel.split('/').forEach((part, i, parts) => {
        add(dir, part, i < parts.length - 1);
        dir = path.join(dir, part);
      });
    }
    vi.spyOn(fs, 'readdirSync').mockImplementation((dir, options) => {
      const entries = [...(dirs.get(dir) || new Map())];
      if (!options) return entries.map(([name]) => name);
      return entries.map(([name, isDir]) => ({ name, isFile: () => !isDir, isDirectory: () => isDir }));
    });
  }

  it('gives twenty thousand identical names their suffixes without slowing down', () => {
    virtualTree(Array.from({ length: 20000 }, (_, i) => `d${String(i).padStart(5, '0')}/video.mp4`));
    const started = Date.now();
    const plan = planFolder(root, FLAT);
    expect(plan.moves.at(-1).targetName).toBe('video (20000).mp4');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('numbers ten thousand files whose shortened folders look the same without slowing down', () => {
    const head = 'c'.repeat(240);
    virtualTree(Array.from({ length: 10000 }, (_, i) => `${head} ${i}/01.mp4`));
    const started = Date.now();
    const plan = planFolder(root, {});
    expect(plan.numbered).toBe(true);
    expect(plan.blocked).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('Flatten folder keeps names within 255 UTF-8 bytes (NAS shares)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-bytes-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const bytes = (name) => Buffer.byteLength(name);
  const module1 = 'Модуль 1. Практическая теория монтажа';
  const lesson = 'М1.3 Эффект Кулешова  Принципы монтажа по Соколову';

  it('shortens a Cyrillic name that fits in characters but not in bytes', async () => {
    tree(tmp, { [`${module1}/${lesson}/${lesson}.mp4`]: 'lesson', 'Заключение курса.mp4': 'outro' });
    const full = `001 - ${module1} - ${lesson} - ${lesson}.mp4`;
    expect(full.length).toBeLessThanOrEqual(roomIn(tmp));
    expect(bytes(full)).toBeGreaterThan(255);
    const plugin = new FlattenFolder();
    const pre = await plugin.preflight({ targets: [tmp] });
    const [moved, root] = pre.variants.tree.folders[0].moves;
    expect(moved).toMatchObject({ shortened: true });
    expect(bytes(moved.to)).toBeLessThanOrEqual(255);
    expect(bytes(moved.to)).toBeGreaterThan(245);
    expect(moved.to.startsWith(`001 - ${module1} - `)).toBe(true);
    expect(moved.to.endsWith('.mp4')).toBe(true);
    expect(root).toMatchObject({ from: 'Заключение курса.mp4', to: '002 - Заключение курса.mp4', shortened: false });
    const result = await plugin.run({ targets: [tmp] });
    expect(result.ok).toBe(true);
    expect(contentsInNameOrder(tmp)).toEqual(['lesson', 'outro']);
  });

  it('leaves an ASCII name of the same length alone', async () => {
    const ascii = (text) => text.replace(/[^ -~]/g, 'x');
    tree(tmp, { [`${ascii(module1)}/${ascii(lesson)}/${ascii(lesson)}.mp4`]: 'lesson' });
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    const [moved] = pre.variants.tree.folders[0].moves;
    expect(moved.shortened).toBe(false);
    expect(moved.to).toBe(`${ascii(module1)} - ${ascii(lesson)} - ${ascii(lesson)}.mp4`);
  });

  it('shortens a plain name that is too many bytes and keeps its extension', async () => {
    const name = `${'Ж'.repeat(130)}.txt`;
    tree(tmp, { [`a/${name}`]: 'long' });
    const result = await new FlattenFolder().run({ targets: [tmp], options: FLAT });
    expect(result.ok).toBe(true);
    const [moved] = rootFiles(tmp);
    expect(moved).toMatch(/^Ж+…\.txt$/);
    expect(bytes(moved)).toBeLessThanOrEqual(255);
  });

  it('shortens a name when the (N) suffix pushes it past 255 bytes', async () => {
    const name = `${'Ж'.repeat(125)}.txt`;
    expect(bytes(name)).toBe(254);
    tree(tmp, { [name]: 'root', [`a/${name}`]: 'nested' });
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    const [moved] = pre.variants.flat.folders[0].moves;
    expect(moved).toMatchObject({ shortened: true, renamed: true });
    expect(moved.to).toMatch(/^Ж+… \(2\)\.txt$/);
    expect(bytes(moved.to)).toBeLessThanOrEqual(255);
  });

  it('never splits an emoji when cutting by bytes', async () => {
    const name = `${'😀'.repeat(70)}.txt`;
    tree(tmp, { [`a/${name}`]: 'emoji' });
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    const [moved] = pre.variants.flat.folders[0].moves;
    expect(bytes(moved.to)).toBeLessThanOrEqual(255);
    expect(moved.to).not.toMatch(LONE_SURROGATE);
    expect(moved.to.endsWith('….txt')).toBe(true);
  });

  it('cuts a shared folder name the same way for every file in it', async () => {
    const folder = 'Папка с очень длинным русским названием для проверки лимита в байтах';
    tree(tmp, {
      [`${folder}/${folder}/Первый урок с длинным названием на русском языке.mp4`]: 'first',
      [`${folder}/${folder}/Второй урок с длинным названием на русском языке.mp4`]: 'second',
      [`${folder}/${folder}/3.mp4`]: 'third',
    });
    const pre = await new FlattenFolder().preflight({ targets: [tmp] });
    const { moves } = pre.variants.tree.folders[0];
    expect(moves.every((m) => bytes(m.to) <= 255)).toBe(true);
    const heads = moves.map((m) => m.to.split(' - ').slice(0, 2).join(' - '));
    expect(new Set(heads).size).toBe(1);
    await new FlattenFolder().run({ targets: [tmp] });
    expect(contentsInNameOrder(tmp)).toEqual(['third', 'second', 'first']);
  });
});
