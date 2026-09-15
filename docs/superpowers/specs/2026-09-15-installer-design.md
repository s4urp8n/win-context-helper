# Installer + self-managed Explorer menu registration

> **Status:** Draft, awaiting user review.
> **Author:** Claude Opus 5 (1M context).
> **Date:** 2026-09-15.
> **Depends on:** the current flat menu layout written by `scripts/gen-register-bat.js` (3 entry points → `Directory\ContextHelperRoot\shell\<id>`).

## 1. Goal

Installing ContextHelper on another computer is currently "copy `dist/win-unpacked` somewhere, run `register.bat` from there, never move the folder". On a second PC the menu item appears but clicking it does nothing, and there is no way to tell whether the registration is correct.

After this change:

- a one-click installer `ContextHelper-Setup-<version>.exe` installs the app per user and registers the menu;
- the app itself owns the registry entries: it writes them, reads them back, verifies them, and repairs drift;
- the installer fails loudly when the menu could not be registered;
- a Start-menu shortcut opens a status window that checks (and repairs) the registration;
- `register.bat` / `unregister.bat` / `gen-register-bat.js` are gone.

Out of scope: code signing (SmartScreen / Smart App Control will still warn about or block an unsigned installer), an application icon, auto-update, per-machine install, GitHub Releases.

## 2. Decisions (approved in brainstorming)

| Topic | Decision |
|---|---|
| Who writes and verifies the registry | The app (`ContextHelper.exe --register`), not an NSIS script |
| Registry access | `reg.exe`: `reg export` to read, `reg import` of a generated `.reg` to write and delete |
| Installer type | electron-builder NSIS, one-click, per user, no admin |
| Distribution | Installer and `dist/win-unpacked` are committed to git (Git LFS) |
| Old scripts | `register.bat`, `unregister.bat`, `scripts/gen-register-bat.js` removed |

## 3. Registry layout (unchanged from today)

All keys live under `HKEY_CURRENT_USER\Software\Classes`. `E` is the absolute path of the running `ContextHelper.exe` (`process.execPath`). Every value is `REG_SZ`.

| Key | Value | Data |
|---|---|---|
| `Directory\shell\ContextHelper` | `MUIVerb` | `ContextHelper` |
| | `Icon` | `E,0` |
| | `ExtendedSubCommandsKey` | `Directory\ContextHelperRoot` |
| `*\shell\ContextHelper` | same three values | |
| `Directory\Background\shell\ContextHelper` | same three values | |
| `Directory\ContextHelperRoot` | — (key only) | |
| `Directory\ContextHelperRoot\shell` | — (key only) | |
| `Directory\ContextHelperRoot\shell\<id>` (one per plugin) | `MUIVerb` | plugin `label` |
| | `MultiSelectModel` | `Player` |
| `Directory\ContextHelperRoot\shell\<id>\command` | (default) | `"E" --action=<id> "%V"` |
| `Directory\ContextHelperFolders`, `Directory\ContextHelperFiles` | must not exist (legacy layout) | |

**Ownership.** The three entry-point keys and the whole `ContextHelperRoot` subtree are owned exactly: values or subkeys that are not in the table are removed. This also cleans up a stray `SubCommands` value, which would override `ExtendedSubCommandsKey` and empty the submenu.

## 4. Architecture

### 4.1. `src/main/shell-menu/`

**`entries.js`** — pure. `desiredState({ exePath, manifests })` → `Map<keyPath, Map<valueName, data>>` holding exactly the table in §3, with plugins sorted by id. `ownedRoots` lists the keys whose subtrees are owned, `absentKeys` lists the legacy keys.

**`reg-file.js`** — pure. Serialises and parses the `.reg` format (`Windows Registry Editor Version 5.00`):

