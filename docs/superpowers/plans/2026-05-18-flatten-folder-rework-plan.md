# ContextHelper — Plan: flatten-folder rework (dialog-driven)

> **Status:** ✅ Implementation complete (2026-05-18). Tasks 1–12 executed via subagent-driven-development; 81/81 unit tests pass, smoke green. 14 commits from `f9187db` to `c9d81b2`. Task 13 (manual Explorer verification, 6-case matrix) is pending the user — production wiring is in place, but the in-Explorer flow has not yet been exercised.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the `flatten-folder` plugin from a window-based form to a dialog-driven flow (native confirm + indeterminate spinner + silent success). Extend the plugin contract with a new `ui: "dialog"` mode and a separate `preflight()` export so future plugins can opt in to the same flow.

**Architecture:** Plugins gain an optional `manifest.ui` field (`"window"` default, `"dialog"` new). Dialog plugins export `{ preflight, run }` instead of a bare `run` function. A new `src/main/dialog-flow.js` orchestrates: type-check selection → fork worker for `preflight()` → show native confirm with bullet list + summary → open frameless spinner window → fork worker for `run()` → close spinner → either silent exit or `dialog.showErrorBox` with per-file errors.

**Tech Stack:** Node 20+, Electron 33, Vitest 2 (globals mode), CommonJS, pure-Node `child_process.fork` for workers.

**Reference spec:** `docs/superpowers/specs/2026-05-18-flatten-folder-rework-design.md`. When this plan and the spec disagree, the spec wins — but flag the discrepancy.

---

## File map

```
ContextHelper/
├── plugins/flatten-folder/
│   ├── manifest.json                    # MODIFY: + "ui":"dialog", maxSelection 999
│   ├── worker.js                        # MODIFY: extract walkAndPlan, export { preflight, run }
│   └── ui.html                          # DELETE
├── src/
│   ├── shared/plugin-api.js             # MODIFY: + PREFLIGHT IPC + WORKER_MSG.PREFLIGHT_*
│   ├── worker/worker-shim.js            # MODIFY: handle object exports + preflight message
│   ├── main/
│   │   ├── plugin-registry.js           # MODIFY: validate "ui" field, default to "window"
│   │   ├── worker-runner.js             # MODIFY: + runPreflight()
│   │   ├── window-manager.js            # MODIFY: + createSpinnerWindow()
│   │   ├── dialog-flow.js               # NEW: dialog-plugin orchestrator
│   │   └── index.js                     # MODIFY: dispatch on manifest.ui
│   └── renderer/
│       ├── spinner.html                 # NEW
│       └── spinner.css                  # NEW
├── tests/unit/
│   ├── flatten-folder.test.js           # MODIFY: drop encodePathInName tests, add preflight
│   ├── plugin-registry.test.js          # MODIFY: + "ui" field cases
│   ├── worker-shim.test.js              # NEW
│   ├── worker-runner.test.js            # MODIFY: + runPreflight roundtrip
│   └── dialog-flow.test.js              # NEW
└── tests/smoke/runner.js                # MODIFY: call preflight + run, adapt export shape
```

---

## Task 1: Refactor flatten-folder — extract `walkAndPlan`, drop `encodePathInName`

**Files:**
- Modify: `plugins/flatten-folder/worker.js`
- Modify: `tests/unit/flatten-folder.test.js`

This task preserves the existing single-export shape (`module.exports = run`) so Plan 1's runtime keeps working. We split internals into testable pieces and remove the `encodePathInName` option entirely. The export shape change to `{ preflight, run }` happens in Task 2.

- [ ] **Step 1: Update test — drop the `encodePathInName` test**

Delete this test block from `tests/unit/flatten-folder.test.js` (currently lines 66-73):

```js
  it('encodePathInName uses subfolder__filename instead of (N)', async () => {
    tree(tmp, {
      'a/photo.jpg': 'A',
      'b/photo.jpg': 'B',
    });
    await run({ targets: [tmp], options: { encodePathInName: true }, onProgress: () => {} });
    expect(listFiles(tmp).sort()).toEqual(['a__photo.jpg', 'b__photo.jpg']);
  });
```

- [ ] **Step 2: Run tests, confirm everything else still passes**

```
npm test -- tests/unit/flatten-folder.test.js
```

Expected: 6 tests pass (was 7).

- [ ] **Step 3: Rewrite `plugins/flatten-folder/worker.js`**

Replace the entire file with:

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
  for (const dir of stack) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // best-effort
    }
  }
}

// Pure planner: walks `root`, returns the list of files that need to move
// (i.e. live in a subfolder of root) plus the set of names already present
// in the root. Used by both preflight (for counting) and run (for execution).
function walkAndPlan(root) {
  const all = walkFiles(root);
  const toMove = all.filter((f) => path.dirname(f) !== root);
  const takenInRoot = new Set(
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
  );
  return { toMove, takenInRoot };
}

// Count how many of `toMove`'s basenames would collide with `takenInRoot`
// or with each other if we tried to place them in `root` without renaming.
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

async function run({ targets, options = {}, onProgress = () => {}, signal }) {
  const root = targets[0];
  const { toMove, takenInRoot } = walkAndPlan(root);
  const taken = new Set(takenInRoot);
  const total = toMove.length;
  const errors = [];
  let processed = 0;
  let skipped = 0;

  for (const src of toMove) {
    if (signal?.aborted) {
      return { ok: false, processed, skipped, errors, aborted: true };
    }
    const baseName = path.basename(src);
    const target = resolveCollision(baseName, taken);
    try {
      fs.renameSync(src, path.join(root, target));
      taken.add(target);
      processed++;
      onProgress({ processed, total, current: target });
    } catch (err) {
      errors.push({ file: path.relative(root, src), message: err.message });
      skipped++;
    }
  }

  pruneEmptyDirs(root);

  return { ok: errors.length === 0, processed, skipped, errors };
}

module.exports = run;
module.exports.walkAndPlan = walkAndPlan;
module.exports.countCollisions = countCollisions;
```

Note: `module.exports = run` plus attached `walkAndPlan`/`countCollisions` so existing imports (`const run = require(...)`) and the smoke test still work. We change to a plain object in Task 2.

- [ ] **Step 4: Run tests, confirm all 6 still pass**

```
npm test -- tests/unit/flatten-folder.test.js
```

Expected: 6 tests pass. The collision and prune behaviours must still be intact.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass (was 53 before, should be 52 now since we removed one).

- [ ] **Step 6: Commit**

```
git add ContextHelper/plugins/flatten-folder/worker.js ContextHelper/tests/unit/flatten-folder.test.js
git commit -m "$(cat <<'EOF'
refactor(flatten-folder): extract walkAndPlan, drop encodePathInName

Splits the worker into reusable pure helpers (walkAndPlan, countCollisions)
that the upcoming preflight() export will reuse. The encodePathInName option
is removed entirely — collisions always resolve with (N) suffix per the
2026-05-18-flatten-folder-rework spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Change flatten-folder export to `{ preflight, run }`

