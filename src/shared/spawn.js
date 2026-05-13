const { spawn } = require('node:child_process');

function spawnTool({ exe, args, onProgress, parseProgress, signal, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd,
    });
    let stderr = '';
    let stdout = '';

    const feed = (text, stream) => {
      if (stream === 'stderr') stderr += text;
      else stdout += text;
      if (parseProgress) {
        const p = parseProgress(text, stream);
        if (p && onProgress) {
          try { onProgress(p); } catch {}
        }
      }
    };
    child.stdout.on('data', (c) => feed(c.toString('utf8'), 'stdout'));
    child.stderr.on('data', (c) => feed(c.toString('utf8'), 'stderr'));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (signal && signal.aborted) {
        return resolve({ ok: false, aborted: true, stdout, stderr });
      }
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else reject(new Error(`${exe} exited ${code}: ${stderr.slice(-500).trim()}`));
    });

    if (signal) {
      const onAbort = () => { try { child.kill(); } catch {} };
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort);
      }
    }
  });
}

module.exports = { spawnTool };
