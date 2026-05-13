const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnTool } = require('../../src/shared/spawn');

const NODE = process.execPath;

describe('spawnTool', () => {
  it('resolves ok:true when the child exits 0', async () => {
    const result = await spawnTool({
      exe: NODE,
      args: ['-e', 'console.log("hello"); process.exit(0)'],
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/hello/);
  });

  it('rejects when the child exits non-zero with stderr suffix in error', async () => {
    await expect(spawnTool({
      exe: NODE,
      args: ['-e', 'console.error("boom-stderr"); process.exit(7)'],
    })).rejects.toThrow(/boom-stderr/);
  });

  it('calls parseProgress on stdout chunks', async () => {
    const calls = [];
    await spawnTool({
      exe: NODE,
      args: ['-e', 'console.log("PROGRESS:42")'],
      parseProgress: (text, stream) => {
        const m = /PROGRESS:(\d+)/.exec(text);
        if (m) return { processed: Number(m[1]), stream };
        return null;
      },
      onProgress: (p) => calls.push(p),
    });
    expect(calls).toContainEqual({ processed: 42, stream: 'stdout' });
  });

  it('calls parseProgress on stderr chunks', async () => {
    const calls = [];
    await spawnTool({
      exe: NODE,
      args: ['-e', 'console.error("time=00:01:23")'],
      parseProgress: (text, stream) => {
        const m = /time=(\S+)/.exec(text);
        if (m) return { time: m[1], stream };
        return null;
      },
      onProgress: (p) => calls.push(p),
    });
    expect(calls[0]).toEqual({ time: '00:01:23', stream: 'stderr' });
  });

  it('kills the child when signal.aborted becomes true', async () => {
    const controller = new AbortController();
    const promise = spawnTool({
      exe: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });
});
