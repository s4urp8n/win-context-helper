const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ConvertImage = require('../../plugins/convert-image/plugin');

describe('ConvertImage', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cvtimg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ConvertImage.manifest;
    expect(m).toMatchObject({
      id: 'convert-image',
      label: 'Convert image',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight returns per-file info', async () => {
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'X'.repeat(10));
    fs.writeFileSync(path.join(tmp, 'b.png'), 'Y'.repeat(20));
    const result = await new ConvertImage().preflight({ targets: [path.join(tmp, 'a.jpg'), path.join(tmp, 'b.png')] });
    expect(result.totalFiles).toBe(2);
    expect(result.byExt['.jpg']).toBe(1);
    expect(result.byExt['.png']).toBe(1);
    expect(result.files[0]).toHaveProperty('basename');
    expect(result.files[0]).toHaveProperty('sizeBytes');
  });

  it('preflight totalFiles 0 when no targets', async () => {
    const result = await new ConvertImage().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.jpg');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ConvertImage().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run builds magick args with quality for lossy target', async () => {
    const input = path.join(tmp, 'a.jpg');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertImage({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.jpg', quality: 85, deleteOriginal: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'magick.exe'));
    expect(calls[0].args).toEqual(['-monitor', input, '-quality', '85', path.join(tmp, 'a (2).jpg')]);
  });

  it('run omits -quality for lossless target', async () => {
    const input = path.join(tmp, 'a.jpg');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertImage({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.png', deleteOriginal: false },
      onProgress: () => {},
    });
    expect(calls[0].args).not.toContain('-quality');
    expect(calls[0].args[calls[0].args.length - 1]).toBe(path.join(tmp, 'a.png'));
  });

  it('run records errors on spawn failure and continues', async () => {
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'X');
    fs.writeFileSync(path.join(tmp, 'b.jpg'), 'Y');
    let call = 0;
    const plugin = new ConvertImage({
      spawnTool: async () => { call++; if (call === 1) throw new Error('magick exited 1: bad format'); return { ok: true, stdout: '', stderr: '' }; },
    });
    const result = await plugin.run({
      targets: [path.join(tmp, 'a.jpg'), path.join(tmp, 'b.jpg')],
      binDir: '/fake/bin',
      options: { format: '.png' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.errors[0].message).toMatch(/magick exited 1/);
  });

  it('run adds webp lossless flag for .webp target', async () => {
    const input = path.join(tmp, 'a.jpg');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertImage({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.webp', quality: 100 },
      onProgress: () => {},
    });
    expect(calls[0].args).toContain('-define');
    expect(calls[0].args).toContain('webp:lossless=true');
  });

  it('buildRunningLabel returns "Converting…"', () => {
    expect(new ConvertImage().buildRunningLabel({})).toBe('Converting…');
  });
});
