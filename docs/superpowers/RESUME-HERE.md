# Resume Here — ContextHelper

> Snapshot for picking up in a fresh session. Last touched **2026-05-21**.
> Read this first, then `CLAUDE.md` for the longer architecture summary.

---

## TL;DR — Current State

- **Repo:** standalone — branch `main` at https://github.com/s4urp8n/win-context-helper, local clone `C:\OSPanel\home\win-context-helper\`. Moved out of the old parent repo `C:\YandexDisk\Software\bin\` on 2026-09-14 as a single `Initial commit`; the earlier history (and every commit SHA quoted below) lives only in that parent repo: `git -C C:\YandexDisk\Software\bin log -- ContextHelper`. Clone needs `git lfs install` first.
- **Tests:** 246/246 green (Vitest, CommonJS, `globals: true`).
- **Last commit:** `019445f` — Ghostscript `-dNOSAFER` for PDF plugins + archive-each sorted/numbered form list + worker-shim diagnostic logging. Build at `dist/win-unpacked/` is **fresh** (asar 16:30, MAY need a register.bat re-run only if the user's earlier registration referenced a different exe path — registry layout is unchanged).
- **Working tree:** clean.
- **Plan 3 (all 10 plugins) is fully shipped.** Five binaries are bundled in `resources/bin/` (Git LFS, ~246 MB).

## ⚠ Open question — convert-image "nothing happens"

User reported (2026-05-21) that convert-image does nothing in Explorer. I could not reproduce the root cause blind: `magick.exe -version` works, the actual `magick -monitor input.jpg out.png` runs cleanly and produces the output (verified at `/tmp/out-converted.png`), and the asar contains the latest plugin code. The fix shipped in `019445f` was **diagnostic-only** for convert-image — added `logger.info` / `logger.error` calls in `src/worker/worker-shim.js` for `worker: start/complete/run() threw/preflight/preflight-complete/preflight() threw` events with plugin id, target count, options, binDir presence.

**Next session checklist for this:**
1. Ask user to test convert-image again.
2. Read tail of `%LOCALAPPDATA%\ContextHelper\logs\2026-05-21.log` (or today's date).
3. Look for `worker: start convert-image` followed by either `complete` (path worked, maybe a UX issue), `run() threw` (root cause in stack), or NEITHER (worker hung or never received the start message).
4. If only `start` without `complete` → magick hangs. Check stderr buffering in `src/shared/spawn.js`.
5. If neither → IPC / window-runner issue. Check `window-runner.js`'s `runWorker` invocation and shell IPC.

There is one **plausible UX theory worth testing**: convert-image emits `{processed, total, itemProgress}` only **after** each file finishes spawning. For a single-image selection, the progress bar sits at 0% the whole time (with spinner suppressed because `has-progress` class is set), so user sees an empty-looking bar and reads it as "nothing happens". Fix would be to emit a starter progress with `current: basename(input)` and per-item percentage from `itemProgress`. Don't ship this until you confirm the actual root cause from the logs first — guessing the fix is what got us here.

## Where We Left Off (chronological)

Working through user verification of plugins in Explorer after Plan 3 implementation. Each user-reported bug → small fix.

1. User selected 19 folders → "ContextHelper" menu item didn't appear. Documented as Windows shell `~15-item static-verb cap`, raisable only via COM `IExplorerCommand` (out of scope). Commit `4ffce08`.
2. User selected 11 folders → 2 dialogs opened with 9+2 split. Root cause: fixed 250 ms aggregator window in `src/main/named-pipe.js`. Fix: idle-based 500 ms timer (resets per follower) + 5 s hard ceiling + EADDRINUSE retry-as-follower. Commit `4549074`.
3. User reported "только flatten-folder работает". Two root causes:
   - **`src/main/index.js`**: window branch of `createRunner` was using stale `createWindow: createPluginWindow` instead of `openShell: () => createShellWindow()`. All window-mode plugins failed with "openShell is not a function".
   - **`plugins/archive-each/plugin.js`**: `folderSizeRecursive` didn't emit progress, so big folders hung on "Scanning…" forever. Fixed with throttled `{scanned: N}` every 100 files + 150 ms minimum interval.
   - **Menu UX**: User said "давай наверное по думаем как отображать все таки в сабмемню все опции, без разделения Files\Folders оно какое то не логичное" → added `buildFlatMenu` in `src/main/registry/menu-tree.js`, used by `scripts/gen-register-bat.js`. Folders/Files split keys (`ContextHelperFolders` / `ContextHelperFiles`) removed; everything flat under `ContextHelperRoot\shell\<id>`. Unregister.bat still deletes the legacy keys defensively.
   - All three in commit `ed0733b`.
4. User tested archive-each → got "path argument must be of type string" + asked for format/compression choice (default ZIP, max compression).
   - **Root cause of crash**: `src/main/runners/dialog-runner.js` didn't destructure or pass `binDir` to `runPreflightPromise` / `runWorkerPromise`. **All dialog plugins** (archive-each, merge-pdf, extract-audio, concat-video) crashed when trying `path.join(undefined, '7z.exe')`.
   - **archive-each rework**: `manifest.ui: 'dialog' → 'window'`. Added `ui.html` with `<select name="format">` (zip default / 7z) and `<input name="compression" type="number" min="0" max="9" value="9">`. `run()` reads `options.format` / `options.compression`, builds `-tzip`/`-t7z` + `-mx=N`.
   - Both fixes in commit `a862d3f`. Test count 244 → 246.
5. **User screenshot 2026-05-21 15:00** — archive-each form rendered the 3 items as one bullet-prefixed paragraph because shell.css ate the `\n`s. Fixed in `019445f` with `pre-wrap` CSS + sorted+numbered list in archive-each.
6. **User report 2026-05-21 16:15** — "convert-image: nothing happens. split-pdf: click Start, nothing happens too." Two distinct root causes:
   - **split-pdf** — Ghostscript 10.x defaults to SAFER mode, which blocks the PostScript `(path)(r)file` operator. Preflight `gswin64c -q -dNODISPLAY -c "(file.pdf) (r) file runpdfbegin pdfpagecount = quit"` was returning `/invalidfileaccess` → `totalPages: 0` → `isEmpty()` true → "Nothing to split" info dialog with OK button (which user mistook for Start). Verified with `gswin64c -q -dNODISPLAY -dNOSAFER -c '(file.pdf)(r)file runpdfbegin pdfpagecount = quit'` → prints `55`. Fix: add `-dNOSAFER` to split-pdf preflight + run AND merge-pdf run (same issue would hit when actually merging — `pdfwrite` device's input file read also restricted).
   - **convert-image** — unresolved (see "Open question" section above). magick CLI works standalone, asar contains latest code. Added worker-shim diagnostic logging instead of guessing the fix.
   - Both in commit `019445f`. 246/246 tests still pass.

## What to Do First in New Session

1. **Verify post-`019445f` Explorer behavior:**
   - split-pdf on any PDF → should now open form (per-page / by-ranges radios) with correct page count.
   - merge-pdf on 2+ PDFs → confirm dialog → should produce `Merged.pdf` next to the first file.
   - archive-each on 3+ items → form summary should show one item per line, numbered `1.`, `2.`, ... sorted alphabetically.
2. **For convert-image: ask user to test, then read** `%LOCALAPPDATA%\ContextHelper\logs\<today>.log`. Look for `worker: start convert-image` and what follows. See "Open question" section for diagnostic flowchart.
3. **Outstanding manual verification matrices** from Plan 3 sub-plans (3b T3, 3c T2, 3d T3, 3e T3, 3f T4) — still officially "pending user verification". The user has been spot-checking; if they want a formal pass let them drive.
4. **If user reports more UX issues in other window plugins** (cleanup-by-extension, merge-folders, convert-image, images-to-pdf, convert-audio, split-pdf), the `_buildItemList`-style helper from archive-each (sorted + numbered + 50-item cap) should be lifted into BasePlugin or a shared util — currently only archive-each has it.

## Architecture Cheat Sheet (terse)

- Single dispatcher: `src/main/dispatcher.js` → parseCli → loadAll → aggregator (if `targets.length===1`) → classify → validate → `new plugin.Cls()` → `runner.execute(ctx)`.
- Plugins: `class extends BasePlugin` in `plugins/<id>/plugin.js`. Required: `static get manifest()`, `async preflight(ctx)`, `async run(ctx)`. Optional hooks: `isEmpty`, `buildNothingToDoBody`, `buildConfirmMessage`, `buildFormMessage`, `buildFormSummary`, `buildScanningLabel`, `buildRunningLabel`, `buildRejectedBody`, `buildErrorBody`, `buildFormHtml`.
- Runners: `DialogRunner` (scan→confirm→run→info/error) and `WindowRunner` (scan→form→run→info/error). Both in `src/main/runners/`.
- Unified shell: `src/renderer/shell.{html,css,js}` + `shell-preload.js`. 6 states: `scanning, form, confirm, running, info, error`. Frameless 460 px wide, custom titlebar (drag + min + close, no max), auto-resize via `setContentSize` over `shell:resize` IPC.
- IPC: `shell:set-state, shell:action, shell:min, shell:close, shell:resize`.
- Named-pipe aggregator: `src/main/named-pipe.js` — idle 500 ms, hard 5 s, EADDRINUSE retries as follower.
- Registry: 3 entry points (`Directory\shell, *\shell, Directory\Background\shell`) all → `Directory\ContextHelperRoot\shell\<id>` (flat, alphabetical). `MultiSelectModel="Player"` + quoted `"%V"`. See `scripts/gen-register-bat.js`.
- `binDir` threading: dispatcher → `runner.execute(ctx.binDir)` → `runWorker/runPreflight` IPC `msg.binDir` → worker-shim → plugin `ctx.binDir`. Both runners (`dialog-runner.js`, `window-runner.js`) now destructure and forward it.
- Bundled binaries (in `resources/bin/`, gitignored, electron-builder `extraResources` → `dist/win-unpacked/resources/bin/`):
  - `7z.exe` — 7-Zip 26.01 standalone (renamed 7zr.exe), supports `.7z` creation, no DLL needed.
  - `magick.exe` — ImageMagick 7.1.2-23 portable Q16 x64.
  - `gswin64c.exe` + `gsdll64.dll` — Ghostscript 10.07.1 (DLL is required companion, ~24 MB).
  - `ffmpeg.exe` + `ffprobe.exe` — ffmpeg 8.1.1 release-essentials.
  - All download URLs in `resources/bin.README.md`.

## Plugin Roster

| Plugin | UI | Accepts | Binary | Quality default |
|---|---|---|---|---|
| flatten-folder | dialog | folders | (pure JS) | — |
| cleanup-by-extension | window | folders | (pure JS) | — |
| merge-folders | window | folders | (pure JS) | — |
| archive-each | window | folders + files | 7z.exe | ZIP + `-mx=9` |
| convert-image | window | `files:.png,.jpg,.jpeg,.webp,.bmp,.tiff,.gif,.heic,.avif` | magick.exe | `-quality 100`; `.webp` adds `-define webp:lossless=true` |
| images-to-pdf | window | same image exts | magick.exe | single combined PDF, optional `-page A4` |
| merge-pdf | dialog | `files:.pdf` (2..N) | gswin64c.exe | `-dPDFSETTINGS=/prepress` |
| split-pdf | window | `files:.pdf` | gswin64c.exe | `-dPDFSETTINGS=/prepress` |
| convert-audio | window | `files:.mp3,.wav,.flac,.aac,.m4a,.ogg,.opus,.wma` | ffmpeg.exe | `-b:a 320k` for lossy targets, omitted for lossless |
| extract-audio | dialog | `files:.mp4,.mkv,.avi,.mov,.webm,.flv,.wmv,.m4v,.3gp,.ts,.mts` | ffmpeg + ffprobe | `-vn -c:a copy` (stream-copy, lossless), codec→ext via `codecToExt()` |
| concat-video | dialog | `files:` same video exts (2..N) | ffmpeg.exe | `-f concat -safe 0 -c copy` (stream-copy) |

User pinned constraint (multiple times): **"любая конвертация должна желаться без потерь, с сохранением качества"**. The "Quality default" column reflects that — keep it that way unless user changes their mind.

## Key Files (with line-anchor purpose)

- `src/main/index.js` — Tiny entry point. ~50 lines. `app.whenReady → dispatch → app.exit`. Window factory uses `openShell: () => createShellWindow()`.
- `src/main/dispatcher.js` — Orchestrator. Phases listed at top of file.
- `src/main/utils/bin-paths.js` — `binDir()` returns `process.resourcesPath/bin` in packaged build, falls back to `<repo>/resources/bin` in dev. `binPath(name)` joins.
- `src/main/runners/dialog-runner.js` — Fixed (a862d3f) to destructure + forward `binDir`. Don't regress this.
- `src/main/runners/window-runner.js` — Same threading as dialog-runner.
- `src/main/named-pipe.js` — Idle-based aggregator. Don't reintroduce fixed timeout.
- `src/renderer/shell.css` — `.form-summary` MUST have `white-space: pre-wrap` (committed in 019445f).
- `src/worker/worker-shim.js` — Now writes `worker: start/complete/run() threw/preflight/preflight-complete/preflight() threw` log lines with plugin id, target count, options, binDir presence, result keys (committed in 019445f). Lazy-loads logger via try/require so dev/test envs that lack `$LOCALAPPDATA` still work.
- `src/shared/base-plugin.js` — Hook contract + default fallbacks.
- `src/shared/spawn.js` — `spawnTool({exe, args, parseProgress, onProgress, signal})` — used by every binary-backed plugin via constructor DI for mocking.
- `plugins/split-pdf/plugin.js` — Preflight + run both pass `-dNOSAFER`. Nothing-to-do detail now shows `preflightError` when Ghostscript couldn't open the file.
- `plugins/merge-pdf/plugin.js` — Run passes `-dNOSAFER`. Preflight is pure-JS (no gs), unaffected.
- `scripts/gen-register-bat.js` — User-modified version (intentional, preserved). Writes 3 entry points + flat plugin list. Unregister.bat also deletes legacy `ContextHelperFolders`/`ContextHelperFiles` keys.
- `tests/unit/gen-register-bat.test.js` — User-modified version (intentional, preserved). 6 tests for flat layout.

## User Preferences (durable — DO NOT relitigate)

- **Lossless conversions by default.** Bumped convert-image to quality 100 (`.webp` adds `webp:lossless=true`), convert-audio bitrate to 320, extract-audio stream-copy, merge-pdf/split-pdf prepress.
- **Same-window everything.** No native `dialog.showMessageBox` / `showErrorBox`. Everything routes through the frameless shell with state machine. User said: "должен в том же окне и не в ФОНЕ".
- **Window draggable.** Custom titlebar w/ drag region + min + close (no max). `✕` resolves any pending action as cancel.
- **Auto-resize height to content.** `min-height:100vh`, not fixed `height:100vh` (which locked body to window).
- **Alphabetical sort** in folder/file lists everywhere user-visible (preflight + summary + form).
- **English UI strings** throughout. No i18n abstraction yet.
- **Conversation language: Russian.** Respond in Russian.
- **Flat menu** — no Folders/Files split (user found it illogical). Plugins listed alphabetically in one flat list.

## Where to Find More Context

- `CLAUDE.md` at repo root — long-form architecture, commands, conventions.
- `docs/superpowers/specs/2026-05-12-contexthelper-design.md` — original v1 spec (source of truth for v1 features).
- `docs/superpowers/specs/2026-05-20-plan-3-design.md` — Plan 3 master spec.
- `docs/superpowers/plans/2026-05-20-plan-3{a,b,c,d,e,f}-*.md` — six sub-plans.
- `resources/bin.README.md` — binary versions + download URLs + license notes.

## Known Limitations (documented, do not "fix")

- Windows shell hides static-verb context-menu items when **~15+ items are selected**. Not raisable without a COM `IExplorerCommand` extension. Out of scope.
- electron-builder's `winCodeSign-2.6.0` cache extraction needs Developer Mode (admin) on this machine. Workaround documented in CLAUDE.md.

## Ghostscript SAFER trap (gotcha worth remembering)

Ghostscript 10.x defaults to `-dSAFER`, which sandboxes file I/O. Any plugin that:
- uses the `(path)(r)file` PostScript operator on an absolute path, OR
- passes the input PDF as a positional arg with `pdfwrite` device

will fail with `/invalidfileaccess` + `Permission denied` unless `-dNOSAFER` is in the args list. We add it to **every** gswin64c invocation now (split-pdf preflight + run, merge-pdf run). If you add a new Ghostscript plugin, do the same.

The `-dPDFSETTINGS=/prepress` quality flag is independent of SAFER — it controls output quality, not file access.

## Quick Commands

```
npm test                                       # 246 tests, ~2 s
npm run smoke                                  # all workers against synthetic fixtures
npm start -- --action=archive-each --target="C:\path"  # dev launch for one plugin
npm run package                                # → dist/win-unpacked/
npm run gen-register                           # refresh register.bat from manifests
```

After `npm run package`, the user re-runs `dist/win-unpacked/register.bat` in Explorer to refresh the registry.

---

*Generated 2026-05-21 by Claude Opus 4.7. If you're a future agent, verify any file path or commit SHA before quoting it — they may be stale.*
