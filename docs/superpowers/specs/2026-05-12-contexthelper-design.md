# ContextHelper — Design Spec

**Date:** 2026-05-12 (revised 2026-05-13)
**Status:** Approved — ready for implementation planning
**Project root:** `C:\YandexDisk\Software\bin\ContextHelper\`

## 1. Purpose

A Windows utility that exposes useful per-file and per-folder actions through the Explorer right-click context menu. The user selects a file/folder, opens the context menu, and sees a **ContextHelper** submenu listing only the actions applicable to the selection. Operations run in a dedicated window with confirmation, options, and progress.

## 2. Goals & Non-Goals

**Goals:**
- Right-click integration in Windows Explorer (Windows 10/11; appears in the legacy "Show more options" menu on Win11 — acceptable).
- Plugin-based architecture: each feature is a self-contained folder under `plugins/`. Adding a plugin requires no recompilation.
- Eleven built-in plugins on day one (see §3).
- Installable / uninstallable via NSIS installer. No admin rights required (per-user, `HKCU`).
- Build script (`npm run build`) produces a single setup `.exe`.
- Tests verifying functionality, runnable on any machine for diagnostics.
- Stack: JavaScript (Electron) — the user's preferred language.
- Documentation tailored for an AI agent to quickly resume work (`CLAUDE.md`).

**Non-Goals (out of scope for v1):**
- Custom shell extension that bypasses the Windows 11 "Show more options" submenu (would require C++/C# COM and MSIX packaging).
- macOS or Linux support.
- Cloud sync of settings.
- Per-machine installation (`HKLM`).

## 3. Plugins (v1)

| ID | Target | What it does | External tool |
|---|---|---|---|
| `flatten-folder` | folder | Recursively move all nested files into the root of the selected folder. On name collision → `name (2).ext`, `name (3).ext`... Empty subfolders removed after. Optional toggle: encode original path into filename (e.g. `sub__photo.jpg`). | — |
| `cleanup-by-extension` | folder | Scan folder, show table of extensions with file counts and total size. User selects extensions via checkboxes → confirm → files moved to **Recycle Bin** (`shell.trashItem`, recoverable). | — |
| `convert-image` | 1+ image files | Convert to chosen format (JPEG / PNG / WebP / HEIC / TIFF / BMP) with **max-quality presets**. Result written alongside originals; originals untouched. On collision → `name (2).ext`. | `magick.exe` |
| `convert-audio` | 1+ audio files | Convert to chosen format (FLAC / WAV / MP3 / AAC / OGG) with max-quality presets. Result alongside originals. Collisions handled. | `ffmpeg.exe` |
| `images-to-pdf` | 2+ image files | Merge selected images into a single PDF. Options: page size (per-image / A4), compression (lossless / JPEG q95). Output written next to first selected image. | `magick.exe` |
| `split-pdf` | 1 PDF file | Render each page to a PNG/JPEG. Options: DPI (150/300/600), format. Output: `pagename-001.png`, `pagename-002.png`... in same folder. | `magick.exe` + `gswin64c.exe` |
| `merge-folders` | 2+ folders | Move all files from selected folders into one chosen target folder. Collisions → `name (2).ext`. Option: **preserve top-level** (each source goes into a `<source-name>/` subfolder of the target) or **fully merge** into one flat root. Source folders are left in place by default (now empty); user can opt-in to delete them after success. | — |
| `archive-each` | 1+ folders | Pack each selected folder into its own archive **next to it** (e.g. `Photos/` → `Photos.zip`). Options: format (`zip` / `7z`), compression level (`store` / `fast` / `normal` / `best`), optional password (7z only). On name collision → `Photos (2).zip`. | `7z.exe` |
| `merge-pdf` | 2+ PDF files | Concatenate selected PDFs into one. Sort order: **as-selected** (default) / by-name / by-date-modified. Output: `Merged.pdf` next to first selected file; user can rename before run. Quality preserved (no re-compression). | `gswin64c.exe` |
| `concat-video` | 2+ video files | Concatenate selected videos. **Mode A** (default, auto-detected when codec/timebase/dimensions/fps match across inputs): lossless `-c copy` via ffmpeg concat demuxer. **Mode B** (forced or auto-fallback when streams differ): re-encode to H.264 CRF 18 + AAC 320k. Output: `Concat.mp4` next to first selected (container configurable: keep-source/`.mp4`/`.mkv`). | `ffmpeg.exe` |
| `extract-audio` | 1+ video files | Extract audio from each video. **Default:** copy native stream losslessly (`-c:a copy`); extension chosen from codec (`.m4a` for AAC, `.opus`, `.mp3`, `.flac`, etc.). **Alternatives:** transcode to MP3 V0, FLAC, or WAV. Output written next to each video. | `ffmpeg.exe` |

### Quality presets

- **JPEG:** `-quality 95 -sampling-factor 4:4:4 -strip` (preserves chroma, removes metadata only if user opts in).
- **PNG:** `-define png:compression-level=9` (lossless, max compression).
- **WebP:** `-quality 100 -define webp:lossless=true`.
- **HEIC:** `-quality 90` (HEIC is inherently lossy; 90 is near-transparent).
- **TIFF/BMP:** lossless.
- **MP3:** `libmp3lame -q:a 0` (VBR V0, ~245 kbps).
- **AAC:** `aac -b:a 320k` (or `libfdk_aac` if present in bundle).
- **FLAC/WAV:** lossless.
- **OGG:** `libvorbis -q:a 8`.
- **concat-video re-encode (Mode B):** `-c:v libx264 -crf 18 -preset slow -c:a aac -b:a 320k -movflags +faststart` (visually lossless, web-friendly).
- **concat-video lossless detection:** `ffprobe` each input — match `codec_name`, `width`, `height`, `pix_fmt`, `avg_frame_rate`, `sample_rate`, `channels`, `time_base`. All-match → Mode A; any mismatch → Mode B (warn user before run).
- **merge-pdf:** `gswin64c -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dPDFSETTINGS=/default -sOutputFile=out.pdf in1.pdf in2.pdf ...` (no recompression of embedded images).
- **archive-each compression levels:** `store` → `-mx0`; `fast` → `-mx1`; `normal` → `-mx5` (default); `best` → `-mx9`. Format flag: `-tzip` or `-t7z`. Password (7z only): `-p<pwd> -mhe=on` (header encryption).

## 4. Architecture

### 4.1 Process model

- **Main process** (`src/main/index.js`):
  - Parses CLI args: `--action=<plugin-id> --target="<path>"` (or `--register` / `--unregister`).
  - Loads plugin registry from `plugins/*/manifest.json`.
  - Aggregates multi-selection via named pipe (see §4.3).
  - Opens a plugin window, passes targets and plugin definition.
- **Renderer process** (`src/renderer/`): plugin window. Single HTML shell (`index.html`) into which the plugin's `ui.html` is injected. Handles user input, sends start/cancel via IPC, displays progress and results.
- **Worker child process** (one per plugin run): spawned by the main process. Runs the plugin's `worker.js`. Long operations (ffmpeg/magick spawns, large file ops) do not block UI. Reports progress over IPC.

### 4.2 Plugin contract

Each plugin is a folder under `plugins/<id>/`:

```
plugins/flatten-folder/
  manifest.json
  ui.html
  worker.js
```

**`manifest.json`:**
```json
{
  "id": "flatten-folder",
  "label": "Сделать папку плоской",
  "description": "Перенести все вложенные файлы в корень папки",
  "icon": "icon.png",
  "accepts": ["folder"],
  "minSelection": 1,
  "maxSelection": 1
}
```

`accepts` values:
- `"folder"` — exactly one folder.
- `"folders"` — one or more folders.
- `"files:.jpg,.png,.heic,.webp,.tiff,.bmp"` — one or more files with given extensions.
- `"files:.pdf"` — etc.

Canonical extension lists used by built-in plugins:
- **images:** `.jpg,.jpeg,.png,.webp,.heic,.heif,.tiff,.tif,.bmp`
- **audio:** `.mp3,.wav,.flac,.aac,.m4a,.ogg,.opus,.wma`
- **video:** `.mp4,.mkv,.mov,.avi,.webm,.m4v,.flv,.wmv,.ts,.mpg,.mpeg`
- **pdf:** `.pdf`

`minSelection` / `maxSelection` constrain selection count (e.g. `images-to-pdf` needs `minSelection: 2`, `merge-folders` needs `minSelection: 2`, `concat-video` needs `minSelection: 2`).

> **Note on count constraints and Explorer:** Windows cannot show/hide a verb based on selection count, only on file type. Plugins with `minSelection > 1` (e.g. `concat-video`, `merge-pdf`, `merge-folders`, `images-to-pdf`) therefore still appear in the submenu even with a single item selected. When launched below the minimum, the main process aborts before showing the worker UI and displays a brief notification: *"This action needs 2 or more items."*

**`worker.js`:** exports `async function run({ targets, options, onProgress, signal })`. Returns `{ ok, processed, skipped, errors }`. Receives `signal` (AbortSignal) for cancellation.

**`ui.html`:** options form. Form values are serialized to `options` object passed to worker.

### 4.3 Multi-selection aggregation

Windows invokes the registered command **once per selected file**. To present a single window for a multi-file action:

- On startup, the process tries to connect to named pipe `\\.\pipe\ContextHelper-<sessionId>-<plugin-id>`.
- If the pipe exists (another instance is running) → send target path, exit.
- If not → become the leader: create pipe, wait 200 ms for sibling instances to push their paths, then open the window with the aggregated list.

`<sessionId>` is the Windows interactive session id (prevents leakage across users / RDP sessions).

### 4.4 Bundled utilities

Located at `resources/bin/` (copied via `electron-builder.extraResources`):
- `ffmpeg.exe` — used by `convert-audio`, `concat-video`, `extract-audio` (+ `ffprobe.exe` for stream introspection)
- `magick.exe` (ImageMagick portable) — used by `convert-image`, `images-to-pdf`, `split-pdf`
- `gswin64c.exe` (Ghostscript) — used by `magick` for PDF rendering, by `split-pdf`, and by `merge-pdf`
- `7z.exe` (7-Zip CLI, portable) — used by `archive-each`; planned shared dependency for future archive/extract plugins

Resolved at runtime via `process.resourcesPath`. Helper in `src/main/utils/bin-paths.js`.

## 5. UX

### 5.1 Window template

Single HTML shell, plugin injects content into specific slots:

- **Header:** plugin label + short description.
- **Targets summary:** "1 folder: `D:\Photos\Trip`" or "12 files: `IMG_001.jpg`, `IMG_002.jpg`... +10". For folder ops, optional pre-scan summary (e.g. flatten preview).
- **Options form:** plugin-specific. Sensible defaults pre-filled.
- **Action bar:** `Старт` (primary) / `Отмена`.

After Start:
- Options replaced by **progress block**: progressbar (0–100%) + line "3 / 47: photo_023.jpg → photo_023.png".
- `Отмена` becomes "stop after current file" (graceful, SIGTERM to worker between files).

After completion:
- Summary block: `✓ 45 success, ⚠ 2 skipped, ✕ 0 errors`. Error list expandable.
- Buttons: `Открыть папку` (shell.openPath) / `Закрыть`.
- Window does **not** auto-close.

### 5.2 Error handling

- Per-file errors do not abort the queue. Worker catches, logs, continues.
- Errors collected and shown in summary with reason: `magick exit 1: unsupported format`.
- All runs logged to `%LOCALAPPDATA%\ContextHelper\logs\YYYY-MM-DD.log` (daily rotation, 14-day retention).

### 5.3 Edge cases

- **Long paths (>260):** all file ops use `\\?\` prefix via `src/main/utils/long-path.js`.
- **Locked files:** skip, log reason.
- **Insufficient disk space:** estimate output size pre-flight, warn if free space < estimate × 1.1.
- **Cleanup-by-extension safety:** files go to **Recycle Bin**, never deleted permanently. Confirmation required.
- **Flatten safety:** never overwrites — always uses `(N)` suffix.

## 6. Installation & Registry

### 6.1 Installer (NSIS via electron-builder)

- Output: `dist/ContextHelper-Setup-x.y.z.exe` (~300 MB with bundled binaries).
- Optional portable: `dist/ContextHelper-portable.exe`.
- Install location: `%LOCALAPPDATA%\Programs\ContextHelper\`.
- Per-user install (no UAC prompt).
- Post-install hook: `ContextHelper.exe --register`.
- Start Menu shortcut.
- Registered in `Add/Remove Programs` for uninstall.

### 6.2 Uninstaller

- Runs `ContextHelper.exe --unregister` first.
- Removes app files.
- Preserves `%APPDATA%\ContextHelper\` (user settings) and `%LOCALAPPDATA%\ContextHelper\logs\` unless user checks "remove settings too".

### 6.3 Registry layout (HKCU)

**For folders** — single root with `ExtendedSubCommandsKey` submenu:

```
HKCU\Software\Classes\Directory\shell\ContextHelper
  MUIVerb              = "ContextHelper"
  Icon                 = "<install>\ContextHelper.exe,0"
  SubCommands          = ""
  ExtendedSubCommandsKey = "Software\Classes\Directory\ContextHelperSub"

HKCU\Software\Classes\Directory\ContextHelperSub\shell\flatten-folder
  MUIVerb              = "Сделать папку плоской"
  Icon                 = "<install>\plugins\flatten-folder\icon.png"
  command\(Default)    = "<install>\ContextHelper.exe" --action=flatten-folder --target="%1"

HKCU\Software\Classes\Directory\ContextHelperSub\shell\cleanup-by-extension
  MUIVerb              = "Удалить файлы по расширению..."
  command\(Default)    = "<install>\ContextHelper.exe" --action=cleanup-by-extension --target="%1"
```

**For files** — per-extension under `SystemFileAssociations`, same submenu pattern:

```
HKCU\Software\Classes\SystemFileAssociations\.jpg\shell\ContextHelper
  ... ExtendedSubCommandsKey → ContextHelperSub_jpg
HKCU\Software\Classes\SystemFileAssociations\.jpg\ContextHelperSub_jpg\shell\convert-image
  command = ContextHelper.exe --action=convert-image --target="%1"
HKCU\Software\Classes\SystemFileAssociations\.jpg\ContextHelperSub_jpg\shell\images-to-pdf
  command = ContextHelper.exe --action=images-to-pdf --target="%1"
```

Repeated for each accepted extension across plugins. Auto-hide: if a selected file/folder matches no plugin manifest, no registry key applies → no ContextHelper menu appears at all.

### 6.4 register / unregister

- `--register`: idempotent. Reads all `plugins/*/manifest.json`, generates the registry tree above, writes keys.
- `--unregister`: removes the entire `ContextHelper` and `ContextHelperSub*` subtrees from `HKCU\Software\Classes\Directory\` and `HKCU\Software\Classes\SystemFileAssociations\<ext>\`.
- Devs use `npm run register` / `npm run unregister` for live testing without reinstall.

## 7. Tests

### 7.1 Unit (Vitest)

- `tests/unit/collision.test.js` — `name (N).ext` generator across many edge cases.
- `tests/unit/plugin-registry.test.js` — manifest parsing, `accepts` matching against selections.
- `tests/unit/long-path.test.js` — `\\?\` prefixing.
- `tests/unit/ext-scan.test.js` — extension statistics aggregation.

Run: `npm test`.

### 7.2 Smoke tests (functional, machine-portable)

`tests/smoke/runner.js` — `npm run smoke`:

1. Creates a fresh temp dir, copies `tests/smoke/fixtures/` into it. Fixtures include: `sample.jpg`, `sample.png`, `sample.mp3`, `sample.wav`, `sample.pdf` (2 pages), `nested/sub/deep.txt`, `duplicate-name/` (folder with name collisions).
2. For each plugin, runs its `worker.js` directly (no UI) against relevant fixtures.
3. Asserts: expected output files exist, are non-empty, can be re-read (e.g. for an image conversion: output is a valid image of expected format).
4. Prints a table:
   ```
   ✓ flatten-folder           234 files → 234 in root, 0 collisions
   ✓ cleanup-by-extension     scanned 234, deleted 12 .tmp
   ✓ convert-image jpg→png    sample.jpg → sample.png (4.2 KB)
   ✓ convert-audio mp3→flac   sample.mp3 → sample.flac (28.1 KB)
   ✓ images-to-pdf            2 images → out.pdf (page count: 2)
   ✗ split-pdf                gswin64c.exe not found in resources/bin/
   ✓ merge-folders            3 folders → 47 files merged, 2 renamed on collision
   ✓ archive-each zip         3 folders → 3 .zip files (total 1.2 MB)
   ✓ archive-each 7z          3 folders → 3 .7z files (total 0.9 MB)
   ✓ merge-pdf                3 PDFs → merged.pdf (11 pages, 412 KB)
   ✓ concat-video lossless    2 mp4 → concat.mp4 (Mode A, 00:03:42)
   ✓ concat-video reencode    mp4 + mkv (mismatch) → concat.mp4 (Mode B)
   ✓ extract-audio copy       2 mp4 → 2 .m4a (lossless copy)
   ```
5. Exit code: `0` if all passed, `1` otherwise.
6. Each plugin can be run individually: `npm run smoke -- --plugin=convert-image`.

### 7.3 Pre-flight diagnostic

`npm run doctor` — `tests/doctor.js`:
- Verifies all `resources/bin/*.exe` exist and are executable.
- Runs `ffmpeg -version`, `ffprobe -version`, `magick -version`, `gswin64c -version`, `7z` (banner) — captures versions.
- Reads `HKCU\Software\Classes\Directory\shell\ContextHelper` — reports registered or not.
- Checks log dir writable.
- Prints summary + exit code 0/1.

This is the first command to run on an unfamiliar machine to diagnose "what's wrong".

## 8. Repo structure

```
ContextHelper/
├── package.json
├── electron-builder.yml
├── CLAUDE.md
├── README.md
├── .gitignore
├── src/
│   ├── main/
│   │   ├── index.js
│   │   ├── plugin-registry.js
│   │   ├── window-manager.js
│   │   ├── ipc.js
│   │   ├── named-pipe.js
│   │   ├── registry/
│   │   │   ├── register.js
│   │   │   └── unregister.js
│   │   └── utils/
│   │       ├── collision.js
│   │       ├── long-path.js
│   │       └── bin-paths.js
│   ├── renderer/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
│   └── shared/
│       └── plugin-api.js
├── plugins/
│   ├── flatten-folder/
│   ├── cleanup-by-extension/
│   ├── convert-image/
│   ├── convert-audio/
│   ├── images-to-pdf/
│   ├── split-pdf/
│   ├── merge-folders/
│   ├── archive-each/
│   ├── merge-pdf/
│   ├── concat-video/
│   └── extract-audio/
├── resources/
│   ├── bin/                     # ffmpeg.exe, ffprobe.exe, magick.exe, gswin64c.exe, 7z.exe (+ 7z.dll)
│   └── icon.ico
├── tests/
│   ├── unit/
│   ├── smoke/
│   │   ├── runner.js
│   │   ├── fixtures/
│   │   └── plugins/
│   └── doctor.js
└── docs/
    ├── superpowers/specs/2026-05-12-contexthelper-design.md
    └── plugin-authoring.md
```

## 9. Documentation

**`CLAUDE.md`** (mandatory, content outline):
- TL;DR — what this is, stack, single command to get running.
- Commands — what `npm run dev | build | smoke | doctor | test | register | unregister` do.
- Architecture — process model, IPC channels, plugin contract (link to file).
- Where things live — pointers to key files in `src/`, `plugins/`, `resources/`.
- How to add a new plugin — step by step: create folder, manifest, ui.html, worker.js, smoke test.
- How the context menu works — registry layout, how to test locally without reinstall.
- Where bundled tools live and how to add a new one.
- Conventions — naming, error handling, logging, lint/format.
- PR checklist — `npm test && npm run smoke && npm run doctor` must pass.

**`README.md`** — for humans: install, screenshots, features list.

**`docs/plugin-authoring.md`** — extended plugin guide with a complete example.

## 10. CI (optional v1)

GitHub Actions on a Windows runner:
- On push: `npm test && npm run smoke`.
- On tag `v*`: `npm run build` + upload installer as release artifact.

## 11. Out of scope (future)

- True Windows 11 native context menu (MSIX + IExplorerCommand).
- Plugin marketplace / auto-update.
- Per-machine (HKLM) install.
- Localization beyond Russian (current default).
- Drag & drop window mode.

## 12. Stack summary

- **Runtime:** Electron (latest LTS at start of implementation).
- **UI:** vanilla HTML/CSS/JS (no React/Vue) — keeps bundle lean and matches scope.
- **Tests:** Vitest.
- **Lint/format:** ESLint + Prettier (defaults).
- **Build:** electron-builder (NSIS target).
- **External tools:** ffmpeg (+ ffprobe), ImageMagick (portable), Ghostscript, 7-Zip CLI — bundled in `resources/bin/`.

## 13. Changelog

**2026-05-13 — v1 plugin set expansion (6 → 11)**

Added five plugins after brainstorming round (see §3 for details):
- `merge-folders` (2+ folders) — pure JS, no new bundle.
- `archive-each` (1+ folders) — adds `7z.exe` to bundle. Lays groundwork for future `archive-selected`, `extract-archive`, `compress-folder`, `encrypt-folder` plugins.
- `merge-pdf` (2+ PDFs) — uses already-bundled `gswin64c`.
- `concat-video` (2+ videos) — uses already-bundled `ffmpeg` (+ adds `ffprobe` for lossless-vs-reencode detection).
- `extract-audio` (1+ videos) — uses already-bundled `ffmpeg`.

Brainstorm round explicitly declined any new single-folder or single-file plugins beyond the original 6 — those domains may be revisited later.

Other touch-ups in this revision:
- Canonical extension lists for images/audio/video/pdf documented in §4.2.
- Explicit note on Explorer's inability to enforce `minSelection` (§4.2).
- `ffprobe.exe` added to bundled binaries (always shipped with ffmpeg anyway).
- Doctor diagnostic extended to check `ffprobe` and `7z` (§7.3).
- Smoke-test output table extended with new plugins (§7.2).
