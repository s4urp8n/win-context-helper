const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ConcatVideo = require('../../plugins/concat-video/plugin');

describe('ConcatVideo', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-concat-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ConcatVideo.manifest;
    expect(m).toMatchObject({
      id: 'concat-video', label: 'Concatenate video',
      accepts: ['files:.mp4,.mkv,.mov,.avi,.webm'],
      minSelection: 2, maxSelection: 999, ui: 'dialog',
    });
  });

  it('preflight sorts and detects container from first file', async () => {
    fs.writeFileSync(path.join(tmp, 'b.mp4'), 'B'.repeat(20));
    fs.writeFileSync(path.join(tmp, 'a.mp4'), 'A'.repeat(10));
    const result = await new ConcatVideo().preflight({ targets: [path.join(tmp, 'b.mp4'), path.join(tmp, 'a.mp4')] });
    expect(result.files.map((f) => f.basename)).toEqual(['a.mp4', 'b.mp4']);
    expect(result.totalFiles).toBe(2);
    expect(result.container).toBe('.mp4');
  });

  it('preflight returns totalFiles 0 with no targets', async () => {
    const result = await new ConcatVideo().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.mp4'); fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ConcatVideo().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run writes concat list file and invokes ffmpeg with -f concat', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.mp4'); fs.writeFileSync(b, 'B');
    const calls = [];
    const plugin = new ConcatVideo({
      spawnTool: async (args) => { calls.push({ ...args, listFileExists: fs.existsSync(args.args.find((x) => x.endsWith('.txt')) || '') }); return { ok: true, stdout: '', stderr: '' }; },
    });
    const result = await plugin.run({
      targets: [a, b], binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'ffmpeg.exe'));
    expect(calls[0].args).toContain('-f');
    expect(calls[0].args).toContain('concat');
    expect(calls[0].args).toContain('-safe');
    expect(calls[0].args).toContain('0');
    expect(calls[0].args).toContain('-c');
    expect(calls[0].args).toContain('copy');
    expect(calls[0].args.at(-1)).toBe(path.join(tmp, 'Concatenated.mp4'));
    // The concat list file should have existed during the spawn call.
    expect(calls[0].listFileExists).toBe(true);
  });

  it('run resolves output collision with (N) suffix', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.mp4'); fs.writeFileSync(b, 'B');
    fs.writeFileSync(path.join(tmp, 'Concatenated.mp4'), 'existing');
    const calls = [];
    const plugin = new ConcatVideo({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({ targets: [a, b], binDir: '/fake/bin', onProgress: () => {} });
    expect(calls[0].args.at(-1)).toBe(path.join(tmp, 'Concatenated (2).mp4'));
  });

  it('run records error on ffmpeg failure', async () => {
    const a = path.join(tmp, 'a.mp4'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.mp4'); fs.writeFileSync(b, 'B');
    const plugin = new ConcatVideo({ spawnTool: async () => { throw new Error('ffmpeg exited 1: incompatible streams'); } });
    const result = await plugin.run({ targets: [a, b], binDir: '/fake/bin', onProgress: () => {} });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/incompatible/);
  });

  it('buildRunningLabel returns "Concatenating…"', () => {
    expect(new ConcatVideo().buildRunningLabel({})).toBe('Concatenating…');
  });
});
