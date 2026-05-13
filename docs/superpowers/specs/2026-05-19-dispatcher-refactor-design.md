# ContextHelper — Dispatcher refactor + class-based plugins + menu grouping

> **Status:** Draft, awaiting user review.
> **Author:** Claude Opus 4.7 (1M context).
> **Date:** 2026-05-19.
> **Supersedes selected sections of:** `2026-05-12-contexthelper-design.md` (plugin contract, registry layout) and `2026-05-18-flatten-folder-rework-design.md` (dialog-flow internals).

## 1. Goal

Three intertwined changes:

1. **Unify the plugin contract** as a single `class extends BasePlugin` shape. Both `ui:"dialog"` and `ui:"window"` plugins implement the same interface. The split between "function-export" (legacy window) and "object-export" (dialog) goes away.

2. **Introduce a single Dispatcher** in main process. All invariant checks (CLI parse, plugin lookup, target normalisation, type-check, min/max enforcement) happen there, before any UI strategy is chosen. The dispatcher delegates to a `Runner` (`DialogRunner` / `WindowRunner`) which encapsulates the UI-mode-specific flow and returns an exit code.

3. **Reshape the Explorer context menu** into a fixed two-level hierarchy: `ContextHelper → Folders | Files → <plugin>`. The menu is shown for folders, files, and folder backgrounds — three registry entry points sharing a single sub-tree. **No type filtering** on the menu side: every plugin appears in every relevant group regardless of what the user right-clicked. Type-mismatch errors are reported only when the user clicks a plugin that does not accept the current selection.

## 2. User-visible behaviour

### 2.1. Menu structure

Right-click on a folder, a file (any extension), or the empty background inside a folder, then choose **ContextHelper**:

```
ContextHelper ▶
├── Folders ▶
│   ├── Flatten folder
│   └── … other folder-accepting plugins …
└── Files ▶
    └── … file-accepting plugins …
```

Rules:
- A plugin appears under **Folders** if its `accepts` list contains `folder` or `folders`.
- A plugin appears under **Files** if its `accepts` list contains `files` or `files:<...>`.
- A plugin with both kinds in `accepts` appears in **both** groups (same plugin invoked from either location).
- A group is omitted from the menu when it is empty (e.g. no file plugins → no Files submenu).
- Plugins are ordered alphabetically by `id` within a group.

The same `Folders` / `Files` sub-tree is shared between three entry points: folder right-click (`Directory\shell\ContextHelper`), file right-click (`*\shell\ContextHelper`), and folder-background right-click (`Directory\Background\shell\ContextHelper`). The user sees the same menu in all three contexts.

### 2.2. Invocation outcomes

When the user clicks a plugin from any group, the dispatcher runs five checks against the current selection. The first failure produces a single error dialog and exits without opening any plugin UI:

1. **Missing paths** — any selected target that does not exist (ENOENT, etc.).
2. **Wrong selection type** — folders selected but plugin needs files (or vice versa).
3. **Wrong file extension** — plugin's `accepts: ["files:.pdf"]` but selection has `.jpg`.
4. **Mixed selection** — folders + files when plugin doesn't accept both.
5. **Count out of range** — `targets.length` outside `[minSelection, maxSelection]`.

If all checks pass, the dispatcher hands off to the runner appropriate to `manifest.ui`. The user then sees either a native confirm/spinner sequence (dialog mode) or a renderer window with the plugin's form (window mode). The remainder of the flow is unchanged from `2026-05-18-flatten-folder-rework-design.md`.

## 3. Architecture

### 3.1. Module map