- `serialize({ sets, deleteValues, deleteKeys })`: `[key]` sections with `"name"="data"`; `@=` for the default value; `"name"=-` to delete a value; `[-key]` to delete a key. Data escapes `\` → `\\` and `"` → `\"`.
- `parse(text)` → `Map<keyPath, Map<valueName, data>>`; the default value is stored under `''`. Only `REG_SZ` entries are expected; any other type is kept as an opaque string, so it shows up as a mismatch.
- Files are UTF-16LE with a BOM, matching what `reg export` writes and `reg import` expects.

**`reg.js`** — thin `reg.exe` wrapper with an injectable runner `runReg(args) → { code, stdout, stderr }` (`child_process.spawn`, `windowsHide`).

- `exportKey(key)` → `reg export "<key>" "<tmp>.reg" /y`, reads the temp file, deletes it, returns `{ values: parsed map, error }`.
  - A non-zero exit returns an empty map and keeps stderr in `error`. It is **not** classified by message text: `reg.exe` messages are localised ("ОШИБКА: Не удается найти…" on Russian Windows) and printed in the OEM code page.
  - Treating every failure as "absent" is safe. Sync then rewrites those values (the write is idempotent) and re-exports them. An export that keeps failing ends as `ok: false` with the stderr logged, and a real permission problem fails loudly at `importFile`.
- `importFile(text)` → writes a temp `.reg`, runs `reg import`, deletes it, throws on a non-zero exit. The thrown error carries the exit code and the raw stderr.
- It never parses console output for data. `reg query` output piped to a process uses the OEM code page and garbles non-ASCII paths such as `C:\Users\Иван\...`. The `.reg` file written by `reg export` is always UTF-16LE with a BOM, verified on this machine.
- Raw stderr goes only to the log. Texts shown to the user are ContextHelper's own, e.g. "Windows refused to change the registry (reg.exe exit code 1)".
- Both functions take a `root` (default `HKEY_CURRENT_USER\Software\Classes`) so tests can target a scratch key.

**`sync.js`** — `syncMenu({ exePath, manifests, reg, root })`:

1. Export each owned root and legacy key → actual state.
2. Diff against `desiredState`. The diff is a list of `set` (missing or wrong value), `deleteValue` (unexpected value in an owned key), `deleteKey` (unexpected subkey of an owned root, or a legacy key).
3. Empty diff → `{ ok: true, changes: [] }` with no writes.
4. Otherwise import one `.reg` holding all changes, export again, diff again.
5. Return `{ ok: remaining.length === 0, changes, remaining }`. `remaining` lists key / value / expected / actual.

`unregisterMenu({ reg, root })` imports `[-key]` for every owned root and legacy key, exports again and returns `{ ok, remaining }`.

Both results also carry `lines`: human-readable descriptions of what changed or still differs, for the log and the status window, for example `Added "Flatten folder (keep order)"`, `Updated command of "Flatten folder"`, `Removed stale item "old-plugin"`.

### 4.2. Launch modes

`parseCli` gains two flag-only modes. `--register` and `--unregister` take no `=value`; combining them with `--action` is an error.

| Invocation | Behaviour | Exit |
|---|---|---|
| `--action=<id> "<path>"` (menu click) | Unchanged plugin flow. If packaged and this process is the aggregator leader (or had several targets from the start), `syncMenu` starts in the background right after aggregation. Its outcome is logged only. Before `app.exit` the dispatcher awaits it for at most 5 s. | plugin's code |
| no arguments (Start-menu shortcut) | Packaged: `syncMenu`, then the shell window shows `info` ("Explorer menu is registered — 12 items" / "Explorer menu repaired" + change list) or `error` (reason + log path). Not packaged: logs and exits, as today. | 0, or 5 on failure |
| `--register` | Packaged only (otherwise log "only in packaged build", exit 4). Runs `syncMenu` without any window. | 0, or 5 |
| `--unregister` | Packaged only. Runs `unregisterMenu` without any window. | 0, or 5 |

New exit code **5** = the menu registration could not be written or verified.

