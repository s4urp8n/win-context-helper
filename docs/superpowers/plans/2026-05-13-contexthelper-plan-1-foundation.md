# ContextHelper — Plan 1: Foundation + flatten-folder (portable)

> **Status:** ✅ **COMPLETE** (2026-05-14) and end-to-end verified in Explorer on 2026-05-15. All 15 plan tasks executed via subagent-driven-development; 53/53 tests pass; portable build at `dist/win-unpacked/ContextHelper.exe`; `register.bat` / `unregister.bat` generated. Post-execution fixes: hardened plugin-registry validation (`82c4e4f`), worker-shim exit codes (`1ec866d`), empty-submenu registry fix + English UI strings (`18d4b49`).
>
> Two of three Plan 1 carry-overs were closed on 2026-05-15 in `8f553e8`: named-pipe aggregator wired into `src/main/index.js` (multi-select Explorer invocations merge into one app instance) and `minSelection`/`maxSelection` runtime enforcement (shows a single `dialog.showErrorBox` instead of opening N plugin windows). The default Electron application menu is also suppressed via `Menu.setApplicationMenu(null)` in the same commit.
>
> **Remaining carry-over:** `src/main/utils/bin-paths.js` helper for resolving bundled binaries — deferred to Plan 3 since flatten-folder is pure JS and needs no external binary.
>
> **Next session:** start Plan 3 (10 remaining plugins + bundled `ffmpeg.exe` / `ffprobe.exe` / `magick.exe` / `gswin64c.exe` / `7z.exe`). Plan 3 isn't written yet — invoke `superpowers:writing-plans` to draft it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Electron skeleton (main + renderer + worker child processes, plugin contract, IPC, named-pipe aggregation, logging, utilities) and exercise it end-to-end with one real plugin — `flatten-folder`. Produce a **portable** distribution (folder you can copy anywhere) plus `register.bat` / `unregister.bat` that hook the app into the Windows Explorer right-click menu via per-user `HKCU` registry writes.

**Architecture:** Electron app launched via CLI (`ContextHelper.exe --action=<plugin-id> --target="<path>"`). Main process parses args, consults plugin registry (loaded from `plugins/*/manifest.json`), spawns a worker child process running the plugin's `worker.js`, and opens a renderer window that injects the plugin's `ui.html` into a common shell. IPC carries start/cancel commands and progress updates. The named-pipe aggregator is built and unit-tested but only activated for plugins with `maxSelection > 1` (flatten-folder is single-folder, so it stays dormant until Plan 3).

**Tech Stack:** Electron 33, Node 20+, vanilla HTML/CSS/JS in renderer, Vitest 2 for unit/smoke tests, electron-builder 25 (only the `dir` target — no NSIS in this plan), pure Node `child_process.fork` for plugin workers.

**Out of scope for this plan:**
- No NSIS installer (Plan 2 territory; portable build is enough for local testing).
- No bundled external binaries (`ffmpeg`/`magick`/`gswin64c`/`7z`) — flatten-folder is pure JS; those land in Plan 3 alongside the plugins that need them.
- No additional plugins beyond flatten-folder (Plan 3).
- No `--register` / `--unregister` CLI verbs inside ContextHelper.exe — registration is done by hand-generated `.bat` files in this plan (simpler and easier to test). The CLI verbs can move to ContextHelper.exe later if useful.
- No HKLM (per-machine) install. Everything goes into HKCU.

---

## File map

Files created in this plan:

```
ContextHelper/
├── package.json                         # deps, scripts
├── package-lock.json                    # committed
├── .gitignore                           # node_modules, dist, logs, .env
├── .editorconfig                        # 2-space indent, LF
├── vitest.config.js                     # globals mode (Task 2)
├── electron-builder.yml                 # dir target only
├── README.md                            # minimal, expanded later
├── CLAUDE.md                            # TL;DR + commands + pointers
├── src/
│   ├── main/
│   │   ├── index.js                     # app entry, CLI dispatch, lifecycle
│   │   ├── cli.js                       # argv parser
│   │   ├── plugin-registry.js           # load manifests, match accepts
│   │   ├── window-manager.js            # create plugin window
│   │   ├── worker-runner.js             # fork worker, bridge IPC
│   │   ├── ipc-channels.js              # channel name constants
│   │   ├── named-pipe.js                # multi-instance aggregation
│   │   ├── logger.js                    # daily-rotated file log
│   │   └── utils/
│   │       ├── collision.js             # name (N).ext generator
│   │       └── long-path.js             # \\?\ prefixing
│   ├── preload/
│   │   └── plugin-preload.js            # contextBridge exposing IPC subset
│   ├── renderer/
│   │   ├── index.html                   # shell with slots
│   │   ├── app.js                       # wire form → start → progress → summary
│   │   └── styles.css                   # minimal styling
│   ├── shared/
│   │   └── plugin-api.js                # shared constants/types
│   └── worker/
│       └── worker-shim.js               # forked entry: load worker.js, relay IPC
├── plugins/
│   └── flatten-folder/
│       ├── manifest.json
│       ├── ui.html
│       ├── worker.js                    # flatten algorithm
│       └── icon.png                     # placeholder (16×16 transparent PNG)
├── scripts/
│   └── gen-register-bat.js              # generates register.bat & unregister.bat
├── tests/
│   ├── unit/
│   │   ├── collision.test.js
│   │   ├── long-path.test.js
│   │   ├── cli.test.js
│   │   ├── plugin-registry.test.js
│   │   ├── named-pipe.test.js
│   │   └── flatten-folder.test.js
│   └── smoke/
│       ├── runner.js                    # programmatic worker harness
│       └── fixtures.js                  # builds temp dirs for tests
├── register.bat                         # GENERATED, committed to git for visibility
├── unregister.bat                       # GENERATED, committed too
└── dist/                                # IGNORED, electron-builder output
```

Existing (not modified in this plan):
- `docs/superpowers/specs/2026-05-12-contexthelper-design.md`

---

## Conventions for all tasks

- **TDD where possible.** Pure logic (utilities, parsers, registry, flatten algorithm, named-pipe, worker bridge) is written test-first. UI tasks are exercised manually at the end.
- **CommonJS** throughout (`require` / `module.exports`). Electron supports ESM but mixing modes is friction not worth paying in v1.
- **Vitest in CJS:** Vitest 2 cannot be `require()`d from a CJS test file. Use **globals mode** instead — `describe`, `it`, `expect`, `beforeEach`, `afterEach` are exposed as globals via the `globals: true` setting in `vitest.config.js` (created during Task 2). Test files therefore do NOT contain a `require('vitest')` line.
- **No transpilation.** Plain Node 20 + Chromium runtime features only.
- **Encoding:** all source files UTF-8 with LF line endings (enforced via `.editorconfig`).
- **Commit messages:** Conventional Commits style (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). One commit per task. Subject prefixed with `feat(ContextHelper):` / `chore(ContextHelper):` etc. since this lives inside a parent repo. Co-Authored-By trailer required.
- **Working directory** for all shell commands: `C:\YandexDisk\Software\bin\ContextHelper\` unless stated otherwise. Git commits run from the parent: `git -C "C:\YandexDisk\Software\bin" …` with paths prefixed `ContextHelper/`.

---

## Task 1: Project bootstrap

**Files:**
- Create: `ContextHelper/package.json`
- Create: `ContextHelper/.gitignore`
- Create: `ContextHelper/.editorconfig`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "context-helper",
  "version": "0.1.0",
  "private": true,
  "description": "Plugin-based right-click context menu utility for Windows Explorer",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "test": "vitest run",
    "test:watch": "vitest",
    "smoke": "node tests/smoke/runner.js",
    "gen-register": "node scripts/gen-register-bat.js",
    "package": "electron-builder --dir"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
*.log
.env
.env.*
.DS_Store
Thumbs.db
.vscode/
```

(`.env*` blocks accidental secret commits. The earlier draft of this plan had a `%LOCALAPPDATA%/` line — that's a no-op in `.gitignore` since git doesn't expand Windows env vars; dropped.)

- [ ] **Step 3: Write `.editorconfig`**