```
src/main/
  index.js                  — tiny entry: app.whenReady() → dispatcher.dispatch → app.exit
  dispatcher.js             — NEW. Single orchestrator after Electron init.
  registry/
    plugin-loader.js        — NEW. Scans plugins/*/plugin.js, loads classes, validates manifests.
    menu-tree.js            — NEW. (manifests) → { folders: [], files: [] } for the menu.
  selection/
    classify.js             — NEW. (targets, fs) → { folders, files, missing, exts, basenames }.
    validate.js             — NEW. (manifest, classified) → { ok, reason, body }.
  runners/
    base-runner.js          — NEW. Shared helpers: safeHook, exit-code wrapping.
    dialog-runner.js        — Replaces dialog-flow.js (minus classify, now consumes plugin hooks).
    window-runner.js        — Replaces window-manager.js (returns Promise<exitCode>).
  window-manager.js         — Keeps only createSpinnerWindow + createPluginWindow factories.

src/shared/
  base-plugin.js            — NEW. The BasePlugin class with default hooks.
  plugin-api.js             — Unchanged (IPC channel constants).

src/worker/
  worker-shim.js            — Updated: loads class, instantiates, calls preflight / run.

plugins/
  flatten-folder/
    plugin.js               — NEW. `class FlattenFolder extends BasePlugin`.
    icon.png                — Unchanged.
    (manifest.json deleted; worker.js deleted; ui.html already deleted)

scripts/
  gen-register-bat.js       — Rewritten for 3 registry entry points + 2-level group hierarchy.

tests/unit/
  base-plugin.test.js                   — NEW
  classify.test.js                      — NEW
  validate.test.js                      — NEW
  menu-tree.test.js                     — NEW
  plugin-loader.test.js                 — Replaces plugin-registry.test.js
  dispatcher.test.js                    — NEW
  dialog-runner.test.js                 — Replaces dialog-flow.test.js
  window-runner.test.js                 — NEW
  gen-register-bat.test.js              — NEW
  worker-shim.test.js                   — Updated (class-only loader)
  flatten-folder.test.js                — Adapted (class instance API)
  cli.test.js, collision.test.js,
  long-path.test.js, named-pipe.test.js,
  worker-runner.test.js                 — Unchanged
```

### 3.2. BasePlugin contract

`src/shared/base-plugin.js`:

```js
class BasePlugin {
  // Subclasses MUST override.
  static get manifest() {
    throw new Error(`${this.name}: subclass must declare static get manifest()`);
  }
  async preflight(_ctx) {
    throw new Error(`${this.constructor.name}: must implement preflight()`);
  }
  async run(_ctx) {
    throw new Error(`${this.constructor.name}: must implement run()`);
  }

  // Optional hooks — subclasses MAY override. BasePlugin provides defaults.
  isEmpty(_ctx, preflightResult) {
    // Default: nothing to do when preflight reported zero items of work.
    return preflightResult && preflightResult.totalFiles === 0;
  }
  buildNothingToDoBody(_ctx, _pre) {
    return { message: 'Nothing to do.', detail: 'The current selection is already in the desired state.' };
  }
  buildConfirmMessage(_ctx, pre) {
    const n = pre?.folders?.length ?? pre?.totalItems ?? 1;
    return { message: `Process ${n} item(s)?`, detail: '' };
  }
  buildRejectedBody(_ctx, rejected) {
    return [`Selection contains ${rejected.length} invalid path(s):`, ...rejected.map(r => `  • ${r.basename}`)].join('\n');
  }
  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [`${processed} of ${total} processed.`, `${errors.length} could not be processed:`];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}
module.exports = { BasePlugin };
```

`ctx` shape passed to `preflight` / `run` / hooks:

```js
{
  targets:    string[],                // raw target paths from CLI
  selection:  { folders, files, missing, exts, basenames },  // classify result
  options:    object,                  // form values (window mode); empty object for dialog
  onProgress: function,                // worker → main IPC bridge; noop in dialog runner
  signal:     { aborted: boolean },    // cancel signal (currently flipped only by --cancel IPC)
  logger:     { info, warn, error },   // child-process logger in worker; main logger in hooks
}
```

Plugins are stateless. The dispatcher instantiates the class **in main** (for hooks) and **in the worker child** (for `preflight` / `run`) independently — same class, two instances. No persistent state across forks. This is intentional: it keeps plugins trivially testable.

### 3.3. Plugin file layout

A plugin lives at `plugins/<id>/`. Required:

- `plugin.js` — exports the class (CommonJS: `module.exports = MyPlugin`).
- `icon.png` — 16×16 icon shown in Explorer (optional — falls back to the app icon).

Optional (window-mode plugins):
- `ui.html` — form markup injected into the shell window's `#options-slot`.

The plugin's `static get manifest()` returns an object with the same fields as the old `manifest.json` (`id`, `label`, `description`, `icon`, `accepts`, `minSelection`, `maxSelection`, `ui`). `manifest.json` files are deleted.

### 3.4. Manifest schema (unchanged)

```js
{
  id:            string,    // must match folder name
  label:         string,    // shown in Explorer menu
  description:   string,    // shown in window-mode header; ignored in dialog-mode
  icon:          string?,   // filename relative to plugin dir
  accepts:       string[],  // patterns: "folder", "folders", "files", "files:.ext1,.ext2"
  minSelection:  integer,   // ≥ 1
  maxSelection:  integer,   // ≥ minSelection
  ui:            "dialog" | "window"  // default "window" if omitted
}
```

The validator (in `plugin-loader.js`) is the same as today's `plugin-registry.js`; the only change is reading from `Cls.manifest` instead of `JSON.parse(fs.readFileSync('manifest.json'))`.

### 3.5. Menu tree derivation

`registry/menu-tree.js`:

```js
function categoriseAccepts(accepts) {
  const cats = new Set();
  for (const pat of accepts) {
    if (pat === 'folder' || pat === 'folders') cats.add('folders');
    else if (pat === 'files' || pat.startsWith('files:')) cats.add('files');
  }
  return [...cats];
}

function buildMenuTree(plugins) {
  const folders = [], files = [];
  for (const p of plugins) {
    const cats = categoriseAccepts(p.manifest.accepts);
    if (cats.includes('folders')) folders.push(p);
    if (cats.includes('files')) files.push(p);
  }
  folders.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  files.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return { folders, files };
}
```

Used by `gen-register-bat.js` (registry generation) and by `dispatcher.js` (no — dispatcher resolves by `action` id directly; the tree is only for registry generation).

### 3.6. Registry layout

```
HKCU\Software\Classes\Directory\shell\ContextHelper
  MUIVerb=ContextHelper
  Icon=%EXE%,0
  ExtendedSubCommandsKey=Directory\ContextHelperRoot

HKCU\Software\Classes\*\shell\ContextHelper
  MUIVerb=ContextHelper
  Icon=%EXE%,0
  ExtendedSubCommandsKey=Directory\ContextHelperRoot

HKCU\Software\Classes\Directory\Background\shell\ContextHelper
  MUIVerb=ContextHelper
  Icon=%EXE%,0
  ExtendedSubCommandsKey=Directory\ContextHelperRoot

HKCU\Software\Classes\Directory\ContextHelperRoot\shell\Folders
  MUIVerb=Folders
  ExtendedSubCommandsKey=Directory\ContextHelperFolders

HKCU\Software\Classes\Directory\ContextHelperFolders\shell\flatten-folder
  MUIVerb=Flatten folder
  Icon=<plugin icon path>
  MultiSelectModel=Player
  (default for \command subkey) = "%EXE%" --action=flatten-folder %V

HKCU\Software\Classes\Directory\ContextHelperRoot\shell\Files
  MUIVerb=Files
  ExtendedSubCommandsKey=Directory\ContextHelperFiles

HKCU\Software\Classes\Directory\ContextHelperFiles\shell\<plugin-id>
  (per file-accepting plugin)
```

Notes:

- All three entry points (`Directory`, `*`, `Directory\Background`) reference the same `Directory\ContextHelperRoot` sub-tree. We register the sub-tree once.
- For `Directory\Background\shell\ContextHelper`, `%V` expands to the current directory path. Plugins receive `targets = [<cwd>]`. No special handling needed.
- For `*\shell\ContextHelper`, `%V` expands to all selected files. Same plugin contract.
- Empty groups (e.g. no file-accepting plugins yet) → the `Files` group key is omitted entirely. Win shell hides empty cascading submenus automatically.
- Per-extension keys (`SystemFileAssociations\.<ext>\shell\...`) are **dropped**. All file plugins are visible regardless of the right-clicked file's extension. Wrong-extension is reported at runtime by `validate`.