Packaged-only because `npm start` runs `node_modules\electron\dist\electron.exe`; syncing there would repoint the real menu at the dev Electron binary.

Every sync logs one line: `shell-menu: in sync` / `shell-menu: repaired` + changes / `shell-menu: failed` + remaining + `reg.exe` stderr.

## 5. Installer

### 5.1. `electron-builder.yml`

```yaml
win:
  target:
    - target: nsis
      arch: x64
  icon: null
nsis:
  oneClick: true
  perMachine: false
  runAfterFinish: false
  createDesktopShortcut: false
  createStartMenuShortcut: true
  shortcutName: ContextHelper
  artifactName: ContextHelper-Setup-${version}.${ext}
  include: build/installer.nsh
```

The `extraResources` entry for `scripts/gen-register-bat.js` is removed. `plugins` and `resources/bin` stay.

### 5.2. `build/installer.nsh`

```nsis
!macro customInstall
  ClearErrors
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --register' $0
  ${if} ${Errors}
  ${orIf} $0 <> 0
    MessageBox MB_OK|MB_ICONSTOP "ContextHelper could not register its Explorer menu (code $0).$\r$\nDetails: $LOCALAPPDATA\ContextHelper\logs$\r$\nOpen ContextHelper from the Start menu to retry." /SD IDOK
    SetErrorLevel 5
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\Directory\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\*\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ContextHelper"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperRoot"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperFolders"
    DeleteRegKey HKCU "Software\Classes\Directory\ContextHelperFiles"
  ${endIf}
!macroend
```

`<>` is LogicLib's integer comparison (`!=` compares strings). `${Errors}` catches the case where `ExecWait` could not start the exe at all and `$0` stays empty.

Uninstall deletes the keys itself rather than calling `--unregister`, so it still works when the installed exe is damaged. Logs in `%LOCALAPPDATA%\ContextHelper\logs` are kept.

### 5.3. Update and migration

- **Update:** running a newer Setup silently uninstalls the old version with `isUpdated` set, so the menu keys survive. The new files are copied, then `--register` rewrites paths and drops items of removed plugins. The version comes from `package.json` and is bumped by hand before a release build.
- **Migration from `register.bat`:** nothing special. The keys have the same names, so `--register` overwrites them with the installed path.

## 6. Build and repository

- `npm run package` → `electron-builder --win nsis`, which produces both `dist/win-unpacked/` and `dist/ContextHelper-Setup-<version>.exe`. Both are committed; `*.exe` is already an LFS pattern.
- `.gitignore` adds `dist/*.blockmap` and `dist/builder-effective-config.yaml`.
- Removed:
  - `register.bat` and `unregister.bat`, in the repo root and in `dist/win-unpacked/`;
  - `scripts/gen-register-bat.js` and `tests/unit/gen-register-bat.test.js`;
  - the `gen-register` npm script;
  - `src/main/registry/menu-tree.js` and `tests/unit/menu-tree.test.js`: their only production caller is `gen-register-bat.js`, and plugin ordering moves into `entries.js`.
- `README.md` and `CLAUDE.md`: Install / Build / Commands / registry-layout / "Adding a plugin" sections, and exit code 5.

## 7. Error handling

| Situation | Result |
|---|---|
| Sync fails during a menu click | Logged; the plugin runs normally |
| `reg.exe` hangs during a menu click | The process exits after the 5 s cap; logged |
| Several processes from one multi-selection | Only the aggregator leader syncs; followers exit as today |
| Registry editing disabled by group policy | `reg import` fails. The installer shows the error box; the status window says Windows refused to change the registry and points to the log, which holds `reg.exe`'s raw message. No workaround. |
| Written values differ when read back | `ok: false`, exit 5, each mismatch logged |
| Installer's `--register` returns non-zero | Error box (auto-OK in `/S` mode), installer exit code 5, files stay installed |

## 8. Testing

