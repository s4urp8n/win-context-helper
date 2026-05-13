const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ConvertAudio = require('../../plugins/convert-audio/plugin');

describe('ConvertAudio', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cvtaud-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ConvertAudio.manifest;
    expect(m).toMatchObject({
      id: 'convert-audio', label: 'Convert audio',
      accepts: ['files:.mp3,.wav,.flac,.m4a,.ogg,.opus,.aac'],
      minSelection: 1, maxSelection: 999, ui: 'window',
    });
  });

  it('preflight returns per-file info', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mp3'), 'X'.repeat(10));
    fs.writeFileSync(path.join(tmp, 'b.wav'), 'Y'.repeat(20));
    const result = await new ConvertAudio().preflight({
      targets: [path.join(tmp, 'a.mp3'), path.join(tmp, 'b.wav')],
    });
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBe(30);
  });

  it('preflight returns totalFiles 0 with no targets', async () => {
    const result = await new ConvertAudio().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.mp3');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ConvertAudio().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run builds ffmpeg args with bitrate for lossy target', async () => {
    const input = path.join(tmp, 'a.flac');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertAudio({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.mp3', bitrate: 192, deleteOriginal: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'ffmpeg.exe'));
    expect(calls[0].args).toContain('-i');
    expect(calls[0].args).toContain(input);
    expect(calls[0].args).toContain('-b:a');
    expect(calls[0].args).toContain('192k');
    expect(calls[0].args.at(-1)).toBe(path.join(tmp, 'a.mp3'));
  });

  it('run omits -b:a for lossless target', async () => {
    const input = path.join(tmp, 'a.mp3');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertAudio({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.flac' },
      onProgress: () => {},
    });
    expect(calls[0].args).not.toContain('-b:a');
  });

  it('run records error on spawn failure', async () => {
    const input = path.join(tmp, 'a.mp3');
    fs.writeFileSync(input, 'X');
    const plugin = new ConvertAudio({ spawnTool: async () => { throw new Error('ffmpeg exited 1: bad'); } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.wav' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('buildRunningLabel returns "Converting…"', () => {
    expect(new ConvertAudio().buildRunningLabel({})).toBe('Converting…');
  });
});
