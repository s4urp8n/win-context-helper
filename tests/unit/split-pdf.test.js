const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SplitPdf = require('../../plugins/split-pdf/plugin');

describe('SplitPdf', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-splitpdf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = SplitPdf.manifest;
    expect(m).toMatchObject({
      id: 'split-pdf', label: 'Split PDF',
      accepts: ['files:.pdf'], minSelection: 1, maxSelection: 1, ui: 'window',
    });
  });

  it('preflight returns totalPages from gswin64c stdout', async () => {
    const input = path.join(tmp, 'book.pdf');
    fs.writeFileSync(input, 'X');
    const plugin = new SplitPdf({ spawnTool: async () => ({ ok: true, stdout: '7\n', stderr: '' }) });
    const result = await plugin.preflight({ targets: [input], binDir: '/fake/bin' });
    expect(result.totalPages).toBe(7);
    expect(result.basename).toBe('book.pdf');
  });

  it('preflight returns 0 pages when stdout is empty / unparseable', async () => {
    const input = path.join(tmp, 'broken.pdf');
    fs.writeFileSync(input, 'X');
    const plugin = new SplitPdf({ spawnTool: async () => ({ ok: true, stdout: '', stderr: '' }) });
    const result = await plugin.preflight({ targets: [input], binDir: '/fake/bin' });
    expect(result.totalPages).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const input = path.join(tmp, 'book.pdf');
    fs.writeFileSync(input, 'X');
    const before = fs.statSync(input).mtimeMs;
    const plugin = new SplitPdf({ spawnTool: async () => ({ ok: true, stdout: '3\n', stderr: '' }) });
    await plugin.preflight({ targets: [input], binDir: '/fake/bin' });
    expect(fs.statSync(input).mtimeMs).toBe(before);
  });

  it('run per-page invokes gswin64c once per page', async () => {
    const input = path.join(tmp, 'book.pdf'); fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new SplitPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { mode: 'per-page', prefix: 'book-', totalPages: 3 },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toContain('-dFirstPage=1');
    expect(calls[0].args).toContain('-dLastPage=1');
    expect(calls[0].args.find((a) => a.startsWith('-sOutputFile='))).toBe(`-sOutputFile=${path.join(tmp, 'book-1.pdf')}`);
    expect(calls[2].args).toContain('-dFirstPage=3');
  });

  it('run by-ranges parses ranges and invokes per span', async () => {
    const input = path.join(tmp, 'book.pdf'); fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new SplitPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { mode: 'by-ranges', ranges: '1-3, 5, 7-9', prefix: 'doc-', totalPages: 10 },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toContain('-dFirstPage=1');
    expect(calls[0].args).toContain('-dLastPage=3');
    expect(calls[0].args.find((a) => a.startsWith('-sOutputFile='))).toBe(`-sOutputFile=${path.join(tmp, 'doc-1-3.pdf')}`);
    expect(calls[1].args).toContain('-dFirstPage=5');
    expect(calls[1].args).toContain('-dLastPage=5');
    expect(calls[1].args.find((a) => a.startsWith('-sOutputFile='))).toBe(`-sOutputFile=${path.join(tmp, 'doc-5.pdf')}`);
    expect(calls[2].args).toContain('-dFirstPage=7');
    expect(calls[2].args).toContain('-dLastPage=9');
  });

  it('run records error when a page split fails and continues', async () => {
    const input = path.join(tmp, 'book.pdf'); fs.writeFileSync(input, 'X');
    let call = 0;
    const plugin = new SplitPdf({
      spawnTool: async () => { call++; if (call === 2) throw new Error('gswin64c exited 1: page error'); return { ok: true, stdout: '', stderr: '' }; },
    });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { mode: 'per-page', prefix: 'p-', totalPages: 3 },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  it('run includes prepress quality preset', async () => {
    const input = path.join(tmp, 'book.pdf'); fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new SplitPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { mode: 'per-page', prefix: 'b-', totalPages: 1 },
      onProgress: () => {},
    });
    expect(calls[0].args).toContain('-dPDFSETTINGS=/prepress');
  });

  it('buildRunningLabel returns "Splitting…"', () => {
    expect(new SplitPdf().buildRunningLabel({})).toBe('Splitting…');
  });
});
