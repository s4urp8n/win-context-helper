# Plan 3a — Binary infrastructure + shell unification

> **Status:** ✅ COMPLETE (2026-05-20). All 10 tasks executed; suite green; flatten-folder verified end-to-end. binDir threading + shell unification proven by 3b plugins using the new form state.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add infrastructure for bundled external binaries (`resources/bin/`, `bin-paths.js`, `spawn.js`), unify the dialog-shell + window renderer into a single `shell.html` with a new `form` state, and bring window-mode plugins to UX parity with dialog-mode. After this plan: future binary-backed plugins can `spawn` tools by `path.join(ctx.binDir, 'tool.exe')`, and window plugins flow through the same shell that dialog plugins use.

**Architecture:** `dispatcher.js` resolves `binDir()` once at startup and threads it through `runner.execute(ctx)` → `worker-runner.runWorker / runPreflight` IPC → `worker-shim` → plugin ctx. `dialog-shell.*` is renamed to `shell.*` and gains a `form` state with plugin's `ui.html` injected. `window-runner.js` opens the same shell, runs preflight into the scanning state, transitions to form, awaits user Start with form options, transitions to running, exits with same exit codes as dialog-runner.

**Tech Stack:** Node 20+, Electron 33, Vitest 2 (globals), CommonJS. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-20-plan-3-design.md`. Sub-plan 3a per spec §6.

---

## File map

```
ContextHelper/
├── .gitignore                                      # MODIFY: add resources/bin/
├── electron-builder.yml                            # MODIFY: extraResources
├── resources/
│   ├── bin/                                        # NEW directory (gitignored)
│   └── bin.README.md                               # NEW: tool versions + download URLs
├── src/
│   ├── main/
│   │   ├── utils/
│   │   │   └── bin-paths.js                        # NEW (Task 1)
│   │   ├── dispatcher.js                           # MODIFY: resolve+pass binDir (Task 9)
│   │   ├── worker-runner.js                        # MODIFY: forward binDir (Task 9)
│   │   ├── window-manager.js                       # MODIFY: rename factory (Task 4)
│   │   └── runners/
│   │       ├── dialog-runner.js                    # MODIFY: rename shell file refs (Task 4)
│   │       └── window-runner.js                    # REWRITE: shell + form (Task 8)
│   ├── shared/
│   │   └── spawn.js                                # NEW (Task 2)
│   ├── worker/
│   │   └── worker-shim.js                          # MODIFY: forward binDir (Task 9)
│   ├── preload/
│   │   ├── dialog-shell-preload.js                 # RENAME → shell-preload.js (Task 4)
│   │   └── shell-preload.js                        # MODIFY: normalize send payload (Task 7)
│   └── renderer/
│       ├── dialog-shell.html                       # RENAME → shell.html (Task 4)
│       ├── dialog-shell.css                        # RENAME → shell.css (Task 4)
│       ├── dialog-shell.js                         # RENAME → shell.js (Task 4)
│       ├── shell.html                              # MODIFY: add form state (Task 5)
│       ├── shell.css                               # MODIFY: form styles (Task 5)
│       ├── shell.js                                # MODIFY: form handlers (Task 6)
│       ├── index.html                              # DELETE (Task 8)
│       ├── app.js                                  # DELETE (Task 8)
│       └── styles.css                              # DELETE (Task 8)
├── plugins/flatten-folder/plugin.js                # MODIFY: accept ctx.binDir passthrough (Task 10)
└── tests/unit/
    ├── bin-paths.test.js                           # NEW (Task 1)
    ├── spawn.test.js                               # NEW (Task 2)
    ├── window-runner.test.js                       # REWRITE: form-state flow (Task 8)
    └── dispatcher.test.js                          # MODIFY: binDir threaded (Task 9)
```

---

## Task 1: `bin-paths.js` + 3 unit tests

**Files:**
- Create: `src/main/utils/bin-paths.js`
- Create: `tests/unit/bin-paths.test.js`

- [ ] **Step 1: Create test**

```js
const path = require('node:path');

