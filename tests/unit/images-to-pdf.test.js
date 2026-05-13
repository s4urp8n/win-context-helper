const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ImagesToPdf = require('../../plugins/images-to-pdf/plugin');

describe('ImagesToPdf', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-imgpdf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ImagesToPdf.manifest;
    expect(m).toMatchObject({
      id: 'images-to-pdf',
      label: 'Images to PDF',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight sorts files by basename and reports totals', async () => {
    fs.writeFileSync(path.join(tmp, 'b.jpg'), 'BB');
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'A');
    fs.writeFileSync(path.join(tmp, 'c.jpg'), 'CCC');
    const result = await new ImagesToPdf().preflight({ targets: [path.join(tmp, 'b.jpg'), path.join(tmp, 'a.jpg'), path.join(tmp, 'c.jpg')] });
    expect(result.files.map((f) => f.basename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(result.totalFiles).toBe(3);
    expect(result.totalBytes).toBe(6);
  });

  it('preflight returns totalFiles 0 with no targets', async () => {
    const result = await new ImagesToPdf().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.jpg');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ImagesToPdf().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run calls magick once with all inputs + output PDF', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.jpg'); fs.writeFileSync(b, 'B');
    const calls = [];
    const plugin = new ImagesToPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [a, b], binDir: '/fake/bin',
      options: { output: 'Photos.pdf', pageSize: 'Original' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'magick.exe'));
    expect(calls[0].args[0]).toBe('-monitor');
    expect(calls[0].args.slice(1, 3)).toEqual([a, b]);
    expect(calls[0].args.at(-1)).toBe(path.join(tmp, 'Photos.pdf'));
  });

  it('run inserts -page for non-Original page sizes', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const calls = [];
    const plugin = new ImagesToPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [a], binDir: '/fake/bin',
      options: { output: 'P.pdf', pageSize: 'A4' },
      onProgress: () => {},
    });
    expect(calls[0].args).toContain('-page');
    expect(calls[0].args).toContain('A4');
  });

  it('run records error when magick fails', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const plugin = new ImagesToPdf({ spawnTool: async () => { throw new Error('magick exited 1: format error'); } });
    const result = await plugin.run({
      targets: [a], binDir: '/fake/bin',
      options: { output: 'P.pdf', pageSize: 'Original' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('buildRunningLabel returns "Building PDF…"', () => {
    expect(new ImagesToPdf().buildRunningLabel({})).toBe('Building PDF…');
  });
});
