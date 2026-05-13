const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExtractAudio = require('../../plugins/extract-audio/plugin');

describe('ExtractAudio', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-xaud-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ExtractAudio.manifest;
    expect(m).toMatchObject({
      id: 'extract-audio', label: 'Extract audio',
      accepts: ['files:.mp4,.mkv,.mov,.avi,.webm'],
      minSelection: 1, maxSelection: 999, ui: 'dialog',
    });
  });

  it('preflight detects audio codec and maps to output extension', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'X');
    const b = path.join(tmp, 'b.mp4'); fs.writeFileSync(b, 'Y');
    let call = 0;
    const plugin = new ExtractAudio({
      spawnTool: async () => {
        call++;
        return { ok: true, stdout: call === 1 ? 'aac\n' : '', stderr: '' };
      },
    });
    const result = await plugin.preflight({ targets: [a, b], binDir: '/fake/bin' });
    expect(result.totalFiles).toBe(2);
    expect(result.files[0].hasAudio).toBe(true);
    expect(result.files[0].audioCodec).toBe('aac');
    expect(result.files[0].outputExt).toBe('.m4a');
    expect(result.files[1].hasAudio).toBe(false);
  });

  it('preflight returns totalFiles 0 with no targets', async () => {
    const plugin = new ExtractAudio({ spawnTool: async () => ({ ok: true, stdout: '', stderr: '' }) });
    const result = await plugin.preflight({ targets: [], binDir: '/fake/bin' });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.mp4'); fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    const plugin = new ExtractAudio({ spawnTool: async () => ({ ok: true, stdout: 'aac\n', stderr: '' }) });
    await plugin.preflight({ targets: [p], binDir: '/fake/bin' });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run extracts audio via stream-copy with codec-appropriate extension', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'X');
    const calls = [];
    const plugin = new ExtractAudio({
      spawnTool: async (args) => {
        calls.push(args);
        // ffprobe call returns codec 'aac'; ffmpeg call returns ok
        if (args.exe.endsWith('ffprobe.exe')) return { ok: true, stdout: 'aac\n', stderr: '' };
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const result = await plugin.run({
      targets: [a], binDir: '/fake/bin', selection: { skipped: [] }, options: {}, onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    // We expect at least one ffprobe call + one ffmpeg call
    const ffmpegCalls = calls.filter((c) => c.exe.endsWith('ffmpeg.exe'));
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0].args).toContain('-vn');
    expect(ffmpegCalls[0].args).toContain('-c:a');
    expect(ffmpegCalls[0].args).toContain('copy');
    // Output should be .m4a (aac → .m4a mapping)
    expect(ffmpegCalls[0].args.at(-1)).toBe(path.join(tmp, 'a.m4a'));
  });

  it('run records error on ffmpeg failure and continues', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'X');
    const b = path.join(tmp, 'b.mp4'); fs.writeFileSync(b, 'Y');
    let ffmpegCall = 0;
    const plugin = new ExtractAudio({
      spawnTool: async (args) => {
        if (args.exe.endsWith('ffprobe.exe')) return { ok: true, stdout: 'aac\n', stderr: '' };
        ffmpegCall++;
        if (ffmpegCall === 1) throw new Error('ffmpeg exited 1: no audio stream');
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const result = await plugin.run({
      targets: [a, b], binDir: '/fake/bin', selection: { skipped: [] }, options: {}, onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('buildRunningLabel returns "Extracting…"', () => {
    expect(new ExtractAudio().buildRunningLabel({})).toBe('Extracting…');
  });

  it('buildConfirmMessage lists files (with codec→ext) and mentions skipped without-audio ones', () => {
    const p = new ExtractAudio();
    const out = p.buildConfirmMessage({}, {
      files: [
        { basename: 'a.mp4', hasAudio: true, audioCodec: 'aac', outputExt: '.m4a' },
        { basename: 'b.mp4', hasAudio: false },
      ],
      totalFiles: 2,
    });
    expect(out.message).toMatch(/Extract audio/);
    expect(out.detail).toMatch(/b\.mp4/);
    expect(out.detail).toMatch(/no audio/i);
    expect(out.detail).toMatch(/a\.mp4/);
    expect(out.detail).toMatch(/\.m4a/);
    expect(out.detail).toMatch(/lossless|Stream-copy/i);
  });
});
