const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function walkFilesWithRel(root) {
  const out = [];
  const stack = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) stack.push({ dir: full, rel: childRel });
      else if (entry.isFile()) out.push({ full, rel: childRel, name: entry.name });
    }
  }
  return out;
}

function pruneEmptyDirs(root) {
  const stack = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(dir, entry.name));
    if (dir !== root) stack.push(dir);
  })(root);
  for (const dir of stack) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  }
}

class MergeFolders extends BasePlugin {
  static get manifest() {
    return {
      id: 'merge-folders',
      label: 'Merge folders',
      description: 'Merge contents of 2+ folders into the first (alphabetical)',
      icon: 'icon.png',
      accepts: ['folders'],
      minSelection: 2,
      maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets, onProgress }) {
    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const target = sorted[0];
    const sources = sorted.slice(1);

    const takenInTarget = new Set();
    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name);
    } catch {}
    for (const n of entries) takenInTarget.add(n);

    let totalFiles = 0;
    let collisionCount = 0;
    const sourceInfo = [];
    const seenNames = new Set(takenInTarget);

    let scanned = 0;
    let lastEmit = 0;
    for (const src of sources) {
      const files = walkFilesWithRel(src);
      sourceInfo.push({ basename: path.basename(src), fileCount: files.length });
      for (const { name } of files) {
        totalFiles++;
        scanned++;
        if (seenNames.has(name)) collisionCount++;
        else seenNames.add(name);
        if (onProgress) {
          const now = Date.now();
          if (scanned % 100 === 0 && now - lastEmit >= 150) {
            lastEmit = now;
            onProgress({ scanned });
          }
        }
      }
    }
    if (onProgress) onProgress({ scanned });

    return {
      target: { basename: path.basename(target), path: target },
      sources: sourceInfo,
      totalFiles,
      collisionCount,
    };
  }

  async run({ targets, options = {}, onProgress = () => {}, signal }) {
    const strategy = options.collisionStrategy || 'rename';
    const deleteSourceFolders = options.deleteSourceFolders !== false;

    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const target = sorted[0];
    const sources = sorted.slice(1);

    const taken = new Set();
    try {
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (e.isFile()) taken.add(e.name);
      }
    } catch {}

    // Build plan
    const plan = [];
    for (const src of sources) {
      for (const f of walkFilesWithRel(src)) plan.push({ src: f.full, name: f.name, srcRoot: src });
    }

    let processed = 0;
    let skipped = 0;
    const errors = [];
    let lastEmit = 0;
    const total = plan.length;

    for (const item of plan) {
      if (signal && signal.aborted) {
        return { ok: false, processed, skipped, errors, aborted: true };
      }
      let destName = item.name;
      if (taken.has(destName)) {
        if (strategy === 'skip') {
          skipped++;
          processed++;
          continue;
        } else if (strategy === 'overwrite') {
          // fall through; fs.renameSync will overwrite on Windows when dest exists? Not by default.
          // Use unlink first.
          try { fs.unlinkSync(path.join(target, destName)); } catch {}
        } else {
          // rename
          destName = resolveCollision(destName, taken);
        }
      }
      try {
        fs.renameSync(item.src, path.join(target, destName));
        taken.add(destName);
        processed++;
      } catch (err) {
        errors.push({ file: item.name, message: err.message });
        skipped++;
      }
      const now = Date.now();
      if (now - lastEmit >= 150 || processed + skipped === total) {
        lastEmit = now;
        onProgress({ processed: processed + skipped, total });
      }
    }

    if (deleteSourceFolders) {
      for (const src of sources) {
        pruneEmptyDirs(src);
        try { if (fs.readdirSync(src).length === 0) fs.rmdirSync(src); } catch {}
      }
    }

    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) {
    return !!(pre && pre.totalFiles === 0);
  }

  buildNothingToDoBody(_ctx, _pre) {
    return {
      message: 'Nothing to merge.',
      detail: 'The source folders contain no files.',
    };
  }

  buildFormMessage(_ctx, pre) {
    return `Merge into "${pre.target.basename}"`;
  }

  buildFormSummary(_ctx, pre) {
    const lines = [
      `Target: ${pre.target.basename}`,
      `Sources: ${pre.sources.map((s) => `${s.basename} (${s.fileCount})`).join(', ')}`,
      `${pre.totalFiles} ${plural(pre.totalFiles, 'file', 'files')} will be moved.`,
    ];
    if (pre.collisionCount > 0) {
      lines.push(`${pre.collisionCount} ${plural(pre.collisionCount, 'name collision', 'name collisions')} detected.`);
    }
    return lines.join('\n');
  }

  buildRunningLabel(_ctx) { return 'Merging…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'file', 'files')} merged.`,
      `${errors.length} ${plural(errors.length, 'file', 'files')} could not be merged:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = MergeFolders;