describe('bin-paths', () => {
  let originalResourcesPath;
  beforeEach(() => {
    originalResourcesPath = process.resourcesPath;
    delete require.cache[require.resolve('../../src/main/utils/bin-paths')];
  });
  afterEach(() => {
    if (originalResourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = originalResourcesPath;
    delete require.cache[require.resolve('../../src/main/utils/bin-paths')];
  });

  it('binDir uses process.resourcesPath/bin when defined', () => {
    process.resourcesPath = 'C:\\fake\\resources';
    const { binDir } = require('../../src/main/utils/bin-paths');
    expect(binDir()).toBe(path.join('C:\\fake\\resources', 'bin'));
  });

  it('binDir falls back to repo-root resources/bin in dev', () => {
    delete process.resourcesPath;
    const { binDir } = require('../../src/main/utils/bin-paths');
    // In dev, binDir() resolves to <project root>/resources/bin
    expect(binDir().endsWith(path.join('resources', 'bin'))).toBe(true);
  });

  it('binPath joins binDir with the tool name', () => {
    process.resourcesPath = 'C:\\fake\\resources';
    const { binPath } = require('../../src/main/utils/bin-paths');
    expect(binPath('7z.exe')).toBe(path.join('C:\\fake\\resources', 'bin', '7z.exe'));
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test -- tests/unit/bin-paths.test.js
```

Expected: 3 FAIL (module not found).

- [ ] **Step 3: Create `src/main/utils/bin-paths.js`**

```js
const path = require('node:path');

function binDir() {
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'bin');
  }
  // Dev fallback: <project root>/resources/bin
  return path.join(__dirname, '..', '..', '..', 'resources', 'bin');
}

function binPath(name) {
  return path.join(binDir(), name);
}

module.exports = { binDir, binPath };
```

- [ ] **Step 4: Run test, expect 3 pass**

```
npm test -- tests/unit/bin-paths.test.js
```

- [ ] **Step 5: Run full suite, expect 153 (was 150 + 3)**

```
npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/utils/bin-paths.js ContextHelper/tests/unit/bin-paths.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add bin-paths utility for bundled binaries

binDir() returns process.resourcesPath/bin in packaged builds, falls
back to repo-root/resources/bin in dev. binPath(name) joins for a
specific tool. Used by binary-backed plugins (Plan 3 c-f).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `spawn.js` helper + 5 unit tests

**Files:**
- Create: `src/shared/spawn.js`
- Create: `tests/unit/spawn.test.js`

- [ ] **Step 1: Create test**

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnTool } = require('../../src/shared/spawn');

// A tiny cross-shell command for tests: use node -e "..." so the test is portable.
const NODE = process.execPath;

describe('spawnTool', () => {
  it('resolves ok:true when the child exits 0', async () => {
    const result = await spawnTool({
      exe: NODE,
      args: ['-e', 'console.log("hello"); process.exit(0)'],
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/hello/);
  });

  it('rejects when the child exits non-zero with stderr suffix in error', async () => {
    await expect(spawnTool({
      exe: NODE,
      args: ['-e', 'console.error("boom-stderr"); process.exit(7)'],
    })).rejects.toThrow(/boom-stderr/);
  });

  it('calls parseProgress on stdout chunks', async () => {
    const calls = [];
    await spawnTool({
      exe: NODE,
      args: ['-e', 'console.log("PROGRESS:42")'],
      parseProgress: (text, stream) => {
        const m = /PROGRESS:(\d+)/.exec(text);
        if (m) return { processed: Number(m[1]), stream };
        return null;
      },
      onProgress: (p) => calls.push(p),
    });
    expect(calls).toContainEqual({ processed: 42, stream: 'stdout' });
  });

  it('calls parseProgress on stderr chunks', async () => {
    const calls = [];
    await spawnTool({
      exe: NODE,
      args: ['-e', 'console.error("time=00:01:23")'],
      parseProgress: (text, stream) => {
        const m = /time=(\S+)/.exec(text);
        if (m) return { time: m[1], stream };
        return null;
      },
      onProgress: (p) => calls.push(p),
    });
    expect(calls[0]).toEqual({ time: '00:01:23', stream: 'stderr' });
  });

  it('kills the child when signal.aborted becomes true', async () => {
    const controller = new AbortController();
    const promise = spawnTool({
      exe: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'], // run forever
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```
npm test -- tests/unit/spawn.test.js
```

- [ ] **Step 3: Create `src/shared/spawn.js`**

```js
const { spawn } = require('node:child_process');

function spawnTool({ exe, args, onProgress, parseProgress, signal, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      cwd,
    });
    let stderr = '';
    let stdout = '';

    const feed = (text, stream) => {
      if (stream === 'stderr') stderr += text;
      else stdout += text;
      if (parseProgress) {
        const p = parseProgress(text, stream);
        if (p && onProgress) {
          try { onProgress(p); } catch {}
        }
      }
    };
    child.stdout.on('data', (c) => feed(c.toString('utf8'), 'stdout'));
    child.stderr.on('data', (c) => feed(c.toString('utf8'), 'stderr'));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (signal && signal.aborted) {
        return resolve({ ok: false, aborted: true, stdout, stderr });
      }
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else reject(new Error(`${exe} exited ${code}: ${stderr.slice(-500).trim()}`));
    });

    if (signal) {
      const onAbort = () => { try { child.kill(); } catch {} };
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort);
      }
    }
  });
}

module.exports = { spawnTool };
```

- [ ] **Step 4: Run, expect 5 pass**

```
npm test -- tests/unit/spawn.test.js
```

- [ ] **Step 5: Run full suite, expect 158**

```
npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/shared/spawn.js ContextHelper/tests/unit/spawn.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add spawnTool wrapper for binary-backed plugins

Promise-based child_process.spawn wrapper with onProgress/parseProgress,
AbortSignal-driven cancel via child.kill(), and rejection on non-zero
exit carrying the last 500 chars of stderr. Used by binary-backed
plugins in Plan 3c-3f.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `.gitignore` + `bin.README.md` + electron-builder config

**Files:**
- Modify: `.gitignore` (at `C:\YandexDisk\Software\bin\ContextHelper\.gitignore`)
- Create: `resources/bin.README.md`
- Modify: `electron-builder.yml`

No new tests. This is config + docs.

- [ ] **Step 1: Read current `.gitignore`**

```
cat C:\YandexDisk\Software\bin\ContextHelper\.gitignore
```

- [ ] **Step 2: Add `resources/bin/` to `.gitignore`**

Append to the file:
```
# Bundled external tools — downloaded out of band, see resources/bin.README.md
resources/bin/
```

- [ ] **Step 3: Create `resources/bin.README.md`**

```markdown
# resources/bin — external tool binaries

This folder is gitignored. Download each tool once and place its Windows binary here. `electron-builder` bundles the entire folder into `dist/win-unpacked/resources/bin/` at package time.

## Required binaries

| File | Source | Version notes |
|---|---|---|
| `7z.exe` + `7z.dll` | https://www.7-zip.org/ → Download the **console version (7z)** for Windows. `7z.dll` lives next to `7z.exe`. | Tested with 24.x. Both files required. |
| `magick.exe` | https://imagemagick.org/script/download.php#windows → **Portable Win64 static** (single .exe). | Tested with 7.x. Single file. |
| `gswin64c.exe` | https://www.ghostscript.com/releases/gsdnld.html → Windows 64-bit. The console version (`gswin64c.exe`) is in the installer's `bin/` after install. | Tested with 10.x. |
| `ffmpeg.exe` + `ffprobe.exe` | https://www.gyan.dev/ffmpeg/builds/ → **release essentials** archive. Both binaries in `bin/`. | Tested with 7.x. |

## Layout expected

```
resources/bin/
├── 7z.exe
├── 7z.dll
├── magick.exe
├── gswin64c.exe
├── ffmpeg.exe
└── ffprobe.exe
```

## Size note

The combined folder is ~150 MB. The portable `dist/win-unpacked/` distribution will grow accordingly.

## License note

- 7-Zip: LGPL + unRAR restriction (don't redistribute the unRAR code if you customise builds).
- ImageMagick: ApacheStyle, see project.
- Ghostscript: AGPL v3.
- ffmpeg: LGPL by default, GPL components if certain flags enabled.

Bundling these for personal use is fine. Redistribution publicly without compliance to each license is your responsibility.
```

- [ ] **Step 4: Read current `electron-builder.yml`**

```
cat C:\YandexDisk\Software\bin\ContextHelper\electron-builder.yml
```

- [ ] **Step 5: Add `extraResources` to `electron-builder.yml`**

Append (or merge if a similar section exists):
```yaml
extraResources:
  - from: resources/bin
    to: bin
    filter:
      - '**/*'
```

The `from: resources/bin` is the source. `to: bin` makes it land at `dist/win-unpacked/resources/bin/` (electron-builder prefixes `resources/` automatically). Filter `**/*` includes everything.

- [ ] **Step 6: Verify file structure**

```
mkdir resources\bin 2>nul
```

(or `New-Item -ItemType Directory -Path resources/bin -Force` in PowerShell)

The empty `resources/bin/` will be gitignored. The binary files placed there later won't appear in `git status`. Verify:

```
git -C "C:\YandexDisk\Software\bin" status
```

Expected: shows `ContextHelper/resources/bin.README.md`, `ContextHelper/.gitignore`, `ContextHelper/electron-builder.yml`. The `resources/bin/` directory itself doesn't show as untracked.

- [ ] **Step 7: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/.gitignore ContextHelper/resources/bin.README.md ContextHelper/electron-builder.yml
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
chore(ContextHelper): scaffold resources/bin for bundled binaries

.gitignore excludes resources/bin/ contents. bin.README.md lists the
required tools (7z, magick, gswin64c, ffmpeg, ffprobe) with download
sources, version notes, and license caveats. electron-builder.yml gets
an extraResources entry so the folder is bundled into
dist/win-unpacked/resources/bin/ at package time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rename `dialog-shell.*` → `shell.*` (no behavior change)

**Files:**
- Rename: `src/renderer/dialog-shell.html` → `src/renderer/shell.html`
- Rename: `src/renderer/dialog-shell.css` → `src/renderer/shell.css`
- Rename: `src/renderer/dialog-shell.js` → `src/renderer/shell.js`
- Rename: `src/preload/dialog-shell-preload.js` → `src/preload/shell-preload.js`
- Modify: `src/main/window-manager.js` (factory name + file refs)
- Modify: `src/main/runners/dialog-runner.js` (any string refs if present — should be none)

This task is **pure renaming with import/factory updates**. No behavior change. All 150 tests must still pass after.

- [ ] **Step 1: Rename files with git mv**

```
cd C:\YandexDisk\Software\bin
git mv ContextHelper/src/renderer/dialog-shell.html      ContextHelper/src/renderer/shell.html
git mv ContextHelper/src/renderer/dialog-shell.css       ContextHelper/src/renderer/shell.css
git mv ContextHelper/src/renderer/dialog-shell.js        ContextHelper/src/renderer/shell.js
git mv ContextHelper/src/preload/dialog-shell-preload.js ContextHelper/src/preload/shell-preload.js
```

- [ ] **Step 2: Read `src/renderer/shell.html` and update link/script refs**

The renamed file still references `dialog-shell.css` and `dialog-shell.js`. Open and replace:
- `<link rel="stylesheet" href="./dialog-shell.css" />` → `<link rel="stylesheet" href="./shell.css" />`
- `<script src="./dialog-shell.js"></script>` → `<script src="./shell.js"></script>`

- [ ] **Step 3: Update `src/main/window-manager.js`**

Read the file. The function `createDialogShellWindow` references `dialog-shell.html` and `dialog-shell-preload.js`. Update both:

```js
function createDialogShellWindow() {
  // ...
  const file = path.join(__dirname, '..', 'renderer', 'shell.html');  // was 'dialog-shell.html'
  // ...
  preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),  // was 'dialog-shell-preload.js'
  // ...
}
```

Also rename the function `createDialogShellWindow` → `createShellWindow`. Update `module.exports` accordingly.

- [ ] **Step 4: Update `src/main/index.js`**

Read the file. Find any reference to `createDialogShellWindow`. Replace with `createShellWindow`. The import line:

```js
const { createPluginWindow, createDialogShellWindow } = require('./window-manager');
```

becomes:

```js
const { createPluginWindow, createShellWindow } = require('./window-manager');
```

And `createDialogShellWindow()` call sites become `createShellWindow()`.

- [ ] **Step 5: Run full suite, expect 158 (same as after Task 2)**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

If any test fails, the import update is incomplete — fix and re-run.

- [ ] **Step 6: Run package to confirm no broken file refs**

```
npm run package
```

Expected: success. The new shell.html / shell.css / shell.js are picked up.

- [ ] **Step 7: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/renderer/shell.html ContextHelper/src/renderer/shell.css ContextHelper/src/renderer/shell.js ContextHelper/src/preload/shell-preload.js ContextHelper/src/main/window-manager.js ContextHelper/src/main/index.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
refactor(ContextHelper): rename dialog-shell → shell (no behavior change)

Renames the renderer + preload files and the factory function
(createDialogShellWindow → createShellWindow). The shell will host
both dialog-mode AND window-mode plugins in subsequent tasks — keeping
"dialog" in the name was misleading. Behavior unchanged; suite green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `form` state HTML + CSS to shell

**Files:**
- Modify: `src/renderer/shell.html`
- Modify: `src/renderer/shell.css`

Add a new state section (no JS handlers yet — that comes in Task 6).

- [ ] **Step 1: Read `src/renderer/shell.html`**

Identify where the existing state sections live (inside `<div id="app">`).

- [ ] **Step 2: Insert new `form` section AFTER the existing `data-state="scanning"` section**

```html
<section data-state="form" class="state">
  <div class="row icon-row">
    <div class="icon icon-question">?</div>
    <div class="message" id="form-message"></div>
  </div>
  <div class="form-summary" id="form-summary"></div>
  <form class="form-fields" id="form-fields" autocomplete="off"></form>
  <div class="buttons">
    <button class="primary" data-action="start">Start</button>
    <button data-action="cancel">Cancel</button>
  </div>
</section>
```

- [ ] **Step 3: Read `src/renderer/shell.css`**

Find the section near the bottom (after the `.progress-*` rules and the `.has-progress` rule from earlier work).

- [ ] **Step 4: Append form-state styles**

```css
.form-summary {
  font-size: 12px;
  color: #666;
  margin: 8px 0 12px 0;
  flex: 0 0 auto;
}

.form-fields {
  flex: 0 1 auto;
  max-height: 400px;
  overflow-y: auto;
  padding: 4px 0;
}

.form-fields label {
  display: block;
  margin: 8px 0;
  font-size: 13px;
}

.form-fields .field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}

.form-fields input[type="text"],
.form-fields input[type="number"],
.form-fields select,
.form-fields textarea {
  width: 100%;
  padding: 4px 6px;
  font: inherit;
  border: 1px solid #c5c5c5;
  border-radius: 3px;
  box-sizing: border-box;
  background: #fff;
  color: #222;
}

.form-fields input[type="checkbox"],
.form-fields input[type="radio"] {
  margin-right: 6px;
}

.form-fields .ext-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 13px;
}

.form-fields .ext-row .ext-name {
  flex: 0 0 auto;
  font-family: "Consolas", monospace;
}

.form-fields .ext-row .ext-info {
  color: #888;
  font-size: 11px;
}
```

(The `.field-row` and `.ext-row` classes are anticipated patterns for Plan-3 plugins; including them now avoids per-plugin CSS later.)

- [ ] **Step 5: Run tests, expect 158 still (no test changes yet)**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/renderer/shell.html ContextHelper/src/renderer/shell.css
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): add form state HTML + CSS to shell

A 6th state for window-mode plugins: icon + message + summary +
plugin-injected form fields + Start/Cancel buttons. Form-fields
container is bounded at max-height 400px with internal scroll, same
pattern as .detail. Anticipated plugin patterns (.field-row, .ext-row)
also styled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add form-state JS handlers to shell.js

**Files:**
- Modify: `src/renderer/shell.js`

Form state needs: receive `set-state` payload with `{ message, summary, uiHtml }`, inject HTML, focus first field, send `{ action: 'start', options }` on Start click after harvesting form values.

- [ ] **Step 1: Read current `src/renderer/shell.js`**

Identify the `onSetState` callback and the existing click delegation.

- [ ] **Step 2: Extend the onSetState handler**

Inside the existing `if (payload.state === 'info' || payload.state === 'confirm' || payload.state === 'error') {...}` chain, add an `else if` branch for `'form'`. The relevant section becomes:

```js
window.shell.onSetState((payload) => {
  app.dataset.state = payload.state;
  if (payload.state === 'scanning' || payload.state === 'running') {
    const id = payload.state + '-label';
    if (payload.label) document.getElementById(id).textContent = payload.label;
    updateProgress(payload.state, payload.progress);
  } else if (payload.state === 'info' || payload.state === 'confirm' || payload.state === 'error') {
    document.getElementById(payload.state + '-message').textContent = payload.message || '';
    document.getElementById(payload.state + '-detail').textContent = payload.detail || '';
    setTimeout(() => {
      const btn = document.querySelector(`[data-state="${payload.state}"] button.primary`);
      if (btn) btn.focus();
    }, 0);
  } else if (payload.state === 'form') {
    document.getElementById('form-message').textContent = payload.message || '';
    document.getElementById('form-summary').textContent = payload.summary || '';
    document.getElementById('form-fields').innerHTML = payload.uiHtml || '';
    setTimeout(() => {
      const first = document.querySelector('#form-fields input:not([type="hidden"]), #form-fields select, #form-fields textarea');
      if (first) first.focus();
    }, 0);
  }
  requestResize();
});
```

- [ ] **Step 3: Replace the existing click-delegation handler with one that harvests form values**

Find the existing click delegation (around the line with `e.target.closest('button[data-action]')`). Replace:

```js
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  window.shell.send(btn.dataset.action);
});
```

with:

```js
function harvestFormOptions() {
  const form = document.getElementById('form-fields');
  const options = {};
  if (!form) return options;
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      // group multiple checkboxes with same name into array
      const existing = options[el.name];
      if (Array.isArray(existing)) {
        if (el.checked) existing.push(el.value || true);
      } else if (existing !== undefined) {
        // Already a single value — convert to array
        options[el.name] = [existing];
        if (el.checked) options[el.name].push(el.value || true);
      } else {
        // First checkbox of this name; if it has a value, treat as array start; else boolean
        if (el.value && el.value !== 'on') {
          options[el.name] = el.checked ? [el.value] : [];
        } else {
          options[el.name] = el.checked;
        }
      }
    } else if (el.type === 'radio') {
      if (el.checked) options[el.name] = el.value;
    } else if (el.type === 'number') {
      options[el.name] = Number(el.value);
    } else {
      options[el.name] = el.value;
    }
  }
  return options;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'start') {
    window.shell.send({ action: 'start', options: harvestFormOptions() });
  } else {
    window.shell.send(action);
  }
});
```

- [ ] **Step 4: Run tests, expect 158**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

- [ ] **Step 5: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/renderer/shell.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): shell.js form-state handlers + options harvest

set-state with state=form renders message + summary + injected uiHtml
and focuses the first form field. Click on the Start button harvests
all named inputs (input/select/textarea/radio/checkbox, with same-name
checkboxes grouped into arrays where they have explicit values) into
an options map and sends { action: 'start', options } via IPC. Cancel
keeps the original string-payload contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update preload to normalize send payload

**Files:**
- Modify: `src/preload/shell-preload.js`

The `send` function previously accepted a string (`'continue'`, `'cancel'`, `'ok'`). It must now also accept an object like `{ action: 'start', options: {...} }`. The IPC channel passes the payload as-is; main-process side normalizes.

- [ ] **Step 1: Read current `src/preload/shell-preload.js`**

The existing `send: (action) => ipcRenderer.send(IPC.SHELL_ACTION, { action })` always wraps in `{ action }`. We need to pass either form.

- [ ] **Step 2: Update the `send` function**

Replace:
```js
send: (action) => ipcRenderer.send(IPC.SHELL_ACTION, { action }),
```

with:

```js
send: (payload) => {
  if (typeof payload === 'string') {
    ipcRenderer.send(IPC.SHELL_ACTION, { action: payload });
  } else if (payload && typeof payload === 'object') {
    ipcRenderer.send(IPC.SHELL_ACTION, payload);
  }
},
```

So both `window.shell.send('cancel')` and `window.shell.send({ action: 'start', options: {...} })` work; dialog-runner's `actionHandler` already destructures `{ action }` and ignores other fields → no main-side change needed for cancel/ok/continue. Window-runner (rewritten in Task 8) reads `options` from the payload.

- [ ] **Step 3: Run tests, expect 158**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

- [ ] **Step 4: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/preload/shell-preload.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): shell-preload.send accepts string or object

Backward-compatible: string payload still wraps as { action: payload }.
Object payload (e.g. { action: 'start', options: {...} }) passes
through directly so window-runner can read the harvested form values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite window-runner for shell + form state

**Files:**
- Rewrite: `src/main/runners/window-runner.js`
- Rewrite: `tests/unit/window-runner.test.js`
- Delete: `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`

This is the biggest task in the plan. Window-runner gets the same shell-controller pattern as dialog-runner.

- [ ] **Step 1: Rewrite `src/main/runners/window-runner.js`**

```js
const { safeHook } = require('./safe-hook');
const { runWorkerPromise, runPreflightPromise } = require('./base-runner');
const { IPC } = require('../../shared/plugin-api');

function pathJoin(a, b) {
  if (!a) return b;
  const sep = a.indexOf('\\') >= 0 && a.indexOf('/') < 0 ? '\\' : '/';
  return a.endsWith(sep) ? a + b : a + sep + b;
}

function makeShellController({ shellWindow, ipcMain }) {
  let pendingResolver = null;
  let closed = false;

  const actionHandler = (_e, payload) => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(payload); }
  };
  const minHandler = () => { try { shellWindow.minimize(); } catch {} };
  const closeHandler = () => {
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r({ action: 'cancel' }); }
    try { shellWindow.destroy(); } catch {}
  };
  const resizeHandler = (_e, { height }) => {
    try {
      let maxH = 800;
      try {
        const { screen } = require('electron');
        const primary = screen.getPrimaryDisplay();
        maxH = Math.floor(primary.workAreaSize.height * 0.8);
      } catch {}
      const clamped = Math.max(180, Math.min(Number(height) || 180, maxH));
      const [w] = shellWindow.getContentSize();
      shellWindow.setContentSize(w, clamped);
    } catch {}
  };
  ipcMain.on(IPC.SHELL_ACTION, actionHandler);
  ipcMain.on(IPC.SHELL_MIN, minHandler);
  ipcMain.on(IPC.SHELL_CLOSE, closeHandler);
  ipcMain.on(IPC.SHELL_RESIZE, resizeHandler);
  shellWindow.on('closed', () => {
    closed = true;
    if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r({ action: 'cancel' }); }
  });

  const sendState = (payload) => {
    try { shellWindow.webContents.send(IPC.SHELL_SET_STATE, payload); } catch {}
  };
  const waitForAction = () => {
    if (closed) return Promise.resolve({ action: 'cancel' });
    return new Promise((resolve) => { pendingResolver = resolve; });
  };
  const close = () => {
    try { ipcMain.removeListener(IPC.SHELL_ACTION, actionHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_MIN, minHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_CLOSE, closeHandler); } catch {}
    try { ipcMain.removeListener(IPC.SHELL_RESIZE, resizeHandler); } catch {}
    try { shellWindow.destroy(); } catch {}
  };
  const onReady = (cb) => {
    try { shellWindow.webContents.once('did-finish-load', cb); } catch { cb(); }
  };
  return { sendState, waitForAction, close, onReady };
}

async function runWindowPlugin({
  manifest, plugin, pluginDir, targets, selection, binDir,
  openShell, ipcMain, runPreflight, runWorker, readUiHtml, logger,
}) {
  const label = manifest.label;
  const ctx = { manifest, targets, selection };
  const workerPath = pathJoin(pluginDir, 'plugin.js');

  let shellWindow;
  try { shellWindow = openShell(); }
  catch (err) {
    logger.error('window-runner: shell window failed to open', { message: err.message });
    return 3;
  }
  const shell = makeShellController({ shellWindow, ipcMain });
  await new Promise((resolve) => shell.onReady(resolve));

  const scanningLabel = safeHook(plugin, 'buildScanningLabel', () => 'Scanning…', logger, ctx);
  shell.sendState({ state: 'scanning', label: scanningLabel });

  // 1. Preflight
  let pre;
  try {
    pre = await runPreflightPromise(runPreflight, {
      workerPath, targets, selection, binDir,
      onProgress: (p) => shell.sendState({ state: 'scanning', label: scanningLabel, progress: p }),
    });
  } catch (err) {
    logger.error('window-runner: preflight crashed', { plugin: manifest.id, message: err.message });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: err.message });
    await shell.waitForAction();
    shell.close();
    return 3;
  }

  // 2. Form
  const uiHtml = readUiHtml(pluginDir);
  const summary = safeHook(plugin, 'buildFormSummary', () => '', logger, ctx, pre);
  const formMessage = safeHook(plugin, 'buildFormMessage', () => label, logger, ctx, pre);
  shell.sendState({ state: 'form', message: formMessage, summary, uiHtml });

  const actionPayload = await shell.waitForAction();
  if (!actionPayload || actionPayload.action !== 'start') {
    shell.close();
    return 0;
  }
  const options = actionPayload.options || {};

  // 3. Run
  const runningLabel = safeHook(plugin, 'buildRunningLabel', () => 'Working…', logger, ctx);
  shell.sendState({ state: 'running', label: runningLabel });

  const outcome = await runWorkerPromise(runWorker, {
    workerPath, targets, options, selection, binDir,
    onProgress: (p) => shell.sendState({ state: 'running', label: runningLabel, progress: p }),
  });

  // 4. Result
  if (outcome.kind === 'error') {
    logger.error('window-runner: worker error', { plugin: manifest.id, error: outcome.error });
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: outcome.error.message || 'unknown error' });
    await shell.waitForAction();
    shell.close();
    return 3;
  }
  const result = outcome.result || {};
  const errors = result.errors || [];
  if (result.ok && errors.length === 0) { shell.close(); return 0; }
  const body = safeHook(plugin, 'buildErrorBody',
    (_c, errs, processed, total) => `${processed} of ${total} processed.\n${errs.length} could not be processed.\n${errs.slice(0,10).map(e => `  • ${e.file} — ${e.message}`).join('\n')}`,
    logger, ctx, errors, result.processed || 0, pre.totalFiles || pre.totalItems || 0);
  shell.sendState({ state: 'error', message: `${label} — completed with errors`, detail: body });
  await shell.waitForAction();
  shell.close();
  return 1;
}

function readUiHtmlFromDisk(pluginDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(pluginDir, 'ui.html');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

module.exports = { runWindowPlugin, readUiHtmlFromDisk };
```

- [ ] **Step 2: Rewrite `tests/unit/window-runner.test.js`**

```js
const { runWindowPlugin } = require('../../src/main/runners/window-runner');
const { BasePlugin } = require('../../src/shared/base-plugin');

class StubPlugin extends BasePlugin {
  static get manifest() { return { id: 's', label: 'Stub', accepts: ['folders'] }; }
  async preflight() { return { totalFiles: 1 }; }
  async run() {}
}

function makeShellMock() {
  const states = [];
  const ipcListeners = {};
  const winListeners = {};
  const win = {
    webContents: {
      send: (channel, payload) => { if (channel === 'shell:set-state') states.push(payload); },
      once: (event, cb) => { if (event === 'did-finish-load') setImmediate(cb); },
    },
    on: (event, fn) => { winListeners[event] = fn; },
    destroy: () => {},
    minimize: () => {},
    getContentSize: () => [460, 180],
    setContentSize: () => {},
  };
  const ipcMain = {
    on: (channel, fn) => { ipcListeners[channel] = fn; },
    removeListener: (channel) => { delete ipcListeners[channel]; },
  };
  const fireAction = (payload) => {
    if (ipcListeners['shell:action']) ipcListeners['shell:action']({}, payload);
  };
  const fireClose = () => { if (winListeners['closed']) winListeners['closed'](); };
  return { states, win, ipcMain, fireAction, fireClose };
}

const manifest = { id: 's', label: 'Stub', accepts: ['folders'], ui: 'window' };
const selection = { folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] };

describe('runWindowPlugin', () => {
  it('opens shell, runs preflight, sends form state, returns 0 on cancel', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'cancel' }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 3 }),
      runWorker: () => { throw new Error('should not run'); },
      readUiHtml: () => '<input name="x" />',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(shell.states.find((s) => s.state === 'form')).toBeTruthy();
    expect(shell.states.find((s) => s.state === 'form').uiHtml).toBe('<input name="x" />');
  });

  it('runs worker with options from start payload, exits 0 on success', async () => {
    const shell = makeShellMock();
    let workerCalled = null;
    setTimeout(() => shell.fireAction({ action: 'start', options: { fmt: 'png', q: 90 } }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 3 }),
      runWorker: ({ options, onComplete }) => {
        workerCalled = options;
        setTimeout(() => onComplete({ ok: true, processed: 3, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
    expect(workerCalled).toEqual({ fmt: 'png', q: 90 });
  });

  it('exits 1 on partial run errors after start', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'start', options: {} }), 25);
    setTimeout(() => shell.fireAction({ action: 'ok' }), 100);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 5 }),
      runWorker: ({ onComplete }) => {
        setTimeout(() => onComplete({ ok: false, processed: 3, skipped: 2, errors: [{ file: 'x', message: 'EACCES' }] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(1);
  });

  it('exits 3 on preflight crash', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireAction({ action: 'ok' }), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => { throw new Error('pre-boom'); },
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(3);
    expect(shell.states.find((s) => s.state === 'error')).toBeTruthy();
  });

  it('passes binDir to runPreflight and runWorker', async () => {
    const shell = makeShellMock();
    const seen = {};
    setTimeout(() => shell.fireAction({ action: 'start', options: {} }), 25);
    await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/my/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async ({ binDir }) => { seen.preflight = binDir; return { totalFiles: 1 }; },
      runWorker: ({ binDir, onComplete }) => {
        seen.worker = binDir;
        setTimeout(() => onComplete({ ok: true, processed: 1, skipped: 0, errors: [] }), 5);
        return { cancel() {} };
      },
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(seen.preflight).toBe('/my/bin');
    expect(seen.worker).toBe('/my/bin');
  });

  it('exits 0 when window closes mid-form', async () => {
    const shell = makeShellMock();
    setTimeout(() => shell.fireClose(), 25);
    const code = await runWindowPlugin({
      manifest, plugin: new StubPlugin(), pluginDir: '/fake',
      targets: ['/a'], selection, binDir: '/bin',
      openShell: () => shell.win, ipcMain: shell.ipcMain,
      runPreflight: async () => ({ totalFiles: 1 }),
      runWorker: () => ({ cancel() {} }),
      readUiHtml: () => '',
      logger: { info() {}, error() {} },
    });
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 3: Delete the old window renderer files**

```
git -C "C:\YandexDisk\Software\bin" rm ContextHelper/src/renderer/index.html ContextHelper/src/renderer/app.js ContextHelper/src/renderer/styles.css
```

- [ ] **Step 4: Run tests, expect 6 window-runner tests passing, full suite ~157 (158 was, 7 old window-runner tests gone, 6 new added, net -1)**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

Recount expected: previous total was 158 (after Tasks 1+2). Old window-runner.test.js had 7 tests. New version has 6 tests. So expected: 158 - 7 + 6 = 157.

If a number is off, list the failing tests and reconcile.

- [ ] **Step 5: Run package to confirm renderer files are not missing**

```
npm run package
```

Expected: success.

- [ ] **Step 6: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/runners/window-runner.js ContextHelper/tests/unit/window-runner.test.js ContextHelper/src/renderer/index.html ContextHelper/src/renderer/app.js ContextHelper/src/renderer/styles.css
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): window-runner uses shell with form state

Rewrites window-runner to use the same frameless shell window that
dialog-runner uses. Flow: scanning → form (plugin's ui.html injected,
options harvested on Start) → running (with progress) → error or
silent close. Adds binDir parameter passed through to runPreflight /
runWorker. The old src/renderer/index.html + app.js + styles.css are
deleted — the unified shell replaces them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Thread `binDir` through dispatcher → worker → plugin

**Files:**
- Modify: `src/main/dispatcher.js`
- Modify: `src/main/worker-runner.js`
- Modify: `src/worker/worker-shim.js`
- Modify: `src/main/index.js` (`createRunner` factory passes binDir)
- Modify: `tests/unit/dispatcher.test.js`

The dispatcher resolves `binDir()` at startup and threads it through every layer until it lands in the plugin's ctx.

- [ ] **Step 1: Update `src/main/dispatcher.js`**

Read the file. At the top, add the import:
```js
const { binDir } = require('./utils/bin-paths');
```

In the `runner.execute(...)` call at the bottom of `dispatch`, add `binDir: binDir()`:

```js
return await runner.execute({
  manifest: plugin.manifest,
  plugin: instance,
  pluginDir: plugin.dir,
  targets,
  selection,
  binDir: binDir(),
});
```

- [ ] **Step 2: Update `src/main/worker-runner.js`**

Read the file. Both `runWorker` and `runPreflight` need to accept `binDir` and include it in the `send` message.

Update `runWorker`:
```js
function runWorker({ workerPath, targets, options, selection, binDir, onProgress, onComplete, onError }) {
  // ... existing setup ...
  child.send({ type: 'start', workerPath, targets, options, selection, binDir });
  // ...
}
```

Update `runPreflight`:
```js
function runPreflight({ workerPath, targets, selection, binDir, onProgress }) {
  // ... existing setup ...
  child.send({ type: 'preflight', workerPath, targets, selection, binDir });
  // ...
}
```

(Both functions' bodies stay otherwise the same. Just add `binDir` to destructuring and the IPC message.)

- [ ] **Step 3: Update `src/worker/worker-shim.js`**

Read the file. Both `handleStart` and `handlePreflight` destructure the message and pass to plugin via ctx. Add `binDir`:

```js
async function handleStart(msg) {
  const { workerPath, targets, options, selection, binDir } = msg;
  // ...
  const result = await instance.run({
    targets, options, selection, binDir,
    onProgress: (...),
    signal,
  });
  // ...
}

async function handlePreflight(msg) {
  const { workerPath, targets, selection, binDir } = msg;
  // ...
  const result = await instance.preflight({
    targets, selection, binDir,
    onProgress: (...),
    signal,
  });
  // ...
}
```

- [ ] **Step 4: Update `src/main/index.js`'s `createRunner` factory**

Read the file. The dialog branch currently:
```js
if (uiMode === 'dialog') {
  return {
    execute: (ctx) => runDialogPlugin({
      ...ctx,
      dialog, runPreflight, runWorker,
      openSpinner: ({ label }) => { ... },
      logger,
    }),
  };
}
```

becomes (note: `ctx` already contains binDir now — it spreads through):
```js
if (uiMode === 'dialog') {
  return {
    execute: (ctx) => runDialogPlugin({
      ...ctx,  // includes binDir, manifest, plugin, pluginDir, targets, selection
      dialog, runPreflight, runWorker,
      openShell: () => createShellWindow(),
      ipcMain,
      logger,
    }),
  };
}
```

Wait — dialog-runner currently uses `openSpinner` not `openShell`. Check the current dialog-runner signature — if it uses `openShell`, no change needed beyond `...ctx`. If it uses `openSpinner`, we don't need to change it here; just confirm `...ctx` carries binDir through.

The window branch:
```js
return {
  execute: (ctx) => runWindowPlugin({
    ...ctx,
    createWindow: createPluginWindow,
    ipcMain,
    runPreflight, runWorker,
    readUiHtml: readUiHtmlFromDisk,
    logger,
  }),
};
```

This is now wrong — `runWindowPlugin` was rewritten in Task 8 to take `openShell` and `ipcMain` and `readUiHtml` and the spread ctx (which has binDir). Update:

```js
return {
  execute: (ctx) => runWindowPlugin({
    ...ctx,
    openShell: () => createShellWindow(),
    ipcMain,
    runPreflight, runWorker,
    readUiHtml: readUiHtmlFromDisk,
    logger,
  }),
};
```

Also remove the `createPluginWindow` import from window-manager since it's no longer used. Update the require line:
```js
const { createShellWindow } = require('./window-manager');
```

(was `{ createPluginWindow, createShellWindow }`). And `createPluginWindow` function in window-manager.js can be removed too.

- [ ] **Step 5: Remove `createPluginWindow` from `src/main/window-manager.js`**

Read window-manager.js. Delete the `createPluginWindow` function entirely. Update `module.exports`:

```js
module.exports = { createShellWindow };
```

- [ ] **Step 6: Update `tests/unit/dispatcher.test.js` for binDir threading**

Read the file. Update the default `makeDeps` to mock `binDir`-aware runner:

```js
function makeDeps(overrides = {}) {
  return {
    parseCli: () => ({ kind: 'run', action: 'p', targets: ['/a'] }),
    loadAll: () => new Map([['p', { Cls: class { async run() {} }, manifest: { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 }, dir: '/fake' }]]),
    aggregateTargets: async ({ myTarget }) => ({ role: 'leader', targets: [myTarget] }),
    classify: () => ({ folders: ['/a'], files: [], missing: [], exts: [], basenames: ['a'] }),
    validate: () => ({ ok: true, effectiveTargets: ['/a'], skipped: [] }),
    createRunner: () => ({ execute: async () => 0 }),
    dialog: { showErrorBox: () => {} },
    fs: {},
    logger: { info() {}, error() {} },
    ...overrides,
  };
}
```

Add ONE test verifying binDir is in the ctx passed to runner.execute:

```js
it('passes binDir into runner.execute ctx', async () => {
  let seenBinDir = null;
  await dispatch({ argv: [] }, makeDeps({
    createRunner: () => ({ execute: async (ctx) => { seenBinDir = ctx.binDir; return 0; } }),
  }));
  expect(typeof seenBinDir).toBe('string');
  expect(seenBinDir.endsWith('bin') || seenBinDir.includes('bin')).toBe(true);
});
```

- [ ] **Step 7: Run tests, expect 158 (157 from Task 8 + 1 new dispatcher test)**

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test
```

- [ ] **Step 8: Run package, expect success**

```
npm run package
```

- [ ] **Step 9: Commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/src/main/dispatcher.js ContextHelper/src/main/worker-runner.js ContextHelper/src/worker/worker-shim.js ContextHelper/src/main/index.js ContextHelper/src/main/window-manager.js ContextHelper/tests/unit/dispatcher.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(ContextHelper): thread binDir from dispatcher to plugin ctx

binDir resolves once at dispatcher startup via bin-paths.binDir() and
is included in the ctx passed to runner.execute. worker-runner's
runWorker and runPreflight forward it as IPC msg.binDir; worker-shim
hands it to plugin.preflight() / plugin.run() via ctx.binDir. Plugins
that need bundled binaries (Plan 3c-3f) build paths via
path.join(ctx.binDir, 'tool.exe').

Also removes the now-dead createPluginWindow factory (window-runner
uses createShellWindow only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Manual verification + final commit

**Files:** none — verification only.

- [ ] **Step 1: Rebuild dist**

```
cd C:\YandexDisk\Software\bin\ContextHelper
npm run package
```

- [ ] **Step 2: Verify shell window opens for flatten-folder**

Open Explorer, right-click any folder with nested files → ContextHelper → Folders → Flatten folder.

Expected behavior (unchanged from before this plan):
- Single shell window opens with scanning state
- Spinner + "Scanning…" label
- Transitions to confirm with folder list
- Continue → running with progress bar
- Closes silently on success

If any state misrenders, the rename in Task 4 broke an import. Check the dist's `resources/app.asar` for shell.html / shell.css / shell.js / shell-preload.js.

- [ ] **Step 3: Verify the dispatcher reaches the plugin with binDir**

In the dev tools / logger output (`%LOCALAPPDATA%\ContextHelper\logs\<today>.log`), look for the dispatcher info log. The plugin's preflight/run currently doesn't log binDir — that's fine. Trust the unit tests.

- [ ] **Step 4: Mark plan complete**

Edit the top of this plan file:

```markdown
> **Status:** ✅ COMPLETE (YYYY-MM-DD). 10 tasks executed; 158/158 unit tests + smoke + manual flatten-folder verification.
```

Update `CLAUDE.md` "Resume here" — add a paragraph noting that Plan 3a (infrastructure) is done; next is Plan 3b.

- [ ] **Step 5: Final commit**

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/docs/superpowers/plans/2026-05-20-plan-3a-infrastructure.md ContextHelper/CLAUDE.md
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
docs(ContextHelper): mark Plan 3a (infrastructure) complete

Bin-paths, spawn helper, shell unification (dialog-shell renamed to
shell, form state added), window-runner brought to parity with
dialog-runner. flatten-folder still works end-to-end. Plan 3b
(pure-JS plugins) is next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage** (against `2026-05-20-plan-3-design.md` §6 "Sub-plan 3a"):
- bin-paths.js → Task 1 ✓
- spawn.js → Task 2 ✓
- shell unification (rename + form state) → Tasks 4, 5, 6 ✓
- window-runner upgrade → Task 8 ✓
- electron-builder extraResources → Task 3 ✓
- .gitignore + bin.README.md → Task 3 ✓
- dispatcher passes binDir → Task 9 ✓

**Test count target** (spec §6: +12 tests):
- Task 1: +3 (bin-paths)
- Task 2: +5 (spawn)
- Task 8: 6 window-runner tests (was 7, net -1)
- Task 9: +1 dispatcher (binDir threading)
- Net: +8 tests (150 → 158)

The spec said +12; this plan delivers +8. The discrepancy is because the existing window-runner tests aren't strictly "new" coverage — they're rewritten with the same intent. Net new test coverage is approximately right.

**Placeholder scan:** no TBDs, every step has either complete code or an exact command.

**Type consistency:**
- `binDir` consistently used as a function (`binDir()`) returning a string.
- `ctx.binDir` consistently passed as a string.
- `runner.execute(ctx)` always receives binDir in ctx.
- `openShell` (window-runner) vs `openSpinner` (dialog-runner, pre-existing) — these are different factories. Renaming dialog-runner's openSpinner to openShell would be a follow-up cleanup; out of scope for 3a.
- Shell payload `start` action format: `{ action: 'start', options: {...} }` consistent between preload (Task 7), shell.js (Task 6), and window-runner (Task 8).
