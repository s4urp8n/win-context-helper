# Flatten-folder rework: dialog-driven plugin model

> **Status:** Draft, awaiting user review.
> **Author:** Claude Opus 4.7 (1M context).
> **Date:** 2026-05-18.

## 1. Goal

Convert `flatten-folder` from a window-based plugin (form + Start button + progress UI) into a **dialog-driven** plugin: native Windows dialogs only, no plugin form, support for multiple folders selected in Explorer, silent success.

This also extends the ContextHelper plugin contract with a new `ui: "dialog"` mode so that future plugins with no per-run options (e.g. `merge-folders`, `archive-each`, `cleanup-by-extension`) can opt in to the same flow.

## 2. User-visible behaviour

**Trigger:** user right-clicks one or more items in Explorer and chooses **Flatten folder**.

**Decision tree:**

1. **Selection contains any non-folder** (file, missing path, inaccessible) → `dialog.showErrorBox` (title *"Flatten folder"*, body lists the offending entries by basename), exit code 2. No partial work.
2. **All targets are folders, nothing nested to move** (every selected folder is already flat — 0 files in any subfolder) → `dialog.showMessageBox` info dialog (*"Selected folder(s) already flat. Nothing to do."*), exit code 0.
3. **Anything to move** → confirm dialog (see §4.2). On *Cancel* exit code 0. On *Continue*:
   - Frameless spinner window appears (320×100, always-on-top, no titlebar, no Cancel — see §4.3).
   - Plugin worker is forked and runs the actual flatten.
   - On completion the spinner closes. If any files failed: `dialog.showErrorBox` with the first 10 errors (exit code 1). Otherwise: silent exit 0.

**Multi-folder semantics:** each selected folder is flattened **into its own root, independently**. The 3 folders remain 3 folders, each now flat. Nothing is cross-merged.

**Collision policy:** always `(N)` suffix. The previous `encodePathInName` checkbox is removed entirely (no UI, no option, no fallback).

**No progress UI:** during execution only an indeterminate spinner is shown. There is no progress bar, no file counter, no per-file log, no Cancel button. Operations are expected to be I/O-bound and reasonably fast (`fs.renameSync` within the same filesystem is O(milliseconds) per file).

## 3. Architecture

### 3.1. Plugin manifest extension

A new optional field `ui` is added to `manifest.json`:

```json
{
  "id": "flatten-folder",
  "label": "Flatten folder",
  "description": "Move all nested files into the root of each selected folder",
  "icon": "icon.png",
  "accepts": ["folder"],
  "minSelection": 1,
  "maxSelection": 999,
  "ui": "dialog"
}
```

- `"ui"`: `"window"` (default — current behaviour, retains `ui.html` + renderer shell + form) or `"dialog"` (new — no `ui.html`, no renderer shell, native dialogs only).
- `maxSelection: 999` lifts the previous 1-folder cap and gives a practical upper bound that catches accidental "select-all on a directory with 50 000 entries" mistakes.

### 3.2. Plugin contract for `ui: "dialog"`

Dialog plugins export an object with two functions:

```js
module.exports = {
  async preflight({ targets, signal }) {
    // pure scan, no FS writes
    return {
      folders: [{ basename: string, fileCount: number, collisionCount: number }],
      totalFiles: number,
      totalCollisions: number
    };
  },
  async run({ targets, options, onProgress, signal }) {
    return { ok: boolean, processed: number, skipped: number, errors: Array<{file: string, message: string}> };
  }
};
```

Window plugins (current behaviour) continue to export the bare `run` function. The shim auto-detects: if `module.exports` is a function, treat it as `run`; if it is an object, both `preflight` and `run` must be present.

### 3.3. Main process dispatcher

`src/main/index.js` branches on `manifest.ui`:

- `"window"` → existing flow (CLI → window-manager → renderer + ui.html → user clicks Start → worker-runner forks worker → progress IPC → result).
- `"dialog"` → new `src/main/dialog-flow.js` orchestrates the whole pipeline (§4).

The named-pipe aggregator (commit `8f553e8`) and the min/max selection enforcement in `index.js` are unchanged. By the time `dialog-flow.js` runs, `targets` is already the aggregated list.

### 3.4. New / changed files