**Files:**
- Modify: `plugins/flatten-folder/worker.js`
- Modify: `tests/unit/flatten-folder.test.js`

- [ ] **Step 1: Add failing preflight tests**

Append to `tests/unit/flatten-folder.test.js` (inside the same `describe` block):

```js
  it('preflight counts files and collisions for a single folder', async () => {
    tree(tmp, {
      'a/x.txt': '1',
      'a/y.txt': '2',
      'b/x.txt': '3',   // collides with a/x.txt
      'c/z.txt': '4',
    });
    const { preflight } = require('../../plugins/flatten-folder/worker');
    const result = await preflight({ targets: [tmp] });
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({
      basename: path.basename(tmp),
      fileCount: 4,
      collisionCount: 1,
    });
    expect(result.totalFiles).toBe(4);
    expect(result.totalCollisions).toBe(1);
  });

  it('preflight aggregates across multiple folders', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-b-'));
    try {
      tree(tmp, { 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
      tree(tmp2, { 'sub/c.txt': 'c' });
      const { preflight } = require('../../plugins/flatten-folder/worker');
      const result = await preflight({ targets: [tmp, tmp2] });
      expect(result.folders).toHaveLength(2);
      expect(result.totalFiles).toBe(3);
      expect(result.totalCollisions).toBe(0);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('preflight returns totalFiles: 0 for an already-flat folder', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const { preflight } = require('../../plugins/flatten-folder/worker');
    const result = await preflight({ targets: [tmp] });
    expect(result.totalFiles).toBe(0);
    expect(result.totalCollisions).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(tmp, { 'a/x.txt': 'X', 'a/b/y.txt': 'Y' });
    const beforeA = fs.statSync(path.join(tmp, 'a', 'x.txt'));
    const beforeY = fs.statSync(path.join(tmp, 'a', 'b', 'y.txt'));
    const { preflight } = require('../../plugins/flatten-folder/worker');
    await preflight({ targets: [tmp] });
    expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(beforeA.mtimeMs);
    expect(fs.statSync(path.join(tmp, 'a', 'b', 'y.txt')).mtimeMs).toBe(beforeY.mtimeMs);
    expect(fs.existsSync(path.join(tmp, 'a', 'b'))).toBe(true);
  });
```

Also change the top-level require so both forms work during the transition. Replace the `const run = require(...)` line at the top of the test file with:

```js
const flatten = require('../../plugins/flatten-folder/worker');
const run = typeof flatten === 'function' ? flatten : flatten.run;
```

- [ ] **Step 2: Run tests, see the new ones fail**

```
npm test -- tests/unit/flatten-folder.test.js
```

Expected: 4 new tests FAIL with `preflight is not a function`. The 6 existing tests still PASS.

- [ ] **Step 3: Change export to object shape**

At the bottom of `plugins/flatten-folder/worker.js`, replace:

```js
module.exports = run;
module.exports.walkAndPlan = walkAndPlan;
module.exports.countCollisions = countCollisions;
```

with:

```js
async function preflight({ targets }) {
  const folders = [];
  let totalFiles = 0;
  let totalCollisions = 0;
  for (const root of targets) {
    const { toMove, takenInRoot } = walkAndPlan(root);
    const collisionCount = countCollisions(toMove, takenInRoot);
    folders.push({
      basename: path.basename(root),
      fileCount: toMove.length,
      collisionCount,
    });
    totalFiles += toMove.length;
    totalCollisions += collisionCount;
  }
  return { folders, totalFiles, totalCollisions };
}

module.exports = { preflight, run };
```

- [ ] **Step 4: Run tests, all 10 should pass**

```
npm test -- tests/unit/flatten-folder.test.js
```

Expected: 10 tests pass.

- [ ] **Step 5: Run smoke (still expects old function-export; it will FAIL — that is the trigger for Task 11)**

```
npm run smoke
```

Expected: FAIL with `flattenRun is not a function`. This is expected — Task 11 fixes the smoke runner. Note the failure in your scratch notes and move on.

- [ ] **Step 6: Commit**

```
git add ContextHelper/plugins/flatten-folder/worker.js ContextHelper/tests/unit/flatten-folder.test.js
git commit -m "$(cat <<'EOF'
feat(flatten-folder): export { preflight, run } object

Adds the preflight() function that scans selected folders and returns
file/collision counts without touching the filesystem. The smoke runner
will be updated in a later task to handle the new export shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update flatten-folder manifest

**Files:**
- Modify: `plugins/flatten-folder/manifest.json`

- [ ] **Step 1: Replace `plugins/flatten-folder/manifest.json`**

```json
{
  "id": "flatten-folder",
  "label": "Flatten folder",
  "description": "Move all nested files into the root of each selected folder",
  "icon": "icon.png",
  "accepts": ["folders"],
  "minSelection": 1,
  "maxSelection": 999,
  "ui": "dialog"
}
```

Three changes: `"accepts": ["folder"]` → `["folders"]` (per the matcher logic in `plugin-registry.js`, `"folders"` matches `count >= 1`), `"maxSelection": 1` → `999`, and a new `"ui": "dialog"` field.

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: all tests still pass. The manifest validator in `plugin-registry.js` currently does not validate `ui`, so an unknown field is accepted.

- [ ] **Step 3: Commit**

```
git add ContextHelper/plugins/flatten-folder/manifest.json
git commit -m "$(cat <<'EOF'
feat(flatten-folder): manifest opts into ui:dialog + multi-folder selection

accepts: ["folder"] → ["folders"] enables 1..N folder selections (the
named-pipe aggregator already collects them). maxSelection bumped from 1
to 999 — practical cap that guards against accidental select-all in a
huge directory. ui:"dialog" is the new field that the dispatcher will
branch on in a later task; currently a no-op.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Validate `ui` field in plugin-registry

**Files:**
- Modify: `src/main/plugin-registry.js`
- Modify: `tests/unit/plugin-registry.test.js`

- [ ] **Step 1: Add failing validation tests**

Append to `tests/unit/plugin-registry.test.js` (inside the second `describe('loadPluginRegistry — error messages', ...)` block):

