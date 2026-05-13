const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function codecToExt(codec) {
  if (!codec) return '.m4a';
  const c = String(codec).toLowerCase().trim();
  if (c === 'aac') return '.m4a';
  if (c === 'mp3') return '.mp3';
  if (c === 'vorbis') return '.ogg';
  if (c === 'opus') return '.opus';
  if (c === 'flac') return '.flac';
  if (c.startsWith('pcm_')) return '.wav';
  return '.m4a';
}

class ExtractAudio extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'extract-audio', label: 'Extract audio',
      description: 'Extract audio track from video files (stream-copy, lossless)',
      icon: 'icon.png',
      accepts: ['files:.mp4,.mkv,.mov,.avi,.webm'],
      minSelection: 1, maxSelection: 999, ui: 'dialog',
    };
  }

  async preflight({ targets, binDir }) {
    const files = [];
    let totalBytes = 0;
    const exe = path.join(binDir || '', 'ffprobe.exe');
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      let codec = null;
      try {
        const r = await this._spawnTool({
          exe,
          args: ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', t],
        });
        const trimmed = (r.stdout || '').trim();
        if (trimmed.length > 0) codec = trimmed.split(/\r?\n/)[0].trim();
      } catch {
        codec = null;
      }
      const hasAudio = !!codec;
      const outputExt = codecToExt(codec);
      files.push({ basename: path.basename(t), sizeBytes: stat.size, hasAudio, audioCodec: codec, outputExt, path: t });
      totalBytes += stat.size;
    }
    return { files, totalFiles: files.length, totalBytes };
  }

  async run({ targets, binDir, selection, onProgress = () => {}, signal }) {
    const exe = path.join(binDir, 'ffmpeg.exe');
    const ffprobeExe = path.join(binDir, 'ffprobe.exe');
    const takenByParent = new Map();
    const reserveOutput = (input, ext) => {
      const parent = path.dirname(input);
      const baseNoExt = path.basename(input, path.extname(input));
      const defaultName = `${baseNoExt}${ext}`;
      let taken = takenByParent.get(parent);
      if (!taken) {
        taken = new Set();
        try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); }
        catch {}
        takenByParent.set(parent, taken);
      }
      const chosen = resolveCollision(defaultName, taken);
      taken.add(chosen);
      return path.join(parent, chosen);
    };

    let processed = 0; let skipped = 0;
    const errors = [];
    const total = targets.length;

    for (const input of targets) {
      if (signal && signal.aborted) return { ok: false, processed, skipped, errors, aborted: true };

      // Detect codec for this file (re-probe; preflight result not threaded through to run)
      let codec = null;
      try {
        const r = await this._spawnTool({
          exe: ffprobeExe,
          args: ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', input],
        });
        const trimmed = (r.stdout || '').trim();
        if (trimmed.length > 0) codec = trimmed.split(/\r?\n/)[0].trim();
      } catch {
        codec = null;
      }
      const outputExt = codecToExt(codec);
      const output = reserveOutput(input, outputExt);

      const args = ['-y', '-i', input, '-vn', '-c:a', 'copy', output];
      try {
        await this._spawnTool({ exe, args, signal });
        processed++;
      } catch (err) {
        errors.push({ file: path.basename(input), message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to extract.', detail: 'No video files selected.' }; }

  buildConfirmMessage(_ctx, pre) {
    const lines = [];
    const withAudio = pre.files.filter((f) => f.hasAudio);
    const withoutAudio = pre.files.filter((f) => !f.hasAudio);
    for (const f of withAudio.slice(0, 10)) {
      lines.push(`  • ${f.basename}  →  ${f.outputExt || '.m4a'}  (${f.audioCodec || 'unknown'})`);
    }
    if (withAudio.length > 10) lines.push(`  … and ${withAudio.length - 10} more`);
    if (withoutAudio.length > 0) {
      lines.push('');
      lines.push(`The following ${plural(withoutAudio.length, 'file has', 'files have')} no audio and will be skipped:`);
      for (const f of withoutAudio.slice(0, 10)) lines.push(`  • ${f.basename}`);
    }
    lines.push('');
    lines.push('Stream-copy (lossless) — original audio is preserved bit-for-bit.');
    return {
      message: `Extract audio from ${withAudio.length} ${plural(withAudio.length, 'video', 'videos')}?`,
      detail: lines.join('\n'),
    };
  }

  buildRunningLabel() { return 'Extracting…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} extracted.`,
      `${errors.length} failed:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ExtractAudio;
