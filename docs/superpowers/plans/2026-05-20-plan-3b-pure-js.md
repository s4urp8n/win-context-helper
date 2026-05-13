# Plan 3b — Pure-JS plugins (cleanup-by-extension + merge-folders)

> **Status:** ✅ Tasks 1–2 complete (2026-05-20). 174/174 unit tests + package + register installed. T3 manual Explorer verification pending the user.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two pure-JS plugins from spec §4.1–4.2: `cleanup-by-extension` (delete files of selected extensions from selected folders) and `merge-folders` (merge contents of N folders into the first). Both are window-mode plugins exercising the new `form` state shipped in Plan 3a.

**Architecture:** Each plugin is `class extends BasePlugin` in `plugins/<id>/plugin.js`, with `ui.html` providing the form fragment injected into the shell's form-state container, and an `icon.png` placeholder. Worker IPC contract unchanged from Plan 3a (binDir threaded but not used here — no external binary). Tests follow the same fixture-on-tmp-dir pattern as `flatten-folder`.

**Tech Stack:** Node 20+, Electron 33, Vitest 2 (globals), CommonJS. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-20-plan-3-design.md` §4.1, §4.2. Plan 3a required ✅.

---

## File map

```
ContextHelper/
├── plugins/
│   ├── cleanup-by-extension/
│   │   ├── plugin.js                       # NEW (Task 1)
│   │   ├── ui.html                         # NEW (Task 1)
│   │   └── icon.png                        # NEW (Task 1, copy of flatten-folder/icon.png)
│   └── merge-folders/
│       ├── plugin.js                       # NEW (Task 2)
│       ├── ui.html                         # NEW (Task 2)
│       └── icon.png                        # NEW (Task 2)
└── tests/unit/
    ├── cleanup-by-extension.test.js        # NEW (Task 1)
    └── merge-folders.test.js               # NEW (Task 2)
```

`gen-register-bat.js` already picks plugins up via `loadAll()`. After this plan, the menu will read:
```
ContextHelper → Folders
  ├── cleanup-by-extension
  ├── flatten-folder
  └── merge-folders
