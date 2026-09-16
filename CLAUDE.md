# ContextHelper — Agent orientation

## Resume here (last touched 2026-05-19)

**2026-09-15 update (read first):** distribution moved to an NSIS installer (`dist/ContextHelper-Setup-<version>.exe`, one-click, per user) and the app now owns its Explorer registration: `ContextHelper.exe --register` / `--unregister`, a background repair on every packaged menu click, and a status window when launched without arguments (Start-menu shortcut). `register.bat`, `scripts/gen-register-bat.js` and `src/main/registry/menu-tree.js` are gone; the menu is flat (no Folders/Files split). Spec: `docs/superpowers/specs/2026-09-15-installer-design.md`; plan: `docs/superpowers/plans/2026-09-15-installer.md`. The notes below are historical.

**2026-09-16 update — flatten-folder hardening:** planning lives in `plugins/flatten-folder/plan.js` (shared by preflight and run). Both runners and the status window use one `src/main/runners/shell-controller.js` (`makeShellController` resolves `{ action, options }`; the close button and Alt+F4 are ignored while the `running` state is shown — dialog operations cannot be cancelled; `asBody` normalizes hook bodies). Preflight returns `planId`; dialog-runner passes it as `options.planId` and flatten's `run()` refuses a different plan (`stale`). Failed runs are logged with `errors` and `notRestored`. Overlapping or repeated targets are reduced to the outermost folders, matched by `dev:ino` (`fs.statSync(..., { bigint: true })`, literal path when ino is 0) — never by upper-cased paths (`ß` → `SS` would join different folders). Names that look like 8.3 aliases are also checked with `lstat` in the root. `runWorker` reports a child that fails to start (`error` event), otherwise the non-closable running window would hang. Subfolders kept because they hold links are counted (`totalKeptDirs`). Names are compared like Explorer (Intl.Collator, numeric, case-insensitive, `-`/`'` ignored) and keyed with `toUpperCase` (NTFS upcase). Names are fitted to 255 chars / 259-char full path before anything moves (file name cut first down to 40 chars, a folder is cut identically for all its files, numbered `001 - ` fallback when the cut would change the sort order); a folder path with no room blocks the run through the new `buildBlockedBody` hook (dialog-runner exits 2). `run()` is all-or-nothing and cannot be cancelled: any failed move puts every moved file back, empty-dir pruning happens only after full success, and `renameSync` is guarded against silent overwrite. Pre-existing empty subfolders count as work (`totalEmptyDirs`). The shell renders `table: { columns, rows: [{cells, badges} | {group}], footer }` in info/confirm/error states (zebra rows, window widens to 760 px); hooks may return `{ message, detail, table }` and `buildErrorBody` receives the run result as a 5th argument.

**Where we are:** Dispatcher refactor complete and verified end-to-end (2026-05-19). 150/150 unit tests + smoke green. Architecture changed from scattered `index.js + plugin-registry + dialog-flow + window-manager` into:

```
src/main/
  index.js                       ← ~55 lines: app.whenReady → dispatcher.dispatch → app.exit
  dispatcher.js                  ← single orchestration point
  selection/{classify,validate}.js  ← pure target classification + accepts/min/max validation
  registry/plugin-loader.js  ← class-loading + manifest validation
  shell-menu/{entries,reg-file,reg,sync,status-view}.js  ← self-managed Explorer registration (2026-09-15)
  runners/{safe-hook,base-runner,dialog-runner,window-runner}.js  ← strategy-based