### 3.7. Dispatcher flow

`src/main/dispatcher.js`:

```js
async function dispatch({ argv, electron, fs, logger }) {
  // 1. Parse CLI
  const cli = parseCli(argv);
  if (cli.kind === 'none') { logger.error('startup: no CLI args'); return 0; }
  if (cli.kind !== 'run')  { logger.error('startup: unknown CLI mode', { cli }); return 4; }

  // 2. Load plugin registry
  let plugins;
  try { plugins = loadAll(PLUGINS_DIR); }
  catch (err) {
    electron.dialog.showErrorBox('ContextHelper', `Plugin load failed: ${err.message}`);
    return 4;
  }

  // 3. Resolve action
  const plugin = plugins.get(cli.action);
  if (!plugin) {
    electron.dialog.showErrorBox('ContextHelper', `Unknown action: ${cli.action}`);
    return 4;
  }

  // 4. Normalize targets (aggregator fallback for single-target legacy invocations)
  let targets = cli.targets;
  if (targets.length === 1) {
    const pipeName = `contexthelper-${cli.action}-${process.env.USERNAME || 'user'}`;
    const agg = await aggregateTargets({ pipeName, myTarget: targets[0], waitMs: 250 });
    if (agg.role === 'follower') { logger.info('aggregator: follower exiting'); return 0; }
    targets = agg.targets;
  }

  // 5. Classify selection
  const selection = classify(targets, fs);

  // 6. Validate (missing → type → extension → mixed → count, first failure wins)
  const v = validate(plugin.manifest, selection);
  if (!v.ok) {
    electron.dialog.showErrorBox(plugin.manifest.label, v.body);
    logger.error('validate: rejected', { action: cli.action, reason: v.reason });
    return 2;
  }

  // 7. Instantiate plugin (in main process — for hooks)
  let instance;
  try { instance = new plugin.Cls(); }
  catch (err) {
    electron.dialog.showErrorBox('ContextHelper', `Plugin "${cli.action}" failed to instantiate: ${err.message}`);
    return 4;
  }

  // 8. Resolve runner + execute
  const runner = createRunner(plugin.manifest.ui, { electron, logger, workerRunner: { runPreflight, runWorker } });
  return runner.execute({
    manifest:  plugin.manifest,
    plugin:    instance,
    pluginDir: plugin.dir,
    targets,
    selection,
  });
}
```

### 3.8. Runner contract

Both runners implement:

```js
class Runner {
  constructor({ electron, logger, workerRunner }) { ... }
  async execute({ manifest, plugin, pluginDir, targets, selection }) → number /* exit code */
}
```

`DialogRunner` walks scan-spinner → preflight → confirm → run-spinner → run → result, calling `plugin.buildConfirmMessage(...)`, `plugin.buildErrorBody(...)`, etc. through a `safeHook(plugin, name, defaultFn, ...args)` helper that falls back to BasePlugin defaults if an override throws.

`WindowRunner` creates the renderer window, runs preflight first to seed the form (`window.webContents.send(INIT, { ..., preflight })`), waits for the user's Start click, runs the worker, awaits result, posts COMPLETE, waits for the user to close the window, returns exit code.

### 3.9. Worker-shim contract

`src/worker/worker-shim.js`:

