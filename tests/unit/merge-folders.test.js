const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MergeFolders = require('../../plugins/merge-folders/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => e.name).sort();
}

describe('MergeFolders', () => {
  let dirs;
  beforeEach(() => {
    dirs = [];
    for (const name of ['aaa', 'bbb', 'ccc']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `ch-merge-${name}-`));
      // Create a known-name subdir so basename is predictable
      const inner = path.join(d, name);
      fs.mkdirSync(inner);
      dirs.push(inner);
    }
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(path.dirname(d), { recursive: true, force: true });
  });

  it('static manifest is well-formed', () => {
    const m = MergeFolders.manifest;
    expect(m).toMatchObject({
      id: 'merge-folders',
      label: 'Merge folders',
      accepts: ['folders'],
      minSelection: 2,
      maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight identifies target (alphabetical first) and source folders', async () => {
    tree(dirs[0], { 'a.txt': '1' });
    tree(dirs[1], { 'b.txt': '2', 'c.txt': '3' });
    const result = await new MergeFolders().preflight({ targets: [dirs[1], dirs[0]] });
    // Target is the FIRST after alphabetical sort by basename. dirs[0] is named 'aaa', so target = aaa.
    expect(result.target.basename).toBe('aaa');
    expect(result.sources.map((s) => s.basename)).toEqual(['bbb']);
    expect(result.totalFiles).toBe(2);
  });

  it('preflight counts collisions across sources', async () => {
    tree(dirs[0], { 'shared.txt': 'A' });
    tree(dirs[1], { 'shared.txt': 'B' });
    const result = await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(result.collisionCount).toBeGreaterThanOrEqual(1);
  });

  it('preflight returns totalFiles 0 for empty sources', async () => {
    const result = await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(dirs[0], { 'a.txt': 'A' });
    tree(dirs[1], { 'b.txt': 'B' });
    const before = fs.statSync(path.join(dirs[1], 'b.txt')).mtimeMs;
    await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(fs.statSync(path.join(dirs[1], 'b.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(dirs[1], 'b.txt'))).toBe(true);
  });

  it('run with rename strategy moves files into target', async () => {
    tree(dirs[0], { 'x.txt': 'A' });
    tree(dirs[1], { 'y.txt': 'B', 'shared.txt': 'C' });
    tree(dirs[0], { 'shared.txt': 'Z' });
    const result = await new MergeFolders().run({
      targets: [dirs[0], dirs[1]],
      options: { collisionStrategy: 'rename', deleteSourceFolders: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    const targetFiles = listFiles(dirs[0]);
    expect(targetFiles).toContain('x.txt');
    expect(targetFiles).toContain('y.txt');
    expect(targetFiles).toContain('shared.txt');
    expect(targetFiles.some((f) => /shared \(2\)\.txt/.test(f))).toBe(true);
  });

  it('run with skip strategy leaves colliding source files in place', async () => {
    tree(dirs[0], { 'shared.txt': 'A' });
    tree(dirs[1], { 'shared.txt': 'B', 'unique.txt': 'C' });
    const result = await new MergeFolders().run({
      targets: [dirs[0], dirs[1]],
      options: { collisionStrategy: 'skip', deleteSourceFolders: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(listFiles(dirs[0])).toContain('unique.txt');
    // shared.txt in source dirs[1] should still exist (skipped)
    expect(fs.existsSync(path.join(dirs[1], 'shared.txt'))).toBe(true);
  });

  it('buildRunningLabel returns "Merging…"', () => {
    expect(new MergeFolders().buildRunningLabel({})).toBe('Merging…');
  });
});
