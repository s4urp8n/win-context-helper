# Plan 3 — Ten plugins + bundled binary infrastructure

> **Status:** Draft, awaiting user review.
> **Author:** Claude Opus 4.7 (1M context).
> **Date:** 2026-05-20.
> **Depends on:** `2026-05-19-dispatcher-refactor-design.md` (class-based plugin contract, Folders/Files menu, dialog-shell).

## 1. Goal

Add ten new plugins to ContextHelper, organised in five categories by the external binary they need (or none). Provide the infrastructure to bundle binaries inside the portable distribution. Bring window-mode UI to parity with dialog-mode by unifying both flows into a single `shell.html` (extension of the current `dialog-shell.html`).

After Plan 3 ships, the `ContextHelper → Folders | Files` menu carries 11 plugins (flatten-folder plus the ten below), the portable dist self-contains every external tool used, and each plugin has its own unit test file.

## 2. Per-plugin summary

| Plugin | UI | accepts | Binary | What it does |
|---|---|---|---|---|
| `cleanup-by-extension` | window | folders 1..999 | — | Delete files of selected extensions from selected folders, recursively |
| `merge-folders` | window | folders 2..999 | — | Merge contents of 2-N folders into the first (alphabetical order) |
| `archive-each` | dialog | folders+files 1..999 | `7z.exe` | Create `<basename>.7z` next to each selected item (max compression) |
| `convert-image` | window | image files 1..999 | `magick.exe` | Convert each image to a chosen target format/quality |
| `images-to-pdf` | window | image files 1..999 | `magick.exe` | Combine selected images into one PDF |
| `merge-pdf` | dialog | `.pdf` files 2..999 | `gswin64c.exe` | Merge into `Merged.pdf` in the parent of the first selected |
| `split-pdf` | window | `.pdf` file 1..1 | `gswin64c.exe` | Split a single PDF (per-page or by ranges) |
| `convert-audio` | window | audio files 1..999 | `ffmpeg.exe` | Convert each audio file to a chosen target format/bitrate |
| `extract-audio` | dialog | video files 1..999 | `ffmpeg.exe` + `ffprobe.exe` | Extract first audio track as `.mp3` (192k) next to source |
| `concat-video` | dialog | video files 2..999 | `ffmpeg.exe` | Concatenate (stream-copy) into one file in parent of the first |

Image extensions supported (convert-image, images-to-pdf): `.jpg, .jpeg, .png, .bmp, .tiff, .tif, .webp, .gif`.
Audio extensions (convert-audio): `.mp3, .wav, .flac, .m4a, .ogg, .opus, .aac`.
Video extensions (extract-audio, concat-video): `.mp4, .mkv, .mov, .avi, .webm`.

## 3. Architecture

### 3.1. Binary infrastructure

**`src/main/utils/bin-paths.js`** — single resolver:

```js
const path = require('node:path');

function binDir() {
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', '..', 'resources', 'bin');
}

function binPath(name) {
  return path.join(binDir(), name);
}

module.exports = { binDir, binPath };
```

Main process resolves `binDir()` once at startup. The dispatcher injects it into runner context. Runners forward it via the worker-shim IPC `start`/`preflight` message (`msg.binDir`). Worker-shim passes it to plugin ctx as `ctx.binDir`. Plugin builds binary paths: `path.join(ctx.binDir, '7z.exe')`.

**Repo layout:**

```
resources/bin/                  ← .gitignore'd (binaries not in git)
  ffmpeg.exe
  ffprobe.exe
  magick.exe                    ← single-file ImageMagick build
  gswin64c.exe                  ← Ghostscript Windows console build
  7z.exe
  7z.dll                        ← 7z's required companion DLL

resources/bin.README.md         ← versions + download URLs for each tool
.gitignore                      ← add: resources/bin/
```

**`electron-builder.yml`** — add `extraResources`:

```yaml
extraResources:
  - from: resources/bin
    to: bin
    filter: '**/*'
```

→ files copied into `dist/win-unpacked/resources/bin/` at package time.

### 3.2. Spawn helper

