const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encode, decode, parse } = require('./reg-file');

let tempCounter = 0;
const tempRegFile = () => path.join(os.tmpdir(), `contexthelper-${process.pid}-${Date.now()}-${tempCounter++}.reg`);

function createRunner(exe = 'reg.exe') {
  return (args) => new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(exe, args, { windowsHide: true });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // A promise settles once, so whichever of 'error' / 'close' comes first wins.
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: `${err.code}: ${err.message}` }));
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('latin1'),
      stderr: Buffer.concat(stderr).toString('latin1'),
    }));
  });
}

// reg.exe prints to the console in the OEM code page, which garbles non-ASCII paths,
// so data is always read from the UTF-16 file written by `reg export`. stderr is only for the log.
function createReg({ runReg = createRunner() } = {}) {
  async function exportKey(key) {
    const file = tempRegFile();
    try {
      const result = await runReg(['export', key, file, '/y']);
      if (result.code !== 0) return { tree: new Map(), error: result.stderr.trim() || `reg export exited ${result.code}` };
      return { tree: parse(decode(fs.readFileSync(file))), error: null };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async function importFile(text) {
    const file = tempRegFile();
    fs.writeFileSync(file, encode(text));
    try {
      const result = await runReg(['import', file]);
      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        throw Object.assign(new Error(`reg import exited ${result.code}: ${stderr}`), { exitCode: result.code, stderr });
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  return { exportKey, importFile };
}

module.exports = { createReg, createRunner };