```js
process.on('message', async (msg) => {
  if (msg.type === 'cancel') { signalState.aborted = true; return; }
  if (msg.type === 'start' || msg.type === 'preflight') {
    let reported = false;
    try {
      const Cls = require(msg.workerPath);
      if (typeof Cls !== 'function') throw new Error(`Plugin at ${msg.workerPath} does not export a class`);
      // Optional sanity: ensure the export extends BasePlugin. Best-effort —
      // BasePlugin is a small module; if the plugin requires it, prototype chain
      // includes BasePlugin. We don't enforce because authors may compose differently.
      const instance = new Cls();
      const fn = msg.type === 'start' ? instance.run.bind(instance) : instance.preflight.bind(instance);
      const ctx = {
        targets:    msg.targets,
        options:    msg.options || {},
        selection:  msg.selection || null,
        onProgress: (p) => { try { process.send({ kind: WORKER_MSG.PROGRESS, payload: p }); } catch {} },
        signal,
        logger:     childLogger,
      };
      const result = await fn(ctx);
      const kind = msg.type === 'start' ? WORKER_MSG.COMPLETE : WORKER_MSG.PREFLIGHT_COMPLETE;
      process.send({ kind, payload: result });
      reported = true;
    } catch (err) {
      const kind = msg.type === 'start' ? WORKER_MSG.ERROR : WORKER_MSG.PREFLIGHT_ERROR;
      try { process.send({ kind, payload: { message: err.message, stack: err.stack } }); reported = true; } catch {}
    } finally {
      process.exit(reported ? 0 : 1);
    }
  }
});
```

The legacy function-export branch is removed. Plugins MUST export a class.

## 4. Data flow

### 4.1. CLI → exit (happy path, dialog plugin, multi-folder)

```
Explorer:
  user right-clicks 2 folders, picks ContextHelper → Folders → Flatten folder
Win shell:
  invokes (per MultiSelectModel=Player + %V):
  "C:\...\ContextHelper.exe" --action=flatten-folder "C:\A" "C:\B"

main process index.js:
  app.whenReady().then(() => dispatcher.dispatch({argv, electron, fs, logger}))

dispatcher.dispatch:
  parseCli       → { action: 'flatten-folder', targets: ['C:\\A', 'C:\\B'] }
  loadAll        → Map { flatten-folder → { Cls: FlattenFolder, manifest, dir } }
  targets.length === 2 → aggregator skipped
  classify       → { folders: [...], files: [], missing: [], exts: [], basenames: ['A','B'] }
  validate       → { ok: true }
  new FlattenFolder()  → instance
  createRunner('dialog') → DialogRunner
  runner.execute({ manifest, plugin: instance, pluginDir, targets, selection })

DialogRunner.execute:
  scanSpinner = createSpinnerWindow({ label: 'Flatten folder — scanning…' })
  pre = runPreflight({ workerPath: <pluginDir>/plugin.js, targets, selection })  // forks worker-shim
       worker-shim: require(plugin.js) → FlattenFolder
                    instance = new FlattenFolder()
                    pre = await instance.preflight({ targets, selection, ... })
                    send PREFLIGHT_COMPLETE pre; exit 0
  scanSpinner.close()
  isEmpty(pre)?  → false
  { message, detail } = plugin.buildConfirmMessage(ctx, pre)   // hook in main
  user clicks Continue
  runSpinner = createSpinnerWindow({ label: 'Flatten folder…' })
  result = runWorker({ workerPath, targets, options: {} })     // fork #2
  runSpinner.close()
  result.errors.length === 0 → return 0 silent

index.js: app.exit(0)
```

### 4.2. CLI → exit (wrong type)

```
Explorer:
  user right-clicks a PDF, picks ContextHelper → Folders → Flatten folder (visible, no filtering)
Win shell:
  invokes: ContextHelper.exe --action=flatten-folder "C:\doc.pdf"

dispatcher.dispatch:
  parseCli       → { action: 'flatten-folder', targets: ['C:\\doc.pdf'] }
  loadAll        → loaded
  targets.length === 1 → aggregator returns 1 target (no other instances)
  classify       → { folders: [], files: ['C:\\doc.pdf'], missing: [], exts: ['.pdf'], basenames: ['doc.pdf'] }
  validate       → { ok: false, reason: 'TYPE', body:
                       'Flatten folder works only with folders.\n' +
                       'Selection contains 1 item that is not a folder:\n' +
                       '  • doc.pdf\n' +
                       'Operation cancelled.' }
  dialog.showErrorBox('Flatten folder', body)
  return 2
```

### 4.3. CLI → exit (background right-click)