**`src/shared/spawn.js`** — common wrapper around `child_process.spawn` used by every binary-backed plugin:

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

    const feed = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (stream === 'stderr') stderr += text;
      else stdout += text;
      if (parseProgress) {
        const p = parseProgress(text, stream);
        if (p && onProgress) onProgress(p);
      }
    };
    child.stdout.on('data', (c) => feed(c, 'stdout'));
    child.stderr.on('data', (c) => feed(c, 'stderr'));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (signal && signal.aborted) return resolve({ ok: false, aborted: true, stdout, stderr });
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else reject(new Error(`${exe} exited ${code}: ${stderr.slice(-500).trim()}`));
    });
    if (signal) {
      const onAbort = () => { try { child.kill(); } catch {} };
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);
    }
  });
}

module.exports = { spawnTool };
```

Each binary-backed plugin defines its own `parseProgress(text, stream) → { processed?, total?, scanned? }` or null. Throttling (150ms / 100 items) is per-plugin.

### 3.3. Unified shell (dialog + window)

`src/renderer/dialog-shell.html` is renamed to `src/renderer/shell.html` and gains a new `form` state for window-mode plugins. States:

| State | Used by | Renders |
|---|---|---|
| `scanning` | dialog + window | Spinner + scanning label |
| `form` | window only | `?` icon + message + plugin's injected form HTML + summary + Start/Cancel |
| `confirm` | dialog only | `?` icon + message + detail + Continue/Cancel |
| `running` | dialog + window | Spinner + running label + progress bar/counter (when data available) |
| `info` | dialog only | `i` icon + message + detail + OK |
| `error` | both | `!` icon + message + detail + OK |

HTML fragment for the new state:

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

Renderer logic for `form`:
- `set-state` payload includes `{ message, summary, uiHtml }`. The renderer injects `uiHtml` into `#form-fields` as `innerHTML`.
- On click `[data-action="start"]`: read all `<input>`, `<select>`, `<textarea>` inside `#form-fields`, build `options` map keyed by `name`, send `shell:action` with `{ action: 'start', options }`.

IPC remains the same plus the `start` action payload extension.

`src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css` (the Plan-1 window shell) are **deleted** — the unified shell replaces them.

### 3.4. Runner contract updates

**`window-runner.js`**:

```js
async function runWindowPlugin({ manifest, plugin, pluginDir, targets, selection, binDir, openShell, ipcMain, runPreflight, runWorker, readUiHtml, logger }) {
  // ... open shell as scanning
  // ... run preflight (with onProgress wired to shell scanning state)
  // ... send state=form with { message, summary, uiHtml }
  // ... await user 'start' or 'cancel' action; cancel → close, exit 0
  // ... send state=running, runWorker with the options from the start payload
  // ... on result: silent close (success) OR state=error → wait OK → exit 1
}
```

Both runners share `makeShellController` (extracted to `src/main/runners/shell-controller.js` if reused, otherwise stays inline in each runner). The controller adds the new `start` action signal so window-runner can `await waitForStartAction()` that returns `{ options }`.

`window-manager.js` factory `createDialogShellWindow` → renamed `createShellWindow` (it serves both modes now). The factory stays the same otherwise.

### 3.5. Dispatcher changes

`dispatcher.js` resolves `binDir` once at the top and passes through to the runner via `deps.binDir`:

```js
const { binDir } = require('./utils/bin-paths');
// ...
return await runner.execute({
  manifest, plugin: instance, pluginDir, targets, selection,
  binDir: binDir(),     // ← new
});
```

`worker-runner.js` `runWorker` and `runPreflight` accept `binDir` and include it in the IPC message. `worker-shim.js` passes `binDir` to plugin via ctx (`{ targets, options, selection, binDir, onProgress, signal, logger }`).

### 3.6. Output naming convention

| Pattern | Used by | Output |
|---|---|---|
| **Sibling** | per-item plugins (archive-each, convert-image, convert-audio, extract-audio) | `<source-dir>/<source-basename-without-ext>.<new-ext>` |
| **Parent-of-first** | combine plugins (merge-pdf, images-to-pdf, concat-video) | `<parent-of-first>/<default-name>.<ext>` |
| **Sibling-multi** | split plugins (split-pdf) | `<source-dir>/<source-basename>-<N>.pdf` |
| **In-place** | destructive plugins (cleanup-by-extension, merge-folders) | modifies originals |

All naming uses `src/main/utils/collision.js`'s `resolveCollision()` on collisions. Names that already exist get `(N)` suffix incremented until free.