```js
  it('accepts ui:"dialog" plugin', () => {
    mkPluginDir(tmp, 'dialog-plugin', {
      id: 'dialog-plugin', label: 'L', description: 'D',
      accepts: ['folder'], minSelection: 1, maxSelection: 1, ui: 'dialog',
    });
    const reg = loadPluginRegistry(tmp);
    expect(reg.get('dialog-plugin').ui).toBe('dialog');
  });

  it('accepts ui:"window" plugin explicitly', () => {
    mkPluginDir(tmp, 'win-plugin', {
      id: 'win-plugin', label: 'L', description: 'D',
      accepts: ['folder'], minSelection: 1, maxSelection: 1, ui: 'window',
    });
    const reg = loadPluginRegistry(tmp);
    expect(reg.get('win-plugin').ui).toBe('window');
  });

  it('defaults missing ui to "window"', () => {
    mkPluginDir(tmp, 'default-ui', {
      id: 'default-ui', label: 'L', description: 'D',
      accepts: ['folder'], minSelection: 1, maxSelection: 1,
    });
    const reg = loadPluginRegistry(tmp);
    expect(reg.get('default-ui').ui).toBe('window');
  });

  it('rejects invalid ui value', () => {
    mkPluginDir(tmp, 'bad-ui', {
      id: 'bad-ui', label: 'L', description: 'D',
      accepts: ['folder'], minSelection: 1, maxSelection: 1, ui: 'invalid',
    });
    expect(() => loadPluginRegistry(tmp)).toThrow(/"ui" must be "window" or "dialog"/);
  });
```

- [ ] **Step 2: Run tests, see them fail**

```
npm test -- tests/unit/plugin-registry.test.js
```

Expected: the four new tests FAIL (default-ui returns `undefined`, bad-ui does not throw).

- [ ] **Step 3: Update validator + loader in `src/main/plugin-registry.js`**

Add validation lines at the end of `validateManifest()` (just before its closing brace):

```js
  if (manifest.ui !== undefined && manifest.ui !== 'window' && manifest.ui !== 'dialog') {
    throw new Error(`Plugin "${folderName}": "ui" must be "window" or "dialog" (got ${JSON.stringify(manifest.ui)})`);
  }
```

In `loadPluginRegistry()`, change the registry.set call so the entry has a normalized `ui` default. Replace:

```js
    registry.set(manifest.id, {
      ...manifest,
      dir: path.join(pluginsDir, entry.name),
    });
```

with:

```js
    registry.set(manifest.id, {
      ...manifest,
      ui: manifest.ui || 'window',
      dir: path.join(pluginsDir, entry.name),
    });
```

- [ ] **Step 4: Run tests, all should pass**

```
npm test -- tests/unit/plugin-registry.test.js
```

Expected: all tests in this file pass (including the four new ones).

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all unit tests pass.

- [ ] **Step 6: Commit**

```
git add ContextHelper/src/main/plugin-registry.js ContextHelper/tests/unit/plugin-registry.test.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): validate optional manifest.ui field

Adds optional "ui" field: "window" (default) or "dialog". Invalid values
throw at manifest-load time. Registry entries are normalized so consumers
always see manifest.ui defined.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add preflight IPC constants

**Files:**
- Modify: `src/shared/plugin-api.js`

- [ ] **Step 1: Replace `src/shared/plugin-api.js`**

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
    PREFLIGHT_COMPLETE: 'worker:preflight-complete',
    PREFLIGHT_ERROR: 'worker:preflight-error',
  },
};
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: all tests pass (only constants added; nothing references them yet).

- [ ] **Step 3: Commit**

```
git add ContextHelper/src/shared/plugin-api.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): add preflight WORKER_MSG constants

PREFLIGHT_COMPLETE / PREFLIGHT_ERROR are used by the worker-shim and
worker-runner to round-trip a non-mutating preflight() call separately
from the run() lifecycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend worker-shim to handle preflight + object exports

**Files:**
- Modify: `src/worker/worker-shim.js`
- Create: `tests/unit/worker-shim.test.js`

- [ ] **Step 1: Create a failing test file `tests/unit/worker-shim.test.js`**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const SHIM = path.resolve(__dirname, '..', '..', 'src', 'worker', 'worker-shim.js');

function runShim(workerPath, message) {
  return new Promise((resolve, reject) => {
    const child = fork(SHIM, [], { silent: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages = [];
    child.on('message', (m) => messages.push(m));
    child.on('exit', (code) => resolve({ code, messages }));
    child.on('error', reject);
    child.send(message);
  });
}

describe('worker-shim', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shim-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes a "start" message to a function-export plugin (legacy)', async () => {
    const workerPath = path.join(tmp, 'worker.js');
    fs.writeFileSync(workerPath, `
      module.exports = async function({ targets }) {
        return { ok: true, processed: targets.length, skipped: 0, errors: [] };
      };
    `);
    const { code, messages } = await runShim(workerPath, {
      type: 'start', workerPath, targets: ['a', 'b'], options: {},
    });
    expect(code).toBe(0);
    const complete = messages.find((m) => m.kind === 'worker:complete');
    expect(complete?.payload).toEqual({ ok: true, processed: 2, skipped: 0, errors: [] });
  });

  it('routes a "start" message to an object-export plugin', async () => {
    const workerPath = path.join(tmp, 'worker.js');
    fs.writeFileSync(workerPath, `
      module.exports = {
        async preflight({ targets }) { return { folders: [], totalFiles: 0, totalCollisions: 0 }; },
        async run({ targets }) {
          return { ok: true, processed: 1, skipped: 0, errors: [] };
        },
      };
    `);
    const { code, messages } = await runShim(workerPath, {
      type: 'start', workerPath, targets: ['x'], options: {},
    });
    expect(code).toBe(0);
    const complete = messages.find((m) => m.kind === 'worker:complete');
    expect(complete?.payload).toMatchObject({ ok: true, processed: 1 });
  });

  it('routes a "preflight" message to plugin.preflight()', async () => {
    const workerPath = path.join(tmp, 'worker.js');
    fs.writeFileSync(workerPath, `
      module.exports = {
        async preflight({ targets }) {
          return { folders: [{ basename: 'X', fileCount: 5, collisionCount: 1 }], totalFiles: 5, totalCollisions: 1 };
        },
        async run() { throw new Error('run should not be called'); },
      };
    `);
    const { code, messages } = await runShim(workerPath, {
      type: 'preflight', workerPath, targets: ['x'],
    });
    expect(code).toBe(0);
    const result = messages.find((m) => m.kind === 'worker:preflight-complete');
    expect(result?.payload).toEqual({
      folders: [{ basename: 'X', fileCount: 5, collisionCount: 1 }],
      totalFiles: 5,
      totalCollisions: 1,
    });
  });

  it('reports preflight-error when preflight throws', async () => {
    const workerPath = path.join(tmp, 'worker.js');
    fs.writeFileSync(workerPath, `
      module.exports = {
        async preflight() { throw new Error('preflight-boom'); },
        async run() { return { ok: true, processed: 0, skipped: 0, errors: [] }; },
      };
    `);
    const { messages } = await runShim(workerPath, {
      type: 'preflight', workerPath, targets: ['x'],
    });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toBe('preflight-boom');
  });

  it('reports preflight-error when plugin is function-only', async () => {
    const workerPath = path.join(tmp, 'worker.js');
    fs.writeFileSync(workerPath, `module.exports = async function() { return { ok: true }; };`);
    const { messages } = await runShim(workerPath, {
      type: 'preflight', workerPath, targets: ['x'],
    });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toMatch(/does not export preflight/i);
  });
});
```

- [ ] **Step 2: Run the new test file, see it fail**

```
npm test -- tests/unit/worker-shim.test.js
```

Expected: 5 tests, all FAIL (current shim ignores `type: 'preflight'`, hangs until the fork is killed). Expect a timeout — that is fine; ctrl-C and proceed.

If a timeout actually hangs the test runner, add to each test a Vitest `{ timeout: 5000 }` option (5th arg to `it`).

- [ ] **Step 3: Replace `src/worker/worker-shim.js`**

```js
// Forked entry. Receives one IPC message of either:
//   { type: 'start',     workerPath, targets, options }  → calls plugin.run()
//   { type: 'preflight', workerPath, targets }            → calls plugin.preflight()
//   { type: 'cancel' }                                    → flips signal.aborted
//
// Plugin module shapes supported:
//   - module.exports = async function run(...)          // legacy
//   - module.exports = { preflight, run }               // dialog plugins
const { WORKER_MSG } = require('../shared/plugin-api');