```
Explorer:
  user right-clicks empty space inside C:\Photos, picks ContextHelper → Folders → Flatten folder
Win shell:
  invokes: ContextHelper.exe --action=flatten-folder "C:\Photos"
  (%V expands to the current directory for Directory\Background\shell)

dispatcher.dispatch:  identical flow to 4.1 (targets is [C:\Photos])
```

### 4.4. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, user cancel, nothing-to-do, follower-exit |
| 1 | Plugin completed with per-item errors |
| 2 | Validation failure (missing path / wrong type / wrong extension / wrong count) |
| 3 | Internal error (preflight or run worker crashed, malformed result, spinner-open failed in critical path) |
| 4 | Configuration error (unknown action, plugin failed to load or instantiate, manifest invalid) |

## 5. Error handling

### 5.1. Failure matrix (consolidated)

| Phase | Failure | User-visible | Exit |
|---|---|---|---|
| CLI parse | malformed flags | logger only | 4 |
| plugin-loader | `plugin.js` missing | `ContextHelper: Plugin "<id>" is not installed.` | 4 |
| plugin-loader | `require()` throws (syntax / missing dep) | `ContextHelper: Plugin "<id>" failed to load: <err.message>` | 4 |
| plugin-loader | export is not a class | `ContextHelper: Plugin "<id>" does not export a class` | 4 |
| plugin-loader | invalid manifest (missing field, invalid `ui`) | `ContextHelper: Plugin "<id>" has invalid manifest: <reason>` | 4 |
| dispatcher | action id not in registry | `ContextHelper: Unknown action: <id>` | 4 |
| dispatcher | `new plugin.Cls()` throws | `ContextHelper: Plugin "<id>" failed to instantiate: <err.message>` | 4 |
| aggregator | EADDRINUSE on listen | retries as follower; if also fails → fatal startup logged, exit 1 (no dialog) | 1 |
| classify | all targets missing | `<label>: Selection contains <N> path(s) that no longer exist: …` | 2 |
| validate | wrong type | `<label> works only with <expected>. Selection contains <N> <got>: • basenames …` | 2 |
| validate | wrong extension | `<label> works only with <exts>. Selection contains: • basename (.ext) …` | 2 |
| validate | mixed selection | type error listing all non-conforming entries | 2 |
| validate | count out of range | `"<label>" accepts <range>, but <N> were selected.` | 2 |
| DialogRunner | preflight worker crash | scan spinner closes; `<label> — internal error: <err.message>` | 3 |
| DialogRunner | preflight malformed | scan spinner closes; `<label> — internal error: Preflight returned invalid data` | 3 |
| DialogRunner | `plugin.isEmpty()` returns true | info dialog (default or `plugin.buildNothingToDoBody`); exit 0 | 0 |
| DialogRunner | user Cancels confirm | silent exit | 0 |
| DialogRunner | hook throws (`buildConfirmMessage` etc.) | fallback to BasePlugin default; logger.error logs the throw | continues |
| DialogRunner | run worker crash | run spinner closes; `<label> — internal error: <err.message>` | 3 |
| DialogRunner | run produced errors | `<label> — completed with errors: <plugin.buildErrorBody(...)>` | 1 |
| WindowRunner | `createPluginWindow` throws | `<label>: Failed to open plugin window: <err.message>` | 3 |
| WindowRunner | preflight crash before window opens | error dialog as DialogRunner; exit 3 | 3 |
| WindowRunner | user closes window without clicking Start | silent exit | 0 |
| WindowRunner | run worker crash | renderer receives `COMPLETE { ok:false, errors:[{file:'(worker)', message}] }`; exit 3 after user closes window | 3 |

### 5.2. Hook safety

`safeHook(plugin, name, defaultFn, ...args)`:

```js
function safeHook(plugin, name, defaultFn, ...args) {
  try {
    if (typeof plugin[name] === 'function') return plugin[name](...args);
  } catch (err) {
    logger.error('plugin hook threw', { plugin: plugin.constructor.name, hook: name, message: err.message });
  }
  return defaultFn(...args);
}
```

