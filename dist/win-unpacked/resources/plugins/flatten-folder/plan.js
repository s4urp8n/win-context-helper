const fs = require('node:fs');
const path = require('node:path');
const { splitExt } = require('../../src/main/utils/collision');
const { explorerCompare } = require('../../src/main/utils/explorer-compare');

// NTFS allows 255 UTF-16 units per name. Explorer and most programs open paths of up to
// MAX_PATH (260 including the terminating NUL), so every moved file must stay within 259.
const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 259;
// A NAS share keeps its files on a Linux file system, which allows 255 UTF-8 bytes per name;
// a longer name fails there with ENOENT. Cyrillic takes two bytes per character.
const MAX_NAME_BYTES = 255;
const PATH_SEPARATOR = ' - ';
const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS);
const nameBytes = (name) => Buffer.byteLength(name);
const fits = (name, budget) => name.length <= budget && nameBytes(name) <= MAX_NAME_BYTES;
// Folder names carry the order, so a long file name is cut first — but not below this.
const FILE_NAME_RESERVE = 40;
// A longer tail after the last dot, or one with spaces, is part of the name ("1. Introduction").
const MAX_EXT_LENGTH = 16;
const MIN_NUMBER_WIDTH = 3;

// NTFS compares upcased names. (toLowerCase would turn a Σ before a space into the final ς.)
const nameKey = (name) => name.toUpperCase();
// "LONGFI~1.TXT": Windows also opens a long-named file by its short 8.3 alias.
const SHORT_ALIAS = /^(?=[^.]{2,8}(?:\.|$))[^.\s~]{0,6}~\d{1,6}(?:\.[^.\s]{1,3})?$/;

function splitName(name) {
  const parts = splitExt(name);
  return parts.ext.length > MAX_EXT_LENGTH || /\s/.test(parts.ext) ? { base: name, ext: '' } : parts;
}

// Reads the whole tree once; every naming variant is planned from the result. Entries are kept
// in Explorer name order. Links and other special entries are never moved, so they are left
// out, but the folder holding one stays. Counts the subfolders that are left empty once every
// file is moved out of them, and the ones that stay.
function scanFolder(root, onFile = () => {}) {
  let emptyDirCount = 0;
  let keptDirCount = 0;
  let rootNames = [];
  const read = (dir, depth) => {
    const found = fs.readdirSync(dir, { withFileTypes: true });
    if (depth === 0) rootNames = found.map((e) => e.name);
    const entries = [];
    let keepsSomething = false;
    for (const e of found.sort((a, b) => explorerCompare(a.name, b.name))) {
      if (e.isDirectory()) {
        const sub = read(path.join(dir, e.name), depth + 1);
        keepsSomething = keepsSomething || sub.keepsSomething;
        entries.push({ name: e.name, dir: sub });
      } else if (e.isFile()) {
        onFile();
        entries.push({ name: e.name });
      } else {
        keepsSomething = true;
      }
    }
    if (depth > 0) {
      if (keepsSomething) keptDirCount++; else emptyDirCount++;
    }
    return { entries, keepsSomething };
  };
  const tree = read(root, 0);
  return { root, tree, rootNames, emptyDirCount, keptDirCount };
}