The plugin's `preflight()` computes the **outputPlan** (`[{ source, output }]`) and returns it as part of the result so `buildConfirmMessage` can show output paths to the user when useful.

## 4. Per-plugin specifications

### 4.1. `cleanup-by-extension` (pure-JS, window)

- **accepts:** `["folders"]`, `min: 1`, `max: 999`
- **preflight:** scans folders recursively (respecting hidden default off), groups files by extension → `{ extensions: [{ ext, count, totalBytes }], totalFiles, totalBytes }`. Sorted by count desc.
- **form:** checkboxes per extension showing `(<count> files, <human-bytes> MB)`; toggle "Show hidden files" (default off). Form values: `selectedExts` (array).
- **run:** for each folder, walks recursively; deletes files where `path.extname(name).toLowerCase()` ∈ `selectedExts`. Does NOT delete folders. Emits progress per file (throttled). Errors per file → `errors[]`, skips and continues.
- **output:** none; modifies in-place.
- **isEmpty:** when `preflight().totalFiles === 0`.

### 4.2. `merge-folders` (pure-JS, window)

- **accepts:** `["folders"]`, `min: 2`, `max: 999`
- **preflight:** sorts folders by basename alphabetically. The first becomes target. Scans sources, returns `{ target: { basename }, sources: [{ basename, fileCount }], totalFiles, collisionCount }`.
- **form:** radio "Collision strategy": `Rename (N)` / `Skip` / `Overwrite`. Default Rename. Checkbox "Delete source folders after merge" (default on).
- **run:** for each source folder, walks files (not subfolders — we move whole tree by walking files and constructing target paths inside `target/`, preserving relative subpath). Strategy:
  - Rename: collision → `name (N).ext`
  - Skip: leave the source file in place, count in `skipped`
  - Overwrite: `fs.renameSync` over existing
- After all files moved, `pruneEmptyDirs(source)` if "Delete source folders" is on.
- **isEmpty:** when `totalFiles === 0`.

### 4.3. `archive-each` (7z, dialog)

- **accepts:** `["folders", "files"]`, `min: 1`, `max: 999`
- **preflight:** for each item, `fs.statSync` → size (or recursive walk for folders). Returns `{ items: [{ basename, isFolder, sizeBytes }], totalItems, totalBytes }`.
- **buildConfirmMessage:** "Archive `N` items? Output: `Foo.7z`, `Bar.7z`, … (next to source). Total: `X MB`."
- **run:** for each item:
  - `args = ['a', '-t7z', '-mx=9', outputPath, sourcePath]`
  - `spawnTool({ exe: path.join(binDir, '7z.exe'), args, onProgress, parseProgress: parse7zProgress })`
  - `parse7zProgress` extracts `\d+%` lines from stdout
  - Per-file: increment processed, emit `{ processed, total }`
- **output:** sibling `.7z`, collision → `(N)`.

### 4.4. `convert-image` (magick, window)

- **accepts:** `["files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif"]`, `min: 1`, `max: 999`
- **preflight:** `{ files: [{ basename, sizeBytes, ext }], totalFiles, byExt: {} }`.
- **form:** select "Target format" (`.png`, `.jpg`, `.webp`, `.bmp`, `.tiff`; default `.png`). Slider "Quality" 1-100 (default 90, shown only for lossy targets). Checkbox "Delete original after convert" (default off).
- **run:** for each file:
  - `args = ['-monitor', input, '-quality', String(quality), output]` (omit `-quality` for lossless targets)
  - `spawnTool({ exe: path.join(binDir, 'magick.exe'), args, parseProgress: parseMagickProgress })`
  - If "delete original" → `fs.unlinkSync(input)` after success
- **output:** sibling with target extension, collision → `(N)`.

### 4.5. `images-to-pdf` (magick, window)

- **accepts:** image files, `min: 1`, `max: 999`
- **preflight:** sorts files by basename; returns `{ files: [...], totalFiles, totalBytes }`.
- **form:** text input "Output filename" (default `Images.pdf`). Select "Page size" (`Original`, `A4`, `Letter`; default Original).
- **run:** single `magick.exe` invocation:
  - `args = ['-monitor', ...inputs, output]`
  - For `A4` / `Letter`: add `-page <size>` between inputs and output