const cancelState = { aborted: false };
const signal = {
  get aborted() { return cancelState.aborted; },
};

function loadPlugin(workerPath) {
  const mod = require(workerPath);
  if (typeof mod === 'function') return { run: mod, preflight: null };
  if (mod && typeof mod === 'object' && typeof mod.run === 'function') {
    return { run: mod.run, preflight: typeof mod.preflight === 'function' ? mod.preflight : null };
  }
  throw new Error(`Plugin at ${workerPath} does not export a function or { run }`);
}

async function handleStart(msg) {
  const { workerPath, targets, options } = msg;
  const { run } = loadPlugin(workerPath);
  let reported = false;
  try {
    const result = await run({
      targets,
      options,
      onProgress: (p) => {
        try { process.send({ kind: WORKER_MSG.PROGRESS, payload: p }); } catch {}
      },
      signal,
    });
    try { process.send({ kind: WORKER_MSG.COMPLETE, payload: result }); reported = true; } catch {}
  } catch (err) {
    try {
      process.send({ kind: WORKER_MSG.ERROR, payload: { message: err.message, stack: err.stack } });
      reported = true;
    } catch {}
  } finally {
    process.exit(reported ? 0 : 1);
  }
}

async function handlePreflight(msg) {
  const { workerPath, targets } = msg;
  let reported = false;
  try {
    const { preflight } = loadPlugin(workerPath);
    if (!preflight) {
      throw new Error(`Plugin at ${workerPath} does not export preflight()`);
    }
    const result = await preflight({ targets, signal });
    try { process.send({ kind: WORKER_MSG.PREFLIGHT_COMPLETE, payload: result }); reported = true; } catch {}
  } catch (err) {
    try {
      process.send({ kind: WORKER_MSG.PREFLIGHT_ERROR, payload: { message: err.message, stack: err.stack } });
      reported = true;
    } catch {}
  } finally {
    process.exit(reported ? 0 : 1);
  }
}

process.on('message', (msg) => {
  if (msg.type === 'cancel') { cancelState.aborted = true; return; }
  if (msg.type === 'start') return void handleStart(msg);
  if (msg.type === 'preflight') return void handlePreflight(msg);
});
```

- [ ] **Step 4: Run worker-shim tests, all should pass**

```
npm test -- tests/unit/worker-shim.test.js
```

Expected: 5 tests pass.

- [ ] **Step 5: Run existing worker-runner tests to confirm legacy `start` path still works**

```
npm test -- tests/unit/worker-runner.test.js
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git add ContextHelper/src/worker/worker-shim.js ContextHelper/tests/unit/worker-shim.test.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): worker-shim handles preflight + object-export plugins

Adds a "preflight" message type that calls plugin.preflight() and emits
PREFLIGHT_COMPLETE / PREFLIGHT_ERROR. Loader now accepts both function-export
(legacy) and object-export ({ preflight, run }) module shapes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `runPreflight()` to worker-runner

**Files:**
- Modify: `src/main/worker-runner.js`
- Modify: `tests/unit/worker-runner.test.js`

- [ ] **Step 1: Add failing tests at the bottom of `tests/unit/worker-runner.test.js`** (still inside the `describe('runWorker', ...)` block):

```js
  it('runPreflight resolves with plugin.preflight result', async () => {
    const { runPreflight } = require('../../src/main/worker-runner');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-preflight-'));
    const stubPath = path.join(tmp, 'stub.js');
    fs.writeFileSync(
      stubPath,
      `module.exports = {
         async preflight({ targets }) {
           return { folders: targets.map(t => ({ basename: t, fileCount: 1, collisionCount: 0 })), totalFiles: targets.length, totalCollisions: 0 };
         },
         async run() { throw new Error('should not run'); },
       };`,
    );
    const result = await runPreflight({ workerPath: stubPath, targets: ['a', 'b'] });
    expect(result.totalFiles).toBe(2);
    expect(result.folders).toHaveLength(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runPreflight rejects when preflight throws', async () => {
    const { runPreflight } = require('../../src/main/worker-runner');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-preflight-err-'));
    const stubPath = path.join(tmp, 'stub.js');
    fs.writeFileSync(
      stubPath,
      `module.exports = { async preflight() { throw new Error('nope'); }, async run() {} };`,
    );
    await expect(runPreflight({ workerPath: stubPath, targets: ['a'] })).rejects.toThrow('nope');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run, see them fail**

```
npm test -- tests/unit/worker-runner.test.js
```

Expected: 2 new tests FAIL (`runPreflight is not a function`).

- [ ] **Step 3: Replace `src/main/worker-runner.js`**

```js
const path = require('node:path');
const { fork } = require('node:child_process');
const { WORKER_MSG } = require('../shared/plugin-api');

const SHIM = path.join(__dirname, '..', 'worker', 'worker-shim.js');

