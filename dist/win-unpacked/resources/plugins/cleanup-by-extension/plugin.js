const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');

const plural = (n, one, many) => (n === 1 ? one : many);

function walkFiles(root, onEntry) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) onEntry(full, entry.name);
    }
  }
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return name.slice(i).toLowerCase();
}

class CleanupByExtension extends BasePlugin {
  static get manifest() {
    return {
      id: 'cleanup-by-extension',
      label: 'Cleanup by extension',
      description: 'Delete files of selected extensions from selected folders',
      icon: 'icon.png',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets, onProgress }) {
    const byExt = new Map();
    let totalFiles = 0;
    let totalBytes = 0;
    let lastEmit = 0;
    for (const root of targets) {
      walkFiles(root, (full, name) => {
        const ext = extOf(name);
        if (!ext) return;
        let entry = byExt.get(ext);
        if (!entry) { entry = { ext, count: 0, totalBytes: 0 }; byExt.set(ext, entry); }
        entry.count++;
        try { entry.totalBytes += fs.statSync(full).size; } catch {}
        totalFiles++;
        if (onProgress) {
          const now = Date.now();
          if (totalFiles % 100 === 0 && now - lastEmit >= 150) {
            lastEmit = now;
            onProgress({ scanned: totalFiles });
          }
        }
      });
    }
    if (onProgress) onProgress({ scanned: totalFiles });
    const extensions = [...byExt.values()].sort((a, b) => b.count - a.count);
    totalBytes = extensions.reduce((s, e) => s + e.totalBytes, 0);
    return { extensions, totalFiles, totalBytes };
  }

  async run({ targets, options = {}, onProgress = () => {}, signal }) {
    const selected = new Set((options.selectedExts || []).map((e) => String(e).toLowerCase()));
    if (selected.size === 0) return { ok: true, processed: 0, skipped: 0, errors: [] };

    // First pass: build list of files to delete (so we know the total).
    const toDelete = [];
    for (const root of targets) {
      walkFiles(root, (full, name) => {
        const ext = extOf(name);
        if (ext && selected.has(ext)) toDelete.push(full);
      });
    }

    let processed = 0;
    let skipped = 0;
    const errors = [];
    let lastEmit = 0;
    const total = toDelete.length;

    for (const full of toDelete) {
      if (signal && signal.aborted) {
        return { ok: false, processed, skipped, errors, aborted: true };
      }
      try {
        fs.unlinkSync(full);
        processed++;
      } catch (err) {
        errors.push({ file: path.basename(full), message: err.message });
        skipped++;
      }
      const now = Date.now();
      if (now - lastEmit >= 150 || processed + skipped === total) {
        lastEmit = now;
        onProgress({ processed: processed + skipped, total });
      }
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) {
    return !!(pre && pre.totalFiles === 0);
  }

  buildNothingToDoBody(_ctx, _pre) {
    return {
      message: 'Nothing to clean up.',
      detail: 'The selected folder(s) contain no files.',
    };
  }

  buildFormMessage(_ctx, pre) {
    const nExts = pre && pre.extensions ? pre.extensions.length : 0;
    return `Cleanup by extension — ${nExts} ${plural(nExts, 'extension', 'extensions')} found`;
  }

  buildFormSummary(_ctx, pre) {
    if (!pre || pre.totalFiles === 0) return 'No files found.';
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'file', 'files')} across ${pre.extensions.length} ${plural(pre.extensions.length, 'extension', 'extensions')} (${mb} MB total). Check the extensions to delete.`;
  }

  buildFormHtml(_ctx, pre) {
    if (!pre || !pre.extensions || pre.extensions.length === 0) {
      return '<div class="form-summary">No files to clean up.</div>';
    }
    const rows = pre.extensions.map((e) => {
      const mb = (e.totalBytes / (1024 * 1024)).toFixed(2);
      return `<label class="ext-row">
  <input type="checkbox" name="selectedExts" value="${e.ext}" />
  <span class="ext-name">${e.ext}</span>
  <span class="ext-info">${e.count} ${plural(e.count, 'file', 'files')} (${mb} MB)</span>
</label>`;
    }).join('\n');
    return rows;
  }

  buildRunningLabel(_ctx) { return 'Cleaning up…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'file', 'files')} deleted.`,
      `${errors.length} ${plural(errors.length, 'file', 'files')} could not be deleted:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = CleanupByExtension;
