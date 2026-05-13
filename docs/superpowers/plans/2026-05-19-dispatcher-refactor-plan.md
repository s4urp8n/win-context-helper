# ContextHelper — Plan: Dispatcher refactor + class-based plugins

> **Status:** ✅ COMPLETE (2026-05-19). All 14 tasks executed; 150/150 unit + smoke green; verified end-to-end in Explorer. Beyond the original plan scope, 10 UX/correctness follow-up commits landed: %V path quoting (`cdf9e71`), single-window dialog shell replacing native dialogs (`d3f6a67`), custom titlebar with drag/min/close (`721eb74`), layout + alphabetical sort (`9d7d7a2`), type/extension mismatch → skip-list (`70ab4ba`), live progress bar + counts (`dbb9f20`), auto-resize to content (`00c06d4`, `f24e401`), spinner-hidden-when-progress (`db887a6`), 15-item shell limit documented (`4ffce08`), idle-based multi-select aggregator (`4549074`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered main-process logic (CLI parsing in `index.js`, plugin loading in `plugin-registry.js`, type-checking in `dialog-flow.js`, window flow in `window-manager.js`) with a single `dispatcher.js` that hands off to a `Runner` strategy. Convert plugins from object-export to `class extends BasePlugin`. Reshape the Explorer context menu into `ContextHelper → Folders | Files → <plugin>` with three shared registry entry points (Directory, *, Directory\Background).

**Architecture:** Single dispatcher orchestrates phases (parse → load → normalize → classify → validate → instantiate → runner.execute). Runners (`DialogRunner`, `WindowRunner`) implement a uniform `execute(ctx) → exitCode` contract and call plugin hooks (`buildConfirmMessage`, `buildErrorBody`, `isEmpty`, …) via a `safeHook` helper that falls back to BasePlugin defaults. Plugins are CJS classes with a `static get manifest()` getter.

**Tech Stack:** Node 20+, Electron 33, Vitest 2 (globals mode), CommonJS, pure-Node `child_process.fork` for workers.

**Reference spec:** `docs/superpowers/specs/2026-05-19-dispatcher-refactor-design.md`. The spec is the source of truth — when in doubt, prefer the spec over this plan.

---

## File map

```
ContextHelper/
├── src/
│   ├── shared/
│   │   ├── base-plugin.js                  # NEW (Task 1)
│   │   └── plugin-api.js                   # unchanged
│   ├── main/
│   │   ├── index.js                        # MODIFY: thinned to ~12 lines (Task 12)
│   │   ├── dispatcher.js                   # NEW (Task 11)
│   │   ├── selection/
│   │   │   ├── classify.js                 # NEW (Task 2)
│   │   │   └── validate.js                 # NEW (Task 3)
│   │   ├── registry/
│   │   │   ├── plugin-loader.js            # NEW (Task 6)
│   │   │   └── menu-tree.js                # NEW (Task 4)
│   │   ├── runners/
│   │   │   ├── safe-hook.js                # NEW (Task 5)
│   │   │   ├── base-runner.js              # NEW (Task 8)
│   │   │   ├── dialog-runner.js            # NEW (Task 9, replaces dialog-flow.js)
│   │   │   └── window-runner.js            # NEW (Task 10)
│   │   ├── window-manager.js               # MODIFY: keeps factories only (Task 10)
│   │   ├── plugin-registry.js              # DELETE (Task 12)
│   │   ├── dialog-flow.js                  # DELETE (Task 12)
│   │   ├── worker-runner.js                # unchanged
│   │   ├── named-pipe.js                   # unchanged
│   │   ├── cli.js                          # unchanged
│   │   ├── logger.js                       # unchanged
│   │   └── utils/
│   │       ├── collision.js                # unchanged
│   │       └── long-path.js                # unchanged
│   ├── worker/
│   │   └── worker-shim.js                  # MODIFY: class loader (Task 7)
│   ├── preload/                            # unchanged
│   └── renderer/                           # unchanged
├── plugins/
│   └── flatten-folder/
│       ├── plugin.js                       # NEW class (Task 7)
│       ├── worker.js                       # DELETE (Task 7)
│       ├── manifest.json                   # DELETE (Task 7)
│       └── icon.png                        # unchanged
├── scripts/
│   └── gen-register-bat.js                 # REWRITE (Task 13)
└── tests/
    ├── unit/
    │   ├── base-plugin.test.js             # NEW (Task 1)
    │   ├── classify.test.js                # NEW (Task 2)
    │   ├── validate.test.js                # NEW (Task 3)
    │   ├── menu-tree.test.js               # NEW (Task 4)
    │   ├── safe-hook.test.js               # NEW (Task 5)
    │   ├── plugin-loader.test.js           # NEW (Task 6, replaces plugin-registry.test.js)
    │   ├── plugin-registry.test.js         # DELETE (Task 12)
    │   ├── dispatcher.test.js              # NEW (Task 11)
    │   ├── dialog-runner.test.js           # NEW (Task 9, replaces dialog-flow.test.js)
    │   ├── dialog-flow.test.js             # DELETE (Task 12)
    │   ├── window-runner.test.js           # NEW (Task 10)
    │   ├── worker-shim.test.js             # MODIFY (Task 7)
    │   ├── flatten-folder.test.js          # MODIFY (Task 7)
    │   └── gen-register-bat.test.js        # NEW (Task 13)
    └── smoke/
        └── runner.js                       # MODIFY (Task 7)
```

---

## Task 1: BasePlugin class + default hooks

**Files:**
- Create: `src/shared/base-plugin.js`
- Create: `tests/unit/base-plugin.test.js`

- [ ] **Step 1: Create `tests/unit/base-plugin.test.js`**

```js
const { BasePlugin } = require('../../src/shared/base-plugin');

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 'stub', label: 'Stub' }; }
}

describe('BasePlugin', () => {
  it('static manifest must be overridden', () => {
    expect(() => BasePlugin.manifest).toThrow(/subclass must declare static get manifest/);
  });

  it('preflight() must be overridden', async () => {
    const p = new StubPlugin();
    await expect(p.preflight({})).rejects.toThrow(/must implement preflight/);
  });

  it('run() must be overridden', async () => {
    const p = new StubPlugin();
    await expect(p.run({})).rejects.toThrow(/must implement run/);
  });

  it('isEmpty default returns true when totalFiles === 0', () => {
    const p = new StubPlugin();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
    expect(p.isEmpty({}, null)).toBeFalsy();
  });

  it('buildNothingToDoBody default returns { message, detail }', () => {
    const p = new StubPlugin();
    const out = p.buildNothingToDoBody({}, {});
    expect(out).toHaveProperty('message');
    expect(out).toHaveProperty('detail');
  });

  it('buildConfirmMessage default returns { message, detail }', () => {
    const p = new StubPlugin();
    const out = p.buildConfirmMessage({}, { folders: [{}, {}, {}] });
    expect(out.message).toMatch(/3/);
  });

  it('buildRejectedBody default lists basenames', () => {
    const p = new StubPlugin();
    const body = p.buildRejectedBody({}, [{ basename: 'a' }, { basename: 'b' }]);
    expect(body).toMatch(/• a/);
    expect(body).toMatch(/• b/);
  });

  it('buildErrorBody default lists first 10 errors', () => {
    const p = new StubPlugin();
    const errors = Array.from({ length: 15 }, (_, i) => ({ file: `f${i}`, message: 'err' }));
    const body = p.buildErrorBody({}, errors, 5, 20);
    expect(body).toMatch(/5 of 20/);
    expect(body).toMatch(/• f0 — err/);
    expect(body).toMatch(/• f9 — err/);
    expect(body).not.toMatch(/• f10 —/);
    expect(body).toMatch(/and 5 more/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test -- tests/unit/base-plugin.test.js
```

Expected: 8 tests FAIL (module not found).

- [ ] **Step 3: Create `src/shared/base-plugin.js`**

```js
const MAX_ERRORS_IN_BODY = 10;

class BasePlugin {
  static get manifest() {
    throw new Error(`${this.name}: subclass must declare static get manifest()`);
  }

  async preflight(_ctx) {
    throw new Error(`${this.constructor.name}: must implement preflight()`);
  }

  async run(_ctx) {
    throw new Error(`${this.constructor.name}: must implement run()`);
  }

  isEmpty(_ctx, pre) {
    return !!(pre && pre.totalFiles === 0);
  }

  buildNothingToDoBody(_ctx, _pre) {
    return {
      message: 'Nothing to do.',
      detail: 'The current selection is already in the desired state.',
    };
  }

  buildConfirmMessage(_ctx, pre) {
    const n = (pre && pre.folders && pre.folders.length) || 1;
    return { message: `Process ${n} item(s)?`, detail: '' };
  }

  buildRejectedBody(_ctx, rejected) {
    const lines = [`Selection contains ${rejected.length} invalid path(s):`];
    for (const r of rejected.slice(0, MAX_ERRORS_IN_BODY)) lines.push(`  • ${r.basename}`);
    if (rejected.length > MAX_ERRORS_IN_BODY) {
      lines.push(`  … and ${rejected.length - MAX_ERRORS_IN_BODY} more`);
    }
    return lines.join('\n');
  }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} processed.`,
      `${errors.length} could not be processed:`,
    ];
    for (const e of errors.slice(0, MAX_ERRORS_IN_BODY)) {
      lines.push(`  • ${e.file} — ${e.message}`);
    }
    if (errors.length > MAX_ERRORS_IN_BODY) {
      lines.push(`  … and ${errors.length - MAX_ERRORS_IN_BODY} more`);
    }
    return lines.join('\n');
  }
}

module.exports = { BasePlugin };
```

- [ ] **Step 4: Run, expect 8 pass**

```
npm test -- tests/unit/base-plugin.test.js
```

- [ ] **Step 5: Run full suite (should remain green)**

```
npm test
```

Expected: 85+ tests pass (8 new + existing).

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/shared/base-plugin.js ContextHelper/tests/unit/base-plugin.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): introduce BasePlugin class with default hooks

Subclasses declare static get manifest() and implement preflight()/run().
Optional overridable hooks (isEmpty, buildConfirmMessage, buildErrorBody,
buildRejectedBody, buildNothingToDoBody) have safe defaults so plugins
can opt into custom wording per the 2026-05-19 dispatcher-refactor spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: classify (pure target classifier)

**Files:**
- Create: `src/main/selection/classify.js`
- Create: `tests/unit/classify.test.js`

- [ ] **Step 1: Create test**

```js
const { classify } = require('../../src/main/selection/classify');