function runWorker({ workerPath, targets, options, onProgress, onComplete, onError }) {
  const child = fork(SHIM, [], { silent: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

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

function runPreflight({ workerPath, targets }) {
  return new Promise((resolve, reject) => {
    const child = fork(SHIM, [], { silent: false, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    child.on('message', (msg) => {
      if (msg.kind === WORKER_MSG.PREFLIGHT_COMPLETE) settle(resolve, msg.payload);
      else if (msg.kind === WORKER_MSG.PREFLIGHT_ERROR) {
        settle(reject, new Error(msg.payload?.message || 'preflight failed'));
      }
    });
    child.on('exit', (code) => {
      if (!settled && code !== 0) settle(reject, new Error(`Preflight worker exited with code ${code}`));
      else if (!settled) settle(reject, new Error('Preflight worker exited without result'));
    });
    child.on('error', (err) => settle(reject, err));

    child.send({ type: 'preflight', workerPath, targets });
  });
}

module.exports = { runWorker, runPreflight };
```

- [ ] **Step 4: Run, all 5 should pass**

```
npm test -- tests/unit/worker-runner.test.js
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```
git add ContextHelper/src/main/worker-runner.js ContextHelper/tests/unit/worker-runner.test.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): worker-runner exposes runPreflight()

Promise-returning helper that forks the worker-shim with a "preflight"
message and awaits PREFLIGHT_COMPLETE / PREFLIGHT_ERROR. Used by the
upcoming dialog-flow orchestrator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Spinner window assets + `createSpinnerWindow`

**Files:**
- Create: `src/renderer/spinner.html`
- Create: `src/renderer/spinner.css`
- Modify: `src/main/window-manager.js`

No unit test for this — Electron `BrowserWindow` is hard to test headlessly and the value is in the visual output. Manual verification in Task 13.

- [ ] **Step 1: Create `src/renderer/spinner.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Working…</title>
  <link rel="stylesheet" href="./spinner.css" />
</head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <div class="label" id="label">Working…</div>
  </div>
  <script>
    // Allow main to pass a label via ?label= for future plugins.
    const params = new URLSearchParams(window.location.search);
    const label = params.get('label');
    if (label) document.getElementById('label').textContent = label;
  </script>
</body>
</html>
```

- [ ] **Step 2: Create `src/renderer/spinner.css`**

```css
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: "Segoe UI", system-ui, sans-serif;
  background: #fff;
  color: #222;
  user-select: none;
}
.wrap {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 18px;
  height: 100%;
  padding: 0 20px;
  box-sizing: border-box;
}
.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid #d0d0d0;
  border-top-color: #1971c2;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
  flex: 0 0 auto;
}
.label {
  font-size: 14px;
  letter-spacing: 0.1px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 3: Add `createSpinnerWindow` to `src/main/window-manager.js`**

At the bottom of the file, before `module.exports`, add:

```js
function createSpinnerWindow({ label = 'Working…' } = {}) {
  const win = new BrowserWindow({
    width: 320,
    height: 100,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  const file = path.join(__dirname, '..', 'renderer', 'spinner.html');
  const url = `file://${file.replace(/\\/g, '/')}?label=${encodeURIComponent(label)}`;
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  return win;
}
```

Replace the existing `module.exports = { openPluginWindow };` with:

```js
module.exports = { openPluginWindow, createSpinnerWindow };
```

- [ ] **Step 4: Run tests (sanity)**

```
npm test
```

Expected: all tests pass; nothing in `npm test` exercises the spinner.

- [ ] **Step 5: Commit**

```
git add ContextHelper/src/renderer/spinner.html ContextHelper/src/renderer/spinner.css ContextHelper/src/main/window-manager.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): frameless spinner window for dialog plugins

Adds a 320x100 always-on-top frameless BrowserWindow with a CSS spinner
and a "Working…" label, intended for the indeterminate phase of dialog
plugins (no Cancel button by design — see flatten-folder-rework spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Implement `dialog-flow.js` with unit tests

**Files:**
- Create: `src/main/dialog-flow.js`
- Create: `tests/unit/dialog-flow.test.js`

The orchestrator is intentionally pure (no Electron imports). All side-effect dependencies are injected: `dialog` (`showMessageBox`, `showErrorBox`), `fs` (`statSync`), `runPreflight`, `runWorker`, `openSpinner` (returns `{ close() }`), and `logger`.

- [ ] **Step 1: Create `tests/unit/dialog-flow.test.js`**

```js
const path = require('node:path');
const { runDialogPlugin } = require('../../src/main/dialog-flow');

function makeDialogMock(confirmResponse = 0) {
  const calls = [];
  return {
    calls,
    showMessageBox: async (opts) => {
      calls.push({ kind: 'msg', opts });
      return { response: opts.type === 'question' ? confirmResponse : 0 };
    },
    showErrorBox: (title, body) => {
      calls.push({ kind: 'err', title, body });
    },
  };
}

function makeFsMock(map) {
  return {
    statSync: (p) => {
      if (!(p in map)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      const kind = map[p];
      if (kind === 'enoent') {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
      };
    },
  };
}

const manifest = {
  id: 'flatten-folder',
  label: 'Flatten folder',
  accepts: ['folders'],
  ui: 'dialog',
  dir: '/fake/plugins/flatten-folder',
};

describe('runDialogPlugin', () => {
  it('rejects non-folder selection with error dialog (exit 2)', async () => {
    const dlg = makeDialogMock();
    const fsx = makeFsMock({ '/a': 'dir', '/b.txt': 'file' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a', '/b.txt'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => { throw new Error('should not call'); },
      runWorker: () => { throw new Error('should not call'); },
      openSpinner: () => { throw new Error('should not call'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(2);
    expect(dlg.calls).toHaveLength(1);
    expect(dlg.calls[0].kind).toBe('err');
    expect(dlg.calls[0].body).toMatch(/works only with folders/);
    expect(dlg.calls[0].body).toMatch(/b\.txt/);
  });

  it('rejects missing path the same way', async () => {
    const dlg = makeDialogMock();
    const fsx = makeFsMock({ '/a': 'dir', '/gone': 'enoent' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a', '/gone'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({ folders: [], totalFiles: 0, totalCollisions: 0 }),
      runWorker: () => {},
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(2);
    expect(dlg.calls[0].kind).toBe('err');
  });

  it('shows info dialog and exits 0 when nothing to do', async () => {
    const dlg = makeDialogMock();
    const fsx = makeFsMock({ '/a': 'dir' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({
        folders: [{ basename: 'a', fileCount: 0, collisionCount: 0 }],
        totalFiles: 0,
        totalCollisions: 0,
      }),
      runWorker: () => { throw new Error('should not run'); },
      openSpinner: () => { throw new Error('should not open spinner'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(dlg.calls.some((c) => c.kind === 'msg' && c.opts.type === 'info')).toBe(true);
  });

  it('exits 0 silently on user cancel', async () => {
    const dlg = makeDialogMock(1); // user clicks Cancel
    const fsx = makeFsMock({ '/a': 'dir' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({
        folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }],
        totalFiles: 3,
        totalCollisions: 0,
      }),
      runWorker: () => { throw new Error('should not run'); },
      openSpinner: () => { throw new Error('should not open spinner'); },
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });

  it('runs worker, closes spinner, exits 0 on full success', async () => {
    const dlg = makeDialogMock(0); // Continue
    const fsx = makeFsMock({ '/a': 'dir' });
    const spinnerClosed = { value: false };
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({
        folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }],
        totalFiles: 3,
        totalCollisions: 0,
      }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: true, processed: 3, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      openSpinner: () => ({ close() { spinnerClosed.value = true; } }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(spinnerClosed.value).toBe(true);
  });

  it('shows error dialog and exits 1 on partial errors', async () => {
    const dlg = makeDialogMock(0);
    const fsx = makeFsMock({ '/a': 'dir' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({
        folders: [{ basename: 'a', fileCount: 5, collisionCount: 0 }],
        totalFiles: 5,
        totalCollisions: 0,
      }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({
          ok: false, processed: 3, skipped: 2,
          errors: [{ file: 'a/x.txt', message: 'EACCES' }, { file: 'a/y.txt', message: 'EBUSY' }],
        }), 5);
        return { cancel() {} };
      },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(1);
    const err = dlg.calls.find((c) => c.kind === 'err');
    expect(err).toBeTruthy();
    expect(err.body).toMatch(/3 of 5 files moved/);
    expect(err.body).toMatch(/EACCES/);
  });

  it('exits 3 on preflight crash', async () => {
    const dlg = makeDialogMock();
    const fsx = makeFsMock({ '/a': 'dir' });
    const code = await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => { throw new Error('preflight crashed'); },
      runWorker: () => { throw new Error('should not call'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
    expect(dlg.calls.find((c) => c.kind === 'err').body).toMatch(/preflight crashed/);
  });

  it('truncates folder list at 10 entries with "and N more"', async () => {
    const dlg = makeDialogMock(1); // Cancel after seeing detail
    const fsx = makeFsMock(Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`/d${i}`, 'dir']),
    ));
    const folders = Array.from({ length: 15 }, (_, i) => ({ basename: `d${i}`, fileCount: 1, collisionCount: 0 }));
    await runDialogPlugin({
      manifest,
      targets: folders.map((_, i) => `/d${i}`),
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({ folders, totalFiles: 15, totalCollisions: 0 }),
      runWorker: () => { throw new Error('should not call'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    const confirm = dlg.calls.find((c) => c.kind === 'msg' && c.opts.type === 'question');
    expect(confirm.opts.detail).toMatch(/and 5 more/);
  });

  it('uses singular phrasing for a single folder', async () => {
    const dlg = makeDialogMock(1); // Cancel
    const fsx = makeFsMock({ '/a': 'dir' });
    await runDialogPlugin({
      manifest,
      targets: ['/a'],
      dialog: dlg,
      fs: fsx,
      runPreflight: async () => ({
        folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }],
        totalFiles: 3,
        totalCollisions: 0,
      }),
      runWorker: () => { throw new Error('not called'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    const confirm = dlg.calls.find((c) => c.kind === 'msg' && c.opts.type === 'question');
    expect(confirm.opts.message).toBe('Flatten this folder?');
    expect(confirm.opts.detail).not.toMatch(/^•/m);
  });
});
```

- [ ] **Step 2: Run, all 9 tests should fail with `runDialogPlugin is not a function`**

```
npm test -- tests/unit/dialog-flow.test.js
```

Expected: 9 tests FAIL.

- [ ] **Step 3: Create `src/main/dialog-flow.js`**

```js
// Orchestrates a dialog-driven plugin (manifest.ui === 'dialog'):
//   type-check targets → fork worker for preflight → confirm dialog →
//   open spinner → fork worker for run → close spinner →
//   silent exit OR error dialog.
//
// All side-effecting dependencies are injected so the orchestrator is
// fully unit-testable.

const MAX_LIST = 10;
const MAX_ERRORS = 10;

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function buildRejectedBody(label, rejected) {
  const lines = [
    `${label} works only with folders.`,
    `Selection contains ${rejected.length} ${plural(rejected.length, 'item', 'items')} that ${plural(rejected.length, 'is', 'are')} not a folder:`,
  ];
  for (const r of rejected.slice(0, MAX_LIST)) {
    lines.push(`  • ${r.basename}`);
  }
  if (rejected.length > MAX_LIST) {
    lines.push(`  … and ${rejected.length - MAX_LIST} more`);
  }
  lines.push('Operation cancelled.');
  return lines.join('\n');
}

function buildConfirm({ label, folders, totalFiles, totalCollisions }) {
  if (folders.length === 1) {
    const f = folders[0];
    const detail = [
      f.basename,
      `${f.fileCount} ${plural(f.fileCount, 'file', 'files')} will be moved to the folder's root.`,
    ];
    if (totalCollisions > 0) {
      detail.push(`${totalCollisions} name ${plural(totalCollisions, 'collision', 'collisions')} will be resolved with "(N)" suffix.`);
    }
    return { message: 'Flatten this folder?', detail: detail.join('\n') };
  }
  const lines = [];
  for (const f of folders.slice(0, MAX_LIST)) {
    lines.push(`  • ${f.basename}  (${f.fileCount} ${plural(f.fileCount, 'file', 'files')})`);
  }
  if (folders.length > MAX_LIST) {
    lines.push(`  … and ${folders.length - MAX_LIST} more`);
  }
  lines.push('');
  lines.push(`Each folder will be flattened into its own root (${totalFiles} files total).`);
  if (totalCollisions > 0) {
    lines.push(`${totalCollisions} name ${plural(totalCollisions, 'collision', 'collisions')} will be resolved with "(N)" suffix.`);
  }
  return { message: 'Flatten the following folder(s)?', detail: lines.join('\n') };
}

