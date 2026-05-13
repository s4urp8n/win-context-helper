const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CleanupByExtension = require('../../plugins/cleanup-by-extension/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe('CleanupByExtension', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cleanup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = CleanupByExtension.manifest;
    expect(m).toMatchObject({
      id: 'cleanup-by-extension',
      label: 'Cleanup by extension',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight groups files by extension across selected folders', async () => {
    tree(tmp, {
      'a/p1.jpg': 'x', 'a/p2.jpg': 'xx', 'a/n1.txt': 'y', 'b/p3.jpg': 'xxx', 'b/log.log': 'zzz',
    });
    const result = await new CleanupByExtension().preflight({ targets: [tmp] });
    const byExt = Object.fromEntries(result.extensions.map((e) => [e.ext, e]));
    expect(byExt['.jpg'].count).toBe(3);
    expect(byExt['.jpg'].totalBytes).toBe(1 + 2 + 3);
    expect(byExt['.txt'].count).toBe(1);
    expect(byExt['.log'].count).toBe(1);
    expect(result.totalFiles).toBe(5);
    expect(result.extensions[0].count).toBeGreaterThanOrEqual(result.extensions.at(-1).count);
  });

  it('preflight returns totalFiles: 0 for an empty folder', async () => {
    const result = await new CleanupByExtension().preflight({ targets: [tmp] });
    expect(result.totalFiles).toBe(0);
    expect(result.extensions).toEqual([]);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(tmp, { 'a/x.txt': 'X', 'a/b/y.jpg': 'Y' });
    const before = fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs;
    await new CleanupByExtension().preflight({ targets: [tmp] });
    expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(tmp, 'a', 'b', 'y.jpg'))).toBe(true);
  });

  it('run deletes only files matching selectedExts', async () => {
    tree(tmp, {
      'p1.jpg': 'x', 'p2.JPG': 'y', 'n1.txt': 'z', 'sub/p3.jpg': 'w', 'sub/n2.txt': 'v',
    });
    const result = await new CleanupByExtension().run({
      targets: [tmp],
      options: { selectedExts: ['.jpg'] },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3); // 3 .jpg files (case-insensitive)
    expect(fs.existsSync(path.join(tmp, 'p1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'p2.JPG'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'sub', 'p3.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'n1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'sub', 'n2.txt'))).toBe(true);
  });

  it('run records errors and continues when an unlink fails', async () => {
    tree(tmp, { 'a.tmp': 'x', 'b.tmp': 'y' });
    const realUnlink = fs.unlinkSync;
    const target = path.join(tmp, 'a.tmp');
    let firstCall = true;
    fs.unlinkSync = (p) => {
      if (firstCall && p === target) { firstCall = false; throw new Error('EBUSY'); }
      return realUnlink.call(fs, p);
    };
    try {
      const result = await new CleanupByExtension().run({
        targets: [tmp], options: { selectedExts: ['.tmp'] }, onProgress: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/EBUSY/);
      expect(result.processed).toBe(1); // b.tmp deleted, a.tmp failed
    } finally {
      fs.unlinkSync = realUnlink;
    }
  });

  it('isEmpty returns true when no files found', () => {
    const p = new CleanupByExtension();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
  });

  it('buildRunningLabel returns "Cleaning up…"', () => {
    expect(new CleanupByExtension().buildRunningLabel({})).toBe('Cleaning up…');
  });
});