src/shared/base-plugin.js        ← class contract + default hooks
```

**Plugin contract:** every plugin is now `class extends BasePlugin` in `plugins/<id>/plugin.js` with `static get manifest()`, `async preflight()`, `async run()`, and optional overridable hooks (`isEmpty`, `buildConfirmMessage`, `buildErrorBody`, `buildRejectedBody`, `buildNothingToDoBody`). Legacy function/object exports + `manifest.json` are gone. flatten-folder is the only plugin so far.

**Menu structure:** Explorer right-click on a folder, a file (any extension), or folder background → `ContextHelper → Folders | Files → <plugin>`. `register.bat` writes 3 entry points (Directory, *, Directory\Background) all referencing a shared `ContextHelperRoot` sub-tree. No menu filtering by selection type — wrong-kind invocations error at runtime in `validate`.

**Commits this session:** `55e9d0b` (T1 BasePlugin) → `5a33e90` (T13 gen-register-bat). 13 commits net + 1 dist rebuild + register.bat reinstall.

**Verified end-to-end in Explorer.** Beyond the original plan, 10 UX follow-ups landed:

- `cdf9e71` — `%V` path quoting in registry command (paths with spaces no longer split into multiple args)
- `d3f6a67` — single-window dialog shell (no more native showMessageBox / showErrorBox for dialog plugins; all states render in one frameless BrowserWindow via IPC `shell:set-state` / `shell:action`)
- `721eb74` — custom titlebar inside the shell (drag region + minimize + close, no maximize); ✕ resolves any pending action as cancel
- `9d7d7a2` — flex-scroll layout for long content + alphabetical preflight folder sort
- `70ab4ba` — `validate.js` partitions selection into `effectiveTargets` + `skipped` instead of TYPE/EXTENSION rejection; plugin hooks render skip-list in confirm/info dialogs
- `dbb9f20` — live progress: scanning shows file count, running shows progress bar + N/M (%); throttled to ~7 updates/s
- `00c06d4` + `f24e401` — window auto-resizes height to content via `shell:resize` IPC (`useContentSize: true`, body grows naturally, `.detail` capped at 400px before its own scroll)
- `db887a6` — running-state spinner hidden when progress bar present (redundant motion)
- `4ffce08` — Windows shell `~15-item static-verb limit` documented in README + CLAUDE.md (raisable only by COM `IExplorerCommand`; out of scope)
- `4549074` — named-pipe aggregator switched from fixed 250 ms to idle-based 500 ms (new connections reset timer, hard 5 s ceiling). Fixes "select 11 folders → 2 dialogs" splitting bug

**electron-builder caveat (unchanged):** `npm run package` may need the manually-extracted `winCodeSign-2.6.0` cache in `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` (extracted via `7za x cache.7z -oOUT -xr!darwin`). Already done this session.

**Next milestone — Plan 3:** Adding the remaining 10 plugins (`merge-folders`, `archive-each`, `merge-pdf`, `concat-video`, `extract-audio`, `cleanup-by-extension`, `convert-image`, `convert-audio`, `images-to-pdf`, `split-pdf`) and bundled binaries (`ffmpeg.exe`, `ffprobe.exe`, `magick.exe`, `gswin64c.exe`, `7z.exe`) in `resources/bin/`. Spec at `docs/superpowers/specs/2026-05-20-plan-3-design.md`; broken into 6 sub-plans 3a-3f.

**Plan 3a (infrastructure) ✅** — bin-paths.js, spawnTool helper, resources/bin gitignored + README + electron-builder extraResources, shell rename (dialog-shell → shell) with new `form` state for window-mode plugins, window-runner rewritten to use the shell + binDir threaded from dispatcher → worker → plugin ctx.

**Plan 3b (pure-JS plugins) ✅ pending user matrix** — `cleanup-by-extension` (delete files of selected exts from N folders, uses new `buildFormHtml` hook for dynamic per-extension checkboxes) + `merge-folders` (flatten contents of N folders into the alphabetically-first, 3 collision strategies). 174 unit tests pass. Menu now shows Folders → cleanup-by-extension, flatten-folder, merge-folders.

**Plan 3c (archive-each, 7z) ✅ implementation** — first binary-backed plugin. Constructor accepts `{ spawnTool }` override for test mocking (production uses real spawnTool). Dialog mode. Per-item `<basename>.7z` next to source with `(N)` collision suffix. Accepts both folders + files → appears in both menu groups. 9 plugin tests. **User needs to drop `7z.exe` + `7z.dll` into `resources/bin/` before testing in Explorer.**

**Plan 3d (image plugins, magick) ✅ implementation** — convert-image (per-file sibling output with format/quality form) + images-to-pdf (single combined PDF with output name + page size form). Both window-mode, same constructor-DI spawnTool pattern. 16 plugin tests. **User to drop `magick.exe` in `resources/bin/`.**

**Plan 3e (PDF plugins, gswin64c) ✅ implementation** — merge-pdf (dialog) + split-pdf (window, dynamic buildFormHtml for page count). 17 plugin tests. **User to drop `gswin64c.exe` in `resources/bin/`.**

**Plan 3f (audio/video plugins, ffmpeg + ffprobe) ✅ implementation** — convert-audio (window, format+bitrate), extract-audio (dialog, ffprobe hasAudio detection), concat-video (dialog, temp concat list, stream-copy). 24 plugin tests. **User to drop `ffmpeg.exe` + `ffprobe.exe` in `resources/bin/`.**

**Plan 3 fully implemented (2026-05-20).** All 10 plugins from spec §4 ship. 240/240 unit tests + 6 sub-plans (3a infrastructure + 3b-3f plugins by binary). Awaiting user to populate `resources/bin/` and run the per-plugin Explorer matrices.

**Final menu layout (after user drops binaries in resources/bin/):**

```
ContextHelper → Folders
  ├── archive-each            (7z)
  ├── cleanup-by-extension    (pure JS)
  ├── flatten-folder          (pure JS — Plan 1)
  └── merge-folders           (pure JS)
