const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const MAX_LIST = 10;
const plural = (n, one, many) => n === 1 ? one : many;

function walkFiles(root, onScanProgress) {
  const out = [];
  const stack = [root];
  let lastEmit = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        out.push(full);
        if (onScanProgress) {
          const now = Date.now();
          if (out.length % 100 === 0 && now - lastEmit >= 150) {
            lastEmit = now;
            onScanProgress({ scanned: out.length });
          }
        }
      }
    }
  }
  if (onScanProgress) onScanProgress({ scanned: out.length });
  return out;
}

function pruneEmptyDirs(root) {
  const stack = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
    if (dir !== root) stack.push(dir);
  })(root);
  for (const dir of stack) {
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
  }
}

function walkAndPlan(root, onScanProgress) {
  const all = walkFiles(root, onScanProgress);
  const toMove = all.filter((f) => path.dirname(f) !== root);
  const takenInRoot = new Set(
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  );
  return { toMove, takenInRoot };
}

function countCollisions(toMove, takenInRoot) {
  const seen = new Set(takenInRoot);
  let collisions = 0;
  for (const src of toMove) {
    const name = path.basename(src);
    if (seen.has(name)) collisions++;
    else seen.add(name);
  }
  return collisions;
}

class FlattenFolder extends BasePlugin {
  static get manifest() {
    return {
      id: 'flatten-folder',
      label: 'Flatten folder',
      description: 'Move all nested files into the root of each selected folder',
      icon: 'icon.png',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    };
  }

  async preflight({ targets, onProgress }) {
    const folders = [];
    let totalFiles = 0;
    let totalCollisions = 0;
    let cumulative = 0;
    for (const root of targets) {
      const { toMove, takenInRoot } = walkAndPlan(root, onProgress
        ? ({ scanned }) => onProgress({ scanned: cumulative + scanned })
        : null);
      cumulative += toMove.length;
      const collisionCount = countCollisions(toMove, takenInRoot);
      folders.push({
        basename: path.basename(root),
        fileCount: toMove.length,
        collisionCount,
      });
      totalFiles += toMove.length;
      totalCollisions += collisionCount;
    }
    folders.sort((a, b) => a.basename.localeCompare(b.basename));
    return { folders, totalFiles, totalCollisions };
  }

  buildRunningLabel(_ctx) { return 'Flattening…'; }

  async run({ targets, onProgress = () => {}, signal }) {
    // Pre-compute grand total across all targets
    let grandTotal = 0;
    const plans = [];
    for (const root of targets) {
      const plan = walkAndPlan(root);
      grandTotal += plan.toMove.length;
      plans.push({ root, ...plan });
    }

    let processedTotal = 0;
    let lastEmit = 0;
    const emit = (current) => {
      const now = Date.now();
      if (now - lastEmit >= 150 || current === grandTotal) {
        lastEmit = now;
        onProgress({ processed: current, total: grandTotal, current: '' });
      }
    };

    let processed = 0, skipped = 0;
    const errors = [];
    for (const { root, toMove, takenInRoot } of plans) {
      const taken = new Set(takenInRoot);
      for (const src of toMove) {
        if (signal && signal.aborted) {
          return { ok: false, processed, skipped, errors, aborted: true };
        }
        const baseName = path.basename(src);
        const target = resolveCollision(baseName, taken);
        try {
          fs.renameSync(src, path.join(root, target));
          taken.add(target);
          processed++;
          processedTotal++;
          emit(processedTotal);
        } catch (err) {
          errors.push({ file: path.relative(root, src), message: err.message });
          skipped++;
          processedTotal++;
          emit(processedTotal);
        }
      }
      pruneEmptyDirs(root);
    }
    // Final emit to ensure last state is always reported
    onProgress({ processed, total: grandTotal });
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) {
    return pre && pre.totalFiles === 0;
  }

  buildNothingToDoBody(ctx, _pre) {
    const skipped = (ctx && ctx.selection && ctx.selection.skipped) || [];
    if (skipped.length > 0) {
      const lines = [`Flatten folder works only with folders.`, `Selection contains ${skipped.length} ${plural(skipped.length, 'item', 'items')} that ${plural(skipped.length, 'is', 'are')} not a folder:`];
      for (const s of skipped.slice(0, MAX_LIST)) lines.push(`  • ${s.basename}`);
      if (skipped.length > MAX_LIST) lines.push(`  … and ${skipped.length - MAX_LIST} more`);
      return { message: 'Nothing to process.', detail: lines.join('\n') };
    }
    return {
      message: 'Nothing to do.',
      detail: 'Selected folder(s) are already flat.',
    };
  }

  buildConfirmMessage(ctx, pre) {
    const { folders, totalFiles, totalCollisions } = pre;
    const skipped = (ctx && ctx.selection && ctx.selection.skipped) || [];
    const lines = [];
    lines.push(`You selected ${folders.length} ${plural(folders.length, 'folder', 'folders')}.`);
    lines.push(folders.length > 1
      ? 'They will be processed independently — each folder is flattened into its own root.'
      : 'It will be flattened into its own root.');
    lines.push('');
    for (const f of folders.slice(0, MAX_LIST)) {
      lines.push(`  • ${f.basename}  (${f.fileCount} ${plural(f.fileCount, 'file', 'files')})`);
    }
    if (folders.length > MAX_LIST) {
      lines.push(`  … and ${folders.length - MAX_LIST} more`);
    }
    lines.push('');
    lines.push(`${totalFiles} ${plural(totalFiles, 'file', 'files')} total will be moved.`);
    if (totalCollisions > 0) {
      lines.push(`${totalCollisions} name ${plural(totalCollisions, 'collision', 'collisions')} will be resolved with "(N)" suffix.`);
    }
    if (skipped.length > 0) {
      lines.push('');
      lines.push(`The following ${plural(skipped.length, 'item will', 'items will')} be skipped (not a folder):`);
      for (const s of skipped.slice(0, MAX_LIST)) {
        lines.push(`  • ${s.basename}`);
      }
      if (skipped.length > MAX_LIST) {
        lines.push(`  … and ${skipped.length - MAX_LIST} more`);
      }
    }
    const message = folders.length === 1 ? 'Flatten this folder?' : `Flatten ${folders.length} folders?`;
    return { message, detail: lines.join('\n') };
  }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'file', 'files')} moved.`,
      `${errors.length} ${plural(errors.length, 'file', 'files')} could not be moved:`,
    ];
    for (const e of errors.slice(0, MAX_LIST)) {
      lines.push(`  • ${e.file} — ${e.message}`);
    }
    if (errors.length > MAX_LIST) {
      lines.push(`  … and ${errors.length - MAX_LIST} more`);
    }
    return lines.join('\n');
  }
}

module.exports = FlattenFolder;
