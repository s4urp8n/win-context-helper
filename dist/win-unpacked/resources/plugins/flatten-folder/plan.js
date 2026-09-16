const fs = require('node:fs');
const path = require('node:path');
const { splitExt } = require('../../src/main/utils/collision');

// NTFS allows 255 UTF-16 units per name. Explorer and most programs open paths of up to
// MAX_PATH (260 including the terminating NUL), so every moved file must stay within 259.
const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 259;
const PATH_SEPARATOR = ' - ';
const ELLIPSIS = '…';
// Folder names carry the order, so a long file name is cut first — but not below this.
const FILE_NAME_RESERVE = 40;
// A longer tail after the last dot, or one with spaces, is part of the name ("1. Introduction").
const MAX_EXT_LENGTH = 16;
const MIN_NUMBER_WIDTH = 3;

// Explorer sorts with StrCmpLogicalW: case-insensitive, digit runs by value, and hyphens and
// apostrophes ignored. ICU with those characters removed is a close match.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const sortKey = (name) => name.replace(/['’-]/g, '');
const explorerCompare = (a, b) => collator.compare(sortKey(a), sortKey(b));

// Where the two disagree anyway: Explorer puts "…" after every punctuation mark, ICU before
// some of them. An order decided by "…" next to anything but a letter, digit or space is unsure.
const SAFE_BESIDE_ELLIPSIS = /[\p{L}\p{N}\s]/u;
// `a` sorts before `b`.
function decidedByEllipsis(a, b) {
  const x = sortKey(a);
  const y = sortKey(b);
  let i = 0;
  while (i < x.length && (x[i] === y[i] || collator.compare(x[i], y[i]) === 0)) i++;
  // `a` is the beginning of `b`: the shorter name comes first everywhere.
  if (i === x.length) return false;
  const [p, q] = [x[i], y[i]];
  return (p === ELLIPSIS && !SAFE_BESIDE_ELLIPSIS.test(q)) || (q === ELLIPSIS && !SAFE_BESIDE_ELLIPSIS.test(p));
}

// NTFS compares upcased names. (toLowerCase would turn a Σ before a space into the final ς.)
const nameKey = (name) => name.toUpperCase();
// "LONGFI~1.TXT": Windows also opens a long-named file by its short 8.3 alias.
const SHORT_ALIAS = /^(?=[^.]{2,8}(?:\.|$))[^.\s~]{0,6}~\d{1,6}(?:\.[^.\s]{1,3})?$/;

function splitName(name) {
  const parts = splitExt(name);
  return parts.ext.length > MAX_EXT_LENGTH || /\s/.test(parts.ext) ? { base: name, ext: '' } : parts;
}

// Visits files in Explorer order: at every level subfolders first, then files.
// `dirs` holds the folder names between root and the file.
// Counts the subfolders that are left empty once every file is moved out of them, and the ones
// that stay because they hold links or other special entries.
function scanFolder(root, onFile) {
  let emptyDirCount = 0;
  let keptDirCount = 0;
  (function walk(dir, dirs) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => explorerCompare(a.name, b.name));
    // Links and other special entries are never moved, so they keep their folder.
    let keepsSomething = entries.some((e) => !e.isFile() && !e.isDirectory());
    for (const e of entries) {
      if (e.isDirectory() && walk(path.join(dir, e.name), [...dirs, e.name])) keepsSomething = true;
    }
    for (const e of entries) if (e.isFile()) onFile(path.join(dir, e.name), dirs, e.name);
    if (dirs.length > 0) {
      if (keepsSomething) keptDirCount++; else emptyDirCount++;
    }
    return keepsSomething;
  })(root, []);
  return { emptyDirCount, keptDirCount };
}

// Cuts `text` to at most `max` UTF-16 units (ellipsis included) without splitting a surrogate pair.
function shorten(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 2);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 2 : max - 1;
  return text.slice(0, end).trimEnd() + ELLIPSIS;
}

// Largest cap such that parts of the given lengths, each cut to the cap, take at most `room`.
// Infinity when they fit untouched; 1 (a lone ellipsis each) when nothing fits.
function largestCap(lengths, room) {
  const widthAt = (cap) => lengths.reduce((sum, n) => sum + Math.min(n, cap), 0);
  const longest = Math.max(0, ...lengths);
  if (widthAt(longest) <= room) return Infinity;
  if (widthAt(1) > room) return 1;
  // widthAt(low) fits, widthAt(high) does not.
  let low = 1;
  let high = longest;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (widthAt(mid) <= room) low = mid; else high = mid;
  }
  return low;
}

// Gives every file a name that is free in the root (`inRoot` tells what the root already has).
// `build(file, index, suffix)` returns { name, shortened } or null when nothing fits; a taken
// name retries with " (2)", " (3)"… The last number used for a name is remembered, so thousands
// of equal names stay fast.
function assignNames(files, inRoot, build) {
  const assigned = new Set();
  const isTaken = (name) => assigned.has(nameKey(name)) || inRoot(name);
  const lastNumber = new Map();
  return files.map((file, index) => {
    const plain = build(file, index, '');
    if (!plain) return { blocked: true };
    const plainKey = nameKey(plain.name);
    let n = 1;
    let named = plain;
    if (isTaken(plain.name)) {
      n = lastNumber.get(plainKey) || 1;
      do { named = build(file, index, ` (${++n})`); } while (named && isTaken(named.name));
      if (!named) return { blocked: true };
      lastNumber.set(plainKey, n);
    }
    assigned.add(nameKey(named.name));
    return { ...named, renamed: n > 1 };
  });
}

const buildFullName = (file, _index, suffix) => ({
  name: [...file.dirs, file.base].join(PATH_SEPARATOR) + suffix + file.ext,
  shortened: false,
});