- **output:** `<parent of first>/<outputFilename>` with `.pdf` extension enforced. Collision → `(N)`.

### 4.6. `merge-pdf` (gswin64c, dialog)

- **accepts:** `["files:.pdf"]`, `min: 2`, `max: 999`
- **preflight:** sort by basename, `{ files: [{ basename, sizeBytes }], totalFiles, totalBytes }`. (pageCount via gswin64c on v1 — too slow; omitted)
- **buildConfirmMessage:** "Merge `N` PDFs into 'Merged.pdf'? Total size: `X MB`. Output in `<parent>`."
- **run:**
  - `args = ['-dBATCH', '-dNOPAUSE', '-q', '-sDEVICE=pdfwrite', `-sOutputFile=${output}`, ...inputs]`
  - Single invocation. Progress is indeterminate (gswin64c stdout is sparse) — spinner stays on without progress bar; OR show "Merging…" with no bar.
- **output:** `<parent of first>/Merged.pdf`. Collision → `(N)`.

### 4.7. `split-pdf` (gswin64c, window)

- **accepts:** `["files:.pdf"]`, `min: 1`, `max: 1`
- **preflight:** runs gswin64c to count pages:
  - `gswin64c -q -dNODISPLAY -c "(${file}) (r) file runpdfbegin pdfpagecount = quit"`
  - parses single integer from stdout
  - returns `{ totalPages, basename }`
- **form:** radio "Split mode": `Per page` / `By ranges` (default Per page). Text input "Ranges" (e.g. `1-5, 7, 10-12`), validated, shown only for ranges mode. Text input "Output prefix" (default `<basename>-`).
- **run:**
  - Per-page: loop `i = 1..totalPages`, for each call gswin64c with `-dFirstPage=i -dLastPage=i -sOutputFile=<prefix><i>.pdf`. Progress: per iteration.
  - By ranges: parse `1-5, 7, 10-12` into spans, call once per span with `-dFirstPage / -dLastPage`. Output name: `<prefix>1-5.pdf` etc.
- **output:** sibling, collision → `(N)`.

### 4.8. `convert-audio` (ffmpeg, window)

- **accepts:** `["files:.mp3,.wav,.flac,.m4a,.ogg,.opus,.aac"]`, `min: 1`, `max: 999`
- **preflight:** `{ files: [{ basename, sizeBytes, ext }], totalFiles }`. Duration via ffprobe is optional (adds latency) — omitted on v1; progress within a single file shows `time=` from ffmpeg stderr without a total.
- **form:** select "Target format" (`.mp3, .wav, .flac, .m4a, .ogg, .opus, .aac`; default `.mp3`). Input "Bitrate kbps" (default 192, shown only for lossy targets). Checkbox "Delete original" (default off).
- **run:** per file:
  - `args = ['-i', input, '-b:a', `${bitrate}k`, output]` (omit `-b:a` for lossless)
  - `spawnTool({ exe: path.join(binDir, 'ffmpeg.exe'), args, parseProgress: parseFfmpegProgress })`
- **output:** sibling, collision → `(N)`.

### 4.9. `extract-audio` (ffmpeg + ffprobe, dialog)

- **accepts:** `["files:.mp4,.mkv,.mov,.avi,.webm"]`, `min: 1`, `max: 999`
- **preflight:** for each file, runs ffprobe to check for audio stream presence:
  - `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 input`
  - if output empty → no audio. Skip-list those.
- Returns `{ files: [{ basename, sizeBytes, hasAudio: bool }], totalFiles }`.
- **buildConfirmMessage:** "Extract audio from `N` videos to `.mp3` (192k)? Files without audio in skip-list."
- **run:** per file with `hasAudio`:
  - `args = ['-i', input, '-vn', '-b:a', '192k', output]`
- **output:** sibling `.mp3`, collision → `(N)`.

### 4.10. `concat-video` (ffmpeg, dialog)

