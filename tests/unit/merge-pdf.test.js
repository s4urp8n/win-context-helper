const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MergePdf = require('../../plugins/merge-pdf/plugin');

describe('MergePdf', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mergepdf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = MergePdf.manifest;
    expect(m).toMatchObject({
      id: 'merge-pdf', label: 'Merge PDF',
      accepts: ['files:.pdf'], minSelection: 2, maxSelection: 999, ui: 'dialog',
    });
  });

  it('preflight sorts and returns counts/sizes', async () => {
    fs.writeFileSync(path.join(tmp, 'b.pdf'), 'B'.repeat(20));
    fs.writeFileSync(path.join(tmp, 'a.pdf'), 'A'.repeat(10));
    const result = await new MergePdf().preflight({ targets: [path.join(tmp, 'b.pdf'), path.join(tmp, 'a.pdf')] });
    expect(result.files.map((f) => f.basename)).toEqual(['a.pdf', 'b.pdf']);
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBe(30);
  });

  it('preflight returns totalFiles 0 for empty targets', async () => {
    const result = await new MergePdf().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.pdf');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new MergePdf().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run calls gswin64c once with all inputs + output Merged.pdf', async () => {
    const a = path.join(tmp, 'a.pdf'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.pdf'); fs.writeFileSync(b, 'B');
    const calls = [];
    const plugin = new MergePdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [a, b], binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'gswin64c.exe'));
    expect(calls[0].args).toContain('-dBATCH');
    expect(calls[0].args).toContain('-dNOPAUSE');
    expect(calls[0].args).toContain('-sDEVICE=pdfwrite');
    expect(calls[0].args.find((a) => a.startsWith('-sOutputFile='))).toBe(`-sOutputFile=${path.join(tmp, 'Merged.pdf')}`);
    // Inputs at the end
    expect(calls[0].args.slice(-2)).toEqual([a, b]);
  });

  it('run resolves output collision with (N) suffix', async () => {
    const a = path.join(tmp, 'a.pdf'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.pdf'); fs.writeFileSync(b, 'B');
    fs.writeFileSync(path.join(tmp, 'Merged.pdf'), 'existing');
    const calls = [];
    const plugin = new MergePdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({ targets: [a, b], binDir: '/fake/bin', onProgress: () => {} });
    expect(calls[0].args.find((arg) => arg.startsWith('-sOutputFile='))).toBe(`-sOutputFile=${path.join(tmp, 'Merged (2).pdf')}`);
  });

  it('run records error on spawn failure', async () => {
    const a = path.join(tmp, 'a.pdf'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.pdf'); fs.writeFileSync(b, 'B');
    const plugin = new MergePdf({ spawnTool: async () => { throw new Error('gswin64c exited 1: bad PDF'); } });
    const result = await plugin.run({ targets: [a, b], binDir: '/fake/bin', onProgress: () => {} });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/gswin64c exited 1/);
  });

  it('buildRunningLabel returns "Merging…"', () => {
    expect(new MergePdf().buildRunningLabel({})).toBe('Merging…');
  });

  it('run includes prepress quality preset for lossless preservation', async () => {
    const a = path.join(tmp, 'a.pdf'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.pdf'); fs.writeFileSync(b, 'B');
    const calls = [];
    const plugin = new MergePdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({ targets: [a, b], binDir: '/fake/bin', onProgress: () => {} });
    expect(calls[0].args).toContain('-dPDFSETTINGS=/prepress');
  });

  it('buildConfirmMessage mentions count and Merged.pdf', () => {
    const out = new MergePdf().buildConfirmMessage({}, {
      files: [{ basename: 'a.pdf' }, { basename: 'b.pdf' }, { basename: 'c.pdf' }],
      totalFiles: 3, totalBytes: 1024 * 1024 * 5,
    });
    expect(out.message).toMatch(/Merge 3 PDFs/);
    expect(out.detail).toMatch(/Merged\.pdf/);
    expect(out.detail).toMatch(/• a\.pdf/);
  });
});
