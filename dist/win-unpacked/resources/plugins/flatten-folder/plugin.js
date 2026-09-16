const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { planFolder, MAX_PATH_LENGTH } = require('./plan');

const MAX_LIST = 10;
const MAX_TABLE_ROWS = 1000;
const SCAN_PROGRESS_EVERY = 100;
const PROGRESS_INTERVAL_MS = 150;
const PROBLEM_COLUMNS = ['File', 'Problem'];
const MOVE_CLOSER_HINT = 'Move the folder closer to the drive root (for example D:\\Temp) and try again.';
const UNCHANGED = 'the folders are exactly as they were.';

const plural = (n, one, many) => (n === 1 ? one : many);
const formatCount = (n, one, many) => `${n} ${plural(n, one, many)}`;
const formatFiles = (n) => formatCount(n, 'file', 'files');
const keptDirsLine = (n) => `${formatCount(n, 'subfolder stays: it holds', 'subfolders stay: they hold')} links or other items that are not moved.`;
const moreFiles = (n) => (n > 0 ? `… and ${n} more ${plural(n, 'file', 'files')}` : undefined);
// A drive root such as "D:\" has no base name.
const folderName = (root) => path.basename(root) || root;

const ERROR_TEXT = {
  EBUSY: 'The file is open in another program',
  EPERM: 'Access denied — the file may be open or read-only',
  EACCES: 'Access denied',
  ENOENT: 'The file was moved or deleted',
  EEXIST: 'A file with this name already exists',
  ENAMETOOLONG: 'The name is too long',
};