| File | Status | Purpose |
|---|---|---|
| `plugins/flatten-folder/manifest.json` | modified | `ui: "dialog"`, `maxSelection: 999` |
| `plugins/flatten-folder/worker.js` | modified | exports `{ preflight, run }`; drop `encodePathInName` |
| `plugins/flatten-folder/ui.html` | deleted | dialog plugins have no HTML |
| `src/shared/plugin-api.js` | modified | new IPC channel constants `PLUGIN_PREFLIGHT_REQUEST` / `PLUGIN_PREFLIGHT_RESULT` |
| `src/worker/worker-shim.js` | modified | handle `preflight` message; backward-compat for function-exporting plugins |
| `src/main/worker-runner.js` | modified | add `runPreflight(plugin, targets, signal)` alongside existing `runWorker` |
| `src/main/plugin-registry.js` | modified | validate `ui` field; dialog plugins do not require `ui.html`; default `ui: "window"` |
| `src/main/index.js` | modified | dispatch on `manifest.ui` |
| `src/main/dialog-flow.js` | **new** | the dialog-driven orchestrator (testable unit) |
| `src/main/window-manager.js` | modified | add `createSpinnerWindow({ label })` |
| `src/renderer/spinner.html` | **new** | frameless spinner window markup |
| `src/renderer/spinner.css` | **new** | spinner styles |
| `scripts/gen-register-bat.js` | verify | confirm `MultiSelectModel=Player` is emitted when `maxSelection > 1` |
| `tests/unit/dialog-flow.test.js` | **new** | unit tests with mocked spawn + dialog |
| `tests/unit/flatten-folder.test.js` | modified | drop `encodePathInName` test; add `preflight` tests |
| `tests/smoke/runner.js` | modified | smoke-run `preflight` + `run` for flatten-folder |

### 3.5. Component boundaries

- **`dialog-flow.js`** is pure orchestration: it accepts `{ plugin, targets, spawn, dialog }` (last two injectable for tests) and returns an exit code. Knows nothing about Electron windows directly — calls a passed-in `openSpinner` thunk.
- **`window-manager.js`** owns Electron `BrowserWindow` creation, including the new frameless spinner.
- **`worker-runner.js`** owns `child_process.fork` lifecycle. It exposes two operations: `runPreflight(...)` and `runWorker(...)`. Both are short-lived forks.
- **`worker-shim.js`** is the in-child router. It loads the plugin module, decides whether to expect function-shaped or object-shaped export, and dispatches the IPC message types to the right plugin export.
- **`plugins/flatten-folder/worker.js`** is unchanged in spirit — it does file ops — but now has two named exports sharing a common `walkAndPlan(root)` helper that returns `{ toMove, takenInRoot }`. `preflight` uses it to count; `run` uses it to actually rename.

## 4. Data flow

### 4.1. Type check

```
for each target in targets:
  try { stat = fs.statSync(target) }
  catch (e) { rejected.push({ path: target, reason: e.code }) }
  if (stat exists and !stat.isDirectory()) rejected.push({ path: target, reason: 'NOT_FOLDER' })

if rejected.length > 0:
  body = build_rejected_message(rejected)   // see §4.6 wording
  dialog.showErrorBox('Flatten folder', body)
  exit 2
```

### 4.2. Preflight → confirm dialog

`worker-runner.runPreflight` forks the shim, sends `{ type: 'preflight', targets }`, awaits `{ type: 'preflight-result', value }` or `{ type: 'preflight-error', error }`, kills the child.

`preflight` for flatten-folder returns the shape in §3.2. `dialog-flow.js` then:

- If `value.totalFiles === 0` → `dialog.showMessageBox({ type: 'info', message: 'Nothing to do.', detail: 'Selected folder(s) already flat.' })`, exit 0.
- Else build confirm body:

  ```
  Flatten the following folder(s)?

    • Photos 2023  (47 files)
    • Vacation     (8 files)

  Each folder will be flattened into its own root (55 files total).
  2 name collisions will be resolved with "(N)" suffix.

  Continue?
  ```

  Rules:
  - If `folders.length > 10` → show first 10, append `  … and N more` line.
  - Bullet list is `dialog.showMessageBox`'s `detail` field (multi-line). The `message` field is the single-line header *"Flatten the following folder(s)?"*.
  - If `totalCollisions === 0` → omit the collisions line.
  - If `folders.length === 1` → singular phrasing: *"Flatten this folder?"*, no bullet list (just folder name on the header line of detail).