- **accepts:** `["files:.mp4,.mkv,.mov,.avi,.webm"]`, `min: 2`, `max: 999`
- **preflight:** sort by basename. `{ files: [{ basename, sizeBytes }], totalFiles, totalBytes, container: ext-of-first }`. Optional ffprobe compatibility check (codec match) — v1 skip; users see ffmpeg error if incompatible.
- **buildConfirmMessage:** "Concatenate `N` videos into 'Concatenated.<ext>'? Total: `X MB`. Stream-copy (no re-encode)."
- **run:**
  - Create temp file `concat-list.txt` with lines `file 'path'` (escape single quotes in paths).
  - `args = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]`
  - Single invocation. Progress from stderr `time=HH:MM:SS.SS` — total duration unknown without per-file ffprobe (v1 omitted; show counter or indeterminate).
- **output:** `<parent of first>/Concatenated.<container>`. Collision → `(N)`.

## 5. Common conventions

### 5.1. Plugin ctx (extended)

Every plugin's `preflight` and `run` receive:

```js
{
  targets:    string[],
  selection:  { folders, files, missing, exts, basenames, skipped },
  options:    object,        // form values for window plugins; {} for dialog
  binDir:     string,        // absolute path to resources/bin/
  onProgress: function,      // throttle in plugin
  signal:     { aborted },
  logger:     { info, warn, error },
}
```

`binDir` is the only new field vs. dispatcher refactor.

### 5.2. Spawn error handling

`spawnTool` throws `Error` carrying the last 500 chars of stderr. Plugin's `run()` wraps each invocation:

```js
try {
  await spawnTool({ ... });
  processed++;
} catch (err) {
  errors.push({ file: path.basename(target), message: err.message });
  skipped++;
}
```

Continues processing remaining items. Final result: `{ ok: errors.length === 0, processed, skipped, errors }`. Error dialog at end (built via `plugin.buildErrorBody`) shows all per-file failures.

### 5.3. Cancel semantics

`signal.aborted` is propagated to `spawnTool`, which calls `child.kill()`. Cancel is currently triggered only by closing the shell window (✕) — no explicit Cancel button during run. Long-running binaries (concat-video) are killed when window closes. Half-written output files are left on disk (acceptable for v1; document in plugin behavior section).

### 5.4. Progress emit throttling

Throttle wrapper applied per plugin: emit at most every 150 ms AND every 100 items (whichever is slower). For per-binary progress where the binary emits high-frequency lines (ffmpeg outputs every frame), the same throttle applies.

### 5.5. Logging discipline

Plugins use `ctx.logger.info/error` only. No `console.*`. Errors → `error` with a meaningful tag (e.g. `plugin: convert-image: spawn failed`). Phase boundaries → `info`. Stack traces in `meta` only, never in the human-readable message field.

### 5.6. Testing strategy

**Mandatory per plugin (8 tests minimum):**

1. `static manifest` shape — id/label/accepts/min/max/ui
2. `preflight` happy path — shape + counts match a typical fixture
3. `preflight` empty case — `totalFiles: 0` or equivalent
4. `preflight` non-mutation — mtimes preserved
5. `run` happy path — output appears, return `ok: true`
6. `run` error handling — on simulated spawn failure / FS error, returns `errors[]` non-empty, `ok: false`, doesn't abort early
7. `buildConfirmMessage` (for dialog plugins) — correct text for single/multi
8. `buildRunningLabel` — returns the verb form (e.g. "Converting…")

**Pure-JS plugins:** real FS via tmp fixtures.

**Binary-backed plugins:** `vi.mock('node:child_process')` substitutes `spawn` with a fake that:
- records the args passed
- emits configurable stdout/stderr lines via `EventEmitter`
- exits with configurable code
- supports `kill()`

Tests assert on captured args (e.g. `expect(spawnCalls[0].args).toContain('-quality')`) and on plugin's interpretation of the simulated output.

**Not in `npm test`:**
- Real binary invocations (no `magick` / `ffmpeg` runs in unit tests)
- Real Explorer integration

**Smoke (optional, separate target):** `npm run smoke:bin` would run each binary-backed plugin against a tiny real fixture. Deferred — not in Plan 3 scope.

### 5.7. Manifest conventions

Required fields per plugin (same as dispatcher-refactor §3.4):
- `id` (matches folder name)
- `label`
- `description` (≤80 chars, human-readable)
- `icon` (`icon.png`, placeholder 16×16 transparent — final icons optional)
- `accepts` (array of patterns per §2)
- `minSelection`, `maxSelection`
- `ui` (`"dialog"` or `"window"`)

### 5.8. Shell unification details

