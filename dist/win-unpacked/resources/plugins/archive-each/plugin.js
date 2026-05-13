const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function folderSizeRecursive(root, onProgress, counter) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
        if (counter) {
          counter.scanned++;
          const now = Date.now();
          if (onProgress && counter.scanned % 100 === 0 && now - counter.lastEmit >= 150) {
            counter.lastEmit = now;
            onProgress({ scanned: counter.scanned });
          }
        }
      }
    }
  }
  return total;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function parse7zProgress(text) {
  // 7z prints lines like " 42% 12 + Compressing  file.txt"
  const m = /(\d+)%/.exec(text);
  if (m) return { percent: Number(m[1]) };
  return null;
}

class ArchiveEach extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'archive-each',
      label: 'Archive each',
      description: 'Create an archive next to each selected item',
      icon: 'icon.png',
      accepts: ['folders', 'files'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets, onProgress }) {
    const items = [];
    let totalBytes = 0;
    const counter = { scanned: 0, lastEmit: 0 };
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      const isFolder = stat.isDirectory();
      const sizeBytes = isFolder ? folderSizeRecursive(t, onProgress, counter) : stat.size;
      if (!isFolder && onProgress) {
        counter.scanned++;
        onProgress({ scanned: counter.scanned });
      }
      items.push({ basename: path.basename(t), isFolder, sizeBytes, path: t });
      totalBytes += sizeBytes;
    }
    if (onProgress) onProgress({ scanned: counter.scanned });
    return { items, totalItems: items.length, totalBytes };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const fmt = String(options.format || 'zip').toLowerCase();
    const targetExt = fmt === '7z' ? '.7z' : '.zip';
    const tFlag = fmt === '7z' ? '-t7z' : '-tzip';
    const compression = options.compression !== undefined ? Number(options.compression) : 9;
    const mx = `-mx=${Math.max(0, Math.min(9, compression))}`;
    const exe = path.join(binDir, '7z.exe');

    let processed = 0;
    let skipped = 0;
    const errors = [];
    const total = targets.length;

    // Track taken output names per parent directory to handle collisions across siblings.
    const takenByParent = new Map();
    const reserveOutput = (sourcePath) => {
      const parent = path.dirname(sourcePath);
      const basename = path.basename(sourcePath);
      const defaultName = `${basename}${targetExt}`;
      let taken = takenByParent.get(parent);
      if (!taken) {
        taken = new Set();
        // Seed with files already on disk
        try {
          for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
            if (e.isFile()) taken.add(e.name);
          }
        } catch {}
        takenByParent.set(parent, taken);
      }
      const chosen = resolveCollision(defaultName, taken);
      taken.add(chosen);
      return path.join(parent, chosen);
    };

    for (const source of targets) {
      if (signal && signal.aborted) {
        return { ok: false, processed, skipped, errors, aborted: true };
      }
      const outputPath = reserveOutput(source);
      try {
        await this._spawnTool({
          exe,
          args: ['a', tFlag, mx, outputPath, source],
          parseProgress: (text) => parse7zProgress(text),
          onProgress: (p) => {
            // Per-item percent; report overall as items-done / total
            onProgress({ processed, total, itemPercent: p.percent, current: path.basename(source) });
          },
          signal,
        });
        processed++;
      } catch (err) {
        errors.push({ file: path.basename(source), message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }

    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalItems === 0); }

  buildNothingToDoBody(_ctx, _pre) {
    return { message: 'Nothing to archive.', detail: 'No items found in selection.' };
  }

  buildFormMessage(_ctx, pre) {
    return `Archive ${pre.totalItems} ${plural(pre.totalItems, 'item', 'items')}`;
  }

  _buildItemList(pre, limit = 50) {
    const sorted = [...pre.items].sort((a, b) =>
      a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' })
    );
    const shown = sorted.slice(0, limit);
    const width = String(Math.min(sorted.length, limit)).length;
    const lines = shown.map((it, i) => {
      const num = String(i + 1).padStart(width, ' ');
      const slash = it.isFolder ? '/' : '';
      return `${num}. ${it.basename}${slash}  (${formatBytes(it.sizeBytes)})`;
    });
    if (sorted.length > limit) lines.push(`… and ${sorted.length - limit} more`);
    return lines;
  }

  buildFormSummary(_ctx, pre) {
    const lines = this._buildItemList(pre, 50);
    lines.push('');
    lines.push(`Total: ${formatBytes(pre.totalBytes)}. Output: next to each source with collision (N) suffix.`);
    return lines.join('\n');
  }

  buildConfirmMessage(_ctx, pre) {
    const lines = this._buildItemList(pre, 50);
    lines.push('');
    lines.push(`Total: ${formatBytes(pre.totalBytes)}. Output: next to each source with collision (N) suffix.`);
    return {
      message: pre.totalItems === 1 ? 'Archive this item?' : `Archive ${pre.totalItems} items?`,
      detail: lines.join('\n'),
    };
  }

  buildRunningLabel(_ctx) { return 'Archiving…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'item', 'items')} archived.`,
      `${errors.length} ${plural(errors.length, 'item', 'items')} could not be archived:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ArchiveEach;
