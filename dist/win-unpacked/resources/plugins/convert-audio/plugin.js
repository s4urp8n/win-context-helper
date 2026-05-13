const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);
const LOSSLESS = new Set(['.wav', '.flac']);

function parseFfmpegProgress(text) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (m) {
    const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return { timeSec: sec };
  }
  return null;
}

class ConvertAudio extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'convert-audio', label: 'Convert audio',
      description: 'Convert audio files to a chosen target format',
      icon: 'icon.png',
      accepts: ['files:.mp3,.wav,.flac,.m4a,.ogg,.opus,.aac'],
      minSelection: 1, maxSelection: 999, ui: 'window',
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
    return { files, totalFiles: files.length, totalBytes };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const fmt = String(options.format || '.mp3').toLowerCase();
    const targetExt = fmt.startsWith('.') ? fmt : '.' + fmt;
    const bitrate = options.bitrate !== undefined ? Number(options.bitrate) : 320;
    const deleteOriginal = !!options.deleteOriginal;
    const exe = path.join(binDir, 'ffmpeg.exe');

    const takenByParent = new Map();
    const reserveOutput = (input) => {
      const parent = path.dirname(input);
      const baseNoExt = path.basename(input, path.extname(input));
      const defaultName = `${baseNoExt}${targetExt}`;
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

    let processed = 0;
    let skipped = 0;
    const errors = [];
    const total = targets.length;

    for (const input of targets) {
      if (signal && signal.aborted) return { ok: false, processed, skipped, errors, aborted: true };
      const output = reserveOutput(input);
      const args = ['-y', '-i', input];
      if (!LOSSLESS.has(targetExt)) args.push('-b:a', `${bitrate}k`);
      args.push(output);
      try {
        await this._spawnTool({
          exe, args,
          parseProgress: parseFfmpegProgress,
          onProgress: (p) => onProgress({ processed, total, itemTimeSec: p.timeSec }),
          signal,
        });
        processed++;
        if (deleteOriginal) { try { fs.unlinkSync(input); } catch {} }
      } catch (err) {
        errors.push({ file: path.basename(input), message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to convert.', detail: 'No audio files selected.' }; }

  buildFormMessage(_ctx, pre) { return `Convert ${pre.totalFiles} ${plural(pre.totalFiles, 'audio file', 'audio files')}`; }
  buildFormSummary(_ctx, pre) {
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'file', 'files')} (${mb} MB).`;
  }
  buildRunningLabel() { return 'Converting…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} converted.`,
      `${errors.length} could not be converted:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ConvertAudio;
