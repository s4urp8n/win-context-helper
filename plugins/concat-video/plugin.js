const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

class ConcatVideo extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'concat-video', label: 'Concatenate video',
      description: 'Concatenate selected videos into one (stream-copy)',
      icon: 'icon.png',
      accepts: ['files:.mp4,.mkv,.mov,.avi,.webm'],
      minSelection: 2, maxSelection: 999, ui: 'dialog',
    };
  }

  async preflight({ targets }) {
    const files = [];
    let totalBytes = 0;
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      files.push({ basename: path.basename(t), sizeBytes: stat.size, path: t });
      totalBytes += stat.size;
    }
    files.sort((a, b) => a.basename.localeCompare(b.basename));
    const container = files.length > 0 ? path.extname(files[0].basename).toLowerCase() : '.mp4';
    return { files, totalFiles: files.length, totalBytes, container };
  }

  async run({ targets, binDir, onProgress = () => {}, signal }) {
    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const parent = path.dirname(sorted[0]);
    const ext = path.extname(sorted[0]).toLowerCase() || '.mp4';

    // Write a temp concat-list file inside the tmp dir so it cleans up easily.
    const listFile = path.join(os.tmpdir(), `ch-concat-${Date.now()}.txt`);
    const listLines = sorted.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listFile, listLines, 'utf8');

    let taken = new Set();
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); } catch {}
    const finalName = resolveCollision(`Concatenated${ext}`, taken);
    const output = path.join(parent, finalName);

    if (signal && signal.aborted) {
      try { fs.unlinkSync(listFile); } catch {}
      return { ok: false, processed: 0, skipped: 0, errors: [], aborted: true };
    }

    const exe = path.join(binDir, 'ffmpeg.exe');
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output];
    try {
      await this._spawnTool({ exe, args, signal });
      try { fs.unlinkSync(listFile); } catch {}
      return { ok: true, processed: targets.length, skipped: 0, errors: [] };
    } catch (err) {
      try { fs.unlinkSync(listFile); } catch {}
      return { ok: false, processed: 0, skipped: targets.length, errors: [{ file: finalName, message: err.message }] };
    }
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to concatenate.', detail: 'No video files selected.' }; }

  buildConfirmMessage(_ctx, pre) {
    const lines = [];
    for (const f of pre.files.slice(0, 10)) lines.push(`  • ${f.basename}`);
    if (pre.files.length > 10) lines.push(`  … and ${pre.files.length - 10} more`);
    lines.push('');
    lines.push(`Output: Concatenated${pre.container} in the parent of the first file.`);
    lines.push(`Total: ${formatBytes(pre.totalBytes)}. Stream-copy (no re-encode).`);
    return {
      message: `Concatenate ${pre.totalFiles} videos?`,
      detail: lines.join('\n'),
    };
  }

  buildRunningLabel() { return 'Concatenating…'; }

  buildErrorBody(_ctx, errors) {
    return errors.map((e) => `  • ${e.file} — ${e.message}`).join('\n');
  }
}

module.exports = ConcatVideo;