function buildErrorBody({ processed, total, errors }) {
  const lines = [
    `${processed} of ${total} ${plural(total, 'file', 'files')} moved.`,
    `${errors.length} ${plural(errors.length, 'file', 'files')} could not be moved:`,
  ];
  for (const e of errors.slice(0, MAX_ERRORS)) {
    lines.push(`  • ${e.file} — ${e.message}`);
  }
  if (errors.length > MAX_ERRORS) {
    lines.push(`  … and ${errors.length - MAX_ERRORS} more`);
  }
  return lines.join('\n');
}

function classifyTargets(targets, fs) {
  const folders = [];
  const rejected = [];
  for (const t of targets) {
    try {
      const st = fs.statSync(t);
      if (st.isDirectory()) folders.push(t);
      else rejected.push({ path: t, basename: basenameOf(t), reason: 'NOT_FOLDER' });
    } catch (err) {
      rejected.push({ path: t, basename: basenameOf(t), reason: err.code || 'EUNKNOWN' });
    }
  }
  return { folders, rejected };
}

function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

async function runDialogPlugin({ manifest, targets, dialog, fs, runPreflight, runWorker, openSpinner, logger }) {
  const label = manifest.label;

  // 1. Type-check
  const { folders, rejected } = classifyTargets(targets, fs);
  if (rejected.length > 0) {
    dialog.showErrorBox(label, buildRejectedBody(label, rejected));
    return 2;
  }

  // 2. Preflight
  let pre;
  try {
    pre = await runPreflight({
      workerPath: pathJoin(manifest.dir, 'worker.js'),
      targets: folders,
    });
  } catch (err) {
    logger.error('dialog-flow: preflight crashed', { message: err.message });
    dialog.showErrorBox(`${label} — internal error`, err.message);
    return 3;
  }

  // 3. Nothing to do
  if (pre.totalFiles === 0) {
    await dialog.showMessageBox({
      type: 'info',
      title: label,
      message: 'Nothing to do.',
      detail: 'Selected folder(s) are already flat.',
      buttons: ['OK'],
      defaultId: 0,
    });
    return 0;
  }

  // 4. Confirm
  const { message, detail } = buildConfirm({
    label,
    folders: pre.folders,
    totalFiles: pre.totalFiles,
    totalCollisions: pre.totalCollisions,
  });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: label,
    message,
    detail,
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 1) return 0;

  // 5. Spinner + run
  const spinner = openSpinner({ label: `${label}…` });
  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      runWorker({
        workerPath: pathJoin(manifest.dir, 'worker.js'),
        targets: folders,
        options: {},
        onProgress: () => {},
        onComplete: (r) => settle({ kind: 'complete', result: r }),
        onError: (e) => settle({ kind: 'error', error: e }),
      });
    } catch (err) {
      settle({ kind: 'error', error: { message: err.message } });
    }
  });
  spinner.close();

  // 6. Result handling
  if (result.kind === 'error') {
    logger.error('dialog-flow: worker error', result.error);
    dialog.showErrorBox(`${label} — internal error`, result.error.message || 'unknown error');
    return 3;
  }
  const { ok, processed, errors } = result.result;
  if (ok && (!errors || errors.length === 0)) return 0;
  dialog.showErrorBox(`${label} — completed with errors`, buildErrorBody({
    processed,
    total: pre.totalFiles,
    errors: errors || [],
  }));
  return 1;
}

