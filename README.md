# ContextHelper

Windows utility that adds a **ContextHelper** submenu to the Explorer right-click menu with 12 file and folder tools: flatten/merge/clean folders, archive, convert images and audio, build/merge/split PDFs, extract audio, join videos.

Per-user registration (HKCU), no admin rights, no installer. Built on Electron; heavy lifting is done by bundled 7-Zip, ImageMagick, Ghostscript and ffmpeg.

## Plugins

| Menu item | Works on | Flow | Result |
|---|---|---|---|
| **Archive each** | 1+ folders and/or files (any type) | form | One archive per item, next to it: `<name>.zip` or `<name>.7z` |
| **Cleanup by extension** | 1+ folders | form | Deletes files with the extensions you tick, recursively |
| **Concatenate video** | 2+ `.mp4 .mkv .mov .avi .webm` | confirm | `Concatenated.<ext>` in the folder of the first file |
| **Convert audio** | 1+ `.mp3 .wav .flac .m4a .ogg .opus .aac` | form | `<name>.<new ext>` next to each source |
| **Convert image** | 1+ `.jpg .jpeg .png .bmp .tiff .tif .webp .gif` | form | `<name>.<new ext>` next to each source |
| **Extract audio** | 1+ `.mp4 .mkv .mov .avi .webm` | confirm | `<name>.<audio ext>` next to each video |
| **Flatten folder** | 1+ folders | confirm | All nested files moved into the root of each folder, empty subfolders removed |
| **Flatten folder (keep order)** | 1+ folders | confirm | Same, but each file is named after its folder path: `Lesson 1\Chapter 1.mp4` → `Lesson 1 - Chapter 1.mp4` |
| **Images to PDF** | 1+ `.jpg .jpeg .png .bmp .tiff .tif .webp .gif` | form | One PDF in the folder of the first file |
| **Merge folders** | 2+ folders | form | Files of all folders moved into the alphabetically first one |
| **Merge PDF** | 2+ `.pdf` | confirm | `Merged.pdf` in the folder of the first file |
| **Split PDF** | exactly 1 `.pdf` | form | One PDF per page or per range, next to the source |

Plugins that combine several inputs into one output (Concatenate video, Images to PDF, Merge PDF, Merge folders) order them by name, and "first file" means the first one in that order. The sort is plain text, so `10.pdf` comes before `2.pdf`. When an output name is already taken, a ` (N)` suffix is added: `photo.png` → `photo (2).png`. Conversions default to lossless / maximum quality.

### Options and details

**Archive each** (7-Zip) — Format: ZIP (default) or 7z. Compression level 0–9 (default 9).

**Cleanup by extension** — Scans the selected folders and lists every extension found with file count and total size (most frequent first). Ticked extensions are deleted with `unlink` — **permanently, not to the Recycle Bin**. Files without an extension are never listed.

**Concatenate video** (ffmpeg) — Stream copy via the concat demuxer, no re-encoding. The inputs must share codecs and stream parameters; the container follows the first file.

**Convert audio** (ffmpeg) — Target: MP3 (default), WAV, FLAC, M4A, OGG, Opus, AAC. Bitrate 32–320 kbps (default 320), ignored for WAV and FLAC. Optional "Delete original after convert".

**Convert image** (ImageMagick) — Target: PNG (default), JPG, WebP, BMP, TIFF. Quality 1–100 (default 100) applies to JPG; WebP is always written lossless. Optional "Delete original after convert".

**Extract audio** (ffprobe + ffmpeg) — Copies the first audio track bit-for-bit (`-vn -c:a copy`). The extension follows the codec: AAC → `.m4a`, MP3 → `.mp3`, Vorbis → `.ogg`, Opus → `.opus`, FLAC → `.flac`, PCM → `.wav`, anything else → `.m4a`.

**Flatten folder** — Each selected folder is flattened independently. Files are taken in Explorer order — subfolders before files, numbers compared by value (`Lesson 2` before `Lesson 10`) — so on a name collision the first file keeps its name and later ones get ` (2)`, ` (3)`… Names that differ only in letter case count as the same name, as on NTFS. The confirm dialog shows per-folder file counts and how many collisions will get a suffix.

**Flatten folder (keep order)** — Like Flatten folder, but every file from a subfolder gets its full folder path in the name, joined with ` - ` at any depth: `Part A\Lesson 1\Chapter 1.mp4` → `Part A - Lesson 1 - Chapter 1.mp4`. Sorting the result by name keeps lessons and chapters in their original order, which plain flattening would mix up. Files already in the root keep their names; a name that is still taken gets ` (N)`. The confirm dialog shows the first three renames. Windows rejects names longer than 255 characters — such files are listed as errors.

