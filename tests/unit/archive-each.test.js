const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ArchiveEach = require('../../plugins/archive-each/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe('ArchiveEach', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-archive-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ArchiveEach.manifest;
    expect(m).toMatchObject({
      id: 'archive-each',
      label: 'Archive each',
      accepts: ['folders', 'files'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight returns per-item entries with size + isFolder flag', async () => {
    const folder = path.join(tmp, 'docs');
    fs.mkdirSync(folder);
    tree(folder, { 'a.txt': 'AAA', 'sub/b.txt': 'BBBBB' });
    const file = path.join(tmp, 'report.pdf');
    fs.writeFileSync(file, 'X'.repeat(100));

    const result = await new ArchiveEach().preflight({ targets: [folder, file] });
    expect(result.totalItems).toBe(2);
    const byName = Object.fromEntries(result.items.map((i) => [i.basename, i]));
    expect(byName['docs']).toMatchObject({ isFolder: true });
    expect(byName['docs'].sizeBytes).toBe(8); // 'AAA' + 'BBBBB'
    expect(byName['report.pdf']).toMatchObject({ isFolder: false, sizeBytes: 100 });
    expect(result.totalBytes).toBe(108);
  });

  it('preflight handles single-file target', async () => {
    const file = path.join(tmp, 'lonely.txt');
    fs.writeFileSync(file, 'x');
    const result = await new ArchiveEach().preflight({ targets: [file] });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].isFolder).toBe(false);
    expect(result.items[0].sizeBytes).toBe(1);
  });

  it('preflight does not mutate the filesystem', async () => {
    const folder = path.join(tmp, 'a');
    fs.mkdirSync(folder);
    tree(folder, { 'x.txt': 'hi' });
    const before = fs.statSync(path.join(folder, 'x.txt')).mtimeMs;
    await new ArchiveEach().preflight({ targets: [folder] });
    expect(fs.statSync(path.join(folder, 'x.txt')).mtimeMs).toBe(before);
  });

  it('run calls spawnTool with zip args per item by default and reports processed', async () => {
    const folder1 = path.join(tmp, 'A');
    const folder2 = path.join(tmp, 'B');
    fs.mkdirSync(folder1); fs.mkdirSync(folder2);
    fs.writeFileSync(path.join(folder1, 'x.txt'), 'x');
    fs.writeFileSync(path.join(folder2, 'y.txt'), 'y');

    const calls = [];
    const mockSpawn = async (args) => {
      calls.push(args);
      return { ok: true, stdout: '', stderr: '' };
    };
    const plugin = new ArchiveEach({ spawnTool: mockSpawn });
    const result = await plugin.run({
      targets: [folder1, folder2],
      binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].exe).toBe(path.join('/fake/bin', '7z.exe'));
    expect(calls[0].args).toEqual(['a', '-tzip', '-mx=9', path.join(tmp, 'A.zip'), folder1]);
    expect(calls[1].args[3]).toBe(path.join(tmp, 'B.zip'));
  });

  it('run resolves output collision with (N) suffix', async () => {
    const folder = path.join(tmp, 'X');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    // Pre-existing output file at the default name (zip is now default)
    fs.writeFileSync(path.join(tmp, 'X.zip'), 'existing');

    const calls = [];
    const plugin = new ArchiveEach({
      spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; },
    });
    await plugin.run({ targets: [folder], binDir: '/fake/bin', onProgress: () => {} });
    expect(calls[0].args[3]).toBe(path.join(tmp, 'X (2).zip'));
  });

  it('run records errors when spawnTool throws and continues', async () => {
    const f1 = path.join(tmp, 'A'); fs.mkdirSync(f1);
    const f2 = path.join(tmp, 'B'); fs.mkdirSync(f2);
    let call = 0;
    const plugin = new ArchiveEach({
      spawnTool: async () => {
        call++;
        if (call === 1) throw new Error('7z exited 2: bad input');
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const result = await plugin.run({
      targets: [f1, f2],
      binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/7z exited 2/);
  });

  it('buildRunningLabel returns "Archiving…"', () => {
    expect(new ArchiveEach().buildRunningLabel({})).toBe('Archiving…');
  });

  it('run uses 7z args when options.format is "7z"', async () => {
    const folder = path.join(tmp, 'X');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    const calls = [];
    const plugin = new ArchiveEach({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [folder], binDir: '/fake/bin',
      options: { format: '7z', compression: 5 },
      onProgress: () => {},
    });
    expect(calls[0].args).toEqual(['a', '-t7z', '-mx=5', path.join(tmp, 'X.7z'), folder]);
  });

  it('buildFormSummary lists items sorted + numbered with total size', () => {
    const p = new ArchiveEach();
    const pre = {
      items: [
        { basename: 'report.pdf', isFolder: false, sizeBytes: 1024 * 1024 * 2 },
        { basename: 'Photos', isFolder: true, sizeBytes: 1024 * 1024 * 10 },
      ],
      totalItems: 2,
      totalBytes: 1024 * 1024 * 12,
    };
    const summary = p.buildFormSummary({}, pre);
    expect(summary).toMatch(/1\. Photos\//);
    expect(summary).toMatch(/2\. report\.pdf/);
    expect(summary).toMatch(/12\.00 MB/);
    const idxOne = summary.indexOf('1. Photos');
    const idxTwo = summary.indexOf('2. report.pdf');
    expect(idxOne).toBeGreaterThanOrEqual(0);
    expect(idxOne).toBeLessThan(idxTwo);
    expect(summary.split('\n').length).toBeGreaterThan(2);
  });
});
