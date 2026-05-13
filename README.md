# ContextHelper

Windows utility that adds a plugin-driven **ContextHelper** submenu to the Explorer right-click menu. Per-user (HKCU), no admin required, no installer — just build the portable folder and run `register.bat`.

> **Status:** Plan 1 + flatten-folder rework complete in code. One plugin (`flatten-folder`) shipping, now using a native confirm dialog and supporting multi-folder selection (1..999). Multi-selection in Explorer aggregates into a single app instance via a named-pipe leader/follower handshake; min/max bounds and target-type checks are enforced before any work begins. Two plugin UI modes are supported via `manifest.ui`: `"window"` (full Electron renderer + form, default) and `"dialog"` (native confirm + frameless spinner, no HTML). See `docs/superpowers/specs/` for design docs and `docs/superpowers/plans/` for implementation plans.

## Quick start (developer)

```
npm install
npm test                          # unit tests
npm run smoke                     # programmatic plugin smoke
npm start -- --action=flatten-folder --target="C:\path\to\some\folder"
```

## Build portable + register in Explorer

```
npm run package                   # produces dist/win-unpacked/
npm run gen-register              # generates register.bat / unregister.bat
copy register.bat dist\win-unpacked\
copy unregister.bat dist\win-unpacked\
```

Then in Explorer: double-click `dist\win-unpacked\register.bat`. The submenu appears on right-click. Run `unregister.bat` to remove.

On Windows 11, the menu appears under "Show more options" (classic context menu). A true Win11 native shell extension is out of scope.

> **Known limitation — selection size:** Windows hides static-verb context-menu items when the selection exceeds **~15 items**. This is a shell-side cap on registry-based verbs (raised only by a native COM `IExplorerCommand` extension, which is out of scope). Practically: select up to ~15 folders/files at a time when invoking ContextHelper. For larger batches, open the parent folder and process its subfolders in groups, or work iteratively.

> **`npm run package` caveat:** electron-builder fetches `winCodeSign-2.6.0.7z`, which contains macOS dylib symlinks that Windows can only extract with admin rights or Developer Mode enabled. If you hit `Cannot create symbolic link : A required privilege is not held by the client`, either enable Developer Mode (Settings → System → For developers → Developer Mode → On) or pre-populate `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` with an already-extracted copy. As a temporary workaround you can edit `dist/win-unpacked/` in place: copy plugin files into `resources/plugins/<id>/`, and use `node_modules/.bin/asar extract … && cp … && asar pack` to update `resources/app.asar`.

## Plugins implemented so far

| Plugin | UI mode | Selection | What it does |
|---|---|---|---|
| `flatten-folder` | dialog | 1..999 folders | Moves every nested file into the root of each selected folder, independently. Resolves name collisions with `(N)` suffix. Removes empty subfolders. Shows a native confirm with per-folder file/collision counts before doing anything; exits silently on success, raises a native error dialog only if files could not be moved. Rejects selections that include any non-folder item. |

### flatten-folder — user-visible flow

1. Right-click one or more folders in Explorer → **Flatten folder**.
2. If the selection includes a file or a non-existent path → red error dialog "Flatten folder works only with folders", exit code 2.
3. If every selected folder is already flat → info dialog "Nothing to do", exit 0.
4. Otherwise → confirm dialog listing each selected folder with its file count + a summary line ("Each folder will be flattened into its own root (N files total)") and, when applicable, the number of `(N)` suffix renames. Cancel → silent exit 0; Continue → frameless spinner appears, work runs, spinner closes, silent exit 0 (or error dialog with per-file failure list and exit 1 if anything could not be moved).

See `docs/superpowers/specs/2026-05-18-flatten-folder-rework-design.md` for the full behavioural spec (dialog wording, edge cases, exit codes) and the plugin contract that other dialog-mode plugins will inherit.

## Repository structure

See the design spec — `docs/superpowers/specs/2026-05-12-contexthelper-design.md` §8.
