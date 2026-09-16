const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolderKeepOrder = require('../../plugins/flatten-folder-keep-order/plugin');
const { loadAll } = require('../../src/main/registry/plugin-loader');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

// Explorer's default name sort: case-insensitive, digit runs compared by value.
const explorerSort = (names) => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

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

function listEntries(dir) {
  return explorerSort(fs.readdirSync(dir));
}

describe('FlattenFolderKeepOrder', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-keep-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('is registered as a folder dialog plugin', () => {
    const entry = loadAll(PLUGINS_DIR).get('flatten-folder-keep-order');
    expect(entry.manifest).toMatchObject({
      label: 'Flatten folder (keep order)',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    });
  });

  describe('run', () => {
    it('prefixes each nested file with its folder name', async () => {
      tree(tmp, { '1/file': 'from 1', '2/file': 'from 2' });
      const result = await new FlattenFolderKeepOrder().run({ targets: [tmp] });
      expect(result).toMatchObject({ ok: true, processed: 2, errors: [] });
      expect(listEntries(tmp)).toEqual(['1 - file', '2 - file']);
      expect(readFile(tmp, '1 - file')).toBe('from 1');
      expect(readFile(tmp, '2 - file')).toBe('from 2');
    });

    it('joins every folder level of a deep path', async () => {
      tree(tmp, { 'Part A/Lesson 1/Topic/clip.mp4': 'deep' });
      await new FlattenFolderKeepOrder().run({ targets: [tmp] });
      expect(listEntries(tmp)).toEqual(['Part A - Lesson 1 - Topic - clip.mp4']);
      expect(readFile(tmp, 'Part A - Lesson 1 - Topic - clip.mp4')).toBe('deep');
    });

    it('keeps a course in lesson order when the result is sorted by name', async () => {
      tree(tmp, {
        'Lesson 10/Chapter 1.mp4': 'L10 C1',
        'Lesson 2/Chapter 1.mp4': 'L2 C1',
        'Lesson 1/Chapter 2.mp4': 'L1 C2',
        'Lesson 1/Chapter 1.mp4': 'L1 C1',
      });
      await new FlattenFolderKeepOrder().run({ targets: [tmp] });
      const names = listEntries(tmp);
      expect(names).toEqual([
        'Lesson 1 - Chapter 1.mp4',
        'Lesson 1 - Chapter 2.mp4',
        'Lesson 2 - Chapter 1.mp4',
        'Lesson 10 - Chapter 1.mp4',
      ]);
      expect(names.map((n) => readFile(tmp, n))).toEqual(['L1 C1', 'L1 C2', 'L2 C1', 'L10 C1']);
    });

    it('leaves files that are already in the root untouched', async () => {
      tree(tmp, { 'intro.mp4': 'intro', 'Lesson 1/a.mp4': 'a' });
      await new FlattenFolderKeepOrder().run({ targets: [tmp] });
      expect(listEntries(tmp)).toEqual(['intro.mp4', 'Lesson 1 - a.mp4']);
      expect(readFile(tmp, 'intro.mp4')).toBe('intro');
    });

    it('adds a (N) suffix when the prefixed name is already taken', async () => {
      tree(tmp, { 'Lesson 1 - a.mp4': 'root', 'Lesson 1/a.mp4': 'nested' });
      const result = await new FlattenFolderKeepOrder().run({ targets: [tmp] });
      expect(result.ok).toBe(true);
      expect(readFile(tmp, 'Lesson 1 - a.mp4')).toBe('root');
      expect(readFile(tmp, 'Lesson 1 - a (2).mp4')).toBe('nested');
    });

    it('builds the prefix relative to each selected folder', async () => {
      const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-keep-second-'));
      try {
        tree(tmp, { 'x/f.txt': 'first' });
        tree(second, { 'y/f.txt': 'second' });
        await new FlattenFolderKeepOrder().run({ targets: [tmp, second] });
        expect(listEntries(tmp)).toEqual(['x - f.txt']);
        expect(listEntries(second)).toEqual(['y - f.txt']);
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });
  });

  describe('preflight and confirm dialog', () => {
    it('counts collisions of the prefixed names, not of the bare names', async () => {
      tree(tmp, { '1/file': 'a', '2/file': 'b' });
      const pre = await new FlattenFolderKeepOrder().preflight({ targets: [tmp] });
      expect(pre.totalFiles).toBe(2);
      expect(pre.totalCollisions).toBe(0);
    });

    it('shows every planned rename as a table row', async () => {
      tree(tmp, {
        'Lesson 1/Chapter 1.mp4': '', 'Lesson 1/Chapter 2.mp4': '',
        'Lesson 2/Chapter 1.mp4': '', 'Lesson 2/Chapter 2.mp4': '',
      });
      const plugin = new FlattenFolderKeepOrder();
      const pre = await plugin.preflight({ targets: [tmp] });
      const { message, table } = plugin.buildConfirmMessage({}, pre);
      expect(message).toBe('Flatten this folder (keep order)?');
      expect(table.rows.map((r) => r.cells)).toEqual([
        [path.join('Lesson 1', 'Chapter 1.mp4'), 'Lesson 1 - Chapter 1.mp4'],
        [path.join('Lesson 1', 'Chapter 2.mp4'), 'Lesson 1 - Chapter 2.mp4'],
        [path.join('Lesson 2', 'Chapter 1.mp4'), 'Lesson 2 - Chapter 1.mp4'],
        [path.join('Lesson 2', 'Chapter 2.mp4'), 'Lesson 2 - Chapter 2.mp4'],
      ]);
    });

    it('groups the renames of several selected folders', async () => {
      const second = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-keep-second-'));
      try {
        tree(tmp, { 'x/1.txt': '' });
        tree(second, { 'y/2.txt': '' });
        const plugin = new FlattenFolderKeepOrder();
        const pre = await plugin.preflight({ targets: [tmp, second] });
        const { message, table } = plugin.buildConfirmMessage({}, pre);
        expect(message).toBe('Flatten 2 folders (keep order)?');
        const [first, last] = [tmp, second].map((d) => path.basename(d)).sort((a, b) => a.localeCompare(b));
        const rowOf = (dir) => (dir === path.basename(tmp) ? [path.join('x', '1.txt'), 'x - 1.txt'] : [path.join('y', '2.txt'), 'y - 2.txt']);
        expect(table.rows).toEqual([
          { group: `${first} — 1 file` },
          { cells: rowOf(first), badges: [] },
          { group: `${last} — 1 file` },
          { cells: rowOf(last), badges: [] },
        ]);
      } finally {
        fs.rmSync(second, { recursive: true, force: true });
      }
    });

    it('names this command when the selection contains no folders', () => {
      const ctx = { selection: { skipped: [{ path: '/x.txt', basename: 'x.txt', reason: 'WRONG_TYPE' }] } };
      const { detail } = new FlattenFolderKeepOrder().buildNothingToDoBody(ctx, { folders: [], totalFiles: 0 });
      expect(detail.split('\n')[0]).toBe('Flatten folder (keep order) works only with folders.');
    });
  });
});