function makeFs(map) {
  return {
    statSync: (p) => {
      if (!(p in map)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      if (map[p] === 'enoent') {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      if (map[p] === 'eacces') {
        const err = new Error('EACCES'); err.code = 'EACCES'; throw err;
      }
      return {
        isDirectory: () => map[p] === 'dir',
        isFile:      () => map[p] === 'file',
      };
    },
  };
}

describe('classify', () => {
  it('all folders', () => {
    const r = classify(['/a', '/b'], makeFs({ '/a': 'dir', '/b': 'dir' }));
    expect(r.folders).toEqual(['/a', '/b']);
    expect(r.files).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.exts).toEqual([]);
    expect(r.basenames).toEqual(['a', 'b']);
  });

  it('all files', () => {
    const r = classify(['/a.pdf', '/b.txt'], makeFs({ '/a.pdf': 'file', '/b.txt': 'file' }));
    expect(r.folders).toEqual([]);
    expect(r.files).toEqual(['/a.pdf', '/b.txt']);
    expect(r.exts.sort()).toEqual(['.pdf', '.txt']);
  });

  it('mixed folders + files', () => {
    const r = classify(['/d', '/f.pdf'], makeFs({ '/d': 'dir', '/f.pdf': 'file' }));
    expect(r.folders).toEqual(['/d']);
    expect(r.files).toEqual(['/f.pdf']);
    expect(r.exts).toEqual(['.pdf']);
  });

  it('all missing', () => {
    const r = classify(['/x', '/y'], makeFs({ '/x': 'enoent', '/y': 'enoent' }));
    expect(r.missing).toEqual(['/x', '/y']);
    expect(r.folders).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('mix of missing + valid', () => {
    const r = classify(['/a', '/gone', '/b.pdf'], makeFs({ '/a': 'dir', '/gone': 'enoent', '/b.pdf': 'file' }));
    expect(r.missing).toEqual(['/gone']);
    expect(r.folders).toEqual(['/a']);
    expect(r.files).toEqual(['/b.pdf']);
  });

  it('EACCES treated as missing', () => {
    const r = classify(['/locked'], makeFs({ '/locked': 'eacces' }));
    expect(r.missing).toEqual(['/locked']);
  });

  it('extensions normalized to lowercase', () => {
    const r = classify(['/A.PDF', '/B.JpG'], makeFs({ '/A.PDF': 'file', '/B.JpG': 'file' }));
    expect(r.exts.sort()).toEqual(['.jpg', '.pdf']);
  });

  it('files without extension yield no ext entry', () => {
    const r = classify(['/README'], makeFs({ '/README': 'file' }));
    expect(r.exts).toEqual([]);
    expect(r.files).toEqual(['/README']);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/classify.test.js
```

Expected: 8 tests FAIL.

- [ ] **Step 3: Create `src/main/selection/classify.js`**

```js
function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null; // no dot, or leading dot (".gitignore" treated as no-ext file)
  return name.slice(i).toLowerCase();
}

function classify(targets, fs) {
  const folders = [];
  const files = [];
  const missing = [];
  const exts = new Set();
  const basenames = [];
  for (const t of targets) {
    const base = basenameOf(t);
    basenames.push(base);
    try {
      const st = fs.statSync(t);
      if (st.isDirectory()) {
        folders.push(t);
      } else if (st.isFile()) {
        files.push(t);
        const ext = extOf(base);
        if (ext) exts.add(ext);
      } else {
        missing.push(t);
      }
    } catch (_err) {
      missing.push(t);
    }
  }
  return { folders, files, missing, exts: [...exts], basenames };
}

module.exports = { classify, basenameOf };
```

- [ ] **Step 4: Run, expect 8 pass**

```
npm test -- tests/unit/classify.test.js
```

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: green.

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/selection/classify.js ContextHelper/tests/unit/classify.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add classify() pure target classifier

Walks a target list through an injected fs, separating into folders,
files (with normalized extensions), and missing/inaccessible entries.
Pure — no diagnostics, no throws. Used by the dispatcher's validation
phase to feed validate().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: validate (manifest vs selection)

**Files:**
- Create: `src/main/selection/validate.js`
- Create: `tests/unit/validate.test.js`

- [ ] **Step 1: Create test**

```js
const { validate } = require('../../src/main/selection/validate');

const m = (over = {}) => ({
  id: 'p', label: 'P',
  accepts: ['folders'],
  minSelection: 1, maxSelection: 999,
  ...over,
});
const sel = (over = {}) => ({
  folders: [], files: [], missing: [], exts: [], basenames: [],
  ...over,
});

describe('validate', () => {
  it('passes when all folders match accepts:folders', () => {
    const r = validate(m(), sel({ folders: ['/a', '/b'], basenames: ['a', 'b'] }));
    expect(r).toEqual({ ok: true });
  });

  it('fails MISSING when selection has missing paths', () => {
    const r = validate(m(), sel({ folders: ['/a'], missing: ['/gone'], basenames: ['a', 'gone'] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MISSING');
    expect(r.body).toMatch(/no longer exist/i);
    expect(r.body).toMatch(/gone/);
  });

  it('fails TYPE when accepts:folders but file given', () => {
    const r = validate(m({ accepts: ['folders'] }), sel({ files: ['/f.pdf'], basenames: ['f.pdf'], exts: ['.pdf'] }));
    expect(r.reason).toBe('TYPE');
    expect(r.body).toMatch(/works only with folders/);
    expect(r.body).toMatch(/f\.pdf/);
  });

  it('fails TYPE when accepts:files but folder given', () => {
    const r = validate(m({ accepts: ['files'] }), sel({ folders: ['/a'], basenames: ['a'] }));
    expect(r.reason).toBe('TYPE');
    expect(r.body).toMatch(/works only with files/);
  });

  it('fails EXTENSION when accepts:files:.pdf but jpg given', () => {
    const r = validate(m({ accepts: ['files:.pdf'] }), sel({ files: ['/a.jpg'], basenames: ['a.jpg'], exts: ['.jpg'] }));
    expect(r.reason).toBe('EXTENSION');
    expect(r.body).toMatch(/\.pdf/);
    expect(r.body).toMatch(/a\.jpg/);
  });

  it('passes EXTENSION when accepts:files:.pdf,.txt and files are .pdf+.txt', () => {
    const r = validate(m({ accepts: ['files:.pdf,.txt'] }), sel({ files: ['/a.pdf', '/b.txt'], basenames: ['a.pdf', 'b.txt'], exts: ['.pdf', '.txt'] }));
    expect(r).toEqual({ ok: true });
  });

  it('fails TYPE on mixed selection when plugin accepts only folders', () => {
    const r = validate(m({ accepts: ['folders'] }), sel({ folders: ['/a'], files: ['/f.pdf'], basenames: ['a', 'f.pdf'], exts: ['.pdf'] }));
    expect(r.reason).toBe('TYPE');
  });

  it('passes mixed when plugin accepts both', () => {
    const r = validate(m({ accepts: ['folders', 'files'] }), sel({ folders: ['/a'], files: ['/f.pdf'], basenames: ['a', 'f.pdf'], exts: ['.pdf'] }));
    expect(r).toEqual({ ok: true });
  });

  it('fails COUNT when below min', () => {
    const r = validate(m({ minSelection: 2 }), sel({ folders: ['/a'], basenames: ['a'] }));
    expect(r.reason).toBe('COUNT');
    expect(r.body).toMatch(/between 2 and 999/);
  });

  it('fails COUNT when above max', () => {
    const r = validate(m({ maxSelection: 2 }), sel({ folders: ['/a', '/b', '/c'], basenames: ['a', 'b', 'c'] }));
    expect(r.reason).toBe('COUNT');
  });

  it('first-failure-wins: MISSING before TYPE', () => {
    const r = validate(m({ accepts: ['files'] }), sel({ folders: ['/a'], missing: ['/gone'], basenames: ['a', 'gone'] }));
    expect(r.reason).toBe('MISSING');
  });

  it('accepts "folder" (singular) as equivalent to "folders" when count is 1', () => {
    const r = validate(m({ accepts: ['folder'], minSelection: 1, maxSelection: 1 }), sel({ folders: ['/a'], basenames: ['a'] }));
    expect(r).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/validate.test.js
```

Expected: 12 tests FAIL.

- [ ] **Step 3: Create `src/main/selection/validate.js`**

```js
const MAX_LIST = 10;

function plural(n, one, many) { return n === 1 ? one : many; }

function listBasenames(items) {
  const lines = [];
  for (const b of items.slice(0, MAX_LIST)) lines.push(`  • ${b}`);
  if (items.length > MAX_LIST) lines.push(`  … and ${items.length - MAX_LIST} more`);
  return lines.join('\n');
}

function acceptsFolders(accepts) {
  return accepts.some((p) => p === 'folder' || p === 'folders');
}

function acceptsAnyFile(accepts) {
  return accepts.some((p) => p === 'files' || p === 'file' || p.startsWith('files:') || p.startsWith('file:'));
}

function allowedExts(accepts) {
  const out = new Set();
  let acceptsAllFiles = false;
  for (const p of accepts) {
    if (p === 'files' || p === 'file') acceptsAllFiles = true;
    else if (p.startsWith('files:')) {
      for (const e of p.slice('files:'.length).split(',')) out.add(e.trim().toLowerCase());
    } else if (p.startsWith('file:')) {
      for (const e of p.slice('file:'.length).split(',')) out.add(e.trim().toLowerCase());
    }
  }
  return { acceptsAllFiles, exts: [...out] };
}

function rangeText(min, max) {
  if (min === max) return `exactly ${min} ${plural(min, 'item', 'items')}`;
  return `between ${min} and ${max} items`;
}

function validate(manifest, selection) {
  const { accepts, minSelection, maxSelection, label } = manifest;
  const { folders, files, missing, exts, basenames } = selection;

  // 1. MISSING
  if (missing.length > 0) {
    const body = [
      `Selection contains ${missing.length} ${plural(missing.length, 'path', 'paths')} that no longer exist or are inaccessible:`,
      ...missing.slice(0, MAX_LIST).map((m) => `  • ${m}`),
    ];
    if (missing.length > MAX_LIST) body.push(`  … and ${missing.length - MAX_LIST} more`);
    body.push('Operation cancelled.');
    return { ok: false, reason: 'MISSING', body: body.join('\n') };
  }

  // 2. TYPE
  const hasFolders = folders.length > 0;
  const hasFiles = files.length > 0;
  const acceptF = acceptsFolders(accepts);
  const acceptFile = acceptsAnyFile(accepts);

  if (hasFolders && !acceptF) {
    const body = [
      `${label} works only with files.`,
      `Selection contains ${folders.length} ${plural(folders.length, 'folder', 'folders')}:`,
      listBasenames(folders.map((_, i) => basenames[i])),
      'Operation cancelled.',
    ].join('\n');
    return { ok: false, reason: 'TYPE', body };
  }
  if (hasFiles && !acceptFile) {
    const body = [
      `${label} works only with folders.`,
      `Selection contains ${files.length} ${plural(files.length, 'file', 'files')}:`,
      listBasenames(basenames.slice(folders.length, folders.length + files.length)),
      'Operation cancelled.',
    ].join('\n');
    return { ok: false, reason: 'TYPE', body };
  }

  // 3. EXTENSION
  if (hasFiles) {
    const { acceptsAllFiles, exts: allowed } = allowedExts(accepts);
    if (!acceptsAllFiles) {
      const bad = exts.filter((e) => !allowed.includes(e));
      if (bad.length > 0) {
        const body = [
          `${label} works only with ${allowed.join(', ')} files.`,
          `Selection contains files with unsupported extension(s): ${bad.join(', ')}`,
          'Operation cancelled.',
        ].join('\n');
        return { ok: false, reason: 'EXTENSION', body };
      }
    }
  }

  // 4. COUNT
  const total = folders.length + files.length;
  if (total < minSelection || total > maxSelection) {
    return {
      ok: false,
      reason: 'COUNT',
      body: `"${label}" accepts ${rangeText(minSelection, maxSelection)}, but ${total} ${plural(total, 'was', 'were')} selected.`,
    };
  }

  return { ok: true };
}

module.exports = { validate };
```

- [ ] **Step 4: Run, expect 12 pass**

```
npm test -- tests/unit/validate.test.js
```

- [ ] **Step 5: Run full suite, expect green**

```
npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/selection/validate.js ContextHelper/tests/unit/validate.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add validate() for manifest vs selection

Pure validator: takes a manifest and a classify() result, returns
{ ok: true } or { ok: false, reason, body }. Checks (first-failure-wins):
MISSING → TYPE → EXTENSION → COUNT. Body is the exact text used by
the dispatcher's error dialog.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: menu-tree (group plugins by accepts)

**Files:**
- Create: `src/main/registry/menu-tree.js`
- Create: `tests/unit/menu-tree.test.js`

- [ ] **Step 1: Create test**

```js
const { buildMenuTree, categoriseAccepts } = require('../../src/main/registry/menu-tree');

const p = (id, accepts) => ({ manifest: { id, accepts, label: id } });

describe('categoriseAccepts', () => {
  it('folder/folders → folders', () => {
    expect(categoriseAccepts(['folder']).sort()).toEqual(['folders']);
    expect(categoriseAccepts(['folders']).sort()).toEqual(['folders']);
  });
  it('files/files:* → files', () => {
    expect(categoriseAccepts(['files']).sort()).toEqual(['files']);
    expect(categoriseAccepts(['files:.pdf']).sort()).toEqual(['files']);
  });
  it('both kinds → both', () => {
    expect(categoriseAccepts(['folders', 'files:.pdf']).sort()).toEqual(['files', 'folders']);
  });
});

describe('buildMenuTree', () => {
  it('folder-only plugin appears only in folders group', () => {
    const tree = buildMenuTree([p('flatten-folder', ['folders'])]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['flatten-folder']);
    expect(tree.files).toEqual([]);
  });

  it('file-only plugin appears only in files group', () => {
    const tree = buildMenuTree([p('merge-pdf', ['files:.pdf'])]);
    expect(tree.folders).toEqual([]);
    expect(tree.files.map((x) => x.manifest.id)).toEqual(['merge-pdf']);
  });

  it('plugin accepting both kinds appears in both groups', () => {
    const tree = buildMenuTree([p('rename', ['folders', 'files'])]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['rename']);
    expect(tree.files.map((x) => x.manifest.id)).toEqual(['rename']);
  });

  it('plugins sorted alphabetically within a group', () => {
    const tree = buildMenuTree([
      p('zip', ['folders']),
      p('aaa', ['folders']),
      p('mid', ['folders']),
    ]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['aaa', 'mid', 'zip']);
  });

  it('empty groups returned as empty arrays', () => {
    const tree = buildMenuTree([p('flatten-folder', ['folders'])]);
    expect(tree.files).toEqual([]);
  });

  it('unknown accepts pattern is ignored', () => {
    const tree = buildMenuTree([p('weird', ['nonsense:x'])]);
    expect(tree.folders).toEqual([]);
    expect(tree.files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/menu-tree.test.js
```

- [ ] **Step 3: Create `src/main/registry/menu-tree.js`**

```js
function categoriseAccepts(accepts) {
  const cats = new Set();
  for (const pat of accepts) {
    if (pat === 'folder' || pat === 'folders') cats.add('folders');
    else if (pat === 'files' || pat === 'file' || pat.startsWith('files:') || pat.startsWith('file:')) cats.add('files');
  }
  return [...cats];
}

function buildMenuTree(plugins) {
  const folders = [];
  const files = [];
  for (const p of plugins) {
    const cats = categoriseAccepts(p.manifest.accepts);
    if (cats.includes('folders')) folders.push(p);
    if (cats.includes('files')) files.push(p);
  }
  const byId = (a, b) => a.manifest.id.localeCompare(b.manifest.id);
  folders.sort(byId);
  files.sort(byId);
  return { folders, files };
}

module.exports = { buildMenuTree, categoriseAccepts };
```

- [ ] **Step 4: Run, expect 9 pass**

```
npm test -- tests/unit/menu-tree.test.js
```

- [ ] **Step 5: Run full suite, expect green**

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/registry/menu-tree.js ContextHelper/tests/unit/menu-tree.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add menu-tree builder for Folders/Files groups

Pure: takes a plugin list, returns { folders: [], files: [] } based on
each manifest.accepts. A plugin accepting both kinds appears in both
groups. Within a group, plugins are sorted alphabetically by id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: safe-hook helper

**Files:**
- Create: `src/main/runners/safe-hook.js`
- Create: `tests/unit/safe-hook.test.js`

- [ ] **Step 1: Create test**

```js
const { safeHook } = require('../../src/main/runners/safe-hook');

describe('safeHook', () => {
  it('returns override result when plugin defines the hook', () => {
    const plugin = { greet: (name) => `hello ${name}` };
    const logger = { error: () => {} };
    const out = safeHook(plugin, 'greet', (name) => `default ${name}`, logger, 'world');
    expect(out).toBe('hello world');
  });

  it('falls back to default when plugin does not define the hook', () => {
    const plugin = {};
    const logger = { error: () => {} };
    const out = safeHook(plugin, 'greet', (name) => `default ${name}`, logger, 'world');
    expect(out).toBe('default world');
  });

  it('falls back to default and logs when override throws', () => {
    const plugin = {
      constructor: { name: 'BadPlugin' },
      boom: () => { throw new Error('oops'); },
    };
    const logged = [];
    const logger = { error: (msg, meta) => logged.push({ msg, meta }) };
    const out = safeHook(plugin, 'boom', () => 'default', logger);
    expect(out).toBe('default');
    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toMatch(/hook threw/);
    expect(logged[0].meta).toMatchObject({ plugin: 'BadPlugin', hook: 'boom', message: 'oops' });
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/safe-hook.test.js
```

- [ ] **Step 3: Create `src/main/runners/safe-hook.js`**

```js
function safeHook(plugin, name, defaultFn, logger, ...args) {
  if (plugin && typeof plugin[name] === 'function') {
    try {
      return plugin[name](...args);
    } catch (err) {
      logger.error('plugin hook threw', {
        plugin: plugin.constructor ? plugin.constructor.name : 'unknown',
        hook: name,
        message: err.message,
      });
    }
  }
  return defaultFn(...args);
}

module.exports = { safeHook };
```

- [ ] **Step 4: Run, expect 3 pass**

```
npm test -- tests/unit/safe-hook.test.js
```

- [ ] **Step 5: Run full suite, expect green**

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/runners/safe-hook.js ContextHelper/tests/unit/safe-hook.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add safeHook helper for plugin overrides

Calls plugin[hookName](...args) if defined; on throw, logs and falls
back to the supplied default. Prevents buggy plugin overrides from
breaking runner flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: plugin-loader (loads class plugins)

**Files:**
- Create: `src/main/registry/plugin-loader.js`
- Create: `tests/unit/plugin-loader.test.js`

This loader will REPLACE `plugin-registry.js`, but we leave the old file alone for now — it gets deleted in Task 12. The new loader expects `plugin.js` exporting a class extending BasePlugin. flatten-folder is converted to that shape in Task 7.

- [ ] **Step 1: Create test**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAll } = require('../../src/main/registry/plugin-loader');

function mkPlugin(root, id, sourceJs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.js'), sourceJs);
  return dir;
}

const VALID_CLASS_SRC = (id = 'p1') => `
const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
class P extends BasePlugin {
  static get manifest() {
    return { id: ${JSON.stringify(id)}, label: 'L', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'dialog' };
  }
  async preflight() { return { folders: [], totalFiles: 0, totalCollisions: 0 }; }
  async run() { return { ok: true, processed: 0, skipped: 0, errors: [] }; }
}
module.exports = P;
`;

describe('plugin-loader', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-loader-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('loads a valid class plugin', () => {
    mkPlugin(tmp, 'p1', VALID_CLASS_SRC('p1'));
    const reg = loadAll(tmp);
    const entry = reg.get('p1');
    expect(entry).toBeDefined();
    expect(entry.manifest.id).toBe('p1');
    expect(typeof entry.Cls).toBe('function');
    expect(entry.dir).toBe(path.join(tmp, 'p1'));
  });

  it('ignores subdirectories without plugin.js', () => {
    fs.mkdirSync(path.join(tmp, 'empty'));
    const reg = loadAll(tmp);
    expect(reg.size).toBe(0);
  });

  it('throws when plugin.js has a syntax error', () => {
    mkPlugin(tmp, 'broken', 'class { syntax error');
    expect(() => loadAll(tmp)).toThrow(/Plugin "broken"/);
  });

  it('throws when plugin export is not a function', () => {
    mkPlugin(tmp, 'notfn', 'module.exports = { foo: 1 };');
    expect(() => loadAll(tmp)).toThrow(/Plugin "notfn".*class/i);
  });

  it('throws when static manifest is missing', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin { async preflight() {} async run() {} }
      module.exports = P;
    `;
    mkPlugin(tmp, 'nomanifest', src);
    expect(() => loadAll(tmp)).toThrow(/manifest/);
  });

  it('throws when manifest id mismatches folder name', () => {
    mkPlugin(tmp, 'p1', VALID_CLASS_SRC('WRONG'));
    expect(() => loadAll(tmp)).toThrow(/id mismatch/i);
  });

  it('throws when manifest is missing required fields', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin {
        static get manifest() { return { id: 'p1' }; }
        async preflight() {} async run() {}
      }
      module.exports = P;
    `;
    mkPlugin(tmp, 'p1', src);
    expect(() => loadAll(tmp)).toThrow(/label/);
  });

  it('throws on invalid ui value', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin {
        static get manifest() {
          return { id: 'p1', label: 'L', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'invalid' };
        }
        async preflight() {} async run() {}
      }
      module.exports = P;
    `;
    mkPlugin(tmp, 'p1', src);
    expect(() => loadAll(tmp)).toThrow(/ui.*must be/i);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/plugin-loader.test.js
```

- [ ] **Step 3: Create `src/main/registry/plugin-loader.js`**

```js
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = ['id', 'label', 'description', 'accepts', 'minSelection', 'maxSelection'];

function validateManifest(manifest, folderName) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Plugin "${folderName}": static manifest must be an object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`Plugin "${folderName}": manifest missing required field "${field}"`);
    }
  }
  if (typeof manifest.label !== 'string' || manifest.label.length === 0) {
    throw new Error(`Plugin "${folderName}": "label" must be a non-empty string`);
  }
  if (typeof manifest.description !== 'string') {
    throw new Error(`Plugin "${folderName}": "description" must be a string`);
  }
  if (!Number.isInteger(manifest.minSelection) || manifest.minSelection < 1) {
    throw new Error(`Plugin "${folderName}": "minSelection" must be a positive integer`);
  }
  if (!Number.isInteger(manifest.maxSelection) || manifest.maxSelection < manifest.minSelection) {
    throw new Error(`Plugin "${folderName}": "maxSelection" must be an integer ≥ minSelection`);
  }
  if (manifest.id !== folderName) {
    throw new Error(`Plugin "${folderName}": id mismatch (manifest says "${manifest.id}")`);
  }
  if (!Array.isArray(manifest.accepts) || manifest.accepts.length === 0) {
    throw new Error(`Plugin "${folderName}": "accepts" must be a non-empty array`);
  }
  for (const pattern of manifest.accepts) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error(`Plugin "${folderName}": "accepts" entries must be non-empty strings`);
    }
  }
  if (manifest.ui !== undefined && manifest.ui !== 'window' && manifest.ui !== 'dialog') {
    throw new Error(`Plugin "${folderName}": "ui" must be "window" or "dialog" (got ${JSON.stringify(manifest.ui)})`);
  }
}

function loadAll(pluginsDir) {
  const registry = new Map();
  if (!fs.existsSync(pluginsDir)) return registry;
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginPath = path.join(pluginsDir, entry.name, 'plugin.js');
    if (!fs.existsSync(pluginPath)) continue;
    let Cls;
    try {
      delete require.cache[require.resolve(pluginPath)];
      Cls = require(pluginPath);
    } catch (err) {
      throw new Error(`Plugin "${entry.name}": failed to load — ${err.message}`);
    }
    if (typeof Cls !== 'function' || !Cls.prototype || typeof Cls.prototype.run !== 'function') {
      throw new Error(`Plugin "${entry.name}": does not export a class with run()`);
    }
    let manifest;
    try {
      manifest = Cls.manifest;
    } catch (err) {
      throw new Error(`Plugin "${entry.name}": reading static manifest threw — ${err.message}`);
    }
    validateManifest(manifest, entry.name);
    const normalized = { ...manifest, ui: manifest.ui || 'window' };
    registry.set(manifest.id, {
      Cls,
      manifest: normalized,
      dir: path.join(pluginsDir, entry.name),
    });
  }
  return registry;
}

module.exports = { loadAll, validateManifest };
```

- [ ] **Step 4: Run, expect 8 pass**

```
npm test -- tests/unit/plugin-loader.test.js
```

- [ ] **Step 5: Run full suite, expect green**

```
npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/registry/plugin-loader.js ContextHelper/tests/unit/plugin-loader.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add plugin-loader for class-based plugins

Scans plugins/*/plugin.js, requires each, asserts the export is a
class with a run() method on its prototype, reads static manifest,
validates fields (same rules as the legacy plugin-registry plus class
checks), and returns Map<id, { Cls, manifest, dir }>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Convert flatten-folder to class + worker-shim class loader

**Files:**
- Create: `plugins/flatten-folder/plugin.js`
- Delete: `plugins/flatten-folder/worker.js`
- Delete: `plugins/flatten-folder/manifest.json`
- Modify: `src/worker/worker-shim.js`
- Modify: `tests/unit/flatten-folder.test.js`
- Modify: `tests/unit/worker-shim.test.js`
- Modify: `tests/smoke/runner.js`

This task combines plugin rewrite, shim update, and test adaptation because they're tightly coupled — old shim is wired for object/function exports; new class shape requires new shim. Doing them together avoids a transient broken-suite state.

- [ ] **Step 1: Create `plugins/flatten-folder/plugin.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const MAX_LIST = 10;
const plural = (n, one, many) => n === 1 ? one : many;

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

  async preflight({ targets }) {
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

  async run({ targets, onProgress = () => {}, signal }) {
    let processed = 0, skipped = 0;
    const errors = [];
    for (const root of targets) {
      const { toMove, takenInRoot } = walkAndPlan(root);
      const taken = new Set(takenInRoot);
      const total = toMove.length;
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
          onProgress({ processed, total, current: target });
        } catch (err) {
          errors.push({ file: path.relative(root, src), message: err.message });
          skipped++;
        }
      }
      pruneEmptyDirs(root);
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) {
    return pre && pre.totalFiles === 0;
  }

  buildNothingToDoBody(_ctx, _pre) {
    return {
      message: 'Nothing to do.',
      detail: 'Selected folder(s) are already flat.',
    };
  }

  buildConfirmMessage(_ctx, pre) {
    const { folders, totalFiles, totalCollisions } = pre;
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
```

- [ ] **Step 2: Delete old files**

```
git -C "C:\YandexDisk\Software\bin" rm ContextHelper/plugins/flatten-folder/worker.js ContextHelper/plugins/flatten-folder/manifest.json
```

- [ ] **Step 3: Replace `src/worker/worker-shim.js`**

```js
// Forked entry. Receives one IPC message of either:
//   { type: 'start',     workerPath, targets, options, selection }
//   { type: 'preflight', workerPath, targets, selection }
//   { type: 'cancel' }
// Plugin module shape: a class with run() (and optionally preflight()) on its prototype.
const { WORKER_MSG } = require('../shared/plugin-api');

const cancelState = { aborted: false };
const signal = { get aborted() { return cancelState.aborted; } };

function loadPluginInstance(workerPath) {
  const Cls = require(workerPath);
  if (typeof Cls !== 'function' || !Cls.prototype || typeof Cls.prototype.run !== 'function') {
    throw new Error(`Plugin at ${workerPath} does not export a class with run()`);
  }
  return new Cls();
}

async function handleStart(msg) {
  const { workerPath, targets, options, selection } = msg;
  let reported = false;
  try {
    const instance = loadPluginInstance(workerPath);
    const result = await instance.run({
      targets,
      options,
      selection,
      onProgress: (p) => { try { process.send({ kind: WORKER_MSG.PROGRESS, payload: p }); } catch {} },
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
  const { workerPath, targets, selection } = msg;
  let reported = false;
  try {
    const instance = loadPluginInstance(workerPath);
    if (typeof instance.preflight !== 'function') {
      throw new Error(`Plugin at ${workerPath} does not implement preflight()`);
    }
    const result = await instance.preflight({ targets, selection, signal });
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

- [ ] **Step 4: Replace `tests/unit/flatten-folder.test.js`**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FlattenFolder = require('../../plugins/flatten-folder/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

describe('FlattenFolder', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = FlattenFolder.manifest;
    expect(m).toMatchObject({
      id: 'flatten-folder',
      label: 'Flatten folder',
      accepts: ['folders'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    });
  });

  it('run moves all nested files to root', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/b/2.txt': '2', 'c/3.txt': '3' });
    const result = await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(result.ok).toBe(true);
    expect(listFiles(tmp)).toEqual(['1.txt', '2.txt', '3.txt']);
    expect(result.processed).toBe(3);
  });

  it('run resolves name collisions with (N) suffix', async () => {
    tree(tmp, { 'a/photo.jpg': 'A', 'b/photo.jpg': 'B', 'c/photo.jpg': 'C' });
    await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['photo (2).jpg', 'photo (3).jpg', 'photo.jpg']);
  });

  it('run removes empty subfolders after flattening', async () => {
    tree(tmp, { 'a/b/c/deep.txt': 'x' });
    await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(fs.existsSync(path.join(tmp, 'a'))).toBe(false);
  });

  it('run preserves already-flat folder unchanged', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const result = await new FlattenFolder().run({ targets: [tmp], onProgress: () => {} });
    expect(listFiles(tmp)).toEqual(['a.txt', 'b.txt']);
    expect(result.processed).toBe(0);
  });

  it('run emits progress events', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2' });
    const events = [];
    await new FlattenFolder().run({ targets: [tmp], onProgress: (p) => events.push(p) });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toMatchObject({ processed: 2, total: 2 });
  });

  it('run respects abort signal mid-run', async () => {
    tree(tmp, { 'a/1.txt': '1', 'a/2.txt': '2', 'a/3.txt': '3', 'a/4.txt': '4' });
    const controller = new AbortController();
    const promise = new FlattenFolder().run({
      targets: [tmp],
      onProgress: (p) => { if (p.processed === 2) controller.abort(); },
      signal: controller.signal,
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.processed).toBeLessThan(4);
  });

  it('preflight counts files and collisions for a single folder', async () => {
    tree(tmp, { 'a/x.txt': '1', 'a/y.txt': '2', 'b/x.txt': '3', 'c/z.txt': '4' });
    const result = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0]).toMatchObject({
      basename: path.basename(tmp), fileCount: 4, collisionCount: 1,
    });
    expect(result.totalFiles).toBe(4);
    expect(result.totalCollisions).toBe(1);
  });

  it('preflight aggregates across multiple folders', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-flatten-b-'));
    try {
      tree(tmp, { 'sub/a.txt': 'a', 'sub/b.txt': 'b' });
      tree(tmp2, { 'sub/c.txt': 'c' });
      const result = await new FlattenFolder().preflight({ targets: [tmp, tmp2] });
      expect(result.folders).toHaveLength(2);
      expect(result.totalFiles).toBe(3);
      expect(result.totalCollisions).toBe(0);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('preflight returns totalFiles: 0 for an already-flat folder', async () => {
    tree(tmp, { 'a.txt': 'A', 'b.txt': 'B' });
    const result = await new FlattenFolder().preflight({ targets: [tmp] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    tree(tmp, { 'a/x.txt': 'X', 'a/b/y.txt': 'Y' });
    const before = fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs;
    await new FlattenFolder().preflight({ targets: [tmp] });
    expect(fs.statSync(path.join(tmp, 'a', 'x.txt')).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(tmp, 'a', 'b'))).toBe(true);
  });

  it('isEmpty returns true when totalFiles is 0', () => {
    const p = new FlattenFolder();
    expect(p.isEmpty({}, { totalFiles: 0 })).toBe(true);
    expect(p.isEmpty({}, { totalFiles: 3 })).toBe(false);
  });

  it('buildConfirmMessage handles single folder', () => {
    const p = new FlattenFolder();
    const out = p.buildConfirmMessage({}, { folders: [{ basename: 'a', fileCount: 3, collisionCount: 0 }], totalFiles: 3, totalCollisions: 0 });
    expect(out.message).toBe('Flatten this folder?');
    expect(out.detail).toMatch(/You selected 1 folder/);
  });

  it('buildConfirmMessage handles multiple folders', () => {
    const p = new FlattenFolder();
    const out = p.buildConfirmMessage({}, {
      folders: [{ basename: 'a', fileCount: 2, collisionCount: 0 }, { basename: 'b', fileCount: 3, collisionCount: 1 }],
      totalFiles: 5,
      totalCollisions: 1,
    });
    expect(out.message).toBe('Flatten 2 folders?');
    expect(out.detail).toMatch(/independently/);
    expect(out.detail).toMatch(/• a/);
    expect(out.detail).toMatch(/• b/);
    expect(out.detail).toMatch(/5 files total/);
    expect(out.detail).toMatch(/1 name collision/);
  });
});
```

- [ ] **Step 5: Replace `tests/unit/worker-shim.test.js`**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const SHIM = path.resolve(__dirname, '..', '..', 'src', 'worker', 'worker-shim.js');
const BASE_PLUGIN_PATH = path.resolve(__dirname, '..', '..', 'src', 'shared', 'base-plugin');

function runShim(message) {
  return new Promise((resolve, reject) => {
    const child = fork(SHIM, [], { silent: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages = [];
    child.on('message', (m) => messages.push(m));
    child.on('exit', (code) => resolve({ code, messages }));
    child.on('error', reject);
    child.send(message);
  });
}

function writeClassPlugin(dir, body) {
  const src = `
const { BasePlugin } = require(${JSON.stringify(BASE_PLUGIN_PATH)});
class P extends BasePlugin {
  static get manifest() { return { id: 'p', label: 'P', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'dialog' }; }
  ${body}
}
module.exports = P;
`;
  const p = path.join(dir, 'plugin.js');
  fs.writeFileSync(p, src);
  return p;
}

describe('worker-shim', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shim-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('routes start to instance.run() of a class plugin', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { return {}; }
      async run({ targets }) { return { ok: true, processed: targets.length, skipped: 0, errors: [] }; }
    `);
    const { code, messages } = await runShim({ type: 'start', workerPath, targets: ['a', 'b'], options: {} });
    expect(code).toBe(0);
    const complete = messages.find((m) => m.kind === 'worker:complete');
    expect(complete?.payload).toMatchObject({ ok: true, processed: 2 });
  });

  it('routes preflight to instance.preflight()', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight({ targets }) { return { folders: [{ basename: 'x', fileCount: 1, collisionCount: 0 }], totalFiles: 1, totalCollisions: 0 }; }
      async run() { throw new Error('should not run'); }
    `);
    const { code, messages } = await runShim({ type: 'preflight', workerPath, targets: ['x'] });
    expect(code).toBe(0);
    const result = messages.find((m) => m.kind === 'worker:preflight-complete');
    expect(result?.payload?.totalFiles).toBe(1);
  });

  it('reports ERROR when plugin export is not a class', async () => {
    const p = path.join(tmp, 'plugin.js');
    fs.writeFileSync(p, 'module.exports = { foo: 1 };');
    const { messages } = await runShim({ type: 'start', workerPath: p, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toMatch(/does not export a class/);
  });

  it('reports ERROR when run() throws', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { return {}; }
      async run() { throw new Error('run-boom'); }
    `);
    const { messages } = await runShim({ type: 'start', workerPath, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toBe('run-boom');
  });

  it('reports PREFLIGHT_ERROR when preflight() throws', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async preflight() { throw new Error('pre-boom'); }
      async run() {}
    `);
    const { messages } = await runShim({ type: 'preflight', workerPath, targets: [] });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toBe('pre-boom');
  });

  it('reports PREFLIGHT_ERROR when plugin does not implement preflight', async () => {
    const workerPath = writeClassPlugin(tmp, `
      async run() {}
    `);
    const { messages } = await runShim({ type: 'preflight', workerPath, targets: [] });
    const err = messages.find((m) => m.kind === 'worker:preflight-error');
    expect(err?.payload?.message).toMatch(/does not implement preflight/i);
  });

  it('reports ERROR when require fails (syntax error)', async () => {
    const p = path.join(tmp, 'plugin.js');
    fs.writeFileSync(p, 'syntax error;');
    const { messages } = await runShim({ type: 'start', workerPath: p, targets: [], options: {} });
    const err = messages.find((m) => m.kind === 'worker:error');
    expect(err?.payload?.message).toBeTruthy();
  });
});
```

- [ ] **Step 6: Update `tests/smoke/runner.js`**

Replace the `flatten-folder` case block with:

```js
cases.push({
  id: 'flatten-folder',
  async run() {
    const FlattenFolder = require('../../plugins/flatten-folder/plugin');
    const instance = new FlattenFolder();
    const dir = buildFlattenFixture();
    try {
      const pre = await instance.preflight({ targets: [dir] });
      if (typeof pre.totalFiles !== 'number') throw new Error('preflight returned no totalFiles');
      const result = await instance.run({ targets: [dir], options: {}, onProgress: () => {} });
      const rootFiles = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile()).map((e) => e.name).sort();
      const subdirs = fs.readdirSync(dir, { withFileTypes: true })
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

- [ ] **Step 7: Run tests**

```
npm test
```

Expected: flatten-folder.test.js: 14 pass. worker-shim.test.js: 7 pass. Other suites unchanged.

But: `dialog-flow.js` (still present) and `plugin-registry.js` (still present) reference the deleted `worker.js` and `manifest.json`. The dialog-flow runtime would break IF an Explorer invocation happened, but tests should still pass since they mock the workerPath. Verify by running the full suite:

```
npm test
```

Expected: all green (dialog-flow.test.js uses mocks, not the real path).

Run smoke:

```
npm run smoke
```

Expected: `flatten-folder ✓ 5 files → 5 in root`.

- [ ] **Step 8: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/flatten-folder/plugin.js ContextHelper/plugins/flatten-folder/worker.js ContextHelper/plugins/flatten-folder/manifest.json ContextHelper/src/worker/worker-shim.js ContextHelper/tests/unit/flatten-folder.test.js ContextHelper/tests/unit/worker-shim.test.js ContextHelper/tests/smoke/runner.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): convert flatten-folder to class + worker-shim class loader

Plugin is now a single plugin.js exporting a class extending BasePlugin
with a static manifest getter (manifest.json deleted; worker.js deleted).
Worker-shim instantiates the class and calls instance.preflight() /
instance.run() — legacy function/object exports no longer supported.
Tests, smoke, and shim coverage all adapted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: base-runner (worker-runner adapter for runners)

**Files:**
- Create: `src/main/runners/base-runner.js`
- Create: `tests/unit/base-runner.test.js`

This is a thin wrapper that runners share for spinning up worker forks and converting their callback-based API into a Promise. It also pre-builds the worker-runner message including `selection`.

- [ ] **Step 1: Create test**

```js
const { runWorkerPromise, runPreflightPromise } = require('../../src/main/runners/base-runner');

describe('runWorkerPromise', () => {
  it('resolves with onComplete payload', async () => {
    const mockRunWorker = ({ onComplete }) => {
      setTimeout(() => onComplete({ ok: true, processed: 3 }), 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result).toEqual({ kind: 'complete', result: { ok: true, processed: 3 } });
  });

  it('resolves with onError payload', async () => {
    const mockRunWorker = ({ onError }) => {
      setTimeout(() => onError({ message: 'boom' }), 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result).toEqual({ kind: 'error', error: { message: 'boom' } });
  });

  it('resolves with error when runWorker throws synchronously', async () => {
    const mockRunWorker = () => { throw new Error('sync-fail'); };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result.kind).toBe('error');
    expect(result.error.message).toBe('sync-fail');
  });

  it('settles only once when both onComplete and onError fire', async () => {
    const mockRunWorker = ({ onComplete, onError }) => {
      setTimeout(() => { onComplete({ ok: true }); onError({ message: 'late' }); }, 5);
      return { cancel() {} };
    };
    const result = await runWorkerPromise(mockRunWorker, { workerPath: 'x', targets: [], options: {} });
    expect(result.kind).toBe('complete');
  });
});

describe('runPreflightPromise', () => {
  it('passes through to injected runPreflight', async () => {
    const mockRunPreflight = async ({ workerPath, targets }) => ({ folders: [], totalFiles: 0, totalCollisions: 0, _wp: workerPath, _t: targets });
    const out = await runPreflightPromise(mockRunPreflight, { workerPath: 'x', targets: ['a'], selection: {} });
    expect(out._wp).toBe('x');
    expect(out._t).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/base-runner.test.js
```

- [ ] **Step 3: Create `src/main/runners/base-runner.js`**

```js
function runWorkerPromise(runWorker, { workerPath, targets, options, selection, onProgress }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      runWorker({
        workerPath,
        targets,
        options: options || {},
        selection,
        onProgress: onProgress || (() => {}),
        onComplete: (r) => settle({ kind: 'complete', result: r }),
        onError: (e) => settle({ kind: 'error', error: e }),
      });
    } catch (err) {
      settle({ kind: 'error', error: { message: err.message } });
    }
  });
}

function runPreflightPromise(runPreflight, { workerPath, targets, selection }) {
  return runPreflight({ workerPath, targets, selection });
}

module.exports = { runWorkerPromise, runPreflightPromise };
```

- [ ] **Step 4: Run, expect 5 pass**

```
npm test -- tests/unit/base-runner.test.js
```

- [ ] **Step 5: Run full suite, expect green**

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/runners/base-runner.js ContextHelper/tests/unit/base-runner.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add base-runner Promise wrappers

runWorkerPromise() converts the callback-based worker-runner into a
Promise that resolves with {kind:'complete'|'error', ...}. Sync throws
from the underlying fork are normalized into the error branch. Used by
dialog-runner and window-runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: dialog-runner (replaces dialog-flow with plugin hooks)

**Files:**
- Create: `src/main/runners/dialog-runner.js`
- Create: `tests/unit/dialog-runner.test.js`

This module replaces `dialog-flow.js`. The old file stays in place until Task 12 deletes it (avoiding a transient broken state).

- [ ] **Step 1: Create test**

```js
const { runDialogPlugin } = require('../../src/main/runners/dialog-runner');
const { BasePlugin } = require('../../src/shared/base-plugin');

function makeDialogMock(confirmResponse = 0) {
  const calls = [];
  return {
    calls,
    showMessageBox: async (opts) => {
      calls.push({ kind: 'msg', opts });
      return { response: opts.type === 'question' ? confirmResponse : 0 };
    },
    showErrorBox: (title, body) => calls.push({ kind: 'err', title, body }),
  };
}

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 's', label: 'Stub', accepts: ['folders'] }; }
  async preflight() {}
  async run() {}
}

const manifest = { id: 's', label: 'Stub', accepts: ['folders'], ui: 'dialog' };

describe('runDialogPlugin', () => {
  it('exits 0 silently when isEmpty returns true', async () => {
    const dlg = makeDialogMock();
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [], totalFiles: 0, totalCollisions: 0 }),
      runWorker: () => { throw new Error('should not run'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(dlg.calls.some((c) => c.kind === 'msg' && c.opts.type === 'info')).toBe(true);
  });

  it('exits 0 silently on Cancel', async () => {
    const dlg = makeDialogMock(1);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });

  it('exits 0 on successful run', async () => {
    const dlg = makeDialogMock(0);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: true, processed: 3, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });

  it('exits 1 on partial run errors', async () => {
    const dlg = makeDialogMock(0);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 5 }], totalFiles: 5, totalCollisions: 0 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({
          ok: false, processed: 3, skipped: 2,
          errors: [{ file: 'x', message: 'EACCES' }, { file: 'y', message: 'EBUSY' }],
        }), 5);
        return { cancel() {} };
      },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(1);
    const err = dlg.calls.find((c) => c.kind === 'err');
    expect(err).toBeTruthy();
    expect(err.body).toMatch(/EACCES/);
  });

  it('exits 3 on preflight crash', async () => {
    const dlg = makeDialogMock();
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => { throw new Error('pre-boom'); },
      runWorker: () => { throw new Error('not called'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
    expect(dlg.calls.find((c) => c.kind === 'err').body).toMatch(/pre-boom/);
  });

  it('exits 3 on async run worker error', async () => {
    const dlg = makeDialogMock(0);
    const code = await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 3 }], totalFiles: 3, totalCollisions: 0 }),
      runWorker: ({ onError }) => {
        setTimeout(() => onError({ message: 'EPIPE' }), 5);
        return { cancel() {} };
      },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
  });

  it('uses plugin override for buildConfirmMessage', async () => {
    class CustomPlugin extends BasePlugin {
      static get manifest() { return manifest; }
      async preflight() {}
      async run() {}
      buildConfirmMessage() { return { message: 'CUSTOM_MSG', detail: 'CUSTOM_DETAIL' }; }
    }
    const dlg = makeDialogMock(1);
    await runDialogPlugin({
      manifest,
      plugin: new CustomPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error() {} },
    });
    const confirm = dlg.calls.find((c) => c.kind === 'msg' && c.opts.type === 'question');
    expect(confirm.opts.message).toBe('CUSTOM_MSG');
    expect(confirm.opts.detail).toBe('CUSTOM_DETAIL');
  });

  it('falls back to BasePlugin default when buildConfirmMessage throws', async () => {
    class BadPlugin extends BasePlugin {
      static get manifest() { return manifest; }
      async preflight() {}
      async run() {}
      buildConfirmMessage() { throw new Error('hook-boom'); }
    }
    const dlg = makeDialogMock(1);
    const logged = [];
    await runDialogPlugin({
      manifest,
      plugin: new BadPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: dlg,
      runPreflight: async () => ({ folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 }),
      runWorker: () => { throw new Error('not called'); },
      openSpinner: () => ({ close() {} }),
      logger: { info() {}, error: (msg, meta) => logged.push({ msg, meta }) },
    });
    expect(logged.some((l) => l.msg.match(/hook threw/))).toBe(true);
    const confirm = dlg.calls.find((c) => c.kind === 'msg' && c.opts.type === 'question');
    expect(confirm.opts.message).toMatch(/Process \d+ item/);
  });

  it('opens scan spinner before preflight and closes after', async () => {
    const events = [];
    await runDialogPlugin({
      manifest,
      plugin: new StubPlugin(),
      pluginDir: '/fake',
      targets: ['/a'],
      selection: { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] },
      dialog: makeDialogMock(1),
      runPreflight: async () => {
        events.push('preflight-running');
        return { folders: [{ basename: 'a', fileCount: 1 }], totalFiles: 1, totalCollisions: 0 };
      },
      runWorker: () => ({ cancel() {} }),
      openSpinner: ({ label }) => {
        events.push(`open:${label}`);
        return { close() { events.push('close'); } };
      },
      logger: { info() {}, error() {} },
    });
    expect(events[0]).toMatch(/^open:.*scanning/i);
    expect(events[1]).toBe('preflight-running');
    expect(events[2]).toBe('close');
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/dialog-runner.test.js
```

- [ ] **Step 3: Create `src/main/runners/dialog-runner.js`**

```js
const { safeHook } = require('./safe-hook');
const { runWorkerPromise } = require('./base-runner');

function isValidPreflightShape(pre) {
  return pre && typeof pre === 'object';
}

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

async function runDialogPlugin({
  manifest, plugin, pluginDir, targets, selection,
  dialog, runPreflight, runWorker, openSpinner, logger,
}) {
  const label = manifest.label;
  const ctx = { manifest, targets, selection };
  const workerPath = pathJoin(pluginDir, 'plugin.js');

  // 1. Scan spinner + preflight
  let scanSpinner;
  try {
    scanSpinner = openSpinner({ label: `${label} — scanning…` });
  } catch (err) {
    logger.error('dialog-runner: scan spinner failed', { message: err.message });
    scanSpinner = { close() {} };
  }
  let pre;
  try {
    pre = await runPreflight({ workerPath, targets, selection });
  } catch (err) {
    try { scanSpinner.close(); } catch {}
    logger.error('dialog-runner: preflight crashed', { plugin: manifest.id, message: err.message });
    dialog.showErrorBox(`${label} — internal error`, err.message);
    return 3;
  }
  if (!isValidPreflightShape(pre)) {
    try { scanSpinner.close(); } catch {}
    logger.error('dialog-runner: preflight returned invalid shape', { plugin: manifest.id });
    dialog.showErrorBox(`${label} — internal error`, 'Preflight returned invalid data');
    return 3;
  }
  try { scanSpinner.close(); } catch {}

  // 2. Nothing to do?
  const empty = safeHook(plugin, 'isEmpty', (_c, p) => !!(p && p.totalFiles === 0), logger, ctx, pre);
  if (empty) {
    const body = safeHook(plugin, 'buildNothingToDoBody',
      (_c, _p) => ({ message: 'Nothing to do.', detail: '' }),
      logger, ctx, pre);
    await dialog.showMessageBox({
      type: 'info', title: label,
      message: body.message, detail: body.detail,
      buttons: ['OK'], defaultId: 0,
    });
    return 0;
  }

  // 3. Confirm
  const confirm = safeHook(plugin, 'buildConfirmMessage',
    (_c, p) => ({ message: `Process ${(p?.folders?.length) || 1} item(s)?`, detail: '' }),
    logger, ctx, pre);
  const { response } = await dialog.showMessageBox({
    type: 'question', title: label,
    message: confirm.message, detail: confirm.detail,
    buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1,
  });
  if (response === 1) return 0;

  // 4. Run spinner + run
  let runSpinner;
  try {
    runSpinner = openSpinner({ label: `${label}…` });
  } catch (err) {
    logger.error('dialog-runner: run spinner failed', { message: err.message });
    runSpinner = { close() {} };
  }
  const outcome = await runWorkerPromise(runWorker, {
    workerPath, targets, options: {}, selection, onProgress: () => {},
  });
  try { runSpinner.close(); } catch {}

  // 5. Result
  if (outcome.kind === 'error') {
    logger.error('dialog-runner: worker error', { plugin: manifest.id, error: outcome.error });
    dialog.showErrorBox(`${label} — internal error`, outcome.error.message || 'unknown error');
    return 3;
  }
  const result = outcome.result || {};
  const errors = result.errors || [];
  if (result.ok && errors.length === 0) return 0;
  const body = safeHook(plugin, 'buildErrorBody',
    (_c, errs, processed, total) => `${processed} of ${total} processed.\n${errs.length} could not be processed.`,
    logger, ctx, errors, result.processed || 0, pre.totalFiles || 0);
  dialog.showErrorBox(`${label} — completed with errors`, body);
  return 1;
}

module.exports = { runDialogPlugin };
```

- [ ] **Step 4: Run, expect 9 pass**

```
npm test -- tests/unit/dialog-runner.test.js
```

- [ ] **Step 5: Run full suite, expect green**

Old `dialog-flow.test.js` may still be in the suite; that's OK — it runs against the old module which still works (it'll be deleted in Task 12).

```
npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/runners/dialog-runner.js ContextHelper/tests/unit/dialog-runner.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add dialog-runner that uses plugin hooks

Replaces the orchestration logic from dialog-flow.js (which is kept
temporarily for index.js's existing wiring). dialog-runner reads
preflight/confirm/error wording from plugin instance hooks via safeHook,
so plugins like FlattenFolder fully own their dialog text. Selection
type-checking moves OUT of the runner — the dispatcher does it before
choosing a runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: window-runner (window-mode flow with exit code)

**Files:**
- Create: `src/main/runners/window-runner.js`
- Create: `tests/unit/window-runner.test.js`
- Modify: `src/main/window-manager.js` (extract `createPluginWindow` factory)

- [ ] **Step 1: Update `src/main/window-manager.js` — keep only factories**

```js
const path = require('node:path');
const { BrowserWindow } = require('electron');

function createPluginWindow({ manifest }) {
  return new BrowserWindow({
    width: 560,
    height: 480,
    title: 'ContextHelper — ' + manifest.label,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'plugin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
}

function createSpinnerWindow({ label = 'Working…' } = {}) {
  const win = new BrowserWindow({
    width: 320, height: 100, frame: false, resizable: false,
    minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  const file = path.join(__dirname, '..', 'renderer', 'spinner.html');
  const url = `file://${file.replace(/\\/g, '/')}?label=${encodeURIComponent(label)}`;
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = { createPluginWindow, createSpinnerWindow };
```

(The `openPluginWindow` function is gone — its IPC orchestration moves into `window-runner.js`.)

- [ ] **Step 2: Create test**

```js
const { runWindowPlugin } = require('../../src/main/runners/window-runner');
const { BasePlugin } = require('../../src/shared/base-plugin');

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 's', label: 'Stub', accepts: ['folders'] }; }
  async preflight() { return { totalFiles: 1 }; }
  async run() {}
}

function makeWin() {
  const handlers = {};
  const sentToRenderer = [];
  return {
    handlers, sentToRenderer,
    win: {
      webContents: {
        on: (event, fn) => { handlers['wc:' + event] = fn; },
        send: (channel, payload) => sentToRenderer.push({ channel, payload }),
      },
      on: (event, fn) => { handlers['win:' + event] = fn; },
      destroy: () => { handlers['win:destroyed'] = true; },
      loadFile: () => {},
    },
  };
}

function makeIpc() {
  const listeners = {};
  return {
    listeners,
    on:  (ch, fn) => { listeners[ch] = fn; },
    removeListener: (ch) => { delete listeners[ch]; },
    fire: (ch, payload) => listeners[ch]?.({}, payload),
  };
}

const manifest = { id: 's', label: 'Stub', accepts: ['folders'], ui: 'window', icon: 'icon.png' };
const selection = { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] };

describe('runWindowPlugin', () => {
  it('opens window, runs preflight, sends INIT', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    let preCalled = false;
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => { preCalled = true; return { totalFiles: 3 }; },
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    // simulate window finished loading
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    expect(preCalled).toBe(true);
    expect(w.sentToRenderer.find((m) => m.channel === 'plugin:init')).toBeDefined();
    // close window without Start → exit 0
    w.handlers['win:closed']();
    const code = await promise;
    expect(code).toBe(0);
  });

  it('exits 0 on successful run, after user closes window', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: true, processed: 1, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    ipc.fire('plugin:start', { options: {} });
    await new Promise((r) => setTimeout(r, 20));
    w.handlers['win:closed']();
    const code = await promise;
    expect(code).toBe(0);
    expect(w.sentToRenderer.some((m) => m.channel === 'plugin:complete')).toBe(true);
  });

  it('exits 1 when run produces errors', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: false, processed: 0, skipped: 1, errors: [{ file: 'x', message: 'e' }] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    ipc.fire('plugin:start', { options: {} });
    await new Promise((r) => setTimeout(r, 20));
    w.handlers['win:closed']();
    expect(await promise).toBe(1);
  });

  it('exits 3 when run worker errors asynchronously', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: ({ onError }) => {
        setTimeout(() => onError({ message: 'EPIPE' }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    ipc.fire('plugin:start', { options: {} });
    await new Promise((r) => setTimeout(r, 20));
    w.handlers['win:closed']();
    expect(await promise).toBe(3);
  });

  it('exits 3 when preflight crashes — window stays open with error message', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => { throw new Error('pre-boom'); },
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    // preflight crash → INIT carries preflightError
    const init = w.sentToRenderer.find((m) => m.channel === 'plugin:init');
    expect(init.payload.preflightError).toMatch(/pre-boom/);
    w.handlers['win:closed']();
    expect(await promise).toBe(3);
  });

  it('exits 0 when user closes window without clicking Start', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    w.handlers['win:closed']();
    expect(await promise).toBe(0);
  });

  it('IPC START handler is removed when window closes', async () => {
    const w = makeWin();
    const ipc = makeIpc();
    const promise = runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection,
      createWindow: () => w.win, ipcMain: ipc,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    w.handlers['wc:did-finish-load']();
    await new Promise((r) => setImmediate(r));
    expect(ipc.listeners['plugin:start']).toBeDefined();
    w.handlers['win:closed']();
    await promise;
    expect(ipc.listeners['plugin:start']).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run, expect fail**

```
npm test -- tests/unit/window-runner.test.js
```

- [ ] **Step 4: Create `src/main/runners/window-runner.js`**

```js
const path = require('node:path');
const fs = require('node:fs');
const { IPC } = require('../../shared/plugin-api');
const { runWorkerPromise } = require('./base-runner');

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

async function runWindowPlugin({
  manifest, plugin, pluginDir, targets, selection,
  createWindow, ipcMain, runPreflight, runWorker, readUiHtml, logger,
}) {
  const workerPath = pathJoin(pluginDir, 'plugin.js');
  const win = createWindow({ manifest });
  let runResult = null;
  let runErrored = false;

  const startHandler = async (_e, { options }) => {
    logger.info('window-runner: start', { plugin: manifest.id, options });
    const outcome = await runWorkerPromise(runWorker, {
      workerPath, targets, options, selection,
      onProgress: (p) => win.webContents.send(IPC.PROGRESS, p),
    });
    if (outcome.kind === 'complete') {
      runResult = outcome.result;
      win.webContents.send(IPC.COMPLETE, runResult);
    } else {
      runErrored = true;
      win.webContents.send(IPC.COMPLETE, { ok: false, processed: 0, skipped: 0, errors: [{ file: '(worker)', message: outcome.error.message || 'unknown' }] });
      logger.error('window-runner: worker error', { plugin: manifest.id, error: outcome.error });
    }
  };
  ipcMain.on(IPC.START, startHandler);

  // Preflight runs once after the window loads (best-effort — failure does not block window).
  win.webContents.on('did-finish-load', async () => {
    let preflight = null;
    let preflightError = null;
    try {
      preflight = await runPreflight({ workerPath, targets, selection });
    } catch (err) {
      preflightError = err.message;
      logger.error('window-runner: preflight crashed', { plugin: manifest.id, message: err.message });
    }
    const uiHtml = readUiHtml(pluginDir);
    win.webContents.send(IPC.INIT, { manifest, targets, selection, uiHtml, preflight, preflightError });
  });

  // Resolve when the user closes the window.
  return new Promise((resolve) => {
    win.on('closed', () => {
      ipcMain.removeListener(IPC.START, startHandler);
      if (runErrored) return resolve(3);
      if (runResult && runResult.errors && runResult.errors.length > 0) return resolve(1);
      resolve(0);
    });
    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  });
}

function readUiHtmlFromDisk(pluginDir) {
  const p = pathJoin(pluginDir, 'ui.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

module.exports = { runWindowPlugin, readUiHtmlFromDisk };
```

- [ ] **Step 5: Run, expect 7 pass**

```
npm test -- tests/unit/window-runner.test.js
```

- [ ] **Step 6: Run full suite, expect green**

```
npm test
```

(Note: `tests/unit/window-manager.test.js` doesn't exist — window-manager has no tests currently. The `openPluginWindow` deletion has no direct test impact.)

- [ ] **Step 7: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/window-manager.js ContextHelper/src/main/runners/window-runner.js ContextHelper/tests/unit/window-runner.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add window-runner returning exit code

Window plugins now go through runWindowPlugin which:
- runs preflight after did-finish-load and includes the result in INIT
- forwards IPC START to runWorker via base-runner's Promise wrapper
- resolves with exit code 0/1/3 when the user closes the window
window-manager.js is reduced to factory exports (createPluginWindow,
createSpinnerWindow); orchestration moves to the runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: dispatcher

**Files:**
- Create: `src/main/dispatcher.js`
- Create: `tests/unit/dispatcher.test.js`

- [ ] **Step 1: Create test**

```js
const { dispatch } = require('../../src/main/dispatcher');

function makeDeps(overrides = {}) {
  return {
    parseCli: () => ({ kind: 'run', action: 'p', targets: ['/a'] }),
    loadAll:  () => new Map([['p', { Cls: class { async run() {} }, manifest: { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 }, dir: '/fake' }]]),
    aggregateTargets: async ({ myTarget }) => ({ role: 'leader', targets: [myTarget] }),
    classify: () => ({ folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] }),
    validate: () => ({ ok: true }),
    createRunner: () => ({ execute: async () => 0 }),
    dialog: { showErrorBox: () => {} },
    fs: {},
    logger: { info() {}, error() {} },
    ...overrides,
  };
}

describe('dispatch', () => {
  it('happy path returns runner exit code', async () => {
    const code = await dispatch({ argv: [] }, makeDeps());
    expect(code).toBe(0);
  });

  it('returns 0 silently when cli.kind === none', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({ parseCli: () => ({ kind: 'none' }) }));
    expect(code).toBe(0);
  });

  it('returns 4 with error dialog on unknown action', async () => {
    const dlg = { calls: [], showErrorBox: function (t, b) { this.calls.push({ t, b }); } };
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => new Map(),
      dialog: dlg,
    }));
    expect(code).toBe(4);
    expect(dlg.calls[0].b).toMatch(/Unknown action/);
  });

  it('returns 4 when loadAll throws', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => { throw new Error('boom'); },
    }));
    expect(code).toBe(4);
  });

  it('returns 4 when instantiation throws', async () => {
    class Bad { constructor() { throw new Error('ctor-boom'); } async run() {} }
    const code = await dispatch({ argv: [] }, makeDeps({
      loadAll: () => new Map([['p', { Cls: Bad, manifest: { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 }, dir: '/fake' }]]),
    }));
    expect(code).toBe(4);
  });

  it('returns 2 when validate fails (missing)', async () => {
    const dlg = { calls: [], showErrorBox: function (t, b) { this.calls.push({ t, b }); } };
    const code = await dispatch({ argv: [] }, makeDeps({
      classify: () => ({ folders: [], files: [], missing: ['/gone'], exts: [], basenames: ['gone'] }),
      validate: () => ({ ok: false, reason: 'MISSING', body: 'gone' }),
      dialog: dlg,
    }));
    expect(code).toBe(2);
    expect(dlg.calls[0].b).toBe('gone');
  });

  it('returns 3 when runner.execute throws', async () => {
    const code = await dispatch({ argv: [] }, makeDeps({
      createRunner: () => ({ execute: async () => { throw new Error('runner-boom'); } }),
    }));
    expect(code).toBe(3);
  });

  it('uses aggregator when targets.length === 1', async () => {
    const seen = [];
    await dispatch({ argv: [] }, makeDeps({
      aggregateTargets: async ({ myTarget }) => { seen.push(myTarget); return { role: 'leader', targets: [myTarget, '/extra'] }; },
      createRunner: () => ({ execute: async ({ targets }) => { seen.push(targets.length); return 0; } }),
    }));
    expect(seen[0]).toBe('/a');
    expect(seen[1]).toBe(2);
  });

  it('skips aggregator when targets.length > 1', async () => {
    let called = false;
    await dispatch({ argv: [] }, makeDeps({
      parseCli: () => ({ kind: 'run', action: 'p', targets: ['/a', '/b'] }),
      aggregateTargets: async () => { called = true; return { role: 'leader', targets: [] }; },
    }));
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/dispatcher.test.js
```

- [ ] **Step 3: Create `src/main/dispatcher.js`**

```js
async function dispatch({ argv }, deps) {
  const {
    parseCli, loadAll, aggregateTargets, classify, validate,
    createRunner, dialog, fs, logger,
  } = deps;

  const cli = parseCli(argv);
  if (cli.kind === 'none') { logger.error('dispatch: no CLI args'); return 0; }
  if (cli.kind !== 'run')  { logger.error('dispatch: unknown CLI mode', { cli }); return 4; }

  let plugins;
  try {
    plugins = loadAll(deps.pluginsDir);
  } catch (err) {
    logger.error('dispatch: plugin load failed', { message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin load failed: ${err.message}`);
    return 4;
  }

  const plugin = plugins.get(cli.action);
  if (!plugin) {
    logger.error('dispatch: unknown action', { action: cli.action });
    dialog.showErrorBox('ContextHelper', `Unknown action: ${cli.action}`);
    return 4;
  }

  let targets = cli.targets;
  if (targets.length === 1) {
    const pipeName = `contexthelper-${cli.action}-${process.env.USERNAME || 'user'}`;
    try {
      const agg = await aggregateTargets({ pipeName, myTarget: targets[0], waitMs: 250 });
      if (agg.role === 'follower') { logger.info('dispatch: follower exiting'); return 0; }
      targets = agg.targets;
    } catch (err) {
      logger.error('dispatch: aggregator failed', { message: err.message });
      // proceed with single target
    }
  }

  const selection = classify(targets, fs);

  const v = validate(plugin.manifest, selection);
  if (!v.ok) {
    logger.error('dispatch: validation rejected', { action: cli.action, reason: v.reason });
    dialog.showErrorBox(plugin.manifest.label || 'ContextHelper', v.body);
    return 2;
  }

  let instance;
  try {
    instance = new plugin.Cls();
  } catch (err) {
    logger.error('dispatch: plugin instantiation failed', { plugin: cli.action, message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin "${cli.action}" failed to instantiate: ${err.message}`);
    return 4;
  }

  const runner = createRunner(plugin.manifest.ui, deps);
  try {
    return await runner.execute({
      manifest: plugin.manifest,
      plugin: instance,
      pluginDir: plugin.dir,
      targets,
      selection,
    });
  } catch (err) {
    logger.error('dispatch: runner crashed', { plugin: cli.action, message: err.message, stack: err.stack });
    dialog.showErrorBox('ContextHelper', `Internal error: ${err.message}`);
    return 3;
  }
}

module.exports = { dispatch };
```

- [ ] **Step 4: Run, expect 9 pass**

```
npm test -- tests/unit/dispatcher.test.js
```

- [ ] **Step 5: Run full suite, expect green**

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/dispatcher.js ContextHelper/tests/unit/dispatcher.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add dispatcher.dispatch as single orchestration point

Walks parse → load → aggregate (1-target only) → classify → validate →
instantiate → runner.execute with full dependency injection so the unit
tests don't touch Electron or filesystem. Returns the spec's exit codes:
0 (ok/cancel/follower), 2 (validation), 3 (runner/internal), 4 (config).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Thin index.js + delete old plugin-registry & dialog-flow

**Files:**
- Modify: `src/main/index.js`
- Delete: `src/main/plugin-registry.js`
- Delete: `src/main/dialog-flow.js`
- Delete: `tests/unit/plugin-registry.test.js`
- Delete: `tests/unit/dialog-flow.test.js`

- [ ] **Step 1: Replace `src/main/index.js` with thin entry**

```js
const fs = require('node:fs');
const path = require('node:path');
const { app, Menu, dialog } = require('electron');
const { parseCli } = require('./cli');
const { loadAll } = require('./registry/plugin-loader');
const { aggregateTargets } = require('./named-pipe');
const { classify } = require('./selection/classify');
const { validate } = require('./selection/validate');
const { runPreflight, runWorker } = require('./worker-runner');
const { runDialogPlugin } = require('./runners/dialog-runner');
const { runWindowPlugin, readUiHtmlFromDisk } = require('./runners/window-runner');
const { createPluginWindow, createSpinnerWindow } = require('./window-manager');
const { dispatch } = require('./dispatcher');
const logger = require('./logger');
const { ipcMain } = require('electron');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

function createRunner(uiMode) {
  if (uiMode === 'dialog') {
    return {
      execute: (ctx) => runDialogPlugin({
        ...ctx,
        dialog,
        runPreflight,
        runWorker,
        openSpinner: ({ label }) => {
          const win = createSpinnerWindow({ label });
          return { close() { try { win.destroy(); } catch {} } };
        },
        logger,
      }),
    };
  }
  // default: window
  return {
    execute: (ctx) => runWindowPlugin({
      ...ctx,
      createWindow: createPluginWindow,
      ipcMain,
      runPreflight,
      runWorker,
      readUiHtml: readUiHtmlFromDisk,
      logger,
    }),
  };
}

async function main() {
  Menu.setApplicationMenu(null);
  logger.pruneOld();
  const argv = process.argv.slice(process.defaultApp ? 2 : 1);
  const code = await dispatch({ argv }, {
    parseCli, loadAll, aggregateTargets, classify, validate, createRunner,
    dialog, fs, logger, pluginsDir: PLUGINS_DIR,
  });
  logger.info('main: exit', { code });
  app.exit(code);
}

app.whenReady().then(main).catch((err) => {
  logger.error('fatal startup error', { message: err.message, stack: err.stack });
  app.exit(3);
});

app.on('window-all-closed', () => { /* do not auto-quit — runners drive lifecycle */ });
```

- [ ] **Step 2: Delete old files**

```
git -C "C:\YandexDisk\Software\bin" rm ContextHelper/src/main/plugin-registry.js ContextHelper/src/main/dialog-flow.js ContextHelper/tests/unit/plugin-registry.test.js ContextHelper/tests/unit/dialog-flow.test.js
```

- [ ] **Step 3: Run full suite**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

Expected: all green. Total test count should be approximately equivalent to before-this-task minus the deleted suites' tests, plus the new orchestration coverage in `dispatcher.test.js` and `dialog-runner.test.js`.

- [ ] **Step 4: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/index.js ContextHelper/src/main/plugin-registry.js ContextHelper/src/main/dialog-flow.js ContextHelper/tests/unit/plugin-registry.test.js ContextHelper/tests/unit/dialog-flow.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
refactor(ContextHelper): thin index.js + delete plugin-registry & dialog-flow

main process is now ~50 lines: app.whenReady wires deps into
dispatcher.dispatch and exits with the returned code. plugin-registry
and dialog-flow are superseded by plugin-loader and dialog-runner +
selection/{classify,validate} respectively; deleted along with their
tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Rewrite gen-register-bat for 3 entry points + 2-level menu

**Files:**
- Modify: `scripts/gen-register-bat.js`
- Create: `tests/unit/gen-register-bat.test.js`

The old script wrote per-extension keys and a single submenu. The new script:
- Writes 3 entry points (`Directory`, `*`, `Directory\Background`) — all pointing at `Directory\ContextHelperRoot`
- Writes group keys `Folders` and `Files` under `ContextHelperRoot` only when each group is non-empty
- Writes per-plugin keys with `MultiSelectModel=Player` and `%V` command
- A plugin accepting both kinds gets registered under both group keys

- [ ] **Step 1: Create test**

```js
const { generateRegisterBat } = require('../../scripts/gen-register-bat');

const flatten = { id: 'flatten-folder', label: 'Flatten folder', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
const mergePdf = { id: 'merge-pdf', label: 'Merge PDF', accepts: ['files:.pdf'], minSelection: 2, maxSelection: 999, ui: 'dialog' };
const rename = { id: 'rename', label: 'Rename', accepts: ['folders', 'files'], minSelection: 1, maxSelection: 999, ui: 'window' };

describe('generateRegisterBat', () => {
  it('writes three top-level entry points', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper/);
    expect(out).toMatch(/HKCU\\Software\\Classes\\\*\\shell\\ContextHelper/);
    expect(out).toMatch(/HKCU\\Software\\Classes\\Directory\\Background\\shell\\ContextHelper/);
  });

  it('all three entry points reference the same ContextHelperRoot', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    const matches = out.match(/ExtendedSubCommandsKey \/t REG_SZ \/d "Directory\\ContextHelperRoot"/g);
    expect(matches).toHaveLength(3);
  });

  it('Folders group is emitted when a folder plugin exists', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/Directory\\ContextHelperRoot\\shell\\Folders/);
    expect(out).toMatch(/Directory\\ContextHelperFolders\\shell\\flatten-folder/);
  });

  it('Files group is emitted when a file plugin exists', () => {
    const out = generateRegisterBat([mergePdf], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/Directory\\ContextHelperRoot\\shell\\Files/);
    expect(out).toMatch(/Directory\\ContextHelperFiles\\shell\\merge-pdf/);
  });

  it('omits Folders group when no folder plugin', () => {
    const out = generateRegisterBat([mergePdf], '%~dp0ContextHelper.exe');
    expect(out).not.toMatch(/ContextHelperRoot\\shell\\Folders/);
  });

  it('per-plugin command uses %V and MultiSelectModel=Player', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/MultiSelectModel \/t REG_SZ \/d "Player"/);
    expect(out).toMatch(/--action=flatten-folder %%V/);
  });

  it('plugin accepting both kinds is registered under both groups', () => {
    const out = generateRegisterBat([rename], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/ContextHelperFolders\\shell\\rename/);
    expect(out).toMatch(/ContextHelperFiles\\shell\\rename/);
  });

  it('plugins are sorted alphabetically within a group', () => {
    const zip = { id: 'zip-each', label: 'Zip each', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
    const aaa = { id: 'aaa', label: 'Aaa', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
    const out = generateRegisterBat([zip, flatten, aaa], '%~dp0ContextHelper.exe');
    const idxA = out.indexOf('shell\\aaa');
    const idxF = out.indexOf('shell\\flatten-folder');
    const idxZ = out.indexOf('shell\\zip-each');
    expect(idxA).toBeLessThan(idxF);
    expect(idxF).toBeLessThan(idxZ);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```
npm test -- tests/unit/gen-register-bat.test.js
```

- [ ] **Step 3: Replace `scripts/gen-register-bat.js`**

```js
const fs = require('node:fs');
const path = require('node:path');
const { loadAll } = require('../src/main/registry/plugin-loader');
const { buildMenuTree } = require('../src/main/registry/menu-tree');

const pluginsDir = path.resolve(__dirname, '..', 'plugins');
const outDir = path.resolve(__dirname, '..');

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

  // Three top-level entry points sharing one sub-tree.
  for (const [scope, label] of [
    ['Directory\\shell\\ContextHelper', 'ContextHelper'],
    ['*\\shell\\ContextHelper', 'ContextHelper'],
    ['Directory\\Background\\shell\\ContextHelper', 'ContextHelper'],
  ]) {
    lines.push(
      `REM === Entry point: ${scope} ===`,
      `reg add "HKCU\\Software\\Classes\\${scope}" /v MUIVerb /t REG_SZ /d "${label}" /f`,
      `reg add "HKCU\\Software\\Classes\\${scope}" /v Icon /t REG_SZ /d "%EXE%,0" /f`,
      `reg add "HKCU\\Software\\Classes\\${scope}" /v ExtendedSubCommandsKey /t REG_SZ /d "Directory\\ContextHelperRoot" /f`,
      '',
    );
  }

  const plugins = manifests.map((m) => ({ manifest: m }));
  const tree = buildMenuTree(plugins);

  if (tree.folders.length > 0) {
    lines.push(
      'REM === Folders group ===',
      `reg add "HKCU\\Software\\Classes\\Directory\\ContextHelperRoot\\shell\\Folders" /v MUIVerb /t REG_SZ /d "Folders" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\ContextHelperRoot\\shell\\Folders" /v ExtendedSubCommandsKey /t REG_SZ /d "Directory\\ContextHelperFolders" /f`,
      '',
    );
    for (const p of tree.folders) {
      const m = p.manifest;
      const key = `HKCU\\Software\\Classes\\Directory\\ContextHelperFolders\\shell\\${m.id}`;
      lines.push(
        `REM --- ${m.id} ---`,
        `reg add "${key}" /v MUIVerb /t REG_SZ /d "${m.label}" /f`,
        `reg add "${key}" /v MultiSelectModel /t REG_SZ /d "Player" /f`,
        `reg add "${key}\\command" /ve /t REG_SZ /d "\\"%EXE%\\" --action=${m.id} %%V" /f`,
        '',
      );
    }
  }

  if (tree.files.length > 0) {
    lines.push(
      'REM === Files group ===',
      `reg add "HKCU\\Software\\Classes\\Directory\\ContextHelperRoot\\shell\\Files" /v MUIVerb /t REG_SZ /d "Files" /f`,
      `reg add "HKCU\\Software\\Classes\\Directory\\ContextHelperRoot\\shell\\Files" /v ExtendedSubCommandsKey /t REG_SZ /d "Directory\\ContextHelperFiles" /f`,
      '',
    );
    for (const p of tree.files) {
      const m = p.manifest;
      const key = `HKCU\\Software\\Classes\\Directory\\ContextHelperFiles\\shell\\${m.id}`;
      lines.push(
        `REM --- ${m.id} ---`,
        `reg add "${key}" /v MUIVerb /t REG_SZ /d "${m.label}" /f`,
        `reg add "${key}" /v MultiSelectModel /t REG_SZ /d "Player" /f`,
        `reg add "${key}\\command" /ve /t REG_SZ /d "\\"%EXE%\\" --action=${m.id} %%V" /f`,
        '',
      );
    }
  }

  lines.push('echo Done. Right-click a folder or file to see the ContextHelper submenu.', 'endlocal', '');
  return lines.join('\r\n');
}

function generateUnregisterBat() {
  return [
    '@echo off',
    'REM Auto-generated. Removes all ContextHelper HKCU registrations.',
    '',
    'reg delete "HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper" /f 2>nul',
    'reg delete "HKCU\\Software\\Classes\\*\\shell\\ContextHelper" /f 2>nul',
    'reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ContextHelper" /f 2>nul',
    'reg delete "HKCU\\Software\\Classes\\Directory\\ContextHelperRoot" /f 2>nul',
    'reg delete "HKCU\\Software\\Classes\\Directory\\ContextHelperFolders" /f 2>nul',
    'reg delete "HKCU\\Software\\Classes\\Directory\\ContextHelperFiles" /f 2>nul',
    'echo Done.',
    '',
  ].join('\r\n');
}

function main() {
  const args = process.argv.slice(2);
  const targetArg = args.find((a) => a.startsWith('--exe='));
  const exePath = targetArg ? targetArg.slice('--exe='.length) : '%~dp0ContextHelper.exe';

  const registry = loadAll(pluginsDir);
  const manifests = [...registry.values()].map((e) => e.manifest);

  fs.writeFileSync(path.join(outDir, 'register.bat'), generateRegisterBat(manifests, exePath));
  fs.writeFileSync(path.join(outDir, 'unregister.bat'), generateUnregisterBat());
  console.log('Wrote register.bat and unregister.bat (exe path:', exePath + ')');
}

module.exports = { generateRegisterBat, generateUnregisterBat };

if (require.main === module) main();
```

- [ ] **Step 4: Run, expect 8 pass**

```
npm test -- tests/unit/gen-register-bat.test.js
```

- [ ] **Step 5: Run full suite, expect green**

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/scripts/gen-register-bat.js ContextHelper/tests/unit/gen-register-bat.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): register.bat emits 3 entry points + Folders/Files groups

Directory\\shell\\ContextHelper, *\\shell\\ContextHelper, and
Directory\\Background\\shell\\ContextHelper all reference a shared
Directory\\ContextHelperRoot sub-tree. Plugins are bucketed by accepts
into Folders / Files group submenus (a plugin accepting both gets two
entries). Empty groups are omitted. unregister.bat now cleans up all
new keys.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Manual verification in Explorer

**Files:** none — verification only.

- [ ] **Step 1: Rebuild distribution**

```
cd C:\YandexDisk\Software\bin\ContextHelper
npm run package
```

Expected: `dist/win-unpacked/ContextHelper.exe` is regenerated. If `winCodeSign` extraction fails per the documented caveat, the existing prepopulated cache should handle it.

- [ ] **Step 2: Regenerate and re-run register.bat**

```
node scripts/gen-register-bat.js
```

Then run `unregister.bat` (cleans old keys), then run the freshly generated `register.bat`:

```
.\unregister.bat
.\register.bat
```

- [ ] **Step 3: Verify the 8-case matrix**

Build a synthetic test folder structure:
- `Test\Photos\a\1.jpg`, `Test\Photos\b\1.jpg`, `Test\Photos\b\2.jpg` (folder with files + 1 collision)
- `Test\Vacation\x\y\z.jpg` (folder with nested file)
- `Test\Already-flat\q.txt`, `Test\Already-flat\w.txt` (already flat)
- `Test\report.pdf` (a file for mixed/wrong-type tests)

| # | Action | Expected |
|---|---|---|
| 1 | Right-click `Photos` → ContextHelper → Folders → Flatten folder | Confirm: "Flatten this folder?", body lists Photos (3 files), 1 collision; Continue → silent success; Photos contains 3 flat files. |
| 2 | Right-click `Photos`+`Vacation`+`Already-flat` (3 folders) → ContextHelper → Folders → Flatten folder | Confirm "Flatten 3 folders?" with bullet list. Continue → silent success. |
| 3 | Right-click `Photos`+`report.pdf` (mixed) → ContextHelper → Folders → Flatten folder | TYPE error: "Flatten folder works only with folders. Selection contains 1 file: • report.pdf". Exit 2. |
| 4 | Right-click `Already-flat` → ContextHelper → Folders → Flatten folder | Info "Nothing to do. Selected folder(s) are already flat." |
| 5 | Right-click `report.pdf` → ContextHelper menu visible? | Yes — menu shows Folders submenu (since flatten-folder is a folder plugin), Files submenu hidden (no file plugins yet). |
| 6 | Right-click `report.pdf` → ContextHelper → Folders → Flatten folder | TYPE error. Exit 2. |
| 7 | Right-click empty space inside `Photos` → ContextHelper → Folders → Flatten folder | Operates on `Photos`. Confirm appears. |
| 8 | Cancel from any confirm dialog | Silent exit. |

- [ ] **Step 4: Note divergences**

For any case that did not match the table, file a follow-up. Either the spec needs updating (commit the change), the runtime has a bug (open a fix-up task), or the wording is awkward (revise the plugin's `buildConfirmMessage` and/or BasePlugin defaults).

- [ ] **Step 5: Mark plan complete**

Append to the top of this plan file:

```
> **Status:** ✅ COMPLETE (YYYY-MM-DD). 14 tasks executed; full unit suite green; smoke green; verified in Explorer across the 8-case matrix.
```

Update `ContextHelper/CLAUDE.md` "Resume here" section to summarize the new architecture and note that Plan 3 (the remaining 10 plugins) is now unblocked.

- [ ] **Step 6: Final commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/docs/superpowers/plans/2026-05-19-dispatcher-refactor-plan.md ContextHelper/CLAUDE.md
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
docs(ContextHelper): mark dispatcher refactor plan complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- §1 Goals (unified contract, single dispatcher, two-level menu) → Tasks 1–10 + 11 + 13.
- §2 User-visible behaviour (menu structure, 5 validation checks) → Tasks 4, 13 (menu) + Tasks 2, 3 (validation).
- §3 Architecture (BasePlugin, dispatcher, runners, registry, worker-shim) → Tasks 1, 6, 7, 8, 9, 10, 11.
- §4 Data flow (happy path, wrong-type, background-click, exit codes) → covered by Tasks 7 (worker-shim selection field), 11 (dispatcher exit codes), 14 (manual matrix).
- §5 Error handling matrix → Tasks 9 (dialog-runner errors), 10 (window-runner errors), 11 (dispatcher errors).
- §6 Testing → every task has tests; net delta ~+40 tests.
- §7 Migration order → this plan IS the migration order.

**Placeholder scan:** no TBDs, no "TODO" markers, every step has either complete code or an exact command.

**Type consistency:**
- `plugin.js` is the entry filename throughout (no leftover `worker.js`).
- `loadAll` (not `loadPluginRegistry`) used consistently.
- `runDialogPlugin` and `runWindowPlugin` use the same `{ manifest, plugin, pluginDir, targets, selection, ... }` ctx shape.
- `selection` is passed end-to-end (dispatcher → runner → worker-shim → plugin).
- Exit codes 0/1/2/3/4 used consistently with the spec.

**Known limitations of the plan:**
- Task 7 is the biggest single step (combines plugin rewrite, shim update, test adaptation). Splitting it would create a transient broken state where flatten-folder works but the rest of the system can't load it. Keeping it as one task is the safer choice.
- The window-runner test mocks Electron heavily; integration-level coverage is in Task 14's manual matrix.
- After Task 12, several files (`plugin-registry.js`, `dialog-flow.js`, plugin's `manifest.json`/`worker.js`) are gone — `git log` is the only audit trail. The spec at `docs/superpowers/specs/2026-05-19-dispatcher-refactor-design.md` documents what they were and why they were replaced.
