const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const MAX_LIST = 10;
const MAX_RENAME_EXAMPLES = 3;
const PATH_SEPARATOR = ' - ';
const SCAN_PROGRESS_EVERY = 100;
const PROGRESS_INTERVAL_MS = 150;
const plural = (n, one, many) => n === 1 ? one : many;

// Explorer compares names case-insensitively and digit runs by value ("Lesson 2" < "Lesson 10").
const byExplorerName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

// Visits files in Explorer order: at every level subfolders first, then files.
// `dirs` holds the folder names between root and the file.
function walkFiles(root, onFile) {
  (function walk(dir, dirs) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort(byExplorerName);
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), [...dirs, e.name]);
    for (const e of entries) if (e.isFile()) onFile(path.join(dir, e.name), dirs, e.name);
  })(root, []);
}

// NTFS is case-insensitive: "photo.jpg" and "PHOTO.jpg" name the same file.
function caseInsensitiveNames(names) {
  const keys = new Set(names.map((n) => n.toLowerCase()));
  return {
    has: (name) => keys.has(name.toLowerCase()),
    add: (name) => keys.add(name.toLowerCase()),
  };
}

function throttle(intervalMs) {
  let last = 0;
  return () => {
    const now = Date.now();
    if (now - last < intervalMs) return false;
    last = now;
    return true;
  };
}

// Decides the final root name of every nested file. Preflight and run share it,
// so the confirm dialog reports exactly what run will do.
// keepOrder puts the folder path into the name ("Lesson 1 - Chapter 1.mp4") so that
// sorting the flat result by name keeps the original folder order.
function planFolder(root, keepOrder, onFileScanned = () => {}) {
  // Root subfolders stay on disk until the move ends, so their names are taken too.
  const taken = caseInsensitiveNames(fs.readdirSync(root));
  const moves = [];
  let collisionCount = 0;
  walkFiles(root, (src, dirs, name) => {
    onFileScanned();
    if (dirs.length === 0) return;
    const desiredName = keepOrder ? [...dirs, name].join(PATH_SEPARATOR) : name;
    if (taken.has(desiredName)) collisionCount++;
    const targetName = resolveCollision(desiredName, taken);
    taken.add(targetName);
    moves.push({ src, relPath: path.relative(root, src), targetName });
  });
  return { moves, collisionCount };
}

function pruneEmptyDirs(dir, isRoot = true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), false);
  }
  if (isRoot || fs.readdirSync(dir).length > 0) return;
  try { fs.rmdirSync(dir); } catch { /* locked or in use — leave it in place */ }
}

class FlattenFolder extends BasePlugin {
  constructor({ keepOrder = false } = {}) {
    super();
    this.keepOrder = keepOrder;
  }

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
    let scanned = 0;
    const tick = throttle(PROGRESS_INTERVAL_MS);
    const onFileScanned = () => {
      scanned++;
      if (onProgress && scanned % SCAN_PROGRESS_EVERY === 0 && tick()) onProgress({ scanned });
    };
    const folders = targets.map((root) => {
      const { moves, collisionCount } = planFolder(root, this.keepOrder, onFileScanned);
      return {
        basename: path.basename(root),
        fileCount: moves.length,
        collisionCount,
        renameExamples: moves.slice(0, MAX_RENAME_EXAMPLES).map((m) => ({ from: m.relPath, to: m.targetName })),
      };
    });
    if (onProgress) onProgress({ scanned });
    folders.sort((a, b) => a.basename.localeCompare(b.basename));
    return {
      folders,
      totalFiles: folders.reduce((n, f) => n + f.fileCount, 0),
      totalCollisions: folders.reduce((n, f) => n + f.collisionCount, 0),
    };
  }

  buildRunningLabel(_ctx) { return 'Flattening…'; }

  async run({ targets, onProgress = () => {}, signal }) {
    const plans = targets.map((root) => ({ root, ...planFolder(root, this.keepOrder) }));
    const total = plans.reduce((n, p) => n + p.moves.length, 0);
    const tick = throttle(PROGRESS_INTERVAL_MS);
    let processed = 0;
    const errors = [];
    for (const { root, moves } of plans) {
      for (const { src, relPath, targetName } of moves) {
        if (signal && signal.aborted) {
          return { ok: false, processed, skipped: errors.length, errors, aborted: true };
        }
        try {
          fs.renameSync(src, path.join(root, targetName));
          processed++;
        } catch (err) {
          errors.push({ file: relPath, message: err.message });
        }
        if (tick()) onProgress({ processed: processed + errors.length, total });
      }
      pruneEmptyDirs(root);
    }
    onProgress({ processed: processed + errors.length, total });
    return { ok: errors.length === 0, processed, skipped: errors.length, errors };
  }

  buildNothingToDoBody(ctx, _pre) {
    const skipped = (ctx && ctx.selection && ctx.selection.skipped) || [];
    if (skipped.length > 0) {
      const lines = [`${this.constructor.manifest.label} works only with folders.`, `Selection contains ${skipped.length} ${plural(skipped.length, 'item', 'items')} that ${plural(skipped.length, 'is', 'are')} not a folder:`];
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
    if (this.keepOrder) {
      lines.push('');
      lines.push('Each file gets its folder path in the name, for example:');
      for (const e of folders.flatMap((f) => f.renameExamples).slice(0, MAX_RENAME_EXAMPLES)) {
        lines.push(`  ${e.from} → ${e.to}`);
      }
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
    const mode = this.keepOrder ? ' (keep order)' : '';
    const message = folders.length === 1 ? `Flatten this folder${mode}?` : `Flatten ${folders.length} folders${mode}?`;
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