// Files level by level in name order. With `foldersFirst` the subfolders of a level come before
// its files, as Explorer lists them; otherwise folders and files are mixed by name.
// `dirs` holds the folder names between root and the file; files of one folder share the array.
function listFiles(tree, foldersFirst) {
  const files = [];
  (function visit(node, dirs) {
    const entries = foldersFirst
      ? [...node.entries.filter((e) => e.dir), ...node.entries.filter((e) => !e.dir)]
      : node.entries;
    for (const e of entries) {
      if (e.dir) visit(e.dir, [...dirs, e.name]);
      else files.push({ dirs, name: e.name });
    }
  })(tree, []);
  return files;
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
  name: [...file.nameDirs, file.base].join(PATH_SEPARATOR) + suffix + file.ext,
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

// Names that fit each file's budget (UTF-16 units). A folder is cut the same way for every
// file inside it, so files of one folder keep a common head; each file name then takes the
// room that is left.
function fittedNamer(files, budgetOf, prefixAt = () => '') {
  const capFor = (file, extra) => largestCap(
    file.nameDirs.map((d) => d.length),
    budgetOf(file) - extra - PATH_SEPARATOR.length * file.nameDirs.length
      - Math.min(file.base.length, FILE_NAME_RESERVE) - file.ext.length,
  );
  const caps = new Map();
  files.forEach((file, index) => {
    const cap = capFor(file, prefixAt(index).length);
    for (const key of dirKeys(file.nameDirs)) caps.set(key, Math.min(caps.get(key) ?? Infinity, cap));
  });
  const nameWith = (file, index, suffix, capAt) => {
    const dirs = file.nameDirs.map((d, depth) => shorten(d, capAt(depth)));
    const head = prefixAt(index) + dirs.map((d) => d + PATH_SEPARATOR).join('');
    const room = budgetOf(file) - head.length - suffix.length - file.ext.length;
    if (room < 1) return null;
    const base = shorten(file.base, room);
    const shortened = base !== file.base || dirs.some((d, depth) => d !== file.nameDirs[depth]);
    return { name: head + base + suffix + file.ext, shortened };
  };
  return (file, index, suffix) => {
    const keys = dirKeys(file.nameDirs);
    const folderCap = (depth) => caps.get(keys[depth]);
    const named = nameWith(file, index, suffix, folderCap);
    if (named || !suffix) return named;
    // No room for " (N)" next to the shared folder head: this one file gets a shorter head.
    const ownCap = capFor(file, prefixAt(index).length + suffix.length);
    return nameWith(file, index, suffix, (depth) => Math.min(folderCap(depth), ownCap));
  };
}

// Names within both limits: `budget` UTF-16 units and MAX_NAME_BYTES UTF-8 bytes. A name that
// is still too many bytes gives its file a smaller budget, and all names are fitted again; the
// budgets only shrink, so this ends with every name fitting or blocked.
function fitNames(files, inRoot, budget, prefixAt) {
  const budgets = new Map();
  const budgetOf = (file) => budgets.get(file) ?? budget;
  for (;;) {
    const names = assignNames(files, inRoot, fittedNamer(files, budgetOf, prefixAt));
    let tightened = false;
    names.forEach((named, i) => {
      const excess = named.blocked ? 0 : nameBytes(named.name) - MAX_NAME_BYTES;
      if (excess <= 0) return;
      // Each cut character takes at least one byte away; the ellipsis adds some back.
      const cut = Math.ceil((excess + ELLIPSIS_BYTES) / 2);
      budgets.set(files[i], Math.min(budgetOf(files[i]), named.name.length) - cut);
      tightened = true;
    });
    if (!tightened) return names;
  }
}

function plainNames(files, inRoot, budget) {
  const full = assignNames(files, inRoot, buildFullName);
  return full.every((n) => fits(n.name, budget)) ? full : fitNames(files, inRoot, budget);
}

const untouched = (named) => !named.shortened && !named.renamed;

// True when the new names, sorted like Explorer sorts them, list the files in `all` order.
// Files already in the root keep their names. Two files of one folder whose own names stay
// untouched share the same head, so they keep their order whatever the comparison says.
function keepsOrder(all, namesOf) {
  let prev = null;
  for (const file of all) {
    const named = file.inRoot ? { name: file.name } : namesOf.get(file);
    if (named.blocked) return false;
    const sameFolder = prev && prev.file.dirs === file.dirs && untouched(prev.named) && untouched(named);
    if (prev && !sameFolder && explorerCompare(prev.named.name, named.name) >= 0) return false;
    prev = { file, named };
  }
  return true;
}

function numberPrefix(count) {
  const width = Math.max(MIN_NUMBER_WIDTH, String(count).length);
  return (index) => `${String(index + 1).padStart(width, '0')}${PATH_SEPARATOR}`;
}

// Decides the final root name of every file for one set of options. Preflight and run share
// it, so the confirm dialog shows exactly what run will do.
// keepHierarchy puts the folder path into the name ("Lesson 1 - Chapter 1.mp4") so that the
// flat result, sorted by name, keeps the original order. When the names alone cannot keep it
// (files in the root, folders and files mixed on one level, cut names), every file of the
// folder, the ones already in the root included, gets a number prefix in the original order.
function planScanned(scan, { keepHierarchy = true, foldersFirst = true } = {}) {
  const { root } = scan;
  const all = listFiles(scan.tree, !keepHierarchy || foldersFirst).map(({ dirs, name }) => {
    const relPath = path.join(...dirs, name);
    return {
      ...splitName(name),
      name,
      dirs,
      nameDirs: keepHierarchy ? dirs : [],
      relPath,
      src: path.join(root, relPath),
      inRoot: dirs.length === 0,
    };
  });
  const nested = all.filter((f) => !f.inRoot);

  // Everything in the root keeps its name until the move ends — subfolders, and root files
  // even when they get a number — so all those names are taken.
  const rootKeys = new Set(scan.rootNames.map(nameKey));
  const inRoot = (name) => rootKeys.has(nameKey(name))
    || (SHORT_ALIAS.test(name) && !!fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }));
  // Length of "<root>\" in front of every moved name (path.join also handles a root like "D:\").
  const rootPrefixLength = path.join(root, 'x').length - 1;
  const budget = Math.min(MAX_NAME_LENGTH, MAX_PATH_LENGTH - rootPrefixLength);

  let files = nested;
  let names = plainNames(nested, inRoot, budget);
  let numbered = false;
  if (keepHierarchy && nested.length > 0) {
    const namesOf = new Map(nested.map((file, i) => [file, names[i]]));
    if (!keepsOrder(all, namesOf)) {
      files = all;
      names = fitNames(all, inRoot, budget, numberPrefix(all.length));
      numbered = true;
    }
  }

  const moves = [];
  const blocked = [];
  files.forEach((file, i) => {
    const { name, shortened, renamed } = names[i];
    if (names[i].blocked) {
      blocked.push({
        relPath: file.relPath,
        reason: `No room for the name: the folder path already takes ${rootPrefixLength} of ${MAX_PATH_LENGTH} characters`,
      });
    } else {
      moves.push({ src: file.src, relPath: file.relPath, targetName: name, shortened, renamed, inRoot: file.inRoot });
    }
  });
  return {
    moves,
    blocked,
    numbered,
    fileCount: nested.length,
    emptyDirCount: scan.emptyDirCount,
    keptDirCount: scan.keptDirCount,
    collisionCount: moves.filter((m) => m.renamed).length,
    shortenedCount: moves.filter((m) => m.shortened).length,
    renamedInRootCount: moves.filter((m) => m.inRoot).length,
  };
}

const planFolder = (root, options, onFile) => planScanned(scanFolder(root, onFile), options);

module.exports = { scanFolder, planScanned, planFolder, shorten, largestCap, MAX_PATH_LENGTH };