**Images to PDF** (ImageMagick) — Output file name (default `Images.pdf`). Page size: Original (default), A4, Letter.

**Merge folders** — The alphabetically first selected folder is the target. Files from all other folders (including their subfolders) land directly in the target's root. On name collision: rename with ` (N)` (default), skip (source file stays where it was), or overwrite. "Delete source folders after merge" (on by default) removes source folders that end up empty.

**Merge PDF** (Ghostscript) — Re-writes the inputs through `pdfwrite` with `/prepress` settings.

**Split PDF** (Ghostscript) — Per page, or by ranges such as `1-5, 7, 10-12`. File prefix defaults to `<name>-`, giving `<name>-3.pdf` or `<name>-1-5.pdf`.

## How it behaves

- **Menu placement.** The submenu appears on right-click of a folder, of any file, and of the empty background of a folder (which targets that folder itself). All plugins are listed in one flat, alphabetical list regardless of what you clicked; items a plugin can't handle are filtered out when it starts. On Windows 11 the menu lives under **Show more options**.
- **Multi-selection.** Explorer starts one process per selected item. The processes find each other over a named pipe and merge into a single run: the first instance waits until no new item has arrived for 250 ms (5 s at most). Selected items of the wrong type or extension are dropped; a path that no longer exists, or an item count outside the plugin's limits after filtering, aborts with an error.
- **One window.** Everything happens in a single small frameless window (always on top, draggable, minimise/close buttons, height follows content): *scanning* with a live file counter → *confirm* or *form* → *running* with a progress bar → *result*.
- **Result.** On success the window closes silently. If some items failed, it lists up to 10 of them with the error message. `Esc` cancels a confirm dialog and dismisses info/error messages; closing the window before the run starts cancels it.
- **Logs.** `%LOCALAPPDATA%\ContextHelper\logs\YYYY-MM-DD.log`, kept for 14 days.

## Install

Run `dist\ContextHelper-Setup-<version>.exe`. It installs for the current user into `%LOCALAPPDATA%\Programs\context-helper` without admin rights, registers the Explorer menu and adds a **ContextHelper** shortcut to the Start menu. The installer is not code-signed, so SmartScreen may ask for confirmation (**More info → Run anyway**).

Open **ContextHelper** from the Start menu to check the menu: it repairs missing or outdated entries and shows what it changed. Every menu click also re-checks the registration in the background.

Uninstall from **Settings → Apps → ContextHelper**. Running a newer Setup updates the app in place.

The installer, the build and the bundled tools are stored in **Git LFS**. Install LFS before cloning, otherwise `.exe`/`.dll`/`.asar` files check out as text pointers:

```
git lfs install
git clone https://github.com/s4urp8n/win-context-helper.git
```

**Portable use:** copy `dist\win-unpacked` anywhere and run `ContextHelper.exe --register` there; `ContextHelper.exe --unregister` removes the menu.

## Development

```
npm install
npm test                          # Vitest unit tests
npm run test:coverage             # same with coverage; the flatten plugins and src/main/shell-menu must stay at 100%
npm run smoke                     # runs plugins against synthetic fixtures, no Electron
npm start -- --action=flatten-folder --target="C:\path\to\folder"
```

`--target` can be repeated (positional paths work too) to simulate a multi-selection.

Exit codes: `0` success, cancel or nothing to do · `1` finished with per-item errors · `2` selection rejected · `3` internal error (including malformed CLI flags) · `4` unknown action or plugin load failure, or `--register` / `--unregister` outside the packaged build · `5` the Explorer menu could not be registered or verified.

`--register`, `--unregister`, the Start-menu status window and the background menu check run only in the packaged app, so `npm start` never repoints the real menu at the development Electron binary.

## Build

```
npm run package                   # electron-builder → dist/win-unpacked/ + dist/ContextHelper-Setup-<version>.exe
```

Bump `version` in `package.json` before building a release — the installer file name follows it.

> **`npm run package` caveat:** electron-builder fetches `winCodeSign-2.6.0.7z`, which contains macOS symlinks that Windows extracts only with admin rights or Developer Mode. If you hit `Cannot create symbolic link : A required privilege is not held by the client`, enable Developer Mode (Settings → System → For developers) or pre-populate `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` with an extracted copy (`7za x <archive>.7z -o<dir> -xr!darwin`).

## Architecture