`src/renderer/dialog-shell.html` → renamed to `src/renderer/shell.html`. Adds `data-state="form"` section. Existing scanning/info/confirm/running/error sections unchanged.

`dialog-shell.css` → `shell.css`. Adds `.form-fields` styles:

```css
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
.form-fields input[type="text"],
.form-fields input[type="number"],
.form-fields select {
  width: 100%;
  padding: 4px 6px;
  font: inherit;
  border: 1px solid #c5c5c5;
  border-radius: 3px;
  box-sizing: border-box;
}
.form-fields input[type="checkbox"],
.form-fields input[type="radio"] {
  margin-right: 6px;
}
.form-summary {
  font-size: 12px;
  color: #666;
  margin: 8px 0 12px 0;
}
```

`dialog-shell.js` → `shell.js`. Adds form-state handling:

```js
// In onSetState:
if (payload.state === 'form') {
  document.getElementById('form-message').textContent = payload.message || '';
  document.getElementById('form-summary').textContent = payload.summary || '';
  document.getElementById('form-fields').innerHTML = payload.uiHtml || '';
  setTimeout(() => {
    const first = document.querySelector('#form-fields input, #form-fields select, #form-fields textarea');
    if (first) first.focus();
  }, 0);
}

// Click handler for [data-action="start"]:
if (btn.dataset.action === 'start') {
  const form = document.getElementById('form-fields');
  const options = {};
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    if (el.type === 'checkbox') options[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) options[el.name] = el.value; }
    else if (el.type === 'number') options[el.name] = Number(el.value);
    else options[el.name] = el.value;
  }
  window.shell.send({ action: 'start', options });
  return;
}
```

(`window.shell.send` signature changes from `(action: string)` to `(payload: string | {action, options})`. Preload normalises.)

`dialog-shell-preload.js` → `shell-preload.js`. Renamed; expose `send(payload)` accepting both old shape and new shape.

### 5.9. Window-runner with form state

```js
async function runWindowPlugin({ manifest, plugin, pluginDir, targets, selection, binDir, openShell, ipcMain, runPreflight, runWorker, readUiHtml, logger }) {
  const shellWindow = openShell();
  const shell = makeShellController({ shellWindow, ipcMain });
  await new Promise((resolve) => shell.onReady(resolve));

  const label = manifest.label;
  const scanningLabel = safeHook(plugin, 'buildScanningLabel', () => 'Scanning…', logger, { manifest, targets, selection });
  shell.sendState({ state: 'scanning', label: scanningLabel });

  let pre;
  try {
    pre = await runPreflight({ workerPath: pathJoin(pluginDir, 'plugin.js'), targets, selection, binDir, onProgress: (p) => shell.sendState({ state: 'scanning', label: scanningLabel, progress: p }) });
  } catch (err) {
    shell.sendState({ state: 'error', message: `${label} — internal error`, detail: err.message });
    await shell.waitForAction();
    shell.close();
    return 3;
  }

  // Build form state
  const uiHtml = readUiHtml(pluginDir);
  const summary = safeHook(plugin, 'buildFormSummary', () => '', logger, { manifest, targets, selection }, pre);
  const formMessage = safeHook(plugin, 'buildFormMessage', () => label, logger, { manifest, targets, selection }, pre);
  shell.sendState({ state: 'form', message: formMessage, summary, uiHtml });

  const action = await shell.waitForAction();
  if (action === 'cancel' || (typeof action === 'object' && action.action !== 'start')) { shell.close(); return 0; }
  const options = (typeof action === 'object' && action.options) || {};

  const runningLabel = safeHook(plugin, 'buildRunningLabel', () => 'Working…', logger, { manifest, targets, selection });
  shell.sendState({ state: 'running', label: runningLabel });
  const outcome = await runWorkerPromise(runWorker, {
    workerPath: pathJoin(pluginDir, 'plugin.js'),
    targets, options, selection, binDir,
    onProgress: (p) => shell.sendState({ state: 'running', label: runningLabel, progress: p }),
  });

  // ... error / success same as dialog-runner
}
```

Two new optional hooks:
- `buildFormMessage(ctx, pre)` — header text for form state. Default: `manifest.label`.
- `buildFormSummary(ctx, pre)` — small grey text under header (e.g. "3 files selected — 12.4 MB total"). Default: empty string.