const dirKeysCache = new WeakMap();
// "a", "a\b", "a\b\c" for dirs [a, b, c]; files of one folder share their dirs array.
function dirKeys(dirs) {
  let keys = dirKeysCache.get(dirs);
  if (!keys) {
    keys = dirs.map((_, depth) => dirs.slice(0, depth + 1).join(path.sep));
    dirKeysCache.set(dirs, keys);
  }
  return keys;
}

// Names that fit `budget`. A folder is cut the same way for every file inside it, so files
// of one folder keep a common head; each file name then takes the room that is left.
function fittedNamer(files, budget, prefixAt = () => '') {
  const capFor = (file, extra) => largestCap(
    file.dirs.map((d) => d.length),
    budget - extra - PATH_SEPARATOR.length * file.dirs.length
      - Math.min(file.base.length, FILE_NAME_RESERVE) - file.ext.length,
  );
  const caps = new Map();
  files.forEach((file, index) => {
    const cap = capFor(file, prefixAt(index).length);
    for (const key of dirKeys(file.dirs)) caps.set(key, Math.min(caps.get(key) ?? Infinity, cap));
  });
  const nameWith = (file, index, suffix, capAt) => {
    const dirs = file.dirs.map((d, depth) => shorten(d, capAt(depth)));
    const head = prefixAt(index) + dirs.map((d) => d + PATH_SEPARATOR).join('');
    const room = budget - head.length - suffix.length - file.ext.length;
    if (room < 1) return null;
    const base = shorten(file.base, room);
    const shortened = base !== file.base || dirs.some((d, depth) => d !== file.dirs[depth]);
    return { name: head + base + suffix + file.ext, shortened };
  };
  return (file, index, suffix) => {
    const keys = dirKeys(file.dirs);
    const folderCap = (depth) => caps.get(keys[depth]);
    const named = nameWith(file, index, suffix, folderCap);
    if (named || !suffix) return named;
    // No room for " (N)" next to the shared folder head: this one file gets a shorter head.
    const ownCap = capFor(file, prefixAt(index).length + suffix.length);
    return nameWith(file, index, suffix, (depth) => Math.min(folderCap(depth), ownCap));
  };
}

const orderByName = (names) => names.map((_, i) => i).sort((a, b) => explorerCompare(names[a].name, names[b].name));

// True when `names`, taken in `order`, still sort ascending in Explorer.
function isOrderPreserved(order, names) {
  return order.every((index, k) => {
    if (k === 0) return true;
    const prev = names[order[k - 1]].name;
    const cur = names[index].name;
    return explorerCompare(prev, cur) < 0 && !decidedByEllipsis(prev, cur);
  });
}

// Numbers the files in the order of their full names, so the order survives any cut.
function numberedNames(files, inRoot, budget, order) {
  const width = Math.max(MIN_NUMBER_WIDTH, String(files.length).length);
  const prefixAt = (k) => `${String(k + 1).padStart(width, '0')}${PATH_SEPARATOR}`;
  const sorted = order.map((i) => files[i]);
  const inOrder = assignNames(sorted, inRoot, fittedNamer(sorted, budget, prefixAt));
  const names = [];
  order.forEach((fileIndex, k) => { names[fileIndex] = inOrder[k]; });
  return names;
}

// Decides the final root name of every nested file. Preflight and run share it,
// so the confirm dialog shows exactly what run will do.
// keepOrder puts the folder path into the name ("Lesson 1 - Chapter 1.mp4") so that
// sorting the flat result by name keeps the original folder order.
function planFolder(root, keepOrder, onFileScanned = () => {}) {
  const files = [];
  const { emptyDirCount, keptDirCount } = scanFolder(root, (src, dirs, name) => {
    onFileScanned();
    if (dirs.length === 0) return;
    const { base, ext } = splitName(name);
    files.push({ src, relPath: path.relative(root, src), dirs: keepOrder ? dirs : [], base, ext });
  });

  // Root subfolders stay on disk until the move ends, so their names are taken too.
  const rootKeys = new Set(fs.readdirSync(root).map(nameKey));
  const inRoot = (name) => rootKeys.has(nameKey(name))
    || (SHORT_ALIAS.test(name) && !!fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }));
  // Length of "<root>\" in front of every moved name (path.join also handles a root like "D:\").
  const rootPrefixLength = path.join(root, 'x').length - 1;
  const budget = Math.min(MAX_NAME_LENGTH, MAX_PATH_LENGTH - rootPrefixLength);

  const fullNames = assignNames(files, inRoot, buildFullName);
  let names = fullNames;
  let numbered = false;
  if (fullNames.some((n) => n.name.length > budget)) {
    names = assignNames(files, inRoot, fittedNamer(files, budget));
    if (keepOrder) {
      const order = orderByName(fullNames);
      if (names.some((n) => n.blocked) || !isOrderPreserved(order, names)) {
        names = numberedNames(files, inRoot, budget, order);
        numbered = true;
      }
    }
  }

  const moves = [];
  const blockedFiles = [];
  files.forEach((file, i) => {
    const { name, blocked, shortened, renamed } = names[i];
    if (blocked) {
      blockedFiles.push({
        relPath: file.relPath,
        reason: `No room for the name: the folder path already takes ${rootPrefixLength} of ${MAX_PATH_LENGTH} characters`,
      });
    } else {
      moves.push({ src: file.src, relPath: file.relPath, targetName: name, shortened, renamed });
    }
  });
  return {
    moves,
    blocked: blockedFiles,
    emptyDirCount,
    keptDirCount,
    numbered,
    collisionCount: moves.filter((m) => m.renamed).length,
    shortenedCount: moves.filter((m) => m.shortened).length,
  };
}

module.exports = { planFolder, shorten, largestCap, MAX_PATH_LENGTH };