// Node puts both paths into the message ("EBUSY: resource busy or locked, rename 'a' -> 'b'");
// the dialog already shows the file, so only the reason is kept.
function describeError(err) {
  const text = err.code && ERROR_TEXT[err.code];
  if (text) return `${text} (${err.code})`;
  return err.code ? err.message.split(', ')[0] : err.message;
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

// The folder itself, however it is spelled: letter case, a trailing separator, a junction or a
// short 8.3 name lead to the same id. Without file ids the literal path has to do; it may miss
// a match (the run then stops and puts everything back) but never joins two different folders.
function folderIdentity(p) {
  try {
    const { dev, ino } = fs.statSync(p, { bigint: true });
    if (ino !== 0n) return `id:${dev}:${ino}`;
  } catch { /* unreadable: fall back to the path */ }
  return `path:${path.resolve(p)}`;
}

function ancestorIdentities(target) {
  const ids = new Set();
  let dir = path.resolve(target);
  for (let parent = path.dirname(dir); parent !== dir; dir = parent, parent = path.dirname(dir)) {
    ids.add(folderIdentity(parent));
  }
  return ids;
}

// Drops folders selected twice and folders inside another selected folder:
// flattening the outer folder already takes care of them.
function outermostTargets(targets) {
  const ids = targets.map(folderIdentity);
  const roots = [];
  const nested = [];
  targets.forEach((target, i) => {
    if (ids.indexOf(ids[i]) < i) return;
    const ancestors = ancestorIdentities(target);
    if (ids.some((id) => ancestors.has(id))) nested.push(target); else roots.push(target);
  });
  return { roots, nested };
}

function planAll(targets, keepOrder, onFileScanned) {
  const { roots, nested } = outermostTargets(targets);
  const plans = roots.map((root) => ({ root, folder: folderName(root), ...planFolder(root, keepOrder, onFileScanned) }));
  return { plans, nested };
}

// Identifies the exact plan shown in the preview; run refuses to carry out any other.
function planDigest(plans) {
  const hash = crypto.createHash('sha1');
  for (const p of plans) {
    hash.update(`${p.root}\0${p.emptyDirCount}\0`);
    for (const m of p.moves) hash.update(`${m.relPath}\0${m.targetName}\0`);
    for (const b of p.blocked) hash.update(`!${b.relPath}\0`);
  }
  return hash.digest('hex');
}

// fs.renameSync silently replaces an existing file on Windows, so the target name must be free.
// lstat also sees a dangling link, and any failure other than "not found" counts as taken.
function moveFile(from, to) {
  if (fs.lstatSync(to, { throwIfNoEntry: false })) {
    throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`), { code: 'EEXIST' });
  }
  fs.renameSync(from, to);
}

// Moves files back in reverse order. Whatever cannot go back is reported with its current name.
function putBack(moved) {
  const notRestored = [];
  for (const m of [...moved].reverse()) {
    try {
      fs.mkdirSync(path.dirname(m.src), { recursive: true });
      moveFile(m.dest, m.src);
    } catch (err) {
      notRestored.push({ folder: m.folder, file: m.relPath, location: m.targetName, message: describeError(err) });
    }
  }
  return notRestored.reverse();
}

function pruneEmptyDirs(dir, isRoot = true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmptyDirs(path.join(dir, e.name), false);
  }
  if (isRoot || fs.readdirSync(dir).length > 0) return;
  try { fs.rmdirSync(dir); } catch { /* locked or in use — leave it in place */ }
}

// The dialog shows at most MAX_TABLE_ROWS rows of each list; the full plan stays in the worker.
function capRows(folders, key) {
  let room = MAX_TABLE_ROWS;
  for (const f of folders) {
    f[key] = f[key].slice(0, room);
    room -= f[key].length;
  }
}

// `items` are { group, cells, badges? }. With `grouped`, each new group starts with a group row.
function buildTable(columns, items, { total = items.length, grouped } = {}) {
  const byGroup = grouped === undefined ? new Set(items.map((i) => i.group)).size > 1 : grouped;
  const shown = items.slice(0, MAX_TABLE_ROWS);
  const rows = [];
  shown.forEach((item, i) => {
    if (byGroup && (i === 0 || shown[i - 1].group !== item.group)) rows.push({ group: item.group });
    rows.push(item.badges ? { cells: item.cells, badges: item.badges } : { cells: item.cells });
  });
  return { columns, rows, footer: moreFiles(total - shown.length) };
}

function planTable(folders, totalFiles) {
  const items = folders.flatMap((f) => f.moves.map((m) => ({
    group: `${f.basename} — ${formatFiles(f.fileCount)}${f.numbered ? ', numbered' : ''}`,
    cells: [m.from, m.to],
    badges: [m.shortened && 'shortened', m.renamed && 'suffix added'].filter(Boolean),
  })));
  return buildTable(['From', 'New name'], items, { total: totalFiles, grouped: folders.length > 1 });
}

const problemItems = (list) => list.map((p) => ({ group: p.folder, cells: [p.file, p.message] }));

function putBackSummary(moved) {
  if (moved === 0) return `No files were moved — ${UNCHANGED}`;
  if (moved === 1) return `The 1 file moved before that was put back — ${UNCHANGED}`;
  return `All ${moved} files moved before that were put back — ${UNCHANGED}`;
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
    const { plans, nested } = planAll(targets, this.keepOrder, onFileScanned);
    if (onProgress) onProgress({ scanned });
    const folders = plans.map((plan) => ({
      basename: plan.folder,
      path: plan.root,
      fileCount: plan.moves.length,
      collisionCount: plan.collisionCount,
      shortenedCount: plan.shortenedCount,
      emptyDirCount: plan.emptyDirCount,
      keptDirCount: plan.keptDirCount,
      numbered: plan.numbered,
      blockedCount: plan.blocked.length,
      moves: plan.moves.map((m) => ({ from: m.relPath, to: m.targetName, shortened: m.shortened, renamed: m.renamed })),
      blocked: plan.blocked.map((b) => ({ file: b.relPath, message: b.reason })),
    }));
    folders.sort((a, b) => a.basename.localeCompare(b.basename));
    capRows(folders, 'moves');
    capRows(folders, 'blocked');
    const sum = (key) => folders.reduce((n, f) => n + f[key], 0);
    return {
      folders,
      insideOthers: nested.map(folderName),
      planId: planDigest(plans),
      totalFiles: sum('fileCount'),
      totalCollisions: sum('collisionCount'),
      totalShortened: sum('shortenedCount'),
      totalEmptyDirs: sum('emptyDirCount'),
      totalKeptDirs: sum('keptDirCount'),
      totalBlocked: sum('blockedCount'),
    };
  }

  isEmpty(_ctx, pre) {
    return pre.totalFiles === 0 && !pre.totalEmptyDirs;
  }

  buildBlockedBody(_ctx, pre) {
    if (!pre || !pre.totalBlocked) return null;
    const items = problemItems(pre.folders.flatMap((f) => f.blocked.map((b) => ({ folder: f.basename, ...b }))));
    return {
      message: `${this.constructor.manifest.label} — cannot start`,
      detail: [
        `${formatCount(pre.totalBlocked, 'file cannot', 'files cannot')} be given a name: the folder path is too long for Windows (${MAX_PATH_LENGTH} characters max).`,
        MOVE_CLOSER_HINT,
        'Nothing was changed.',
      ].join('\n'),
      table: buildTable(PROBLEM_COLUMNS, items, { total: pre.totalBlocked, grouped: pre.folders.length > 1 }),
    };
  }

  buildRunningLabel(_ctx) { return 'Flattening…'; }

  // All or nothing: a file that cannot be moved puts every moved file back, and empty
  // subfolders are removed only after every file has been moved. Once started, the run
  // cannot be cancelled.
  async run({ targets, options = {}, onProgress = () => {} }) {
    const { plans } = planAll(targets, this.keepOrder);
    if (options.planId && options.planId !== planDigest(plans)) {
      return { ok: false, stale: true, processed: 0, skipped: 0, errors: [], moved: 0, notRestored: [] };
    }
    const blocked = plans.flatMap((p) => p.blocked.map((b) => ({ folder: p.folder, file: b.relPath, message: b.reason })));
    if (blocked.length > 0) {
      return { ok: false, blocked: true, processed: 0, skipped: blocked.length, errors: blocked, moved: 0, notRestored: [] };
    }
    const total = plans.reduce((n, p) => n + p.moves.length, 0);
    const tick = throttle(PROGRESS_INTERVAL_MS);
    const moved = [];
    for (const { root, folder, moves } of plans) {
      for (const m of moves) {
        const dest = path.join(root, m.targetName);
        try {
          moveFile(m.src, dest);
        } catch (err) {
          const notRestored = putBack(moved);
          // processed: files that stay in the root because they could not be put back.
          return {
            ok: false,
            processed: notRestored.length,
            skipped: total - notRestored.length,
            errors: [{ folder, file: m.relPath, message: describeError(err) }],
            moved: moved.length,
            notRestored,
          };
        }
        moved.push({ ...m, folder, dest });
        if (tick()) onProgress({ processed: moved.length, total });
      }
    }
    for (const { root } of plans) {
      try { pruneEmptyDirs(root); } catch { /* every file is in place; a leftover empty folder is harmless */ }
    }
    onProgress({ processed: total, total });
    return { ok: true, processed: total, skipped: 0, errors: [] };
  }

  buildNothingToDoBody(ctx, pre) {
    const skipped = (ctx && ctx.selection && ctx.selection.skipped) || [];
    if (skipped.length > 0) {
      const lines = [`${this.constructor.manifest.label} works only with folders.`, `Selection contains ${skipped.length} ${plural(skipped.length, 'item', 'items')} that ${plural(skipped.length, 'is', 'are')} not a folder:`];
      for (const s of skipped.slice(0, MAX_LIST)) lines.push(`  • ${s.basename}`);
      if (skipped.length > MAX_LIST) lines.push(`  … and ${skipped.length - MAX_LIST} more`);
      return { message: 'Nothing to process.', detail: lines.join('\n') };
    }
    const kept = pre.totalKeptDirs || 0;
    return {
      message: 'Nothing to do.',
      detail: kept > 0 ? `Nothing to move. ${keptDirsLine(kept)}` : 'Selected folder(s) are already flat.',
    };
  }

  buildConfirmMessage(ctx, pre) {
    const { folders, totalFiles, totalCollisions, totalShortened = 0, totalEmptyDirs = 0, totalKeptDirs = 0, insideOthers = [] } = pre;
    const skipped = (ctx && ctx.selection && ctx.selection.skipped) || [];
    const several = folders.length > 1;
    const lines = [];
    if (several) {
      if (totalFiles > 0) lines.push(`${formatFiles(totalFiles)} from ${folders.length} folders will be moved, each folder into its own root.`);
    } else {
      lines.push(`Folder: ${folders[0].path}`);
      if (totalFiles > 0) lines.push(`${formatFiles(totalFiles)} will be moved into the folder root.`);
    }
    if (totalEmptyDirs > 0) {
      lines.push(totalFiles > 0
        ? `${formatCount(totalEmptyDirs, 'subfolder', 'subfolders')} will be removed (empty after the move).`
        : `${formatCount(totalEmptyDirs, 'empty subfolder', 'empty subfolders')} will be removed.`);
    }
    if (totalKeptDirs > 0) lines.push(keptDirsLine(totalKeptDirs));
    if (totalCollisions > 0) {
      lines.push(`${formatCount(totalCollisions, 'name collision', 'name collisions')} will be resolved with "(N)" suffix.`);
    }
    if (totalShortened > 0) {
      lines.push(`${formatCount(totalShortened, 'name is', 'names are')} too long for Windows and will be shortened.`);
    }
    const numbered = folders.filter((f) => f.numbered).length;
    if (numbered > 0) {
      const who = several ? `In ${formatCount(numbered, 'folder', 'folders')} files get` : 'Files get';
      lines.push(`${who} a number prefix (001, 002…) so the shortened names keep their order.`);
    }
    if (insideOthers.length > 0) {
      lines.push(`Also selected, but inside another selected folder (flattened with it): ${insideOthers.join(', ')}`);
    }
    if (totalFiles > 0) lines.push('If any file cannot be moved, all files are put back.');
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
    const message = several ? `Flatten ${folders.length} folders${mode}?` : `Flatten this folder${mode}?`;
    return {
      message,
      detail: lines.join('\n'),
      table: totalFiles > 0 ? planTable(folders, totalFiles) : undefined,
    };
  }

  buildErrorBody(_ctx, errors, _processed, _total, result = {}) {
    const label = this.constructor.manifest.label;
    if (result.stale) return staleRunBody(label);
    if (result.blocked) return blockedRunBody(label, errors);
    if (!result.notRestored || result.notRestored.length === 0) return rolledBackBody(label, errors, result.moved || 0);
    return notRestoredBody(label, errors, result.moved, result.notRestored);
  }
}

function staleRunBody(label) {
  return {
    message: `${label} — nothing was changed`,
    detail: 'The folder changed after the preview, so nothing was moved.\nRun the command again to see the new plan.',
  };
}

function blockedRunBody(label, errors) {
  return {
    message: `${label} — nothing was changed`,
    detail: ['Some files cannot be given a name within the Windows path limit, so nothing was moved.', MOVE_CLOSER_HINT].join('\n'),
    table: buildTable(PROBLEM_COLUMNS, problemItems(errors)),
  };
}

function rolledBackBody(label, errors, moved) {
  return {
    message: `${label} — nothing was changed`,
    detail: ['A file could not be moved, so the operation was stopped.', putBackSummary(moved)].join('\n'),
    table: errors.length > 0 ? buildTable(PROBLEM_COLUMNS, problemItems(errors)) : undefined,
  };
}

function notRestoredBody(label, errors, moved, notRestored) {
  const stuck = notRestored.length;
  const lines = ['A file could not be moved, so the operation was stopped.'];
  for (const e of errors) lines.push(`Stopped at ${e.file}: ${e.message}`);
  lines.push(`Put back ${moved - stuck} of ${moved} moved ${plural(moved, 'file', 'files')}; ${stuck} could not be put back.`);
  lines.push(stuck === 1
    ? 'It is still in the folder root under the new name — move it back by hand:'
    : 'They are still in the folder root under the new name — move them back by hand:');
  return {
    message: `${label} — some files were not put back`,
    detail: lines.join('\n'),
    table: buildTable(
      ['Original place', 'Name in the root now', 'Problem'],
      notRestored.map((n) => ({ group: n.folder, cells: [n.file, n.location, n.message] })),
    ),
  };
}

module.exports = FlattenFolder;
