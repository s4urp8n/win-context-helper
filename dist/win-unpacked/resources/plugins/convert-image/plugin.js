const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);
const LOSSY = new Set(['.jpg', '.jpeg', '.webp']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return name.slice(i).toLowerCase();
}

function parseMagickProgress(text) {
  // ImageMagick -monitor emits "load image: <path>" + "<n> of <m>" lines on stderr
  const m = /(\d+)\s+of\s+(\d+)/i.exec(text);
  if (m) return { processed: Number(m[1]), total: Number(m[2]) };
  return null;
}

class ConvertImage extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'convert-image',
      label: 'Convert image',
      description: 'Convert images to a chosen target format and quality',
      icon: 'icon.png',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets }) {
    const files = [];
    const byExt = {};
    let totalBytes = 0;
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      const basename = path.basename(t);
      const ext = extOf(basename);
      files.push({ basename, sizeBytes: stat.size, ext, path: t });
      totalBytes += stat.size;
      if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
    }
    return { files, totalFiles: files.length, totalBytes, byExt };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const fmt = String(options.format || '.png').toLowerCase();
    const targetExt = fmt.startsWith('.') ? fmt : '.' + fmt;
    const quality = options.quality !== undefined ? Number(options.quality) : 100;
    const deleteOriginal = !!options.deleteOriginal;
    const exe = path.join(binDir, 'magick.exe');

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

    let processed = 0; let skipped = 0;
    const errors = [];
    const total = targets.length;

    for (const input of targets) {
      if (signal && signal.aborted) return { ok: false, processed, skipped, errors, aborted: true };
      const output = reserveOutput(input);
      const args = ['-monitor', input];
      if (LOSSY.has(targetExt)) args.push('-quality', String(quality));
      if (targetExt === '.webp') args.push('-define', 'webp:lossless=true');
      args.push(output);
      try {
        await this._spawnTool({
          exe, args,
          parseProgress: parseMagickProgress,
          onProgress: (p) => onProgress({ processed, total, itemProgress: p }),
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
  buildNothingToDoBody() { return { message: 'Nothing to convert.', detail: 'No images selected.' }; }

  buildFormMessage(_ctx, pre) {
    return `Convert ${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')}`;
  }
  buildFormSummary(_ctx, pre) {
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    const exts = Object.entries(pre.byExt).map(([e, n]) => `${e}: ${n}`).join(', ');
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'file', 'files')} (${mb} MB). ${exts}.`;
  }
  buildRunningLabel() { return 'Converting…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'image', 'images')} converted.`,
      `${errors.length} could not be converted:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ConvertImage;