Test-first, as with the flatten plugins. `vitest.config.js` gets a 100% threshold for `src/main/shell-menu/**`.

**Unit (pure):**

- `entries.js` — exact keys/values for a set of manifests: sorting, `%V` quoting, `Icon` suffix, an exe path with spaces and Cyrillic. The layout assertions of `gen-register-bat.test.js` move here.
- `reg-file.js` — serialise → parse round trip; escaping of `\` and `"`; default value `@`; `=-` and `[-key]`; UTF-16LE BOM; parsing a sample exported by the real `reg.exe`.
- `reg.js` with a fake `runReg`:
  - the exact `reg export` / `reg import` arguments;
  - the temp file is deleted after success and after failure;
  - a non-zero export returns an empty map plus `error`;
  - a non-zero import throws with the exit code and stderr.
- `sync.js` diff with an in-memory fake registry: missing value, wrong command path, unexpected `SubCommands`, stale plugin key, legacy key present, already in sync (no import call), still wrong after import (`ok: false` + `remaining`).
- `cli.js` — `--register`, `--unregister`, no args, conflicting flags.
- `dispatcher` — sync starts only when packaged and leader; a rejected sync does not change the plugin's exit code; exit waits at most 5 s; the no-args, register and unregister paths map to exit 0 / 5 / 4.

**Integration (real `reg.exe`, Windows only)** in `HKEY_CURRENT_USER\Software\ContextHelperTest\<random>`, deleted after each test:

- register → export → matches the desired state;
- exe path containing Cyrillic and spaces survives the round trip (guards the encoding decision in §4.1);
- tamper (change a command, delete a plugin key, add a stale key, add `SubCommands`) → `syncMenu` repairs → second sync reports no changes;
- `unregisterMenu` → every owned key is gone.

**Installer verification on the developer PC.** Windows Home has no Sandbox, so this changes the real Explorer menu; the user is asked before step 2.

1. Build, confirm the installer exists and lists the expected files (`7z l`).
2. `ContextHelper-Setup-<v>.exe /S` → install folder and Start-menu shortcut exist; `diagnose.ps1` shows the registry pointing at the installed exe, every file present, and the direct launch showing a window.
3. Run the same Setup again (update path) → menu keys still present.
4. Uninstall with `/S` → every ContextHelper key is gone.
5. Install again so the user ends with a working installation.

Then the user runs the installer on the second PC. If the menu still does nothing there, `diagnose.ps1` narrows it down (most likely Smart App Control / SmartScreen, which needs code signing).

## 9. Files

| File | Change |
|---|---|
| `src/main/shell-menu/entries.js` | new |
| `src/main/shell-menu/reg-file.js` | new |
| `src/main/shell-menu/reg.js` | new |
| `src/main/shell-menu/sync.js` | new |
| `src/main/cli.js` | `--register`, `--unregister` |
| `src/main/dispatcher.js` | background sync, no-args status, register/unregister modes, exit code 5 |
| `src/main/index.js` | wires `app.isPackaged`, `process.execPath`, shell window for status |
| `build/installer.nsh` | new |
| `electron-builder.yml` | NSIS target and options; drop gen-register extraResource |
| `package.json` | `package` script; drop `gen-register` |
| `vitest.config.js` | 100% threshold for `src/main/shell-menu/**` |
| `.gitignore` | blockmap, builder-effective-config |
| `tests/unit/shell-menu-*.test.js`, `tests/unit/cli.test.js`, `tests/unit/dispatcher.test.js` | new / extended |
| `scripts/gen-register-bat.js`, `tests/unit/gen-register-bat.test.js`, `src/main/registry/menu-tree.js`, `tests/unit/menu-tree.test.js`, `register.bat`, `unregister.bat` (root and dist) | removed |
| `README.md`, `CLAUDE.md` | updated |
| `dist/win-unpacked/`, `dist/ContextHelper-Setup-<version>.exe` | rebuilt / new |