### 5.10. `shell.waitForAction` payload

Previously returned just `action: 'continue' | 'cancel' | 'ok'`. Now also returns `{ action: 'start', options: {...} }` for window-mode. Existing dialog actions return as strings (backward-compatible).

## 6. Sub-plan map

| Sub-plan | Includes | Test delta | Dist size delta |
|---|---|---|---|
| **3a** | bin-paths.js, spawn.js, shell unification (rename + form state), window-runner upgrade, electron-builder extraResources config, `.gitignore` + bin.README.md | +12 tests (bin-paths, spawn, shell form state, window-runner form flow) | +0 (no binaries yet) |
| **3b** | cleanup-by-extension, merge-folders | +16 tests (8 per plugin) | +0 |
| **3c** | archive-each | +8 tests | +~3 MB (7z.exe + 7z.dll) |
| **3d** | convert-image, images-to-pdf | +16 tests | +~30 MB (magick.exe single-file build) |
| **3e** | merge-pdf, split-pdf | +16 tests | +~25 MB (gswin64c.exe) |
| **3f** | convert-audio, extract-audio, concat-video | +24 tests | +~90 MB (ffmpeg.exe + ffprobe.exe) |

**Implementation order:** 3a → 3b → 3c → 3d → 3e → 3f. Each closes a sub-plan and adds plugins to the menu via automatic `loadAll()` on next invocation. No `register.bat` re-run needed between sub-plans — registry layout is fixed by the dispatcher refactor.

Total Plan 3: ~+92 tests (150 → ~242), ~150 MB dist size.

## 7. Error handling matrix (Plan 3 additions)

| Phase | Failure | Behaviour |
|---|---|---|
| **binDir resolve** | `process.resourcesPath` undefined in unexpected env | Fallback to dev path; if neither exists, plugin's spawn fails with ENOENT — exit code 3 via dialog-runner / window-runner |
| **Binary missing** | `resources/bin/<name>.exe` not present | `spawn` fails with ENOENT; plugin's `run()` rejects via `spawnTool` reject path; error dialog "Cannot find <name>.exe in resources/bin/" |
| **Binary non-zero exit** | Tool fails mid-batch | Per-file `errors[]` entry with last 500 chars stderr; continue with next file |
| **Binary crash / killed** | OS killed the child (resource exhaustion) | Same as non-zero; error message includes `exited code <code>` |
| **Cancel mid-spawn** | User closes shell window | `signal.aborted = true`, `child.kill()` called, plugin returns `{ ok: false, aborted: true, processed, skipped, errors }`; runner exits 0 (cancel is silent) |
| **Output path collision after `(N)` exhaustion** | Theoretical — collision counter hits Infinity? Doesn't happen, `resolveCollision` enumerates indefinitely | n/a |
| **Form options malformed** | Plugin's `run` receives unexpected `options` | Plugin validates; throws sensible error → run-error envelope → exit code 3 |

## 8. Out of scope

- Smoke tests against real binaries (deferred to a future `npm run smoke:bin` task).
- Cancel button (explicit) during run — current behaviour is "close window to cancel". Adding an explicit cancel button is a small but separate fix-up.
- Re-encode option for `concat-video` when streams are incompatible (v1 just errors out).
- ffprobe-based duration computation for accurate progress in audio/video plugins (v1 shows counter; per-file progress without total).
- Localisation (English only).
- Icons beyond placeholder `icon.png`.
- Plugin auto-discovery / hot-reload during development.

## 9. Open questions

None remaining. Decisions captured:
- Bundle binaries in `resources/bin/` (~150 MB total).
- `.gitignore` `resources/bin/`; `bin.README.md` lists versions + sources.
- Mixed UI: 4 dialog / 6 window.
- One spec + 6 sub-plans (3a-3f).
- Mock-spawn for binary-backed unit tests; real binaries via separate smoke target (deferred).
- Shell unified: dialog-shell renamed to shell, `form` state added for window plugins.
- Window-runner brought to parity with dialog-runner UX (titlebar, auto-resize, progress).
- Output naming: sibling for per-item, parent-of-first for combine, in-place for destructive — `resolveCollision` on collisions.
- No explicit Cancel button in v1; close window = cancel.
- No icons in v1 (placeholder).