- Call `dialog.showMessageBox({ type: 'question', buttons: ['Continue', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Flatten folder', message, detail })`.
- `response === 1` → exit 0 silently.

### 4.3. Spinner + run

On *Continue*:

1. `spinnerWindow = window-manager.createSpinnerWindow({ label: 'Flattening…' })`. Window is `frame: false, transparent: false, resizable: false, alwaysOnTop: true, skipTaskbar: false, width: 320, height: 100, show: false`. The window's HTML preloads, then on `did-finish-load` we `spinnerWindow.show()`.
2. `worker-runner.runWorker(plugin, targets, options: {}, onProgress: noop)` — fork shim, send `{ type: 'run', targets, options }`, await `run-result` or `run-error`.
3. On settlement: `spinnerWindow.destroy()`.

### 4.4. Result handling

- `errors.length === 0` → exit 0, silent.
- `errors.length > 0` → build error body:
  ```
  <processed> of <total> files moved.
  <errors.length> file(s) could not be moved:
    • Photos 2023\IMG_001.jpg — EACCES: permission denied
    • Photos 2023\IMG_002.jpg — EBUSY: file in use
    …
  ```
  If `errors.length > 10` → list the first 10 and append a separate line `… and <errors.length - 10> more`. Per-file path is shown relative to the folder being flattened.

  `dialog.showErrorBox('Flatten folder — completed with errors', body)`, exit 1.

### 4.5. Error/exit code contract

| Code | Meaning |
|---|---|
| 0 | Success, user cancellation, or nothing-to-do |
| 1 | Run completed but with per-file errors |
| 2 | Validation failure (non-folder in selection, manifest mismatch) |
| 3 | Internal error (preflight crashed, worker crashed, unhandled exception) |

Exit code 3 is for paths like `runPreflight` rejecting (child crashed before sending a result) or `runWorker` rejecting. In those cases we show a generic `dialog.showErrorBox('Flatten folder — internal error', err.message)` and exit 3.

### 4.6. Wording (single source of truth)

```
ERROR_NON_FOLDER (file in selection):
  Title: Flatten folder
  Body:
    "Flatten folder works only with folders.
    Selection contains <N> item(s) that are not folders:
      • <basename1>
      • <basename2>
      … (first 10)
    Operation cancelled."

INFO_NOTHING_TO_DO:
  Title: Flatten folder
  message: "Nothing to do."
  detail:  "Selected folder(s) are already flat."

CONFIRM_FLATTEN (multi-folder):
  message: "Flatten the following folder(s)?"
  detail:  <bullet list + summary, see §4.2>
  buttons: [Continue, Cancel]

CONFIRM_FLATTEN (single folder):
  message: "Flatten this folder?"
  detail:  "<basename>
            <N> files will be moved to the folder's root.
            <K> name collisions will be resolved with \"(N)\" suffix."

ERROR_PARTIAL:
  Title: Flatten folder — completed with errors
  Body:  see §4.4

ERROR_INTERNAL:
  Title: Flatten folder — internal error
  Body:  <err.message>
```

All strings are English-only (per the existing project rule — no i18n abstraction in v1).

## 5. Error handling

| Failure mode | Behaviour |
|---|---|
| Selection includes a file or non-existent path | `dialog.showErrorBox` (full list capped at 10), exit 2 |
| `stat` fails with EACCES on a target | Treat as non-folder, group under same error dialog |
| `preflight` worker crashes before result | Catch in `runPreflight`, show ERROR_INTERNAL, exit 3 |
| `preflight` returns malformed shape | Validation in `dialog-flow.js` (typeof checks), ERROR_INTERNAL, exit 3 |
| User clicks Cancel | exit 0, silent |
| Spinner window fails to create | Log to file logger, proceed without spinner; do NOT block the run |
| Run worker crashes mid-run | Close spinner, ERROR_INTERNAL, exit 3 |
| Run completes, errors array non-empty | Close spinner, ERROR_PARTIAL, exit 1 |
| User force-kills the app via Task Manager | Process dies; no cleanup guarantees (each file is renamed atomically with `renameSync`, so partial state is consistent — some files moved, others not) |
| Cross-volume rename (`EXDEV`) | `renameSync` fails; recorded in `errors`. Spec does not require cross-volume fallback (out of scope; current single-folder flatten already has this limitation) |

