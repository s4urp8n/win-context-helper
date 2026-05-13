const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function parseMagickProgress(text) {
  const m = /(\d+)\s+of\s+(\d+)/i.exec(text);
  if (m) return { processed: Number(m[1]), total: Number(m[2]) };
  return null;
}

class ImagesToPdf extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'images-to-pdf',
      label: 'Images to PDF',
      description: 'Combine selected images into a single PDF',
      icon: 'icon.png',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
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
    return { files, totalFiles: files.length, totalBytes };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    let outputName = String(options.output || 'Images.pdf');
    if (!outputName.toLowerCase().endsWith('.pdf')) outputName += '.pdf';
    const pageSize = String(options.pageSize || 'Original');
    const parent = path.dirname(sorted[0]);

    let taken = new Set();
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); } catch {}
    const finalName = resolveCollision(outputName, taken);
    const output = path.join(parent, finalName);

    const exe = path.join(binDir, 'magick.exe');
    const args = ['-monitor', ...sorted];
    if (pageSize !== 'Original') args.push('-page', pageSize);
    args.push(output);

    if (signal && signal.aborted) return { ok: false, processed: 0, skipped: 0, errors: [], aborted: true };

    try {
      await this._spawnTool({
        exe, args,
        parseProgress: parseMagickProgress,
        onProgress: (p) => onProgress(p),
        signal,
      });
      return { ok: true, processed: targets.length, skipped: 0, errors: [] };
    } catch (err) {
      return { ok: false, processed: 0, skipped: targets.length, errors: [{ file: finalName, message: err.message }] };
    }
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to combine.', detail: 'No images selected.' }; }

  buildFormMessage(_ctx, pre) {
    return `Combine ${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')} into a PDF`;
  }
  buildFormSummary(_ctx, pre) {
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')} (${mb} MB). Files will be sorted alphabetically.`;
  }
  buildRunningLabel() { return 'Building PDF…'; }

  buildErrorBody(_ctx, errors) {
    return errors.map((e) => `  • ${e.file} — ${e.message}`).join('\n');
  }
}

module.exports = ImagesToPdf;