```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no errors. Takes ~1–2 min (Electron is ~150 MB).

- [ ] **Step 5: Verify Electron resolves**

Run: `node -e "console.log(require('electron'))"`
Expected: prints a path ending in `electron.exe` (the binary). Do NOT use `npx electron --version` — that launches a window.

- [ ] **Step 6: Commit**

```
git add package.json package-lock.json .gitignore .editorconfig
git commit -m "chore: bootstrap ContextHelper Electron project"
```

---

## Task 2: Collision generator utility

The collision generator turns a desired filename + existing files in a directory into a non-colliding filename by suffixing `(2)`, `(3)`, etc.

**Files:**
- Create: `src/main/utils/collision.js`
- Create: `tests/unit/collision.test.js`

- [ ] **Step 1: Write failing tests**

`tests/unit/collision.test.js`:
```js
const { resolveCollision } = require('../../src/main/utils/collision');

describe('resolveCollision', () => {
  it('returns original name when no collision', () => {
    expect(resolveCollision('photo.jpg', new Set())).toBe('photo.jpg');
  });

  it('appends (2) on first collision', () => {
    expect(resolveCollision('photo.jpg', new Set(['photo.jpg']))).toBe('photo (2).jpg');
  });

  it('appends (3) when (2) is also taken', () => {
    const taken = new Set(['photo.jpg', 'photo (2).jpg']);
    expect(resolveCollision('photo.jpg', taken)).toBe('photo (3).jpg');
  });

  it('handles names without extensions', () => {
    expect(resolveCollision('README', new Set(['README']))).toBe('README (2)');
  });

  it('handles multi-dot names — uses last dot', () => {
    expect(resolveCollision('archive.tar.gz', new Set(['archive.tar.gz']))).toBe('archive.tar (2).gz');
  });

  it('handles hidden dotfiles (no extension)', () => {
    expect(resolveCollision('.gitignore', new Set(['.gitignore']))).toBe('.gitignore (2)');
  });

  it('handles names that already end with (N)', () => {
    const taken = new Set(['photo (2).jpg']);
    expect(resolveCollision('photo (2).jpg', taken)).toBe('photo (2) (2).jpg');
  });

  it('mutates nothing — Set parameter unchanged', () => {
    const taken = new Set(['a.txt']);
    resolveCollision('a.txt', taken);
    expect(taken.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test -- collision`
Expected: 8 failed, "Cannot find module ... collision".

- [ ] **Step 3: Implement**

`src/main/utils/collision.js`:
```js
function splitExt(name) {
  // Treat leading dot (dotfile) as part of base name, not extension.
  // Find last '.' that is not at position 0.
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

function resolveCollision(desiredName, takenSet) {
  if (!takenSet.has(desiredName)) return desiredName;
  const { base, ext } = splitExt(desiredName);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new Error(`resolveCollision: gave up after 10000 attempts for "${desiredName}"`);
}

module.exports = { resolveCollision };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- collision`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```
git add src/main/utils/collision.js tests/unit/collision.test.js
git commit -m "feat: add collision resolver utility (name (N).ext)"
```

---

## Task 3: Long-path utility

Windows path APIs have a 260-char limit unless prefixed with `\\?\`. This utility normalises any absolute path to the long-path form.

**Files:**
- Create: `src/main/utils/long-path.js`
- Create: `tests/unit/long-path.test.js`

- [ ] **Step 1: Write failing tests**

`tests/unit/long-path.test.js`:
```js
const { toLongPath, fromLongPath } = require('../../src/main/utils/long-path');

describe('toLongPath', () => {
  it('prefixes a drive-letter path', () => {
    expect(toLongPath('C:\\Users\\test\\file.txt')).toBe('\\\\?\\C:\\Users\\test\\file.txt');
  });

  it('leaves an already-prefixed path alone', () => {
    expect(toLongPath('\\\\?\\C:\\foo')).toBe('\\\\?\\C:\\foo');
  });

  it('prefixes a UNC path correctly', () => {
    expect(toLongPath('\\\\server\\share\\file.txt')).toBe('\\\\?\\UNC\\server\\share\\file.txt');
  });

  it('normalises forward slashes', () => {
    expect(toLongPath('C:/Users/test')).toBe('\\\\?\\C:\\Users\\test');
  });

  it('throws on a relative path', () => {
    expect(() => toLongPath('relative\\path')).toThrow(/absolute/i);
  });
});

describe('fromLongPath', () => {
  it('strips a drive-letter prefix', () => {
    expect(fromLongPath('\\\\?\\C:\\foo')).toBe('C:\\foo');
  });

  it('strips a UNC prefix', () => {
    expect(fromLongPath('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');
  });

  it('leaves a non-prefixed path alone', () => {
    expect(fromLongPath('C:\\foo')).toBe('C:\\foo');
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test -- long-path`
Expected: 8 failed.

- [ ] **Step 3: Implement**

`src/main/utils/long-path.js`:
```js
const LONG_PREFIX = '\\\\?\\';
const UNC_LONG_PREFIX = '\\\\?\\UNC\\';

function toLongPath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('toLongPath: expected non-empty string');
  }
  const normalised = p.replace(/\//g, '\\');
  if (normalised.startsWith(LONG_PREFIX)) return normalised;
  if (normalised.startsWith('\\\\')) {
    // UNC: \\server\share\... → \\?\UNC\server\share\...
    return UNC_LONG_PREFIX + normalised.slice(2);
  }
  if (/^[A-Za-z]:[\\/]/.test(normalised)) {
    return LONG_PREFIX + normalised;
  }
  throw new Error(`toLongPath: expected absolute path, got "${p}"`);
}

function fromLongPath(p) {
  if (p.startsWith(UNC_LONG_PREFIX)) return '\\\\' + p.slice(UNC_LONG_PREFIX.length);
  if (p.startsWith(LONG_PREFIX)) return p.slice(LONG_PREFIX.length);
  return p;
}

module.exports = { toLongPath, fromLongPath };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- long-path`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```
git add src/main/utils/long-path.js tests/unit/long-path.test.js
git commit -m "feat: add long-path (\\?\\) utility"
```

---

## Task 4: CLI parser

Parse `process.argv` into a structured action descriptor.

**Files:**
- Create: `src/main/cli.js`
- Create: `tests/unit/cli.test.js`

- [ ] **Step 1: Write failing tests**

`tests/unit/cli.test.js`:
```js
const { parseCli } = require('../../src/main/cli');

describe('parseCli', () => {
  it('parses --action and --target', () => {
    const r = parseCli(['--action=flatten-folder', '--target=C:\\Photos']);
    expect(r).toEqual({ kind: 'run', action: 'flatten-folder', target: 'C:\\Photos' });
  });

  it('parses --action and quoted --target', () => {
    const r = parseCli(['--action=flatten-folder', '--target=C:\\Some Folder\\With Spaces']);
    expect(r.target).toBe('C:\\Some Folder\\With Spaces');
  });

  it('errors when --action is missing', () => {
    expect(() => parseCli(['--target=C:\\foo'])).toThrow(/--action/);
  });

  it('errors when --target is missing', () => {
    expect(() => parseCli(['--action=flatten-folder'])).toThrow(/--target/);
  });

  it('errors on unknown flag', () => {
    expect(() => parseCli(['--action=x', '--target=y', '--bogus=z'])).toThrow(/--bogus/);
  });

  it('errors on positional argument', () => {
    expect(() => parseCli(['positional', '--action=x', '--target=y'])).toThrow();
  });

  it('returns kind:none when argv is empty', () => {
    expect(parseCli([])).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test -- cli`
Expected: 7 failed.

- [ ] **Step 3: Implement**

`src/main/cli.js`:
```js
// Accepts argv WITHOUT the leading [node, scriptPath] — pass process.argv.slice(2)
// from the entry point.
function parseCli(argv) {
  if (!Array.isArray(argv)) throw new Error('parseCli: argv must be an array');
  if (argv.length === 0) return { kind: 'none' };

  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new Error(`parseCli: unexpected positional argument "${arg}"`);
    }
    const eq = arg.indexOf('=');
    if (eq === -1) throw new Error(`parseCli: flag "${arg}" missing "=value"`);
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (!['action', 'target'].includes(key)) {
      throw new Error(`parseCli: unknown flag --${key}`);
    }
    flags[key] = value;
  }

  if (!flags.action) throw new Error('parseCli: --action is required');
  if (!flags.target) throw new Error('parseCli: --target is required');
  return { kind: 'run', action: flags.action, target: flags.target };
}

module.exports = { parseCli };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- cli`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```
git add src/main/cli.js tests/unit/cli.test.js
git commit -m "feat: add CLI argv parser"
```

---

## Task 5: Plugin registry and manifest loader

The registry reads all `plugins/*/manifest.json` files, validates them, and exposes lookup by id + selection-matching helpers.

**Files:**
- Create: `src/main/plugin-registry.js`
- Create: `tests/unit/plugin-registry.test.js`

- [ ] **Step 1: Write failing tests**

`tests/unit/plugin-registry.test.js`:
```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPluginRegistry, matchesAccepts } = require('../../src/main/plugin-registry');

function mkPluginDir(root, id, manifest) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('loadPluginRegistry', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-plugins-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a valid plugin', () => {
    mkPluginDir(tmp, 'flatten-folder', {
      id: 'flatten-folder',
      label: 'Сделать папку плоской',
      description: 'Перенести все вложенные файлы в корень папки',
      accepts: ['folder'],
      minSelection: 1,
      maxSelection: 1,
    });
    const reg = loadPluginRegistry(tmp);
    expect(reg.get('flatten-folder').label).toBe('Сделать папку плоской');
    expect(reg.get('flatten-folder').dir).toBe(path.join(tmp, 'flatten-folder'));
  });

  it('skips folders without a manifest.json', () => {
    fs.mkdirSync(path.join(tmp, 'incomplete'));
    const reg = loadPluginRegistry(tmp);
    expect(reg.size).toBe(0);
  });

  it('throws on manifest.id mismatch with folder name', () => {
    mkPluginDir(tmp, 'flatten-folder', {
      id: 'WRONG',
      label: 'x',
      description: 'y',
      accepts: ['folder'],
      minSelection: 1,
      maxSelection: 1,
    });
    expect(() => loadPluginRegistry(tmp)).toThrow(/id mismatch/i);
  });

  it('throws when required field is missing', () => {
    mkPluginDir(tmp, 'no-label', {
      id: 'no-label',
      description: 'y',
      accepts: ['folder'],
      minSelection: 1,
      maxSelection: 1,
    });
    expect(() => loadPluginRegistry(tmp)).toThrow(/label/);
  });
});

describe('matchesAccepts', () => {
  it('"folder" matches a single folder selection', () => {
    expect(matchesAccepts(['folder'], { kind: 'folder', count: 1, exts: [] })).toBe(true);
  });

  it('"folder" does NOT match multiple folders', () => {
    expect(matchesAccepts(['folder'], { kind: 'folder', count: 2, exts: [] })).toBe(false);
  });

  it('"folders" matches one or more folders', () => {
    expect(matchesAccepts(['folders'], { kind: 'folder', count: 1, exts: [] })).toBe(true);
    expect(matchesAccepts(['folders'], { kind: 'folder', count: 5, exts: [] })).toBe(true);
  });

  it('"files:.pdf" matches a PDF selection', () => {
    expect(matchesAccepts(['files:.pdf'], { kind: 'files', count: 1, exts: ['.pdf'] })).toBe(true);
  });

  it('"files:.jpg,.png" matches mixed jpg/png', () => {
    expect(matchesAccepts(['files:.jpg,.png'], { kind: 'files', count: 3, exts: ['.jpg', '.png'] })).toBe(true);
  });

  it('"files:.jpg" does NOT match when selection contains a non-listed ext', () => {
    expect(matchesAccepts(['files:.jpg'], { kind: 'files', count: 2, exts: ['.jpg', '.png'] })).toBe(false);
  });

  it('extensions are matched case-insensitively', () => {
    expect(matchesAccepts(['files:.jpg'], { kind: 'files', count: 1, exts: ['.JPG'] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test -- plugin-registry`
Expected: 11 failed.

- [ ] **Step 3: Implement**

`src/main/plugin-registry.js`:
```js
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = ['id', 'label', 'description', 'accepts', 'minSelection', 'maxSelection'];

function validateManifest(manifest, folderName) {
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`Plugin "${folderName}": manifest missing required field "${field}"`);
    }
  }
  if (manifest.id !== folderName) {
    throw new Error(`Plugin "${folderName}": id mismatch (manifest says "${manifest.id}")`);
  }
  if (!Array.isArray(manifest.accepts) || manifest.accepts.length === 0) {
    throw new Error(`Plugin "${folderName}": "accepts" must be a non-empty array`);
  }
}

function loadPluginRegistry(pluginsDir) {
  const registry = new Map();
  if (!fs.existsSync(pluginsDir)) return registry;
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    validateManifest(manifest, entry.name);
    registry.set(manifest.id, {
      ...manifest,
      dir: path.join(pluginsDir, entry.name),
    });
  }
  return registry;
}

// selection: { kind: 'folder' | 'files', count: number, exts: string[] (lowercase, dotted) }
function matchesAccepts(acceptsList, selection) {
  for (const pattern of acceptsList) {
    if (pattern === 'folder' && selection.kind === 'folder' && selection.count === 1) return true;
    if (pattern === 'folders' && selection.kind === 'folder' && selection.count >= 1) return true;
    if (pattern.startsWith('files:') && selection.kind === 'files') {
      const allowed = pattern
        .slice('files:'.length)
        .split(',')
        .map((e) => e.trim().toLowerCase());
      const selExts = selection.exts.map((e) => e.toLowerCase());
      if (selExts.every((e) => allowed.includes(e))) return true;
    }
  }
  return false;
}

module.exports = { loadPluginRegistry, matchesAccepts };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- plugin-registry`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```
git add src/main/plugin-registry.js tests/unit/plugin-registry.test.js
git commit -m "feat: add plugin manifest loader and selection matcher"
```

---

## Task 6: flatten-folder plugin (manifest, worker, tests)

This is the first real plugin. The worker takes one target folder and moves every nested file up into the root, resolving name collisions with the suffix `(N)`. Empty subfolders are removed. Optional `encodePathInName` flag rewrites collisions as `subdir__file.ext` instead of `(N)`.

**Files:**
- Create: `plugins/flatten-folder/manifest.json`
- Create: `plugins/flatten-folder/ui.html` (filled in Task 14; placeholder here)
- Create: `plugins/flatten-folder/icon.png` (16×16 transparent placeholder)
- Create: `plugins/flatten-folder/worker.js`
- Create: `tests/unit/flatten-folder.test.js`

- [ ] **Step 1: Write the manifest**

`plugins/flatten-folder/manifest.json`:
```json
{
  "id": "flatten-folder",
  "label": "Сделать папку плоской",
  "description": "Перенести все вложенные файлы в корень папки",
  "icon": "icon.png",
  "accepts": ["folder"],
  "minSelection": 1,
  "maxSelection": 1
}
```

- [ ] **Step 2: Create placeholder `ui.html` and `icon.png`**

`plugins/flatten-folder/ui.html`:
```html
<div class="plugin-ui">
  <label class="ch-option">
    <input type="checkbox" name="encodePathInName" />
    Кодировать исходный путь в имя файла (вместо <code>(N)</code> при коллизии)
  </label>
</div>
```

Create a 1×1 transparent PNG at `plugins/flatten-folder/icon.png`. Run from project root:
```
node -e "require('fs').writeFileSync('plugins/flatten-folder/icon.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64'))"
```

- [ ] **Step 3: Write failing tests for the worker**

`tests/unit/flatten-folder.test.js`:
```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const run = require('../../plugins/flatten-folder/worker');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

describe('flatten-folder worker', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('moves all nested files to root', async () => {
    tree(tmp, {
      'a/1.txt': '1',
      'a/b/2.txt': '2',
      'c/3.txt': '3',
    });
    const result = await run({ targets: [tmp], options: {}, onProgress: () => {} });
    expect(result.ok).toBe(true);
    expect(listFiles(tmp)).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(result.processed).toBe(3);
  });

  it('resolves name collisions with (N) suffix', async () => {
    tree(tmp, {
      'a/photo.jpg': 'A',
      'b/photo.jpg': 'B',
      'c/photo.jpg': 'C',
    });
    await run({ targets: [tmp], options: {}, onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['photo (2).jpg', 'photo (3).jpg', 'photo.jpg']);
  });

  it('removes empty subfolders after flattening', async () => {
    tree(tmp, { 'a/b/c/deep.txt': 'x' });
    await run({ targets: [tmp], options: {}, onProgress: () => {} });
    expect(fs.existsSync(path.join(tmp, 'a'))).toBe(false);
  });

  it('preserves an already-flat folder unchanged', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const result = await run({ targets: [tmp], options: {}, onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['a.txt', 'b.txt']);
    expect(result.processed).toBe(0); // nothing moved
  });

  it('encodePathInName uses subfolder__filename instead of (N)', async () => {
    tree(tmp, {
      'a/photo.jpg': 'A',
      'b/photo.jpg': 'B',
    });
    await run({ targets: [tmp], options: { encodePathInName: true }, onProgress: () => {} });
    expect(listFiles(tmp).sort()).toEqual(['a__photo.jpg', 'b__photo.jpg']);
  });

  it('emits progress events', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    const events = [];
    await run({ targets: [tmp], options: {}, onProgress: (p) => events.push(p) });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ processed: 2, total: 2 });
  });

  it('respects an abort signal mid-run', async () => {
    tree(tmp, {
      'a/1.txt': '1',
      'a/2.txt': '2',
      'a/3.txt': '3',
      'a/4.txt': '4',
    });
    const controller = new AbortController();
    const promise = run({
      targets: [tmp],
      options: {},
      onProgress: (p) => {
        if (p.processed === 2) controller.abort();
      },
      signal: controller.signal,
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.processed).toBeLessThan(4);
  });
});
```

- [ ] **Step 4: Run tests, confirm fail**

Run: `npm test -- flatten-folder`
Expected: 7 failed.

- [ ] **Step 5: Implement the worker**

`plugins/flatten-folder/worker.js`:
```js
const fs = require('node:fs');
const path = require('node:path');
const { resolveCollision } = require('../../src/main/utils/collision');

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function pruneEmptyDirs(root) {
  const stack = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
    if (dir !== root) stack.push(dir);
  }
  walk(root);
  // Stack is already deepest-first because the post-order walk pushes
  // each dir AFTER recursing into its children. (An earlier draft of
  // this plan called .reverse() here — that was wrong; it would try to
  // remove parents before children.)
  for (const dir of stack) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // best-effort
    }
  }
}

function encodePath(rootRel) {
  return rootRel.split(path.sep).join('__');
}

async function run({ targets, options = {}, onProgress = () => {}, signal }) {
  const root = targets[0];
  const all = walkFiles(root);
  // Filter to files NOT already in root.
  const toMove = all.filter((f) => path.dirname(f) !== root);
  const total = toMove.length;
  const errors = [];
  let processed = 0;
  let skipped = 0;

  // Track existing root names to avoid live collisions.
  const taken = new Set(
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  );

  for (const src of toMove) {
    if (signal?.aborted) {
      return { ok: false, processed, skipped, errors, aborted: true };
    }
    const rel = path.relative(root, src);
    const baseName = path.basename(src);
    let target;
    if (options.encodePathInName) {
      const encoded = encodePath(rel);
      target = encoded;
      if (taken.has(target)) target = resolveCollision(target, taken);
    } else {
      target = resolveCollision(baseName, taken);
    }
    try {
      fs.renameSync(src, path.join(root, target));
      taken.add(target);
      processed++;
      onProgress({ processed, total, current: target });
    } catch (err) {
      errors.push({ file: rel, message: err.message });
      skipped++;
    }
  }

  pruneEmptyDirs(root);

  return { ok: errors.length === 0, processed, skipped, errors };
}

module.exports = run;
```

- [ ] **Step 6: Run tests, confirm pass**

Run: `npm test -- flatten-folder`
Expected: 7 passed.

- [ ] **Step 7: Commit**

```
git add plugins/flatten-folder/ tests/unit/flatten-folder.test.js
git commit -m "feat(plugins): add flatten-folder plugin (manifest + worker + tests)"
```

---

## Task 7: Smoke runner

The smoke runner programmatically invokes plugin workers against generated fixtures — no UI, no Electron, no IPC. It's the diagnostic that proves "the plugin algorithms work on this machine right now."

**Files:**
- Create: `tests/smoke/fixtures.js`
- Create: `tests/smoke/runner.js`

- [ ] **Step 1: Write fixture builder**

`tests/smoke/fixtures.js`:
```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildFlattenFixture() {
  const dir = mkdtemp('ch-smoke-flatten-');
  const layout = {
    'a/1.txt': '1',
    'a/b/2.txt': '2',
    'a/b/c/3.txt': '3',
    'collision/photo.jpg': 'A',
    'other/photo.jpg': 'B',
  };
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

module.exports = { buildFlattenFixture };
```

- [ ] **Step 2: Write the runner**

`tests/smoke/runner.js`:
```js
const fs = require('node:fs');
const path = require('node:path');
const { buildFlattenFixture } = require('./fixtures');

const args = process.argv.slice(2);
const onlyPlugin = (args.find((a) => a.startsWith('--plugin=')) || '').slice('--plugin='.length);

const cases = [];

cases.push({
  id: 'flatten-folder',
  async run() {
    const flattenRun = require('../../plugins/flatten-folder/worker');
    const dir = buildFlattenFixture();
    try {
      const result = await flattenRun({ targets: [dir], options: {}, onProgress: () => {} });
      const rootFiles = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
      const subdirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).length;
      if (subdirs !== 0) throw new Error(`expected 0 subdirs, got ${subdirs}`);
      if (rootFiles.length !== 5) throw new Error(`expected 5 root files, got ${rootFiles.length}`);
      return { ok: result.ok, summary: `${result.processed} files → ${rootFiles.length} in root` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});

(async function main() {
  let failures = 0;
  for (const c of cases) {
    if (onlyPlugin && c.id !== onlyPlugin) continue;
    process.stdout.write(`${c.id.padEnd(28)} `);
    try {
      const r = await c.run();
      if (r.ok) console.log(`✓ ${r.summary}`);
      else {
        console.log(`✗ ${r.summary || 'failed'}`);
        failures++;
      }
    } catch (err) {
      console.log(`✗ ${err.message}`);
      failures++;
    }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 3: Run the smoke runner**

Run: `npm run smoke`
Expected output:
```
flatten-folder               ✓ 5 files → 5 in root
```
Exit code: 0.

- [ ] **Step 4: Run with filter, verify it filters**

Run: `npm run smoke -- --plugin=nonexistent`
Expected: no output lines printed, exit code 0 (nothing ran, nothing failed).

- [ ] **Step 5: Commit**

```
git add tests/smoke/
git commit -m "test: add smoke runner with flatten-folder case"
```

---

## Task 8: Logger

Daily-rotated text log in `%LOCALAPPDATA%\ContextHelper\logs\YYYY-MM-DD.log`. 14-day retention. Plain text format, one line per event.

**Files:**
- Create: `src/main/logger.js`

(No unit test — logger is simple FS append; we exercise it manually and via integration.)

- [ ] **Step 1: Implement**

`src/main/logger.js`:
```js
const fs = require('node:fs');
const path = require('node:path');

const LOG_ROOT = path.join(process.env.LOCALAPPDATA || process.env.TMP || '.', 'ContextHelper', 'logs');
const RETENTION_DAYS = 14;

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function logFilePath() {
  return path.join(LOG_ROOT, `${todayStamp()}.log`);
}

function ensureLogDir() {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
}

function pruneOld() {
  if (!fs.existsSync(LOG_ROOT)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(LOG_ROOT)) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(LOG_ROOT, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // best-effort
    }
  }
}

function log(level, message, meta) {
  ensureLogDir();
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch (err) {
    process.stderr.write(`logger: failed to write — ${err.message}\n`);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  pruneOld,
  logFilePath,
  LOG_ROOT,
};
```

- [ ] **Step 2: Sanity check**

Run: `node -e "const l = require('./src/main/logger'); l.info('hello', { foo: 1 }); console.log('wrote to', l.logFilePath())"`
Expected: prints log file path. Open the file, verify the line is there.

- [ ] **Step 3: Commit**

```
git add src/main/logger.js
git commit -m "feat: add daily-rotated file logger"
```

---

## Task 9: Named pipe aggregator

When Windows invokes a context-menu command on multiple files, it spawns the registered command **once per file**. The aggregator detects sibling instances via a named pipe and merges their target paths into a single window.

**Built and tested now but not wired in until Plan 3** when the first `maxSelection > 1` plugin lands. Building it here keeps the architecture honest and the test suite stable.

**Files:**
- Create: `src/main/named-pipe.js`
- Create: `tests/unit/named-pipe.test.js`

- [ ] **Step 1: Write failing tests**

`tests/unit/named-pipe.test.js`:
```js
const { aggregateTargets } = require('../../src/main/named-pipe');

describe('aggregateTargets', () => {
  it('lone caller returns its own target after timeout', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const result = await aggregateTargets({
      pipeName,
      myTarget: 'C:\\one.txt',
      waitMs: 100,
    });
    expect(result.role).toBe('leader');
    expect(result.targets).toEqual(['C:\\one.txt']);
  });

  it('two concurrent callers aggregate into one leader', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const [a, b] = await Promise.all([
      aggregateTargets({ pipeName, myTarget: 'A', waitMs: 300 }),
      // small delay to ensure A becomes leader first
      new Promise((r) => setTimeout(r, 50)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'B', waitMs: 300 }),
      ),
    ]);
    // exactly one leader
    const leaders = [a, b].filter((x) => x.role === 'leader');
    const followers = [a, b].filter((x) => x.role === 'follower');
    expect(leaders).toHaveLength(1);
    expect(followers).toHaveLength(1);
    expect(leaders[0].targets.sort()).toEqual(['A', 'B']);
    expect(followers[0].targets).toEqual([]);
  });

  it('three concurrent callers all aggregate', async () => {
    const pipeName = `ContextHelper-test-${Date.now()}-${Math.random()}`;
    const results = await Promise.all([
      aggregateTargets({ pipeName, myTarget: 'A', waitMs: 400 }),
      new Promise((r) => setTimeout(r, 30)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'B', waitMs: 400 }),
      ),
      new Promise((r) => setTimeout(r, 60)).then(() =>
        aggregateTargets({ pipeName, myTarget: 'C', waitMs: 400 }),
      ),
    ]);
    const leader = results.find((r) => r.role === 'leader');
    expect(leader).toBeDefined();
    expect(leader.targets.sort()).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `npm test -- named-pipe`
Expected: 3 failed.

- [ ] **Step 3: Implement**

`src/main/named-pipe.js`:
```js
const net = require('node:net');

const PIPE_PREFIX = '\\\\.\\pipe\\';

function pipePath(name) {
  return PIPE_PREFIX + name;
}

// Try to connect to an existing pipe as a follower. Resolves true if successful.
function tryFollower({ pipeName, myTarget }) {
  return new Promise((resolve) => {
    const socket = net.connect(pipePath(pipeName));
    let done = false;
    socket.once('connect', () => {
      socket.end(myTarget + '\n', 'utf8', () => {
        done = true;
        resolve(true);
      });
    });
    socket.once('error', () => {
      if (!done) resolve(false);
    });
  });
}

// Become leader: create the pipe server, collect targets until waitMs elapses.
function startLeader({ pipeName, myTarget, waitMs }) {
  return new Promise((resolve, reject) => {
    const targets = [myTarget];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      conn.on('end', () => {
        const line = buf.replace(/\r?\n$/, '');
        if (line) targets.push(line);
      });
    });
    server.on('error', reject);
    server.listen(pipePath(pipeName), () => {
      setTimeout(() => {
        server.close(() => {
          resolve({ role: 'leader', targets });
        });
      }, waitMs);
    });
  });
}

async function aggregateTargets({ pipeName, myTarget, waitMs = 200 }) {
  // First try to be a follower. If that fails, become leader.
  const followed = await tryFollower({ pipeName, myTarget });
  if (followed) return { role: 'follower', targets: [] };
  return startLeader({ pipeName, myTarget, waitMs });
}

module.exports = { aggregateTargets };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npm test -- named-pipe`
Expected: 3 passed. (Each test takes 100–400 ms — total ~1 s.)

- [ ] **Step 5: Commit**

```
git add src/main/named-pipe.js tests/unit/named-pipe.test.js
git commit -m "feat: add named-pipe multi-instance aggregator (dormant until Plan 3)"
```

---

## Task 10: Worker bridge (fork + IPC relay)

The main process forks a Node child running `src/worker/worker-shim.js`, passes the plugin's worker module path + targets + options, and relays `progress` / `complete` events back via Electron IPC to the renderer.

**Files:**
- Create: `src/shared/plugin-api.js`
- Create: `src/main/ipc-channels.js`
- Create: `src/worker/worker-shim.js`
- Create: `src/main/worker-runner.js`

(Unit-test the shim + runner end-to-end via a stub worker module.)

- [ ] **Step 1: Write the shared constants**

`src/shared/plugin-api.js`:
```js
// Constants used across main, renderer, and worker.
module.exports = {
  IPC: {
    INIT: 'plugin:init',           // main → renderer: { manifest, targets }
    START: 'plugin:start',         // renderer → main: { options }
    CANCEL: 'plugin:cancel',       // renderer → main: ()
    PROGRESS: 'plugin:progress',   // main → renderer: { processed, total, current }
    COMPLETE: 'plugin:complete',   // main → renderer: { ok, processed, skipped, errors }
  },
  WORKER_MSG: {
    PROGRESS: 'worker:progress',
    COMPLETE: 'worker:complete',
    ERROR: 'worker:error',
    CANCEL: 'worker:cancel',
  },
};
```

`src/main/ipc-channels.js`:
```js
// Re-export from shared so main code has a stable import path.
module.exports = require('../shared/plugin-api').IPC;
```

- [ ] **Step 2: Write the worker shim**

`src/worker/worker-shim.js`:
```js
// Forked entry. Loaded by main via child_process.fork(__dirname/worker-shim.js, [], { ... }).
// Receives { workerPath, targets, options } on the first IPC message.
const { WORKER_MSG } = require('../shared/plugin-api');

const cancelState = { aborted: false };
// Custom AbortSignal-like object — the plugin API only needs the .aborted getter.
const signal = {
  get aborted() {
    return cancelState.aborted;
  },
};

process.on('message', async (msg) => {
  if (msg.type === 'cancel') {
    cancelState.aborted = true;
    return;
  }
  if (msg.type !== 'start') return;
  const { workerPath, targets, options } = msg;
  const run = require(workerPath);
  try {
    const result = await run({
      targets,
      options,
      onProgress: (p) => process.send({ kind: WORKER_MSG.PROGRESS, payload: p }),
      signal,
    });
    process.send({ kind: WORKER_MSG.COMPLETE, payload: result });
  } catch (err) {
    process.send({ kind: WORKER_MSG.ERROR, payload: { message: err.message, stack: err.stack } });
  } finally {
    process.exit(0);
  }
});
```

- [ ] **Step 3: Write the worker-runner (main-side bridge)**

`src/main/worker-runner.js`:
```js
const path = require('node:path');
const { fork } = require('node:child_process');
const { WORKER_MSG } = require('../shared/plugin-api');

function runWorker({ workerPath, targets, options, onProgress, onComplete, onError }) {
  const shim = path.join(__dirname, '..', 'worker', 'worker-shim.js');
  const child = fork(shim, [], { silent: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  child.on('message', (msg) => {
    if (msg.kind === WORKER_MSG.PROGRESS) onProgress?.(msg.payload);
    else if (msg.kind === WORKER_MSG.COMPLETE) onComplete?.(msg.payload);
    else if (msg.kind === WORKER_MSG.ERROR) onError?.(msg.payload);
  });

  child.on('exit', (code) => {
    if (code !== 0) onError?.({ message: `Worker exited with code ${code}` });
  });

  child.send({ type: 'start', workerPath, targets, options });

  return {
    cancel() {
      child.send({ type: 'cancel' });
    },
  };
}

module.exports = { runWorker };
```

- [ ] **Step 4: Write an integration test exercising the bridge**

`tests/unit/worker-runner.test.js`:
```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWorker } = require('../../src/main/worker-runner');

describe('runWorker', () => {
  it('runs a stub worker end-to-end via fork', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-worker-runner-'));
    const stubPath = path.join(tmp, 'stub.js');
    fs.writeFileSync(
      stubPath,
      `module.exports = async function({ targets, onProgress }) {
         onProgress({ processed: 1, total: 2 });
         onProgress({ processed: 2, total: 2 });
         return { ok: true, processed: 2, skipped: 0, errors: [] };
       };`,
    );

    const progresses = [];
    const completion = await new Promise((resolve, reject) => {
      runWorker({
        workerPath: stubPath,
        targets: ['x'],
        options: {},
        onProgress: (p) => progresses.push(p),
        onComplete: resolve,
        onError: reject,
      });
    });
    expect(progresses).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
    expect(completion).toEqual({ ok: true, processed: 2, skipped: 0, errors: [] });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 5: Run tests, confirm pass**

Run: `npm test -- worker-runner`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```
git add src/shared/ src/main/ipc-channels.js src/main/worker-runner.js src/worker/ tests/unit/worker-runner.test.js
git commit -m "feat: add worker child-process bridge with IPC progress relay"
```

---

## Task 11: Preload bridge

The renderer is sandboxed. We expose a minimal, audited subset of `ipcRenderer` to the page via `contextBridge`.

**Files:**
- Create: `src/preload/plugin-preload.js`

- [ ] **Step 1: Implement**

`src/preload/plugin-preload.js`:
```js
const { contextBridge, ipcRenderer } = require('electron');
const { IPC } = require('../shared/plugin-api');

contextBridge.exposeInMainWorld('ch', {
  onInit: (cb) => ipcRenderer.on(IPC.INIT, (_e, payload) => cb(payload)),
  onProgress: (cb) => ipcRenderer.on(IPC.PROGRESS, (_e, payload) => cb(payload)),
  onComplete: (cb) => ipcRenderer.on(IPC.COMPLETE, (_e, payload) => cb(payload)),
  start: (options) => ipcRenderer.send(IPC.START, { options }),
  cancel: () => ipcRenderer.send(IPC.CANCEL),
});
```

- [ ] **Step 2: Commit**

```
git add src/preload/
git commit -m "feat: add preload bridge exposing safe IPC subset"
```

---

## Task 12: Renderer shell (HTML + CSS + app.js)

The renderer is a single page that adapts to whichever plugin sent its `INIT` message. It injects the plugin's `ui.html` into the options slot, wires Start/Cancel, and renders progress + summary.

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/app.js`

- [ ] **Step 1: Write the HTML shell**

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>ContextHelper</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="ch-header">
      <h1 id="plugin-label">…</h1>
      <p id="plugin-description"></p>
    </header>

    <section class="ch-targets">
      <h2>Цель</h2>
      <div id="targets-summary"></div>
    </section>

    <section class="ch-options" id="options-slot">
      <!-- plugin's ui.html injected here -->
    </section>

    <section class="ch-progress hidden" id="progress-block">
      <progress id="progress-bar" value="0" max="100"></progress>
      <div id="progress-line"></div>
    </section>

    <section class="ch-summary hidden" id="summary-block">
      <div id="summary-line"></div>
      <ul id="errors-list"></ul>
    </section>

    <footer class="ch-actions">
      <button id="btn-start" class="primary">Старт</button>
      <button id="btn-cancel" class="hidden">Остановить</button>
      <button id="btn-close" class="hidden">Закрыть</button>
    </footer>

    <script src="app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write minimal styles**

`src/renderer/styles.css`:
```css
* { box-sizing: border-box; }
body {
  font-family: 'Segoe UI', sans-serif;
  font-size: 14px;
  margin: 0;
  padding: 16px;
  background: #f5f5f5;
  color: #222;
}
.ch-header h1 { margin: 0 0 4px; font-size: 18px; }
.ch-header p  { margin: 0 0 16px; color: #666; }
section { background: #fff; padding: 12px; border-radius: 4px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
section h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; color: #999; }
.ch-actions { display: flex; gap: 8px; justify-content: flex-end; }
button { padding: 6px 16px; border: 1px solid #ccc; background: #fff; border-radius: 3px; cursor: pointer; font: inherit; }
button.primary { background: #0078d4; color: #fff; border-color: #0078d4; }
button:hover { background: #e6e6e6; }
button.primary:hover { background: #106ebe; }
.hidden { display: none !important; }
progress { width: 100%; height: 20px; }
#progress-line { margin-top: 8px; font-family: 'Consolas', monospace; color: #555; font-size: 12px; }
.ch-option { display: block; padding: 4px 0; }
code { background: #eee; padding: 1px 4px; border-radius: 2px; font-family: 'Consolas', monospace; }
#errors-list { color: #c00; font-size: 12px; }
```

- [ ] **Step 3: Write app.js**

`src/renderer/app.js`:
```js
const $ = (id) => document.getElementById(id);

let pluginManifest = null;
let pluginTargets = [];

window.ch.onInit(({ manifest, targets, uiHtml }) => {
  pluginManifest = manifest;
  pluginTargets = targets;
  $('plugin-label').textContent = manifest.label;
  $('plugin-description').textContent = manifest.description;

  const summary = targets.length === 1
    ? `1 объект: ${targets[0]}`
    : `${targets.length} объектов: ${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ', …' : ''}`;
  $('targets-summary').textContent = summary;

  $('options-slot').innerHTML = uiHtml || '';
});

window.ch.onProgress(({ processed, total, current }) => {
  $('progress-block').classList.remove('hidden');
  const bar = $('progress-bar');
  bar.value = total ? Math.round((processed / total) * 100) : 0;
  $('progress-line').textContent = `${processed} / ${total}${current ? ': ' + current : ''}`;
});

window.ch.onComplete(({ ok, processed, skipped, errors }) => {
  $('btn-cancel').classList.add('hidden');
  $('btn-close').classList.remove('hidden');
  $('summary-block').classList.remove('hidden');
  const errCount = errors ? errors.length : 0;
  const icon = ok && errCount === 0 ? '✓' : (errCount > 0 ? '✕' : '⚠');
  $('summary-line').textContent = `${icon} Обработано: ${processed}, пропущено: ${skipped}, ошибок: ${errCount}`;
  if (errors && errors.length) {
    const ul = $('errors-list');
    for (const e of errors) {
      const li = document.createElement('li');
      li.textContent = `${e.file}: ${e.message}`;
      ul.appendChild(li);
    }
  }
});

$('btn-start').addEventListener('click', () => {
  const form = $('options-slot');
  const options = {};
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') options[el.name] = el.checked;
    else options[el.name] = el.value;
  }
  $('btn-start').classList.add('hidden');
  $('btn-cancel').classList.remove('hidden');
  $('options-slot').classList.add('hidden');
  window.ch.start(options);
});

$('btn-cancel').addEventListener('click', () => window.ch.cancel());
$('btn-close').addEventListener('click', () => window.close());
```

- [ ] **Step 4: Commit**

```
git add src/renderer/
git commit -m "feat: add renderer shell (HTML + CSS + app.js)"
```

---

## Task 13: Window manager + main entry + wire-up

This is the big integration task. The main process boots Electron, parses CLI, loads the registry, opens a window with the plugin UI injected, and on Start forks the worker and relays progress.

**Files:**
- Create: `src/main/window-manager.js`
- Create: `src/main/index.js`

- [ ] **Step 1: Write window-manager**

`src/main/window-manager.js`:
```js
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, ipcMain } = require('electron');
const { IPC } = require('../shared/plugin-api');
const { runWorker } = require('./worker-runner');
const logger = require('./logger');

function openPluginWindow({ manifest, targets }) {
  const win = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'ContextHelper — ' + manifest.label,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'plugin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require()
    },
  });

  let runner = null;

  win.webContents.on('did-finish-load', () => {
    const uiPath = path.join(manifest.dir, 'ui.html');
    const uiHtml = fs.existsSync(uiPath) ? fs.readFileSync(uiPath, 'utf8') : '';
    win.webContents.send(IPC.INIT, { manifest, targets, uiHtml });
  });

  const startHandler = (_e, { options }) => {
    logger.info('plugin:start', { id: manifest.id, targets, options });
    runner = runWorker({
      workerPath: path.join(manifest.dir, 'worker.js'),
      targets,
      options,
      onProgress: (p) => win.webContents.send(IPC.PROGRESS, p),
      onComplete: (r) => {
        logger.info('plugin:complete', { id: manifest.id, result: r });
        win.webContents.send(IPC.COMPLETE, r);
      },
      onError: (e) => {
        logger.error('plugin:error', { id: manifest.id, error: e });
        win.webContents.send(IPC.COMPLETE, { ok: false, processed: 0, skipped: 0, errors: [{ file: '(worker)', message: e.message }] });
      },
    });
  };

  const cancelHandler = () => {
    if (runner) runner.cancel();
  };

  ipcMain.on(IPC.START, startHandler);
  ipcMain.on(IPC.CANCEL, cancelHandler);

  win.on('closed', () => {
    ipcMain.removeListener(IPC.START, startHandler);
    ipcMain.removeListener(IPC.CANCEL, cancelHandler);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

module.exports = { openPluginWindow };
```

- [ ] **Step 2: Write main entry**

`src/main/index.js`:
```js
const path = require('node:path');
const { app } = require('electron');
const { parseCli } = require('./cli');
const { loadPluginRegistry } = require('./plugin-registry');
const { openPluginWindow } = require('./window-manager');
const logger = require('./logger');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

async function main() {
  logger.pruneOld();
  const cli = parseCli(process.argv.slice(process.defaultApp ? 2 : 1));
  if (cli.kind === 'none') {
    logger.error('startup: no CLI args');
    app.quit();
    return;
  }
  if (cli.kind !== 'run') {
    logger.error('startup: unknown CLI mode', { cli });
    app.quit();
    return;
  }

  const registry = loadPluginRegistry(PLUGINS_DIR);
  const manifest = registry.get(cli.action);
  if (!manifest) {
    logger.error('startup: unknown action', { action: cli.action });
    app.quit();
    return;
  }

  openPluginWindow({ manifest, targets: [cli.target] });
}

app.whenReady().then(main).catch((err) => {
  logger.error('fatal startup error', { message: err.message, stack: err.stack });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 3: Manual dev-mode smoke test**

Prepare a test directory and run the app in dev mode:

```
node -e "
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dev-'));
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a/file1.txt'), '1');
  fs.writeFileSync(path.join(dir, 'a/b/file2.txt'), '2');
  console.log(dir);
"
```

Note the printed temp dir path. Then run:
```
npm start -- --action=flatten-folder --target="<temp dir path>"
```

Expected:
1. A window opens titled "ContextHelper — Сделать папку плоской".
2. The "Цель" section shows the temp dir.
3. There's a checkbox "Кодировать исходный путь в имя файла".
4. Click Старт. Progress bar advances to 100%. Summary says "✓ Обработано: 2, пропущено: 0, ошибок: 0".
5. Close the window.
6. Verify the temp dir now contains `file1.txt` and `file2.txt` in the root (no `a/` subfolder).

- [ ] **Step 4: Commit**

```
git add src/main/window-manager.js src/main/index.js
git commit -m "feat: wire up Electron main entry + window manager (end-to-end flatten-folder)"
```

---

## Task 14: Portable build + register/unregister generator

We use electron-builder's `dir` target — produces a fully-populated `dist/win-unpacked/` folder that runs `ContextHelper.exe` from anywhere with no install. We generate `register.bat` / `unregister.bat` from plugin manifests and copy them alongside the .exe so the user can right-click → register.

**Files:**
- Create: `electron-builder.yml`
- Create: `scripts/gen-register-bat.js`

- [ ] **Step 1: Write electron-builder config**

`electron-builder.yml`:
```yaml
appId: dev.contexthelper.app
productName: ContextHelper
directories:
  output: dist
files:
  - "src/**/*"
  - "plugins/**/*"
  - "package.json"
extraResources:
  - from: scripts/gen-register-bat.js
    to: scripts/gen-register-bat.js
  - from: plugins
    to: plugins
win:
  target:
    - target: dir
      arch: x64
  icon: null
```

Note: omitting `icon` for now — electron-builder will use a generic one.

- [ ] **Step 2: Run packager**

Run: `npm run package`
Expected: takes ~30–90 s. Produces `dist/win-unpacked/ContextHelper.exe` plus `resources/`, `locales/`, etc.

- [ ] **Step 3: Verify the portable launches**

Run: `dist/win-unpacked/ContextHelper.exe --action=flatten-folder --target="<some test folder>"`
Expected: same window as in Task 13. Closes cleanly.

- [ ] **Step 4: Write the .bat generator**

`scripts/gen-register-bat.js`:
```js
const fs = require('node:fs');
const path = require('node:path');

const pluginsDir = path.resolve(__dirname, '..', 'plugins');
const outDir = path.resolve(__dirname, '..');

function loadManifests() {
  const out = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mp = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    out.push(JSON.parse(fs.readFileSync(mp, 'utf8')));
  }
  return out;
}

function escapeForReg(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Group plugins by selection kind.
function classify(manifest) {
  // For Plan 1, only "folder" / "folders" / "files:.ext" forms.
  const result = { folders: [], filesByExt: {} };
  for (const pattern of manifest.accepts) {
    if (pattern === 'folder' || pattern === 'folders') result.folders.push(manifest);
    else if (pattern.startsWith('files:')) {
      const exts = pattern.slice('files:'.length).split(',').map((e) => e.trim().toLowerCase());
      for (const ext of exts) {
        result.filesByExt[ext] = result.filesByExt[ext] || [];
        result.filesByExt[ext].push(manifest);
      }
    }
  }
  return result;
}

function generateRegisterBat(manifests, exePath) {
  const lines = [
    '@echo off',
    'REM Auto-generated by scripts/gen-register-bat.js — do not edit by hand.',
    'REM Registers ContextHelper plugins in HKCU. No admin required.',
    '',
    'setlocal',
    `set "EXE=${exePath}"`,
    '',
  ];

  // Folder-level root verb with submenu.
  lines.push(
    'REM === Folder submenu root ===',
    'reg add "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /v MUIVerb /t REG_SZ /d "ContextHelper" /f',
    'reg add "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /v Icon /t REG_SZ /d "%EXE%,0" /f',
    'reg add "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /v SubCommands /t REG_SZ /d "" /f',
    'reg add "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /v ExtendedSubCommandsKey /t REG_SZ /d "Software\\Classes\\Directory\\ContextHelperSub" /f',
    '',
  );

  const folderPlugins = manifests.filter((m) => m.accepts.includes('folder') || m.accepts.includes('folders'));
  for (const m of folderPlugins) {
    const key = `HKCU\\Software\\Classes\\Directory\\ContextHelperSub\\shell\\${m.id}`;
    lines.push(
      `REM --- ${m.id} (folder) ---`,
      `reg add "${key}" /v MUIVerb /t REG_SZ /d "${m.label}" /f`,
      `reg add "${key}\\command" /ve /t REG_SZ /d "\\"%EXE%\\" --action=${m.id} --target=\\"%%1\\"" /f`,
      '',
    );
  }

  // Per-extension registrations.
  const byExt = {};
  for (const m of manifests) {
    for (const pat of m.accepts) {
      if (!pat.startsWith('files:')) continue;
      const exts = pat.slice('files:'.length).split(',').map((e) => e.trim().toLowerCase());
      for (const ext of exts) {
        byExt[ext] = byExt[ext] || [];
        byExt[ext].push(m);
      }
    }
  }
  for (const [ext, plugins] of Object.entries(byExt)) {
    const extKey = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}`;
    const subKey = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\ContextHelperSub_${ext.slice(1)}`;
    lines.push(
      `REM === Extension ${ext} ===`,
      `reg add "${extKey}\\shell\\ContextHelper" /v MUIVerb /t REG_SZ /d "ContextHelper" /f`,
      `reg add "${extKey}\\shell\\ContextHelper" /v Icon /t REG_SZ /d "%EXE%,0" /f`,
      `reg add "${extKey}\\shell\\ContextHelper" /v SubCommands /t REG_SZ /d "" /f`,
      `reg add "${extKey}\\shell\\ContextHelper" /v ExtendedSubCommandsKey /t REG_SZ /d "Software\\Classes\\SystemFileAssociations\\${ext}\\ContextHelperSub_${ext.slice(1)}" /f`,
    );
    for (const m of plugins) {
      const cmdKey = `${subKey}\\shell\\${m.id}`;
      lines.push(
        `reg add "${cmdKey}" /v MUIVerb /t REG_SZ /d "${m.label}" /f`,
        `reg add "${cmdKey}\\command" /ve /t REG_SZ /d "\\"%EXE%\\" --action=${m.id} --target=\\"%%1\\"" /f`,
      );
    }
    lines.push('');
  }

  lines.push('echo Done. Right-click any folder/file to see the ContextHelper submenu.', 'endlocal', '');
  return lines.join('\r\n');
}

function generateUnregisterBat(byExt) {
  const lines = [
    '@echo off',
    'REM Auto-generated. Removes all ContextHelper HKCU registrations.',
    '',
    'reg delete "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /f',
    'reg delete "HKCU\\Software\\Classes\\Directory\\ContextHelperSub" /f',
  ];
  for (const ext of Object.keys(byExt)) {
    lines.push(
      `reg delete "HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\ContextHelper" /f`,
      `reg delete "HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\ContextHelperSub_${ext.slice(1)}" /f`,
    );
  }
  lines.push('echo Done.', '');
  return lines.join('\r\n');
}

function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--exe='));
  const exePath = targetArg
    ? targetArg.slice('--exe='.length)
    : '%~dp0ContextHelper.exe'; // default: same folder as the .bat

  const manifests = loadManifests();
  const byExt = {};
  for (const m of manifests) {
    for (const pat of m.accepts) {
      if (!pat.startsWith('files:')) continue;
      for (const e of pat.slice('files:'.length).split(',')) byExt[e.trim().toLowerCase()] = true;
    }
  }

  const registerBat = generateRegisterBat(manifests, exePath);
  const unregisterBat = generateUnregisterBat(byExt);

  fs.writeFileSync(path.join(outDir, 'register.bat'), registerBat);
  fs.writeFileSync(path.join(outDir, 'unregister.bat'), unregisterBat);
  console.log('Wrote register.bat and unregister.bat (exe path:', exePath + ')');
}

main();
```

- [ ] **Step 5: Generate the .bats for dev mode**

Run: `npm run gen-register`
Expected: prints "Wrote register.bat and unregister.bat (exe path: %~dp0ContextHelper.exe)". Two .bat files appear in project root.

- [ ] **Step 6: Copy the generated .bats into the portable build**

```
copy register.bat dist\win-unpacked\register.bat
copy unregister.bat dist\win-unpacked\unregister.bat
```

The default `%~dp0ContextHelper.exe` will correctly resolve to the portable .exe location.

- [ ] **Step 7: Manual end-to-end test in Explorer**

1. Open `dist\win-unpacked\` in Explorer.
2. Double-click `register.bat`. A console flashes with "Done."
3. Create a test folder somewhere (`C:\Temp\flatten-test\a\b\c\file.txt`).
4. Right-click `flatten-test` folder. On Win11 click "Show more options". Confirm the `ContextHelper` submenu appears with `Сделать папку плоской`.
5. Click it. Window opens. Click Старт. Confirm summary "✓ Обработано: 1".
6. Verify `file.txt` is now in root of `flatten-test`.
7. Double-click `unregister.bat`. Confirm "Done."
8. Right-click any folder — ContextHelper no longer in menu.

- [ ] **Step 8: Commit**

```
git add electron-builder.yml scripts/gen-register-bat.js register.bat unregister.bat
git commit -m "feat: portable build (electron-builder dir) + register/unregister bat generator"
```

---

## Task 15: Documentation (README + CLAUDE.md TL;DR)

Minimal docs that let a returning agent (or human) get oriented in under a minute.

**Files:**
- Create: `README.md`
- Create: `CLAUDE.md`

- [ ] **Step 1: Write README.md**

`README.md`:
```markdown
# ContextHelper

Windows utility that adds a plugin-driven `ContextHelper` submenu to the Explorer right-click menu. Per-user (`HKCU`), no admin required, no installer — just unzip and run `register.bat`.

> **Status:** Plan 1 complete. One plugin (`flatten-folder`) implemented end-to-end. See `docs/superpowers/specs/2026-05-12-contexthelper-design.md` for the full design.

## Quick start (developer)

```
npm install
npm test                          # unit tests
npm run smoke                     # programmatic plugin smoke
npm start -- --action=flatten-folder --target="C:\path\to\some\folder"
```

## Build portable + register in Explorer

```
npm run package                   # produces dist/win-unpacked/
npm run gen-register              # generates register.bat / unregister.bat
copy register.bat dist\win-unpacked\
copy unregister.bat dist\win-unpacked\
```

Then in Explorer: double-click `dist\win-unpacked\register.bat`. The submenu appears on right-click. Run `unregister.bat` to remove.

## Plugins implemented so far

- `flatten-folder` — move all nested files into the root of a folder, with collision-safe renaming.
```

- [ ] **Step 2: Write CLAUDE.md**

`CLAUDE.md`:
```markdown
# ContextHelper — Agent orientation

## TL;DR

Electron app for a plugin-driven Explorer right-click submenu on Windows. Spec is the source of truth: `docs/superpowers/specs/2026-05-12-contexthelper-design.md`. Plans live in `docs/superpowers/plans/`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest unit tests. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run smoke` | Run all plugins programmatically against synthetic fixtures. `--plugin=<id>` filters. |
| `npm start -- --action=<id> --target="<path>"` | Launch the app in dev mode for one plugin. |
| `npm run package` | electron-builder `dir` target → `dist/win-unpacked/`. |
| `npm run gen-register` | Generate `register.bat` / `unregister.bat` from plugin manifests. |

## Architecture cheat sheet

- **Main process** (`src/main/index.js`) → parses CLI, loads plugin registry, opens a window via `window-manager.js`, forks a worker child process via `worker-runner.js`.
- **Worker shim** (`src/worker/worker-shim.js`) loads the plugin's `worker.js` in a forked Node child. Plugin export shape: `async function run({ targets, options, onProgress, signal }) → { ok, processed, skipped, errors }`.
- **Renderer** (`src/renderer/`) is a single HTML shell. Plugin `ui.html` is injected into `#options-slot`. Form values become the worker's `options` object.
- **IPC channels** declared in `src/shared/plugin-api.js`. Renderer talks only through the preload bridge (`src/preload/plugin-preload.js`).
- **Named pipe aggregator** (`src/main/named-pipe.js`) exists and is unit-tested but not wired in yet. Plan 3 turns it on for the first `maxSelection > 1` plugin.

## Adding a new plugin

1. `mkdir plugins/<id>`
2. Create `manifest.json` (required fields: `id`, `label`, `description`, `accepts`, `minSelection`, `maxSelection`).
3. Create `ui.html` (optional form; values keyed by `name` attribute become `options`).
4. Create `worker.js` exporting the standard async run signature.
5. Add a unit test under `tests/unit/<id>.test.js`.
6. Add a smoke case to `tests/smoke/runner.js`.
7. Run `npm run gen-register` to refresh the .bat files.

## Conventions

- CommonJS (`require` / `module.exports`).
- 2-space indent, LF line endings, UTF-8.
- TDD for pure logic; manual verification for UI.
- One commit per task in plans, conventional-commits messages.
- Russian UI strings are hardcoded; no i18n abstraction in v1.

## PR checklist

- [ ] `npm test` green
- [ ] `npm run smoke` green
- [ ] If you changed manifests, regenerate `register.bat` and `unregister.bat`.
```

- [ ] **Step 3: Commit**

```
git add README.md CLAUDE.md
git commit -m "docs: add README and CLAUDE.md agent orientation"
```

---

## Verification

After Task 15, the following should all be true:

1. `npm test` → all unit tests pass (collision, long-path, cli, plugin-registry, named-pipe, worker-runner, flatten-folder).
2. `npm run smoke` → `flatten-folder` case passes.
3. `npm start -- --action=flatten-folder --target="<temp folder>"` opens a window, flattens the folder on Старт, shows correct summary.
4. `npm run package && npm run gen-register && copy register.bat dist\win-unpacked\` produces a working portable.
5. Double-clicking `register.bat` enables the right-click submenu; double-clicking `unregister.bat` removes it.
6. Logs at `%LOCALAPPDATA%\ContextHelper\logs\YYYY-MM-DD.log` show `plugin:start` and `plugin:complete` entries.

## What this plan deliberately does NOT do

- No additional plugins. Plan 3 adds the other ten.
- No NSIS installer. Portable build is enough until Plan 2 (if ever needed).
- No `--register` / `--unregister` CLI verbs inside the .exe. The .bat files do the registry writes directly — simpler and easier to inspect.
- No multi-target aggregation in the runtime path. The named-pipe module exists and is tested, but `index.js` always launches a single-target window. Plan 3 wires it in.
- No external binaries bundled. The `resources/bin/` folder doesn't exist yet. Plan 3 will add ffmpeg / magick / gswin64c / 7z as the plugins that need them are added.
- No CI. Manual `npm test && npm run smoke` is the gate.