## 6. Testing strategy

### 6.1. Unit tests (`tests/unit/`)

**`flatten-folder.test.js`** (modified):
- Drop the `encodePathInName` test.
- Keep: moves all nested files, resolves `(N)` collisions, removes empty subfolders, preserves already-flat folder, emits no errors on happy path, respects abort signal.
- **New**: `preflight` counts files and collisions correctly for single folder.
- **New**: `preflight` aggregates across multiple folders (3-folder fixture).
- **New**: `preflight` returns `totalFiles: 0` for an already-flat folder.
- **New**: `preflight` does not mutate the filesystem (sentinel test — capture `mtime`s before and after).

**`dialog-flow.test.js`** (new):
- Mock `dialog`, `spawn` (preflight + run), and `openSpinner`.
- *Type-check rejects file in selection*: pass a mix of `isFile` and `isDirectory` (mocked `fs.statSync`), assert `dialog.showErrorBox` called once, exit code 2.
- *Nothing-to-do*: preflight mock returns `totalFiles: 0`, assert info dialog and exit 0 — no run invoked.
- *Confirm cancelled*: confirm mock returns `{ response: 1 }`, assert no spinner opened, no run invoked, exit 0.
- *Confirm accepted, run succeeds*: full flow, assert spinner opened then destroyed, exit 0.
- *Run returns errors*: assert error dialog with formatted body, exit 1.
- *Preflight crashes*: spawn rejects, assert ERROR_INTERNAL dialog, exit 3.
- *Bullet list truncation*: 15 folders → confirm detail includes `… and 5 more`.
- *Single-folder phrasing*: 1 folder → uses `CONFIRM_FLATTEN (single)` template (no bullet list).

**`plugin-registry.test.js`** (additional cases):
- `ui: "dialog"` plugin without `ui.html` validates OK.
- `ui: "window"` plugin without `ui.html` fails validation (current behaviour).
- `ui` field absent defaults to `"window"`.
- Invalid `ui` value (`"foobar"`) fails validation.

**`worker-shim.test.js`** (additional cases if test exists; otherwise new):
- Object-export plugin: `preflight` message routes to `module.exports.preflight`.
- Function-export plugin: `run` message still works; `preflight` message returns `preflight-error`.

### 6.2. Smoke test (`tests/smoke/runner.js`)

- Existing flatten-folder smoke case runs `run` against fixtures.
- New: run `preflight` against the same fixtures, assert it returns the right counts without mutating the FS.

### 6.3. Manual verification in Explorer

After `npm run package` (or in-place `asar` patching while the electron-builder caveat persists — see CLAUDE.md), verify in Explorer:

1. Right-click on **one** folder with nested files → confirm dialog shows single-folder phrasing → Continue → silent success.
2. Right-click on **three** folders (Ctrl-click selection) → confirm dialog shows bullet list of 3 → Continue → silent success.
3. Right-click selection containing 2 folders + 1 file → error dialog "Selection contains 1 item that is not a folder", no work done.
4. Right-click on an already-flat folder → info dialog "Nothing to do".
5. Right-click on a folder containing a file currently open in another program → error dialog "completed with errors" with EBUSY message.
6. Cancel from the confirm dialog → no work done, no further dialogs.

## 7. Out of scope

- Migrating any other plugin to `ui: "dialog"` (Plan 3 handles new plugins).
- Cross-volume rename fallback (copy + delete).
- Progress UI of any kind, taskbar progress, tray icon.
- Localisation / i18n.
- Undo / dry-run preview list of every individual rename.
- Recovery from partial state on crash.
- Per-user preference persistence (e.g. "always use path-encoded names").

## 8. Open questions

None remaining. Decisions captured:
- Drop `encodePathInName` entirely.
- Mixed selection (folders + files) → full cancel with error.
- Confirm dialog shows folder list + summary.
- During execution: indeterminate spinner, no Cancel.
- Empty case (nothing to flatten): info dialog "Nothing to do".
- Architecture: extend plugin contract with `ui: "dialog"` + `preflight()` + `run()` (Approach A).