ContextHelper → Files
  ├── archive-each            (7z, also in Folders)
  ├── concat-video            (ffmpeg)
  ├── convert-audio           (ffmpeg)
  ├── convert-image           (magick)
  ├── extract-audio           (ffmpeg + ffprobe)
  ├── images-to-pdf           (magick)
  ├── merge-pdf               (gswin64c)
  └── split-pdf               (gswin64c)
```

**Carry-overs:** `src/main/utils/bin-paths.js` helper for resolving bundled binaries (deferred to Plan 3).

---

## Previous session note (2026-05-18) — superseded by today's refactor

**Where we are:** flatten-folder rework plan complete in code (12 of 13 tasks done; only the user-driven Explorer verification matrix in Task 13 is outstanding). 81/81 unit tests + smoke green. The plugin now uses a native confirm dialog instead of a renderer window, supports 1..N folder selections via the existing named-pipe aggregator, shows a frameless indeterminate spinner during work, and exits silently on success.

**Architectural delta from Plan 1:**
- New plugin contract: object export `{ preflight, run }` for plugins with `manifest.ui === "dialog"`. Existing window-based plugins continue to use the bare `module.exports = run` form. Defaulting + validation in `src/main/plugin-registry.js`.
- New IPC channels `worker:preflight-complete` / `worker:preflight-error` (`src/shared/plugin-api.js`). The worker-shim now routes by `msg.type` and auto-detects export shape (`src/worker/worker-shim.js`). `worker-runner.js` exposes `runPreflight()` alongside `runWorker()`.
- New `src/main/dialog-flow.js` — pure, Electron-free orchestrator (injectable deps). Walks: type-check → preflight → confirm → spinner → run → result. Exit codes per spec §4.5: 0/1/2/3.
- New frameless spinner window: `src/renderer/spinner.html` + `spinner.css`, opened via `createSpinnerWindow({ label })` in `window-manager.js`.
- `src/main/index.js` branches on `manifest.ui`; legacy window plugins are unchanged.
- `plugins/flatten-folder/ui.html` deleted. `encodePathInName` option removed entirely — `(N)` suffix is the only collision strategy. Manifest now `accepts: ["folders"]`, `maxSelection: 999`, `ui: "dialog"`.

**Commits this session (2026-05-18):** `f9187db` → `c9d81b2` (14 commits). See `git log --oneline f355655..HEAD`.

**Outstanding work — Task 13 (manual Explorer verification):**
1. Repackage or in-place asar patch the existing `dist/win-unpacked/` (see electron-builder caveat below).
2. Re-run `register.bat` from the dist folder.
3. Verify the 6 cases in the table at the bottom of the plan: single folder with collisions, three folders, mixed selection (folder+file), already-flat folder, file-busy partial errors, Cancel-from-confirm. Spec wording for each dialog lives in `docs/superpowers/specs/2026-05-18-flatten-folder-rework-design.md` §4.6.
4. Capture any divergences and fix them with follow-up commits.
5. Update this "Resume here" section with the final ✅ status once verified.

**electron-builder caveat (unchanged from Plan 1):** `npm run package` fails on this machine due to `winCodeSign-2.6.0.7z` symlink extraction requiring admin/Developer Mode. Workaround: enable Developer Mode (Settings → System → For developers → Developer Mode → On), or in-place asar-patch the existing `dist/win-unpacked/`. See the plan's Task 13 Step 1 for exact commands.

**Next milestone — Plan 3:** Adding the remaining 10 plugins (`merge-folders`, `archive-each`, `merge-pdf`, `concat-video`, `extract-audio`, `cleanup-by-extension`, `convert-image`, `convert-audio`, `images-to-pdf`, `split-pdf`) and bundled binaries (`ffmpeg.exe`, `ffprobe.exe`, `magick.exe`, `gswin64c.exe`, `7z.exe`) in `resources/bin/`. Several of these will be dialog plugins and can reuse the contract introduced in this rework. Plan 3 isn't written yet — invoke `superpowers:writing-plans` when ready.

**Carry-overs from Plan 1 (still open):**
- `src/main/utils/bin-paths.js` helper for resolving bundled binaries at runtime. Deferred to Plan 3 alongside the first plugin that needs it.

## TL;DR

Electron app that adds a plugin-driven right-click submenu to Windows Explorer. Per-user (HKCU), no installer. Spec is the source of truth: `docs/superpowers/specs/2026-05-12-contexthelper-design.md`. Plans live in `docs/superpowers/plans/`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Vitest unit tests. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run smoke` | Run all plugin workers programmatically against synthetic fixtures (no Electron). `--plugin=<id>` filters. |
| `npm start -- --action=<id> --target="<path>"` | Launch the app in dev mode for one plugin. |
| `npm run test:coverage` | Vitest with coverage; the flatten plugins and `src/main/shell-menu` must stay at 100%. |
| `npm run package` | electron-builder → `dist/win-unpacked/` + `dist/ContextHelper-Setup-<version>.exe` (NSIS, one-click, per user). |