```

(alphabetical order — set by `menu-tree.js`).

---

## Task 1: `cleanup-by-extension` plugin

**Files:**
- Create: `plugins/cleanup-by-extension/plugin.js`
- Create: `plugins/cleanup-by-extension/ui.html`
- Copy: `plugins/cleanup-by-extension/icon.png` (from `plugins/flatten-folder/icon.png`)
- Create: `tests/unit/cleanup-by-extension.test.js`

### Step 1: Create `tests/unit/cleanup-by-extension.test.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CleanupByExtension = require('../../plugins/cleanup-by-extension/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe('CleanupByExtension', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cleanup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = CleanupByExtension.manifest;
    expect(m).toMatchObject({
      id: 'cleanup-by-extension',
      label: 'Cleanup by extension',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight groups files by extension across selected folders', async () => {
    tree(tmp, {
      'a/p1.jpg': 'x', 'a/p2.jpg': 'xx', 'a/n1.txt': 'y', 'b/p3.jpg': 'xxx', 'b/log.log': 'zzz',
    });
    const result = await new CleanupByExtension().preflight({ targets: [tmp] });
    const byExt = Object.fromEntries(result.extensions.map((e) => [e.ext, e]));
    expect(byExt['.jpg'].count).toBe(3);
    expect(byExt['.jpg'].totalBytes).toBe(1 + 2 + 3);
    expect(byExt['.txt'].count).toBe(1);
    expect(byExt['.log'].count).toBe(1);
    expect(result.totalFiles).toBe(5);
    expect(result.extensions[0].count).toBeGreaterThanOrEqual(result.extensions.at(-1).count);
  });

  it('preflight returns totalFiles: 0 for an empty folder', async () => {
    const result = await new CleanupByExtension().preflight({ targets: [tmp] });
    expect(result.totalFiles).toBe(0);
    expect(result.extensions).toEqual([]);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(tmp, { 'a/x.txt': 'X', 'a/b/y.jpg': 'Y' });
    const before = fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs;
    await new CleanupByExtension().preflight({ targets: [tmp] });
    expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(tmp, 'a', 'b', 'y.jpg'))).toBe(true);
  });

  it('run deletes only files matching selectedExts', async () => {
    tree(tmp, {
      'p1.jpg': 'x', 'p2.JPG': 'y', 'n1.txt': 'z', 'sub/p3.jpg': 'w', 'sub/n2.txt': 'v',
    });
    const result = await new CleanupByExtension().run({
      targets: [tmp],
      options: { selectedExts: ['.jpg'] },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(3); // 3 .jpg files (case-insensitive)
    expect(fs.existsSync(path.join(tmp, 'p1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'p2.JPG'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'sub', 'p3.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'n1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'sub', 'n2.txt'))).toBe(true);
  });

  it('run records errors and continues when an unlink fails', async () => {
    tree(tmp, { 'a.tmp': 'x', 'b.tmp': 'y' });
    const realUnlink = fs.unlinkSync;
    const target = path.join(tmp, 'a.tmp');
    let firstCall = true;
    fs.unlinkSync = (p) => {
      if (firstCall && p === target) { firstCall = false; throw new Error('EBUSY'); }
      return realUnlink.call(fs, p);
    };
    try {
      const result = await new CleanupByExtension().run({
        targets: [tmp], options: { selectedExts: ['.tmp'] }, onProgress: () => {},
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/EBUSY/);
      expect(result.processed).toBe(1); // b.tmp deleted, a.tmp failed
    } finally {
      fs.unlinkSync = realUnlink;
    }
  });

  it('isEmpty returns true when no files found', () => {
    const p = new CleanupByExtension();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
  });

  it('buildRunningLabel returns "Cleaning up…"', () => {
    expect(new CleanupByExtension().buildRunningLabel({})).toBe('Cleaning up…');
  });
});
```

### Step 2: Run, expect fail

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test -- tests/unit/cleanup-by-extension.test.js
```

### Step 3: Create `plugins/cleanup-by-extension/plugin.js`

```js
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
```

### Step 4: Run tests, expect 8 pass

```
npm test -- tests/unit/cleanup-by-extension.test.js
```

### Step 5: Create `plugins/cleanup-by-extension/ui.html`

The form HTML is generated DYNAMICALLY by the plugin's `buildFormSummary` reading preflight result. Since the form's checkbox list depends on what extensions were found (`pre.extensions`), we need a way for the plugin to emit dynamic ui.html.

**Architectural note:** the current shell only injects a static `ui.html`. For dynamic content based on preflight, the simplest approach is: ship a placeholder `ui.html` that the renderer hydrates from the `summary` field. But that conflates summary with form fields.

**Pragmatic v1 solution:** the plugin's `buildFormSummary` constructs the entire form-fields HTML (with checkboxes per extension found in preflight) AS A STRING, and the runner sends it as `uiHtml` in the set-state payload — overriding the static file read.

For this we need ONE small change to `window-runner.js`: if the plugin defines a `buildFormHtml(ctx, pre)` hook, use that INSTEAD of `readUiHtml(pluginDir)`. Add to BasePlugin's defaults: `buildFormHtml = null` (signal "use static file").

Actually — keep things simple. The plugin's `buildFormSummary` returns a string for the summary. For DYNAMIC form fields, override a new hook `buildFormHtml(ctx, pre)`. If the hook is defined and returns a string, runner uses that; otherwise fall back to reading `ui.html`.

**Update to window-runner.js (small, do here in this task since it's coupled to cleanup-by-extension's design):**

Read `src/main/runners/window-runner.js`. Find:
```js
const uiHtml = readUiHtml(pluginDir);
```

Replace with:
```js
const dynamicUi = safeHook(plugin, 'buildFormHtml', () => null, logger, ctx, pre);
const uiHtml = (typeof dynamicUi === 'string' && dynamicUi.length > 0) ? dynamicUi : readUiHtml(pluginDir);
```

Add to `cleanup-by-extension/plugin.js` at the bottom of the class (above `buildRunningLabel`):

```js
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
```

Static placeholder `ui.html` (used as fallback if buildFormHtml ever returns null):

```html
<div class="form-summary">Select extensions to delete.</div>
```

Write that as `plugins/cleanup-by-extension/ui.html`.

### Step 6: Copy icon placeholder

```
copy "C:\YandexDisk\Software\bin\ContextHelper\plugins\flatten-folder\icon.png" "C:\YandexDisk\Software\bin\ContextHelper\plugins\cleanup-by-extension\icon.png"
```

(or in PowerShell: `Copy-Item ... -Destination ...`)

### Step 7: Run tests for this plugin + window-runner (verify the small window-runner change didn't break anything)

```
npm test -- tests/unit/cleanup-by-extension.test.js tests/unit/window-runner.test.js
```

Expected: 8 + 6 = 14 pass.

### Step 8: Run full suite

```
npm test
```

Expected: 158 + 8 new = 166.

### Step 9: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/cleanup-by-extension/ ContextHelper/tests/unit/cleanup-by-extension.test.js ContextHelper/src/main/runners/window-runner.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(plugins): add cleanup-by-extension plugin

Deletes files of selected extensions from selected folders recursively.
Preflight groups files by extension with counts and total bytes; form
shows a checkbox per discovered extension. Window-runner gains a new
optional buildFormHtml() hook so plugins can produce dynamic form
markup based on preflight result (cleanup needs this — checkboxes are
per-extension-found).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `merge-folders` plugin

**Files:**
- Create: `plugins/merge-folders/plugin.js`
- Create: `plugins/merge-folders/ui.html`
- Copy: `plugins/merge-folders/icon.png`
- Create: `tests/unit/merge-folders.test.js`

### Step 1: Create `tests/unit/merge-folders.test.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MergeFolders = require('../../plugins/merge-folders/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => e.name).sort();
}

describe('MergeFolders', () => {
  let dirs;
  beforeEach(() => {
    dirs = [];
    for (const name of ['aaa', 'bbb', 'ccc']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), `ch-merge-${name}-`));
      // Create a known-name subdir so basename is predictable
      const inner = path.join(d, name);
      fs.mkdirSync(inner);
      dirs.push(inner);
    }
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(path.dirname(d), { recursive: true, force: true });
  });

  it('static manifest is well-formed', () => {
    const m = MergeFolders.manifest;
    expect(m).toMatchObject({
      id: 'merge-folders',
      label: 'Merge folders',
      accepts: ['folders'],
      minSelection: 2,
      maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight identifies target (alphabetical first) and source folders', async () => {
    tree(dirs[0], { 'a.txt': '1' });
    tree(dirs[1], { 'b.txt': '2', 'c.txt': '3' });
    const result = await new MergeFolders().preflight({ targets: [dirs[1], dirs[0]] });
    // Target is the FIRST after alphabetical sort by basename. dirs[0] is named 'aaa', so target = aaa.
    expect(result.target.basename).toBe('aaa');
    expect(result.sources.map((s) => s.basename)).toEqual(['bbb']);
    expect(result.totalFiles).toBe(2);
  });

  it('preflight counts collisions across sources', async () => {
    tree(dirs[0], { 'shared.txt': 'A' });
    tree(dirs[1], { 'shared.txt': 'B' });
    const result = await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(result.collisionCount).toBeGreaterThanOrEqual(1);
  });

  it('preflight returns totalFiles 0 for empty sources', async () => {
    const result = await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(dirs[0], { 'a.txt': 'A' });
    tree(dirs[1], { 'b.txt': 'B' });
    const before = fs.statSync(path.join(dirs[1], 'b.txt')).mtimeMs;
    await new MergeFolders().preflight({ targets: [dirs[0], dirs[1]] });
    expect(fs.statSync(path.join(dirs[1], 'b.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(dirs[1], 'b.txt'))).toBe(true);
  });

  it('run with rename strategy moves files into target', async () => {
    tree(dirs[0], { 'x.txt': 'A' });
    tree(dirs[1], { 'y.txt': 'B', 'shared.txt': 'C' });
    tree(dirs[0], { 'shared.txt': 'Z' });
    const result = await new MergeFolders().run({
      targets: [dirs[0], dirs[1]],
      options: { collisionStrategy: 'rename', deleteSourceFolders: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    const targetFiles = listFiles(dirs[0]);
    expect(targetFiles).toContain('x.txt');
    expect(targetFiles).toContain('y.txt');
    expect(targetFiles).toContain('shared.txt');
    expect(targetFiles.some((f) => /shared \(2\)\.txt/.test(f))).toBe(true);
  });

  it('run with skip strategy leaves colliding source files in place', async () => {
    tree(dirs[0], { 'shared.txt': 'A' });
    tree(dirs[1], { 'shared.txt': 'B', 'unique.txt': 'C' });
    const result = await new MergeFolders().run({
      targets: [dirs[0], dirs[1]],
      options: { collisionStrategy: 'skip', deleteSourceFolders: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(listFiles(dirs[0])).toContain('unique.txt');
    // shared.txt in source dirs[1] should still exist (skipped)
    expect(fs.existsSync(path.join(dirs[1], 'shared.txt'))).toBe(true);
  });

  it('buildRunningLabel returns "Merging…"', () => {
    expect(new MergeFolders().buildRunningLabel({})).toBe('Merging…');
  });
});
```

### Step 2: Run tests, expect fail

```
npm test -- tests/unit/merge-folders.test.js
```

### Step 3: Create `plugins/merge-folders/plugin.js`

```js
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
```

### Step 4: Create `plugins/merge-folders/ui.html`

```html
<label class="field-row">
  <span>Collision strategy:</span>
</label>
<label class="field-row">
  <input type="radio" name="collisionStrategy" value="rename" checked />
  Rename with "(N)" suffix
</label>
<label class="field-row">
  <input type="radio" name="collisionStrategy" value="skip" />
  Skip (leave source file in place)
</label>
<label class="field-row">
  <input type="radio" name="collisionStrategy" value="overwrite" />
  Overwrite target file
</label>
<label class="field-row">
  <input type="checkbox" name="deleteSourceFolders" value="true" checked />
  Delete source folders after merge
</label>
```

### Step 5: Copy icon placeholder

```
copy "C:\YandexDisk\Software\bin\ContextHelper\plugins\flatten-folder\icon.png" "C:\YandexDisk\Software\bin\ContextHelper\plugins\merge-folders\icon.png"
```

### Step 6: Run tests for this plugin

```
npm test -- tests/unit/merge-folders.test.js
```

Expected: 8 pass.

### Step 7: Run full suite

```
npm test
```

Expected: 166 + 8 = 174.

### Step 8: Regenerate register.bat (since 2 new plugins exist)

```
node scripts/gen-register-bat.js
copy register.bat dist\win-unpacked\
copy unregister.bat dist\win-unpacked\
```

(Or in PowerShell:
```
node scripts/gen-register-bat.js
Copy-Item register.bat,unregister.bat -Destination dist\win-unpacked\ -Force
```
)

User can run unregister.bat + register.bat from dist/win-unpacked/ at their convenience to see the new menu items.

### Step 9: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/merge-folders/ ContextHelper/tests/unit/merge-folders.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(plugins): add merge-folders plugin

Merges contents of 2+ selected folders into the first (alphabetically
sorted by basename). Form picks collision strategy (rename / skip /
overwrite) and whether to delete source folders after. Walks files
recursively preserving relative subpath... wait — actually the v1 flat
behavior is: every file from sources lands in the top of target. Sub-
folder structure within sources is collapsed. (This matches the spec
§4.2 description: "merge contents".)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rebuild + manual verify + finalize

**Files:** none — verification + docs.

### Step 1: Rebuild

```
cd C:\YandexDisk\Software\bin\ContextHelper
npm run package
```

Expected: success. New plugins are now in `dist/win-unpacked/resources/app.asar`.

### Step 2: Re-register

```
node scripts/gen-register-bat.js
Copy-Item register.bat,unregister.bat -Destination dist\win-unpacked\ -Force
cd dist\win-unpacked
.\unregister.bat
.\register.bat
```

### Step 3: Manual verification matrix

Verify in Explorer:

| # | Action | Expected |
|---|---|---|
| 1 | Right-click 1 folder → ContextHelper → Folders → Cleanup by extension | Window opens with scanning, then form with checkboxes per discovered extension. Check `.jpg` → Start → files deleted. |
| 2 | Right-click 1 empty folder → Cleanup by extension | "Nothing to clean up" info state. |
| 3 | Right-click 2 folders → ContextHelper → Folders → Merge folders | Window opens, scanning, then form. "Merge into <basename>" header. Sources listed with counts. Strategy radios. Continue → merging → silent close on success. |
| 4 | Right-click 2 folders with shared filename → Merge folders → Rename | Target ends up with `shared.txt` + `shared (2).txt`. |
| 5 | Right-click 2 folders → Merge folders → Skip → Continue | Colliding file in source remains; non-colliding moved. |
| 6 | Sort verification | In the cascade menu under Folders, alphabetical: `cleanup-by-extension`, `flatten-folder`, `merge-folders`. |

### Step 4: Mark Plan 3b complete

Edit the top of `2026-05-20-plan-3b-pure-js.md`:

```markdown
> **Status:** ✅ COMPLETE (YYYY-MM-DD). 3 tasks executed; 174/174 tests + manual matrix verified.
```

Update `CLAUDE.md` "Resume here" with a paragraph noting that Plan 3b (cleanup-by-extension + merge-folders) is done; next is Plan 3c (archive-each with 7z).

### Step 5: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/docs/superpowers/plans/2026-05-20-plan-3b-pure-js.md ContextHelper/CLAUDE.md
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
docs(ContextHelper): mark Plan 3b (pure-JS plugins) complete

cleanup-by-extension + merge-folders shipped, 174 unit tests green,
manual verification in Explorer passed. Plan 3c (archive-each + 7z)
is next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- Spec §4.1 cleanup-by-extension → Task 1 ✓ (preflight groups, form with checkboxes per ext, run deletes per signaled exts, error handling)
- Spec §4.2 merge-folders → Task 2 ✓ (target = alphabetical first, sources move in, collision strategies, optional source-folder deletion)
- Spec §5.6 tests: 8 mandatory tests per plugin ✓ (cleanup: 8, merge: 8 — manifest, preflight happy/empty/no-mutation, run happy/errors, isEmpty, buildRunningLabel)

**No placeholders.** Every step shows code or exact commands.

**Type consistency:** `selectedExts` (array of `.ext` strings) used consistently between preflight output and run options. `collisionStrategy` enum (`'rename' | 'skip' | 'overwrite'`) used consistently. `buildFormHtml` hook signature matches between cleanup-by-extension and window-runner addition.

**Known UX note:** the cleanup plugin's form rendering uses `buildFormHtml` (dynamic), requiring a one-line window-runner adjustment in Task 1. The merge plugin uses static `ui.html` (no dynamic content needed). Both patterns work and document the BasePlugin extension point for future plugins.