All hook calls in runners go through `safeHook`. Plugin authors can't break the flow by writing a buggy `buildConfirmMessage`.

### 5.3. Resource cleanup

- Spinner windows always closed in `finally` blocks. `spinner.close()` itself wrapped in try/catch.
- Worker child processes self-exit. Parent does not kill them explicitly except via `child.kill()` on unhandled errors.
- Named pipe server closes after aggregation window expires (250 ms). On crash, OS releases the pipe.

### 5.4. Logging

- `logger.error` on every failure that produces a user-visible dialog. Include phase, plugin id, message.
- `logger.info` at phase boundaries (parsed, validated, runner started, preflight done, run done, exit code).
- No `logger.warn`.
- No stack traces in `message` fields; stacks go into structured `meta` only.

## 6. Testing strategy

### 6.1. Pure-function unit tests

| File | Approx. count | Notes |
|---|---|---|
| `classify.test.js` | 8 | Mock `fs.statSync`. All-folders / all-files / mixed / all-missing / mixed-missing / EACCES / extension casing / dot-files. |
| `validate.test.js` | 12 | All five failure modes; first-failure-wins ordering; combined-violation cases; `files:.pdf,.txt` extension matching. |
| `menu-tree.test.js` | 6 | Folder-only plugin → only Folders; file-only → only Files; both → both; empty group omitted; alphabetical ordering; unknown accepts pattern ignored. |
| `base-plugin.test.js` | 5 | Defaults: `isEmpty`, `buildConfirmMessage`, `buildErrorBody`, `buildRejectedBody`, `buildNothingToDoBody`. `preflight`/`run` throw with subclass name. |
| `safe-hook.test.js` | 3 | Hook absent → default; hook present → override; hook throws → default + error log. |

### 6.2. Plugin loader tests

`plugin-loader.test.js` (≈ 8 tests): valid class loads; missing `plugin.js` ignored; syntax error wraps with plugin id; non-class export rejected; missing static manifest rejected; manifest field validation (covers same cases as old `plugin-registry.test.js`); duplicate id rejected.

### 6.3. Dispatcher tests

`dispatcher.test.js` (≈ 9 tests): happy path; unknown action → 4; load throws → 4; instantiation throws → 4; classify all-missing → 2; validate type mismatch → 2; validate count mismatch → 2; runner throws → 3; single-target invokes aggregator and follows.

### 6.4. Runner tests

`dialog-runner.test.js` adapts the existing 15 tests from `dialog-flow.test.js` to the new API (plugin instance with hooks) and adds 2 tests for hook fallback + hook override.

`window-runner.test.js` is new (≈ 7 tests): window opens with init payload; Start triggers runWorker; COMPLETE forwarded to renderer; user closes window → exit 0; run errors → exit 1; worker crash → exit 3; preflight crash before window opens → no window, error dialog, exit 3.

### 6.5. Worker-shim tests

`worker-shim.test.js` (≈ 7 tests): class plugin start; class plugin preflight; non-class export → ERROR; class missing run → ERROR; run throws → ERROR; preflight throws → PREFLIGHT_ERROR; require throws → ERROR.

### 6.6. flatten-folder plugin tests

`flatten-folder.test.js` adapts the existing 10 tests to the class shape (`new FlattenFolder()`, call instance methods). Adds 1 test for `static manifest` shape.

### 6.7. Registry generator

`gen-register-bat.test.js` (≈ 8 tests): build manifests synthetically, assert generated `.bat` content includes the three top-level entry points, the shared `ContextHelperRoot`, the `Folders`/`Files` group keys (empty groups omitted), per-plugin keys with `MultiSelectModel=Player` and `%V` commands, duplicate registration when plugin accepts both kinds, alphabetical ordering within groups.

### 6.8. Smoke

`tests/smoke/runner.js` adapted: `const FlattenFolder = require('plugins/flatten-folder/plugin'); const instance = new FlattenFolder(); ...`. Existing fixture preserved.

### 6.9. Manual matrix (Explorer)

Verify after rebuild + re-register:

1. Right-click folder → ContextHelper → Folders → Flatten folder works.
2. Right-click PDF → ContextHelper menu visible; Folders → Flatten folder visible (clicking → TYPE error, exit 2).
3. Right-click empty space inside a folder (background) → ContextHelper → Folders → Flatten folder operates on current folder.
4. Multi-select 2+ folders, click Flatten folder → confirm dialog lists all selected folders.
5. Multi-select 2 folders + 1 file → TYPE error listing the file.
6. Folder already flat → info dialog "Nothing to do".
7. User cancels confirm → silent.
8. Once a file-accepting plugin lands (Plan 3): right-click folder → Files group visible → file plugin → TYPE error on click.

### 6.10. Net test count

| | Before | After | Δ |
|---|---|---|---|
| classify | 0 | 8 | +8 |
| validate | 0 | 12 | +12 |
| menu-tree | 0 | 6 | +6 |
| base-plugin | 0 | 5 | +5 |
| safe-hook | 0 | 3 | +3 |
| plugin-loader | 21 (was plugin-registry) | 8 | −13 |
| dispatcher | 0 | 9 | +9 |
| dialog-runner | 15 (was dialog-flow) | 17 | +2 |
| window-runner | 0 | 7 | +7 |
| worker-shim | 6 | 7 | +1 |
| flatten-folder | 10 | 11 | +1 |
| gen-register-bat | 0 | 8 | +8 |
| cli / collision / long-path / named-pipe / worker-runner | 24 (unchanged) | 24 | 0 |
| **Total** | **~85** | **~125** | **~+40** |

Counts are approximate — the actual numbers will be locked by the implementation plan. The point is: every new file gets coverage proportional to its responsibility, and net coverage roughly doubles in the dispatcher / runner layer.

## 7. Migration / order of operations

A single implementation plan executes this refactor. High-level order (to be turned into bite-sized tasks by `writing-plans`):

1. Create `BasePlugin` + tests.
2. Create `classify` + `validate` + `menu-tree` + their tests.
3. Create `plugin-loader` + tests. Keep old `plugin-registry.js` temporarily.
4. Create `dispatcher` + tests.
5. Create `base-runner` (with `safeHook`) + tests.
6. Rewrite `dialog-flow.js` → `runners/dialog-runner.js` + adapted tests.
7. Rewrite `window-manager.js` → `runners/window-runner.js` + new tests.
8. Update `worker-shim.js` for class loading + tests.
9. Rewrite `flatten-folder` as `plugin.js` class. Delete `manifest.json` + `worker.js`. Adapt tests + smoke.
10. Rewrite `index.js` to the thin entry. Delete `plugin-registry.js` and `dialog-flow.js`.
11. Rewrite `gen-register-bat.js` for 3-entry-point + 2-level tree + tests.
12. Regenerate `register.bat`, run `unregister.bat` on the user's machine for cleanup, run new `register.bat`, rebuild dist.
13. Manual Explorer verification.

Each step has its own tests so the suite stays green throughout.

## 8. Out of scope

- ES6 class via `class extends` keyword in CJS — supported by Node 20+, no transpilation.
- Per-extension menu filtering at registry level — removed.
- Plugin authoring docs / README rewrite — separate task after the refactor lands.
- Migration of any other plugin (none exist yet besides flatten-folder).
- Plan 3 (10 new plugins + bundled binaries) — this refactor is groundwork for it but does not include it.
- Cross-platform support — Windows-only stays.
- Localisation — English-only stays.

## 9. Open questions

None remaining. Decisions captured:

- Multi-kind plugin → appears in both Folders and Files groups (registry-key duplication).
- Three registry entry points: `Directory`, `*`, `Directory\Background`, sharing a single sub-tree.
- Unified plugin contract: class extends BasePlugin, `static get manifest()`, `preflight()`, `run()`, plus optional overridable hooks.
- Type-check failures are runtime errors (no menu filtering).
- Hooks fall back to BasePlugin defaults via `safeHook`.
- New exit code 4 for configuration errors (unknown action, load/instantiate failure).