// Tiny path.join replacement that avoids importing node:path so the unit test
// doesn't accidentally read the real filesystem for /fake paths.
function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

module.exports = { runDialogPlugin, buildConfirm, buildRejectedBody, buildErrorBody, classifyTargets };
```

- [ ] **Step 4: Run, all 9 tests pass**

```
npm test -- tests/unit/dialog-flow.test.js
```

Expected: 9 tests pass.

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add ContextHelper/src/main/dialog-flow.js ContextHelper/tests/unit/dialog-flow.test.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): dialog-flow orchestrator for ui:dialog plugins

Pure orchestrator (Electron-free, fully unit-tested) that walks a dialog
plugin from selection-validation through preflight, native confirm,
frameless spinner, run(), and result handling. Exit codes match the spec:
0 (ok/cancel/nothing-to-do), 1 (partial errors), 2 (validation), 3 (internal).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Dispatch on `manifest.ui` in `src/main/index.js`

**Files:**
- Modify: `src/main/index.js`

- [ ] **Step 1: Replace `src/main/index.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { app, Menu, dialog } = require('electron');
const { parseCli } = require('./cli');
const { loadPluginRegistry } = require('./plugin-registry');
const { openPluginWindow, createSpinnerWindow } = require('./window-manager');
const { aggregateTargets } = require('./named-pipe');
const { runPreflight, runWorker } = require('./worker-runner');
const { runDialogPlugin } = require('./dialog-flow');
const logger = require('./logger');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

async function main() {
  Menu.setApplicationMenu(null);
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

  const pipeName = `contexthelper-${cli.action}-${process.env.USERNAME || 'user'}`;
  const aggregated = await aggregateTargets({ pipeName, myTarget: cli.target, waitMs: 250 });

  if (aggregated.role === 'follower') {
    logger.info('aggregator: follower exiting', { target: cli.target });
    app.quit();
    return;
  }

  const targets = aggregated.targets;
  logger.info('aggregator: leader collected', { count: targets.length, targets });

  const min = manifest.minSelection || 1;
  const max = manifest.maxSelection || 1;
  if (targets.length < min || targets.length > max) {
    const msg = min === max
      ? `"${manifest.label}" accepts exactly ${min} item${min === 1 ? '' : 's'}, but ${targets.length} were selected.`
      : `"${manifest.label}" accepts between ${min} and ${max} items, but ${targets.length} were selected.`;
    dialog.showErrorBox('ContextHelper', msg);
    app.quit();
    return;
  }

  if (manifest.ui === 'dialog') {
    const code = await runDialogPlugin({
      manifest,
      targets,
      dialog,
      fs,
      runPreflight,
      runWorker,
      openSpinner: ({ label }) => {
        const win = createSpinnerWindow({ label });
        return { close() { try { win.destroy(); } catch {} } };
      },
      logger,
    });
    logger.info('dialog-flow: exit', { code });
    app.exit(code);
    return;
  }

  // Default: window plugin
  openPluginWindow({ manifest, targets });
}