```
src/main/index.js              Electron entry: app.whenReady → dispatch → app.exit(code)
src/main/dispatcher.js         CLI → load plugins → merge multi-select → classify → validate → runner
src/main/named-pipe.js         leader/follower aggregation of per-item Explorer launches
src/main/selection/            classify (folders / files / missing), validate (accepts, min/max)
src/main/registry/             plugin-loader (manifest checks)
src/main/shell-menu/           writes, verifies and repairs the Explorer menu in HKCU via reg.exe
src/main/runners/              dialog-runner (scan → confirm → run), window-runner (scan → form → run)
src/main/worker-runner.js      forks src/worker/worker-shim.js, which runs preflight()/run() off the UI process
src/renderer/shell.*           the single state-machine window; src/preload/shell-preload.js bridges IPC
src/shared/base-plugin.js      plugin base class with default hooks
src/shared/spawn.js            spawnTool(): runs a bundled exe, collects output, parses progress
plugins/<id>/plugin.js         one class per plugin (+ optional ui.html, icon.png)
resources/bin/                 bundled tools, copied to resources/bin in the build
build/installer.nsh            NSIS hooks: --register after install, key cleanup on uninstall
```

## Adding a plugin

1. Create `plugins/<id>/plugin.js` exporting a class that extends `BasePlugin`:

   ```js
   const { BasePlugin } = require('../../src/shared/base-plugin');

   class MyPlugin extends BasePlugin {
     static get manifest() {
       return {
         id: 'my-plugin',              // must match the folder name
         label: 'My plugin',           // menu text
         description: '…',
         accepts: ['folders'],         // 'folders', 'files', 'files:.png,.jpg'
         minSelection: 1,
         maxSelection: 999,
         ui: 'window',                 // 'window' (form, default) or 'dialog' (confirm)
       };
     }

     // ctx: { targets, selection, binDir, onProgress, signal }
     async preflight(ctx) { return { totalFiles: 0 }; }

     // ctx: { targets, options, selection, binDir, onProgress, signal }
     async run(ctx) { return { ok: true, processed: 0, skipped: 0, errors: [] }; }
   }

   module.exports = MyPlugin;
   ```

   Progress payloads: `{ scanned }` during preflight, `{ processed, total }` during run. Errors are `{ file, message }`.

2. **Form (window mode):** put the fields in `plugins/<id>/ui.html`, or return HTML from `buildFormHtml(ctx, pre)` when the form depends on the scan. Every field's `name` becomes a key in `options`: number inputs arrive as numbers, radios as the checked value, a checkbox without `value` as a boolean, checkboxes with a `value` as an array of checked values.

3. **Optional hooks** (all receive `ctx` and the preflight result): `buildFormMessage`, `buildFormSummary` (window mode); `isEmpty`, `buildNothingToDoBody`, `buildConfirmMessage` (dialog mode); `buildScanningLabel`, `buildRunningLabel`, `buildErrorBody`. A hook that throws falls back to the default text.

4. **External tools:** build the path from `ctx.binDir` (e.g. `path.join(binDir, 'ffmpeg.exe')`) and call `spawnTool`. Accept `{ spawnTool }` in the constructor so tests can inject a mock — see any binary-backed plugin.

5. Add `tests/unit/<id>.test.js`, run `npm test`, then `npm run package`; installing the new Setup (or running `ContextHelper.exe --register`) adds the menu item.

## Bundled tools

| File | Version | Used by |
|---|---|---|
| `7z.exe` | 7-Zip 26.01 (standalone `7zr`) | Archive each |
| `magick.exe` | ImageMagick 7.1.2-23 portable Q16 x64 | Convert image, Images to PDF |
| `gswin64c.exe` + `gsdll64.dll` | Ghostscript 10.07.1 | Merge PDF, Split PDF |
| `ffmpeg.exe`, `ffprobe.exe` | ffmpeg 8.1.1 essentials | Concatenate video, Convert audio, Extract audio |

Download links, refresh steps and license notes: [`resources/bin.README.md`](resources/bin.README.md). Ghostscript is AGPL v3 — check the licenses before redistributing a build.

## Known limitations

- **~15 selected items at most.** Windows hides registry-based context-menu verbs when more items are selected. Lifting this requires a native COM `IExplorerCommand` extension, which is out of scope. Process larger batches in groups.
- **No cancel once running.** Closing the window during the *running* state does not stop the work.
- **Classic menu only on Windows 11** — no native Win11 shell extension.

## Docs

Design specs are in `docs/superpowers/specs/`, implementation plans in `docs/superpowers/plans/`. The original v1 design is `docs/superpowers/specs/2026-05-12-contexthelper-design.md`.
