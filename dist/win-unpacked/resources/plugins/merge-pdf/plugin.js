const fs = require('node:fs');
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

class MergePdf extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'merge-pdf',
      label: 'Merge PDF',
      description: 'Combine selected PDFs into one (alphabetical order)',
      icon: 'icon.png',
      accepts: ['files:.pdf'],
      minSelection: 2, maxSelection: 999,
      ui: 'dialog',
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

  async run({ targets, binDir, onProgress = () => {}, signal }) {
    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const parent = path.dirname(sorted[0]);
    let taken = new Set();
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); } catch {}
    const finalName = resolveCollision('Merged.pdf', taken);
    const output = path.join(parent, finalName);

    if (signal && signal.aborted) return { ok: false, processed: 0, skipped: 0, errors: [], aborted: true };

    const exe = path.join(binDir, 'gswin64c.exe');
    const args = [
      '-dBATCH', '-dNOPAUSE', '-q', '-dNOSAFER',
      '-sDEVICE=pdfwrite',
      '-dPDFSETTINGS=/prepress',
      `-sOutputFile=${output}`,
      ...sorted,
    ];
    try {
      await this._spawnTool({ exe, args, signal });
      return { ok: true, processed: targets.length, skipped: 0, errors: [] };
    } catch (err) {
      return { ok: false, processed: 0, skipped: targets.length, errors: [{ file: finalName, message: err.message }] };
    }
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to merge.', detail: 'No PDF files selected.' }; }

  buildConfirmMessage(_ctx, pre) {
    const lines = [];
    for (const f of pre.files.slice(0, 10)) lines.push(`  • ${f.basename}`);
    if (pre.files.length > 10) lines.push(`  … and ${pre.files.length - 10} more`);
    lines.push('');
    lines.push(`Output: Merged.pdf (or Merged (N).pdf on collision) in the parent of the first file.`);
    lines.push(`Total: ${formatBytes(pre.totalBytes)}.`);
    return {
      message: `Merge ${pre.totalFiles} PDFs?`,
      detail: lines.join('\n'),
    };
  }

  buildRunningLabel() { return 'Merging…'; }

  buildErrorBody(_ctx, errors) {
    return errors.map((e) => `  • ${e.file} — ${e.message}`).join('\n');
  }
}

module.exports = MergePdf;