## Architecture cheat sheet

- **Main process** (`src/main/index.js`) → parses CLI, loads plugin registry, opens a window via `window-manager.js`, forks a worker child process via `worker-runner.js`.
- **Worker shim** (`src/worker/worker-shim.js`) loads the plugin's `worker.js` in a forked Node child. Plugin export shape:
  ```js
  module.exports = async function run({ targets, options, onProgress, signal })
    → { ok, processed, skipped, errors }
  ```
- **Renderer** (`src/renderer/`) is a single HTML shell. Plugin `ui.html` is injected into `#options-slot`. Form values (keyed by `name`) become the worker's `options` object.
- **IPC channels** declared in `src/shared/plugin-api.js`. Renderer talks only through the preload bridge (`src/preload/plugin-preload.js`).
- **Named pipe aggregator** (`src/main/named-pipe.js`) exists and is unit-tested but not wired in yet. Plan 3 turns it on for the first `maxSelection > 1` plugin.
- **Registry layout (cascading submenu):** the root verb under `HKCU\Software\Classes\Directory\shell\ContextHelper` carries `MUIVerb`, `Icon`, and `ExtendedSubCommandsKey="Directory\ContextHelperSub"` (path is HKCR-relative, NOT HKCU-relative). Per-plugin entries live at `HKCU\Software\Classes\Directory\ContextHelperSub\shell\<plugin-id>` with their own `MUIVerb` and `command` subkey. Do NOT also write `SubCommands` — an empty `SubCommands` string overrides `ExtendedSubCommandsKey` and produces an empty submenu. Same pattern for per-extension keys under `SystemFileAssociations\.<ext>\...`. The app owns these keys: `src/main/shell-menu/` (`entries.js` → desired state, `sync.js` → diff / repair / verify through `reg export` + `reg import` of UTF-16 `.reg` files; console output of `reg.exe` is OEM-encoded and never parsed). `ContextHelper.exe --register` / `--unregister`; the installer runs `--register`; every packaged menu click re-syncs in the background (leader only, ≤5 s); launching without arguments opens a status window. `register.bat` and `gen-register-bat.js` no longer exist.
- **Multi-select handling:** The menu registration (`src/main/shell-menu/entries.js`) writes `MultiSelectModel="Player"` for every plugin verb. Windows ignores this on `ExtendedSubCommandsKey` cascaded items and runs Document mode (one invocation per selected item). We quote `%V` in the command (`"%V"`) so paths with spaces stay intact; the named-pipe aggregator (`src/main/named-pipe.js`) merges concurrent single-target invocations within a 250 ms window. **Selection size limit:** Windows hides static-verb context-menu items at ~15 selected items. This is a shell-side cap on registry-based verbs and is not raisable without a COM `IExplorerCommand` extension (out of scope). Document the limit; users batch larger jobs.
- **Vitest in CJS:** the project uses `globals: true` in `vitest.config.js`. Test files do NOT `require('vitest')`; `describe`/`it`/`expect`/`beforeEach`/`afterEach` are global.

## Adding a new plugin

1. `mkdir plugins/<id>` and create `plugin.js` exporting `class extends BasePlugin` with `static get manifest()` (`id`, `label`, `description`, `accepts`, `minSelection`, `maxSelection`, `ui`), `preflight()` and `run()`.
2. Optional `ui.html` (window mode) — form values keyed by `name` become `options`.
3. Add a unit test under `tests/unit/<id>.test.js` and a smoke case to `tests/smoke/runner.js`.
4. `npm run package`, then install the new Setup (or run `ContextHelper.exe --register`) to add the menu item.

## Conventions

- CommonJS (`require` / `module.exports`).
- 2-space indent, LF line endings, UTF-8.
- TDD for pure logic; manual verification for UI.
- One commit per task in plans. Conventional Commits subjects (`feat:` / `fix:` / `chore:` / `test:` / `docs:`). Commits from when the project lived inside a parent repo used a `(ContextHelper)` scope — no longer needed. Co-Authored-By trailer required.
- UI strings are hardcoded in English in v1; no i18n abstraction yet.

## PR / "Plan complete" checklist

- [ ] `npm test` green
- [ ] `npm run smoke` green
- [ ] If you changed manifests: `npm run package`, install the Setup (or `--register`) and check the menu in Explorer.

## Where the bundled binaries will live (Plan 3)

`resources/bin/` is not present yet — Plan 3 adds `ffmpeg.exe`, `ffprobe.exe`, `magick.exe`, `gswin64c.exe`, `7z.exe` as the plugins that need them are added. The resolution helper will go in `src/main/utils/bin-paths.js`.