app.whenReady().then(main).catch((err) => {
  logger.error('fatal startup error', { message: err.message, stack: err.stack });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 2: Run tests**

```
npm test
```

Expected: all tests pass. (`index.js` has no unit tests; we verify via Task 13's manual checks.)

- [ ] **Step 3: Commit**

```
git add ContextHelper/src/main/index.js
git commit -m "$(cat <<'EOF'
feat(ContextHelper): dispatch ui:dialog plugins through dialog-flow

For plugins with manifest.ui === "dialog", main now runs the
dialog-flow orchestrator (preflight → confirm → spinner → run → result)
and uses app.exit(code) with the spec'd exit codes 0/1/2/3 — bypassing
the legacy window+renderer path. Window plugins are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Delete `ui.html` + update smoke runner

**Files:**
- Delete: `plugins/flatten-folder/ui.html`
- Modify: `tests/smoke/runner.js`

- [ ] **Step 1: Delete `plugins/flatten-folder/ui.html`**

```
git rm ContextHelper/plugins/flatten-folder/ui.html
```

- [ ] **Step 2: Update `tests/smoke/runner.js`**

Replace the `flatten-folder` case block (currently lines 10-32) with:

```js
cases.push({
  id: 'flatten-folder',
  async run() {
    const plugin = require('../../plugins/flatten-folder/worker');
    const flattenRun = typeof plugin === 'function' ? plugin : plugin.run;
    const flattenPreflight = typeof plugin === 'function' ? null : plugin.preflight;
    const dir = buildFlattenFixture();
    try {
      if (flattenPreflight) {
        const pre = await flattenPreflight({ targets: [dir] });
        if (typeof pre.totalFiles !== 'number') throw new Error('preflight returned no totalFiles');
      }
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
```

- [ ] **Step 3: Run smoke**

```
npm run smoke
```

Expected: `flatten-folder ✓ 5 files → 5 in root`. Exit 0.

- [ ] **Step 4: Run full unit suite for safety**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add ContextHelper/plugins/flatten-folder/ui.html ContextHelper/tests/smoke/runner.js
git commit -m "$(cat <<'EOF'
chore(flatten-folder): remove ui.html + adapt smoke runner

The dialog-driven flatten-folder has no HTML form. The smoke runner now
calls preflight + run on the new object export.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Verify `register.bat` supports multi-select

**Files:**
- Inspect: `scripts/gen-register-bat.js`
- Possibly modify: same file

The Windows shell only sends multiple targets to a single command invocation when the verb has `MultiSelectModel="Player"`. With `MultiSelectModel="Document"` (or unset, which behaves as Document), Explorer launches the verb once *per selected item* — which is exactly the scenario the named-pipe aggregator was built for. Either model works because the aggregator collects them, but `Player` is more efficient.

- [ ] **Step 1: Grep the generated `register.bat` for MultiSelectModel**

```
node ContextHelper/scripts/gen-register-bat.js
```

Then inspect `ContextHelper/register.bat`. Look for `MultiSelectModel`.

Expected: it is **not** present (current behaviour). This is fine — the named-pipe aggregator already handles per-item invocations.

- [ ] **Step 2: Decide**

Two options:

- **A: leave as-is** — N selected folders cause N app launches; the aggregator collapses them into one process in ≤250 ms. Already works.
- **B: add `MultiSelectModel=Player`** — one app launch with all `%V` paths. More efficient but requires changing how the command line is parsed. Not required for v1.

Choose **A** for this plan (keep the aggregator-based flow). Document the decision in the plugin's manifest comment (or a follow-up issue).

- [ ] **Step 3: No code change required. Commit a doc note instead**

If you want to record the decision, append to `CLAUDE.md`'s `## Architecture cheat sheet` section the bullet:

```
- **Multi-select handling:** Explorer invokes ContextHelper.exe once per selected item; the named-pipe aggregator (`src/main/named-pipe.js`) collapses those into a single `targets` array within a 250 ms window. We do NOT emit `MultiSelectModel="Player"` in `register.bat` — keeping per-item invocations means future plugins do not need to refactor the CLI parser.
```

Then:

```
git add ContextHelper/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(ContextHelper): document multi-select flow (aggregator, not Player)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If `CLAUDE.md` already mentions this, skip the commit.)

---

## Task 13: Manual end-to-end verification in Explorer

**Files:** none — verification only.

- [ ] **Step 1: Repackage (or in-place asar patch)**

Either run:

```
npm run package
```

(if Developer Mode is on — see CLAUDE.md for the winCodeSign symlink caveat), or in-place patch `dist/win-unpacked/`:

```
cd ContextHelper/dist/win-unpacked
mkdir tmp-asar
node_modules/.bin/asar extract resources/app.asar tmp-asar
# overwrite changed files
cp -r ../../src/* tmp-asar/src/
cp -r ../../plugins/* tmp-asar/plugins/
# remove the deleted ui.html
rm tmp-asar/plugins/flatten-folder/ui.html
# repack
node_modules/.bin/asar pack tmp-asar resources/app.asar
rm -rf tmp-asar
```

- [ ] **Step 2: Re-run register.bat**

```
node ContextHelper/scripts/gen-register-bat.js --exe="%~dp0ContextHelper.exe"
cp register.bat unregister.bat ContextHelper/dist/win-unpacked/
```

In Explorer, double-click `ContextHelper/dist/win-unpacked/register.bat`.

- [ ] **Step 3: Verify each user-facing case**

In a synthetic test folder, build:
- `Photos/a/1.jpg`, `Photos/b/1.jpg`, `Photos/b/2.jpg` (forces 1 collision)
- `Vacation/x/y/z.jpg`
- `Already-flat/q.txt`, `Already-flat/w.txt`
- `report.pdf` (a file, for the mixed-selection test)

| # | Selection | Expected dialog | Verify |
|---|---|---|---|
| 1 | one folder `Photos` | "Flatten this folder?" with body listing Photos, "3 files", "1 collision will be resolved..." | Click Continue → spinner flashes → no further dialog → Photos contains 3 flat files (`1.jpg`, `1 (2).jpg`, `2.jpg`), no subfolders |
| 2 | three folders `Photos`, `Vacation`, `Already-flat` (already with prior files restored) | "Flatten the following folder(s)?" with bullet list of all three | Continue → silent success → each folder is flat |
| 3 | mix: `Photos` + `report.pdf` | Red error dialog "Flatten folder works only with folders. Selection contains 1 item that is not a folder: • report.pdf" | No work done |
| 4 | `Already-flat` only (no nested files) | Info dialog "Nothing to do. Selected folder(s) are already flat." | No work done |
| 5 | a folder containing a file open in another app | Continue → error dialog "Flatten folder — completed with errors: N of M moved, • path — EBUSY..." | Other files moved successfully |
| 6 | any folder → click Cancel on confirm | No further dialog, no work | |

- [ ] **Step 4: Note any divergences from the spec**

For each test case that did **not** behave as in the table, note the divergence. Either the spec needs an update (commit the change), the dialog-flow code has a bug (open a follow-up task), or the wording is awkward (revise §4.6 of the spec and the corresponding `buildXxx` functions).

- [ ] **Step 5: Final commit if any verification fixes were needed**

```
git add -p   # stage only the relevant files
git commit -m "$(cat <<'EOF'
fix(ContextHelper): flatten-folder rework — Explorer verification fixups

(list specific fixes from Step 4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If Step 4 found nothing, skip this commit.

- [ ] **Step 6: Mark plan complete**

Edit the very top of this plan file and add a status banner:

```
> **Status:** ✅ COMPLETE (YYYY-MM-DD). All 13 tasks executed; flatten-folder rework verified end-to-end in Explorer. <NN>/<NN> unit tests pass.
```

Then update `ContextHelper/CLAUDE.md`'s "Resume here" section to reflect the new state.

```
git add ContextHelper/docs/superpowers/plans/2026-05-18-flatten-folder-rework-plan.md ContextHelper/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(ContextHelper): mark flatten-folder rework plan complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- All 8 spec requirements (drop encodePathInName, mixed-selection error, list-of-folders confirm, indeterminate-spinner during run, info-dialog for empty, ui:dialog + preflight + run contract, silent success, error dialog with formatted body) are covered by Tasks 1–10 and verified in Task 13.
- Exit codes 0/1/2/3 are checked in Task 9 unit tests and exercised in Task 13's manual matrix.
- Spec §4.6 wording is implemented by `buildRejectedBody`, `buildConfirm`, and `buildErrorBody` in `dialog-flow.js` (Task 9). Wording matches the spec; if user feedback in Task 13 prefers different phrasing, update Step 3 in Task 9 *and* §4.6 in the spec.
- Truncation rules (10-item folder list, 10-error list) are tested in Task 9 and shared between the three builders.
- Single-folder phrasing path is tested in Task 9.
- Backward compatibility: window-mode plugins still use `module.exports = function run` and `manifest.ui` defaults to `"window"`. The dispatch branch in Task 10 keeps the old path untouched.
- The smoke runner is the only consumer that imports the worker module directly; Task 11 updates it. Other consumers go through the worker-shim.
- Edge: if Explorer happens to send all N selected paths within one invocation (some future Windows shell version with `MultiSelectModel=Player`), Task 12's decision to keep per-item invocations means a single CLI call would only ever carry one `--target` arg — the rest are ignored. This is a future-self problem; documented in Task 12.
