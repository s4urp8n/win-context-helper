# Installer + self-managed Explorer menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a one-click per-user NSIS installer whose app registers, verifies and repairs its own Explorer menu entries, replacing `register.bat`.

**Architecture:** A new `src/main/shell-menu/` module computes the desired HKCU keys from plugin manifests (`entries.js`), talks to the registry only through `reg export` / `reg import` with UTF-16 `.reg` files (`reg-file.js`, `reg.js`), and diffs, applies and re-verifies (`sync.js`). The dispatcher gains `--register`, `--unregister`, a no-args status window and a background sync on every menu click. electron-builder builds an NSIS installer whose hooks call `--register` and delete the keys on uninstall.

**Tech Stack:** Node (CommonJS), Electron 33, electron-builder 25.1.8 (NSIS), Vitest 2 + @vitest/coverage-v8, Windows `reg.exe`.

**Spec:** `docs/superpowers/specs/2026-09-15-installer-design.md`

## Global Constraints

- CommonJS, 2-space indent, LF, English UI strings. Vitest `globals: true`: tests do not `require('vitest')`.
- No new runtime dependencies. Registry access only via `reg.exe` (`export` / `import`); console output is never parsed for data.
- HKCU only: `HKEY_CURRENT_USER\Software\Classes`. The key layout is exactly spec §3.
- `--register`, `--unregister`, the no-args status and the background sync run only when `app.isPackaged`; otherwise `--register`/`--unregister` exit 4 and the others skip the menu.
- Exit code 5 = the menu could not be written or verified.
- Background sync on a menu click: only the aggregator leader; awaited at most 5000 ms; its failure never changes the plugin's exit code.
- `vitest.config.js` enforces 100% coverage for `src/main/shell-menu/**`.
- Do not commit: the user commits. Each task ends with a green-tests checkpoint instead.

---

### Task 1: `.reg` file format (`reg-file.js`)

**Files:**
- Create: `src/main/shell-menu/reg-file.js`
- Test: `tests/unit/shell-menu-reg-file.test.js`

**Interfaces:**
- Produces:
  - `serialize({ sets?: Map<key, Map<name, data>>, deleteValues?: Map<key, name[]>, deleteKeys?: key[] }) → string`. `''` is the default value; an empty value Map just creates the key. Key deletions come first, then one section per key (value deletions before sets).
  - `parse(text) → Map<key, Map<name, data>>`.
  - `encode(text) → Buffer` (UTF-16LE with BOM).
  - `decode(buffer) → string` (BOM stripped).

- [ ] **Step 1: Write the failing test** — `tests/unit/shell-menu-reg-file.test.js`

```js
const { serialize, parse, encode, decode } = require('../../src/main/shell-menu/reg-file');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));
const regText = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines].join('\r\n');

describe('reg-file serialize', () => {
  it('writes the default value as @ and escapes backslashes and quotes', () => {
    const sets = new Map([[String.raw`HKEY_CURRENT_USER\T\shell\p\command`, new Map([
      ['', String.raw`"C:\Program Files\ContextHelper.exe" --action=p "%V"`],
      ['MUIVerb', 'Flatten folder'],
    ])]]);
    expect(serialize({ sets })).toBe(regText(
      String.raw`[HKEY_CURRENT_USER\T\shell\p\command]`,
      String.raw`@="\"C:\\Program Files\\ContextHelper.exe\" --action=p \"%V\""`,
      '"MUIVerb"="Flatten folder"',
      '',
    ));
  });

  it('writes key deletions first, then value deletions and empty keys', () => {
    const text = serialize({
      deleteKeys: [String.raw`HKEY_CURRENT_USER\T\stale`],
      deleteValues: new Map([[String.raw`HKEY_CURRENT_USER\T\entry`, ['SubCommands']]]),
      sets: new Map([[String.raw`HKEY_CURRENT_USER\T\empty`, new Map()]]),
    });
    expect(text).toBe(regText(
      String.raw`[-HKEY_CURRENT_USER\T\stale]`,
      '',
      String.raw`[HKEY_CURRENT_USER\T\entry]`,
      '"SubCommands"=-',
      '',
      String.raw`[HKEY_CURRENT_USER\T\empty]`,
      '',
    ));
  });
});

describe('reg-file parse', () => {
  it('reads a file exported by reg.exe', () => {
    const exported = regText(
      String.raw`[HKEY_CURRENT_USER\T\Directory\ContextHelperRoot]`,
      '',
      String.raw`[HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command]`,
      String.raw`@="\"C:\\Users\\Иван Петров\\ContextHelper.exe\" --action=flatten-folder \"%V\""`,
      '"MultiSelectModel"="Player"',
      '',
    );
    expect(toObject(parse(exported))).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command`]: {
        '': String.raw`"C:\Users\Иван Петров\ContextHelper.exe" --action=flatten-folder "%V"`,
        MultiSelectModel: 'Player',
      },
    });
  });

  it('keeps non-string values as written, joins wrapped lines and ignores stray lines', () => {
    const text = regText(
      '"Orphan"="no key yet"',
      String.raw`[HKEY_CURRENT_USER\T\k]`,
      '"Flag"=dword:00000001',
      '"Bin"=hex:01,02,\\',
      '  03,04',
      'garbage',
      '',
    );
    expect(toObject(parse(text))).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\k`]: { Flag: 'dword:00000001', Bin: 'hex:01,02,03,04' },
    });
  });

  it('parses back what serialize writes, including quotes and backslashes', () => {
    const sets = new Map([[String.raw`HKEY_CURRENT_USER\T\k`, new Map([
      ['we"ird\\name', String.raw`a"b\c\\d`],
      ['', ''],
    ])]]);
    expect(toObject(parse(serialize({ sets })))).toEqual(toObject(sets));
  });
});

describe('reg-file encoding', () => {
  it('encodes as UTF-16LE with a byte order mark', () => {
    expect([...encode('Ж')]).toEqual([0xff, 0xfe, 0x16, 0x04]);
  });

  it('decode strips the byte order mark', () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x16, 0x04]))).toBe('Ж');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/shell-menu-reg-file.test.js`
Expected: FAIL — `Cannot find module '../../src/main/shell-menu/reg-file'`.

- [ ] **Step 3: Implement** — `src/main/shell-menu/reg-file.js`

```js
// Reads and writes the .reg format used by `reg export` / `reg import`.
const HEADER = 'Windows Registry Editor Version 5.00';
const BOM = Buffer.from([0xff, 0xfe]);

const SECTION = /^\[(.+)\]$/;
const VALUE = /^(@|"((?:[^"\\]|\\.)*)")=(.*)$/;
const STRING = /^"((?:[^"\\]|\\.)*)"$/;

const escape = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unescape = (text) => text.replace(/\\(.)/g, '$1');
const nameToken = (name) => (name === '' ? '@' : `"${escape(name)}"`);

// sets: Map<key, Map<valueName, data>> ('' is the default value; an empty Map only creates the key).
function serialize({ sets = new Map(), deleteValues = new Map(), deleteKeys = [] }) {
  const lines = [HEADER, ''];
  for (const key of deleteKeys) lines.push(`[-${key}]`, '');
  for (const key of new Set([...deleteValues.keys(), ...sets.keys()])) {
    lines.push(`[${key}]`);
    for (const name of deleteValues.get(key) || []) lines.push(`${nameToken(name)}=-`);
    for (const [name, data] of sets.get(key) || []) lines.push(`${nameToken(name)}="${escape(data)}"`);
    lines.push('');
  }
  return lines.join('\r\n');
}

// String data is unescaped; other types (dword:, hex:) are kept as written so they never match a string.
function parse(text) {
  const tree = new Map();
  let values = null;
  // Binary values wrap with a trailing backslash; join them back into one line.
  for (const raw of text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const section = SECTION.exec(line);
    if (section) {
      values = new Map();
      tree.set(section[1], values);
      continue;
    }
    const value = values && VALUE.exec(line);
    if (!value) continue;
    const string = STRING.exec(value[3]);
    values.set(value[1] === '@' ? '' : unescape(value[2]), string ? unescape(string[1]) : value[3]);
  }
  return tree;
}

const encode = (text) => Buffer.concat([BOM, Buffer.from(text, 'utf16le')]);
const decode = (buffer) => buffer.toString('utf16le').replace(/^\uFEFF/, '');

module.exports = { serialize, parse, encode, decode };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/shell-menu-reg-file.test.js`
Expected: 7 passed.

---

### Task 2: Desired registry state (`entries.js`)

**Files:**
- Create: `src/main/shell-menu/entries.js`
- Test: `tests/unit/shell-menu-entries.test.js`

**Interfaces:**
- Produces:
  - `CLASSES_ROOT = 'HKEY_CURRENT_USER\\Software\\Classes'`.
  - `desiredState({ exePath, manifests: {id,label}[], root = CLASSES_ROOT }) → Map<key, Map<name, data>>`.
  - `ownedRoots(root = CLASSES_ROOT) → key[]`: the three entry points plus `Directory\ContextHelperRoot`.
  - `legacyKeys(root = CLASSES_ROOT) → key[]`: `Directory\ContextHelperFolders`, `Directory\ContextHelperFiles`.

- [ ] **Step 1: Write the failing test** — `tests/unit/shell-menu-entries.test.js`

```js
const { desiredState, ownedRoots, legacyKeys } = require('../../src/main/shell-menu/entries');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));

describe('shell-menu entries', () => {
  const exePath = String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe`;

  it('describes the entry points, the menu root and one item per plugin', () => {
    const state = desiredState({
      exePath,
      root: String.raw`HKEY_CURRENT_USER\T`,
      manifests: [{ id: 'merge-pdf', label: 'Merge PDF' }, { id: 'flatten-folder', label: 'Flatten folder' }],
    });
    const entry = {
      MUIVerb: 'ContextHelper',
      Icon: String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe,0`,
      ExtendedSubCommandsKey: String.raw`Directory\ContextHelperRoot`,
    };
    expect(toObject(state)).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\Directory\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\*\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\Directory\Background\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder`]: { MUIVerb: 'Flatten folder', MultiSelectModel: 'Player' },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command`]: {
        '': String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=flatten-folder "%V"`,
      },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\merge-pdf`]: { MUIVerb: 'Merge PDF', MultiSelectModel: 'Player' },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\merge-pdf\command`]: {
        '': String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=merge-pdf "%V"`,
      },
    });
  });

  it('targets the current user classes root by default', () => {
    expect([...desiredState({ exePath, manifests: [] }).keys()][0])
      .toBe(String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`);
  });

  it('lists the keys it owns and the legacy keys it removes', () => {
    expect(ownedRoots()).toEqual([
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\*\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperRoot`,
    ]);
    expect(legacyKeys()).toEqual([
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperFolders`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperFiles`,
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/shell-menu-entries.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/main/shell-menu/entries.js`

```js
// The Explorer menu ContextHelper registers, as registry keys and REG_SZ values.
const CLASSES_ROOT = 'HKEY_CURRENT_USER\\Software\\Classes';
const MENU_ROOT = 'Directory\\ContextHelperRoot';
const ENTRY_POINTS = [
  'Directory\\shell\\ContextHelper',
  '*\\shell\\ContextHelper',
  'Directory\\Background\\shell\\ContextHelper',
];
const LEGACY_KEYS = ['Directory\\ContextHelperFolders', 'Directory\\ContextHelperFiles'];

function desiredState({ exePath, manifests, root = CLASSES_ROOT }) {
  const key = (relative) => `${root}\\${relative}`;
  const state = new Map();
  for (const entry of ENTRY_POINTS) {
    state.set(key(entry), new Map([
      ['MUIVerb', 'ContextHelper'],
      ['Icon', `${exePath},0`],
      ['ExtendedSubCommandsKey', MENU_ROOT],
    ]));
  }
  state.set(key(MENU_ROOT), new Map());
  state.set(key(`${MENU_ROOT}\\shell`), new Map());
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    state.set(key(`${MENU_ROOT}\\shell\\${m.id}`), new Map([['MUIVerb', m.label], ['MultiSelectModel', 'Player']]));
    state.set(key(`${MENU_ROOT}\\shell\\${m.id}\\command`), new Map([['', `"${exePath}" --action=${m.id} "%V"`]]));
  }
  return state;
}

// Keys whose whole subtree ContextHelper owns: anything inside that is not desired gets removed.
const ownedRoots = (root = CLASSES_ROOT) => [...ENTRY_POINTS, MENU_ROOT].map((k) => `${root}\\${k}`);
const legacyKeys = (root = CLASSES_ROOT) => LEGACY_KEYS.map((k) => `${root}\\${k}`);

module.exports = { CLASSES_ROOT, desiredState, ownedRoots, legacyKeys };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/shell-menu-entries.test.js`
Expected: 3 passed.

---

### Task 3: `reg.exe` wrapper (`reg.js`)

**Files:**
- Create: `src/main/shell-menu/reg.js`
- Test: `tests/unit/shell-menu-reg.test.js`

**Interfaces:**
- Consumes: `encode`, `decode`, `parse` (Task 1).
- Produces:
  - `createRunner(exe = 'reg.exe') → (args) → Promise<{ code, stdout, stderr }>`. A spawn failure gives code `-1`.
  - `createReg({ runReg = createRunner() } = {}) → { exportKey(key) → Promise<{ tree: Map, error: string|null }>, importFile(text) → Promise<void> }`. `importFile` throws an `Error` carrying `exitCode` and `stderr`.

- [ ] **Step 1: Write the failing test** — `tests/unit/shell-menu-reg.test.js`

```js
const fs = require('node:fs');
const { createReg, createRunner } = require('../../src/main/shell-menu/reg');
const { encode } = require('../../src/main/shell-menu/reg-file');

describe('shell-menu reg', () => {
  it('exportKey runs reg export into a temp file, parses it and deletes the file', async () => {
    const calls = [];
    const reg = createReg({
      runReg: async (args) => {
        calls.push(args);
        fs.writeFileSync(args[2], encode('Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\T\\k]\r\n"MUIVerb"="Flatten folder"\r\n'));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const { tree, error } = await reg.exportKey('HKEY_CURRENT_USER\\T\\k');
    expect(error).toBeNull();
    expect(Object.fromEntries(tree.get('HKEY_CURRENT_USER\\T\\k'))).toEqual({ MUIVerb: 'Flatten folder' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('export');
    expect(calls[0][1]).toBe('HKEY_CURRENT_USER\\T\\k');
    expect(calls[0][2]).toMatch(/\.reg$/);
    expect(calls[0][3]).toBe('/y');
    expect(fs.existsSync(calls[0][2])).toBe(false);
  });

  it('exportKey returns an empty tree with the reg.exe message when export fails', async () => {
    const reg = createReg({ runReg: async () => ({ code: 1, stdout: '', stderr: 'ERROR: not found\r\n' }) });
    const { tree, error } = await reg.exportKey('HKEY_CURRENT_USER\\T\\missing');
    expect(tree.size).toBe(0);
    expect(error).toBe('ERROR: not found');
  });

  it('exportKey reports the exit code when reg.exe prints nothing', async () => {
    const reg = createReg({ runReg: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect((await reg.exportKey('HKEY_CURRENT_USER\\T\\missing')).error).toBe('reg export exited 1');
  });

  it('importFile writes UTF-16 text to a temp file, runs reg import and deletes the file', async () => {
    let seen = null;
    const reg = createReg({
      runReg: async (args) => {
        seen = { args, bytes: fs.readFileSync(args[1]) };
        return { code: 0, stdout: '', stderr: 'The operation completed successfully.' };
      },
    });
    await reg.importFile('Windows Registry Editor Version 5.00\r\n');
    expect(seen.args[0]).toBe('import');
    expect(seen.args).toHaveLength(2);
    expect([...seen.bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x57, 0x00]);
    expect(fs.existsSync(seen.args[1])).toBe(false);
  });

  it('importFile throws with the exit code and stderr, and still deletes the file', async () => {
    let file = null;
    const reg = createReg({
      runReg: async (args) => { file = args[1]; return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' }; },
    });
    await expect(reg.importFile('x')).rejects.toMatchObject({ exitCode: 1, stderr: 'ERROR: Access is denied.' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('createRunner reports an executable that cannot start as code -1', async () => {
    const result = await createRunner('contexthelper-no-such-reg.exe')(['query']);
    expect(result.code).toBe(-1);
    expect(result.stderr).toMatch(/ENOENT/);
  });

  it.runIf(process.platform === 'win32')('createRunner returns the exit code of the real reg.exe', async () => {
    const result = await createRunner()(['query', 'HKCU\\Software\\ContextHelperDefinitelyMissingKey']);
    expect(result.code).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/shell-menu-reg.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/main/shell-menu/reg.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encode, decode, parse } = require('./reg-file');

let tempCounter = 0;
const tempRegFile = () => path.join(os.tmpdir(), `contexthelper-${process.pid}-${Date.now()}-${tempCounter++}.reg`);

function createRunner(exe = 'reg.exe') {
  return (args) => new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(exe, args, { windowsHide: true });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // A promise settles once, so whichever of 'error' / 'close' comes first wins.
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: `${err.code}: ${err.message}` }));
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('latin1'),
      stderr: Buffer.concat(stderr).toString('latin1'),
    }));
  });
}

// reg.exe prints to the console in the OEM code page, which garbles non-ASCII paths,
// so data is always read from the UTF-16 file written by `reg export`. stderr is only for the log.
function createReg({ runReg = createRunner() } = {}) {
  async function exportKey(key) {
    const file = tempRegFile();
    try {
      const result = await runReg(['export', key, file, '/y']);
      if (result.code !== 0) return { tree: new Map(), error: result.stderr.trim() || `reg export exited ${result.code}` };
      return { tree: parse(decode(fs.readFileSync(file))), error: null };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  async function importFile(text) {
    const file = tempRegFile();
    fs.writeFileSync(file, encode(text));
    try {
      const result = await runReg(['import', file]);
      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        throw Object.assign(new Error(`reg import exited ${result.code}: ${stderr}`), { exitCode: result.code, stderr });
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  return { exportKey, importFile };
}

module.exports = { createReg, createRunner };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/shell-menu-reg.test.js`
Expected: 7 passed.

---

### Task 4: Diff, repair and verify (`sync.js`)

**Files:**
- Create: `src/main/shell-menu/sync.js`
- Test: `tests/unit/shell-menu-sync.test.js`

**Interfaces:**
- Consumes: `desiredState`, `ownedRoots`, `legacyKeys`, `CLASSES_ROOT` (Task 2); `serialize` (Task 1); a `reg` object shaped like Task 3's.
- Produces:
  - `syncMenu({ exePath, manifests, reg, root = CLASSES_ROOT }) → Promise<{ ok, changes, lines, remaining, remainingLines, error, exportErrors }>`. `changes` / `remaining` are `{ kind: 'set'|'createKey'|'deleteValue'|'deleteKey', key, name?, data?, actual? }[]`; `lines` / `remainingLines` are human-readable strings; `error` is the import error message or `null`. It never throws for `reg` failures.
  - `unregisterMenu({ reg, root = CLASSES_ROOT }) → Promise<{ ok, remaining: key[], error }>`.

- [ ] **Step 1: Write the failing test** — `tests/unit/shell-menu-sync.test.js`

```js
const { syncMenu, unregisterMenu } = require('../../src/main/shell-menu/sync');

const ROOT = String.raw`HKEY_CURRENT_USER\T`;
const EXE = String.raw`C:\Apps\ContextHelper\ContextHelper.exe`;
const MANIFESTS = [{ id: 'flatten-folder', label: 'Flatten folder' }];
const k = (relative) => `${ROOT}\\${relative}`;
const regText = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines].join('\r\n');
const tree = (object) => new Map(Object.entries(object).map(([key, values]) => [key, new Map(Object.entries(values))]));

function registered(exe = EXE) {
  const entry = { MUIVerb: 'ContextHelper', Icon: `${exe},0`, ExtendedSubCommandsKey: String.raw`Directory\ContextHelperRoot` };
  return {
    [k(String.raw`Directory\shell\ContextHelper`)]: entry,
    [k(String.raw`*\shell\ContextHelper`)]: entry,
    [k(String.raw`Directory\Background\shell\ContextHelper`)]: entry,
    [k(String.raw`Directory\ContextHelperRoot`)]: {},
    [k(String.raw`Directory\ContextHelperRoot\shell`)]: {},
    [k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder`)]: { MUIVerb: 'Flatten folder', MultiSelectModel: 'Player' },
    [k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder\command`)]: { '': `"${exe}" --action=flatten-folder "%V"` },
  };
}

// Serves `before` until the first import, then `after`; records every imported .reg text.
function scriptedReg(before, after = before) {
  const imports = [];
  const exported = [];
  let state = before;
  return {
    imports,
    exported,
    async exportKey(key) {
      exported.push(key);
      const prefix = key.toLowerCase();
      const found = new Map([...state].filter(([name]) => name.toLowerCase() === prefix || name.toLowerCase().startsWith(`${prefix}\\`)));
      return { tree: found, error: found.size ? null : `missing ${key}` };
    },
    async importFile(text) {
      imports.push(text);
      state = after;
    },
  };
}

const sync = (reg, options = {}) => syncMenu({ exePath: EXE, manifests: MANIFESTS, reg, root: ROOT, ...options });

describe('syncMenu', () => {
  it('does not write anything when the registry already matches', async () => {
    const reg = scriptedReg(tree(registered()));
    const result = await sync(reg);
    expect(result).toMatchObject({ ok: true, changes: [], lines: [], remaining: [], remainingLines: [], error: null });
    expect(reg.imports).toEqual([]);
  });

  it('compares key and value names case-insensitively', async () => {
    const upper = Object.fromEntries(Object.entries(registered()).map(([key, values]) => [
      key.toUpperCase(),
      Object.fromEntries(Object.entries(values).map(([name, data]) => [name.toUpperCase(), data])),
    ]));
    const reg = scriptedReg(tree(upper));
    expect((await sync(reg)).ok).toBe(true);
    expect(reg.imports).toEqual([]);
  });

  it('registers the whole menu in one import on an empty registry', async () => {
    const reg = scriptedReg(new Map(), tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Added Directory\shell\ContextHelper`,
      String.raw`Added *\shell\ContextHelper`,
      String.raw`Added Directory\Background\shell\ContextHelper`,
      String.raw`Added Directory\ContextHelperRoot`,
      String.raw`Added Directory\ContextHelperRoot\shell`,
      'Added menu item "Flatten folder"',
    ]);
    const entry = [
      '"MUIVerb"="ContextHelper"',
      String.raw`"Icon"="C:\\Apps\\ContextHelper\\ContextHelper.exe,0"`,
      String.raw`"ExtendedSubCommandsKey"="Directory\\ContextHelperRoot"`,
      '',
    ];
    expect(reg.imports).toEqual([regText(
      `[${k(String.raw`Directory\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`*\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`Directory\Background\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`Directory\ContextHelperRoot`)}]`, '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell`)}]`, '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder`)}]`, '"MUIVerb"="Flatten folder"', '"MultiSelectModel"="Player"', '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder\command`)}]`,
      String.raw`@="\"C:\\Apps\\ContextHelper\\ContextHelper.exe\" --action=flatten-folder \"%V\""`, '',
    )]);
  });

  it('rewrites only the values that point at the old program location', async () => {
    const reg = scriptedReg(tree(registered(String.raw`C:\Old\ContextHelper.exe`)), tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Fixed Directory\shell\ContextHelper`,
      String.raw`Fixed *\shell\ContextHelper`,
      String.raw`Fixed Directory\Background\shell\ContextHelper`,
      'Fixed menu item "Flatten folder"',
    ]);
    expect(reg.imports[0]).toContain(String.raw`@="\"C:\\Apps\\ContextHelper\\ContextHelper.exe\" --action=flatten-folder \"%V\""`);
    expect(reg.imports[0]).not.toContain('MultiSelectModel');
  });

  it('removes unexpected values, stale plugins and legacy keys', async () => {
    const entryKey = k(String.raw`Directory\shell\ContextHelper`);
    const before = tree({
      ...registered(),
      [entryKey]: { ...registered()[entryKey], SubCommands: '' },
      [k(String.raw`Directory\ContextHelperRoot\shell\old-plugin`)]: { MUIVerb: 'Old' },
      [k(String.raw`Directory\ContextHelperRoot\shell\old-plugin\command`)]: { '': 'old' },
      [k(String.raw`Directory\ContextHelperFolders`)]: {},
      [k(String.raw`Directory\ContextHelperFolders\shell`)]: {},
    });
    const reg = scriptedReg(before, tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Fixed Directory\shell\ContextHelper`,
      'Removed stale menu item "old-plugin"',
      String.raw`Removed Directory\ContextHelperFolders`,
    ]);
    expect(reg.imports).toEqual([regText(
      `[-${k(String.raw`Directory\ContextHelperRoot\shell\old-plugin`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFolders`)}]`, '',
      `[${entryKey}]`, '"SubCommands"=-', '',
    )]);
  });

  it('reports what still differs when the written values do not stick', async () => {
    const reg = scriptedReg(new Map());
    const result = await sync(reg);
    expect(result.ok).toBe(false);
    expect(result.error).toBeNull();
    expect(result.remainingLines).toContain('Added menu item "Flatten folder"');
    expect(result.exportErrors).toContain(`missing ${k(String.raw`Directory\ContextHelperFolders`)}`);
  });

  it('returns the import error instead of throwing', async () => {
    const reg = {
      exportKey: async () => ({ tree: new Map(), error: 'missing' }),
      importFile: async () => { throw new Error('reg import exited 1: ERROR: Access is denied.'); },
    };
    const result = await sync(reg);
    expect(result).toMatchObject({ ok: false, error: 'reg import exited 1: ERROR: Access is denied.' });
    expect(result.remaining).toHaveLength(result.changes.length);
    expect(result.remainingLines).toContain('Added menu item "Flatten folder"');
  });

  it('reads the real menu location when no root is given', async () => {
    const reg = scriptedReg(new Map());
    await syncMenu({ exePath: EXE, manifests: MANIFESTS, reg });
    expect(reg.exported[0]).toBe(String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`);
  });
});

describe('unregisterMenu', () => {
  it('deletes every owned and legacy key in one import', async () => {
    const reg = scriptedReg(tree(registered()), new Map());
    expect(await unregisterMenu({ reg, root: ROOT })).toEqual({ ok: true, remaining: [], error: null });
    expect(reg.imports).toEqual([regText(
      `[-${k(String.raw`Directory\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`*\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`Directory\Background\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperRoot`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFolders`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFiles`)}]`, '',
    )]);
  });

  it('lists the outermost keys that survived', async () => {
    const result = await unregisterMenu({ reg: scriptedReg(tree(registered())), root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([
      k(String.raw`Directory\shell\ContextHelper`),
      k(String.raw`*\shell\ContextHelper`),
      k(String.raw`Directory\Background\shell\ContextHelper`),
      k(String.raw`Directory\ContextHelperRoot`),
    ]);
  });

  it('returns the import error instead of throwing', async () => {
    const reg = { exportKey: async () => ({ tree: new Map(), error: null }), importFile: async () => { throw new Error('denied'); } };
    expect(await unregisterMenu({ reg, root: ROOT })).toMatchObject({ ok: false, error: 'denied' });
  });

  it('deletes the real menu location when no root is given', async () => {
    const reg = scriptedReg(new Map());
    await unregisterMenu({ reg });
    expect(reg.imports[0]).toContain(String.raw`[-HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperRoot]`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/shell-menu-sync.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/main/shell-menu/sync.js`

```js
const { CLASSES_ROOT, desiredState, ownedRoots, legacyKeys } = require('./entries');
const { serialize } = require('./reg-file');

const PLUGIN_KEY = /^Directory\\ContextHelperRoot\\shell\\([^\\]+)/i;
const lower = (text) => text.toLowerCase();

// Deleting a key removes its subtree, so only keys without a deleted ancestor matter.
const outermostKeys = (keys) => keys.filter((key) => !keys.some((other) => lower(key).startsWith(`${lower(other)}\\`)));

async function readState(reg, root) {
  const actual = new Map();
  const exportErrors = [];
  for (const key of [...ownedRoots(root), ...legacyKeys(root)]) {
    const { tree, error } = await reg.exportKey(key);
    if (error) exportErrors.push(error);
    for (const [name, values] of tree) actual.set(name, values);
  }
  return { actual, exportErrors };
}

// Registry key and value names are case-insensitive.
function diff(desired, actual) {
  const have = new Map();
  for (const [key, values] of actual) {
    have.set(lower(key), { key, values: new Map([...values].map(([name, data]) => [lower(name), { name, data }])) });
  }
  const changes = [];
  for (const [key, values] of desired) {
    const current = have.get(lower(key));
    if (!current && values.size === 0) changes.push({ kind: 'createKey', key });
    for (const [name, data] of values) {
      const found = current && current.values.get(lower(name));
      if (!found || found.data !== data) changes.push({ kind: 'set', key, name, data, actual: found ? found.data : null });
    }
    if (!current) continue;
    const wanted = new Set([...values.keys()].map(lower));
    for (const { name, data } of current.values.values()) {
      if (!wanted.has(lower(name))) changes.push({ kind: 'deleteValue', key, name, actual: data });
    }
  }
  const desiredKeys = new Set([...desired.keys()].map(lower));
  for (const { key } of have.values()) {
    if (!desiredKeys.has(lower(key))) changes.push({ kind: 'deleteKey', key });
  }
  return changes;
}

function toRegFile(changes) {
  const sets = new Map();
  const deleteValues = new Map();
  const deleteKeys = [];
  const bucket = (map, key, make) => map.get(key) || map.set(key, make()).get(key);
  for (const change of changes) {
    if (change.kind === 'deleteKey') deleteKeys.push(change.key);
    else if (change.kind === 'deleteValue') bucket(deleteValues, change.key, () => []).push(change.name);
    else {
      const values = bucket(sets, change.key, () => new Map());
      if (change.kind === 'set') values.set(change.name, change.data);
    }
  }
  return serialize({ sets, deleteValues, deleteKeys: outermostKeys(deleteKeys) });
}

// One line per plugin or per key, e.g. `Added menu item "Flatten folder"`.
function summarize(changes, root, labels) {
  const deleted = outermostKeys(changes.filter((c) => c.kind === 'deleteKey').map((c) => c.key));
  const groups = new Map();
  for (const change of changes) {
    if (change.kind === 'deleteKey' && !deleted.includes(change.key)) continue;
    const relative = change.key.slice(root.length + 1);
    const plugin = PLUGIN_KEY.exec(relative);
    const id = plugin ? `plugin:${lower(plugin[1])}` : `key:${lower(relative)}`;
    if (!groups.has(id)) groups.set(id, { pluginId: plugin && plugin[1], relative, changes: [] });
    groups.get(id).changes.push(change);
  }
  return [...groups.values()].map(({ pluginId, relative, changes: group }) => {
    const added = group.every((c) => (c.kind === 'set' || c.kind === 'createKey') && c.actual == null);
    if (pluginId) {
      const label = labels.get(lower(pluginId));
      if (!label) return `Removed stale menu item "${pluginId}"`;
      return `${added ? 'Added' : 'Fixed'} menu item "${label}"`;
    }
    if (group.some((c) => c.kind === 'deleteKey')) return `Removed ${relative}`;
    return `${added ? 'Added' : 'Fixed'} ${relative}`;
  });
}

async function syncMenu({ exePath, manifests, reg, root = CLASSES_ROOT }) {
  const desired = desiredState({ exePath, manifests, root });
  const labels = new Map(manifests.map((m) => [lower(m.id), m.label]));
  const before = await readState(reg, root);
  const changes = diff(desired, before.actual);
  const lines = summarize(changes, root, labels);
  if (changes.length === 0) {
    return { ok: true, changes, lines, remaining: [], remainingLines: [], error: null, exportErrors: [] };
  }
  try {
    await reg.importFile(toRegFile(changes));
  } catch (err) {
    return { ok: false, changes, lines, remaining: changes, remainingLines: lines, error: err.message, exportErrors: before.exportErrors };
  }
  const after = await readState(reg, root);
  const remaining = diff(desired, after.actual);
  return {
    ok: remaining.length === 0,
    changes,
    lines,
    remaining,
    remainingLines: summarize(remaining, root, labels),
    error: null,
    exportErrors: after.exportErrors,
  };
}

async function unregisterMenu({ reg, root = CLASSES_ROOT }) {
  const keys = [...ownedRoots(root), ...legacyKeys(root)];
  try {
    await reg.importFile(serialize({ deleteKeys: keys }));
  } catch (err) {
    return { ok: false, remaining: keys, error: err.message };
  }
  const { actual } = await readState(reg, root);
  const remaining = outermostKeys([...actual.keys()]);
  return { ok: remaining.length === 0, remaining, error: null };
}

module.exports = { syncMenu, unregisterMenu };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/shell-menu-sync.test.js`
Expected: 12 passed.

---

### Task 5: Status window text (`status-view.js`)

**Files:**
- Create: `src/main/shell-menu/status-view.js`
- Test: `tests/unit/shell-menu-status-view.test.js`

**Interfaces:**
- Consumes: the `syncMenu` result shape (Task 4).
- Produces: `describeMenuStatus(result, { exePath, itemCount, logDir }) → { state: 'info'|'error', message, detail }`. This is the `shell:set-state` payload.

- [ ] **Step 1: Write the failing test** — `tests/unit/shell-menu-status-view.test.js`

```js
const { describeMenuStatus } = require('../../src/main/shell-menu/status-view');

const context = {
  exePath: String.raw`C:\Apps\ContextHelper.exe`,
  itemCount: 12,
  logDir: String.raw`C:\Users\u\AppData\Local\ContextHelper\logs`,
};

describe('describeMenuStatus', () => {
  it('confirms a menu that is already registered', () => {
    expect(describeMenuStatus({ ok: true, changes: [], lines: [] }, context)).toEqual({
      state: 'info',
      message: 'Explorer menu is registered',
      detail: ['12 menu items are in place.', String.raw`Program: C:\Apps\ContextHelper.exe`].join('\n'),
    });
  });

  it('lists what was repaired', () => {
    const result = { ok: true, changes: [{ kind: 'set' }], lines: ['Added menu item "Flatten folder (keep order)"'] };
    expect(describeMenuStatus(result, context)).toEqual({
      state: 'info',
      message: 'Explorer menu repaired',
      detail: ['Added menu item "Flatten folder (keep order)"', '', String.raw`Program: C:\Apps\ContextHelper.exe`].join('\n'),
    });
  });

  it('explains a registry that could not be written and points to the log', () => {
    const result = { ok: false, error: 'reg import exited 1', remainingLines: ['Added menu item "Merge PDF"'] };
    expect(describeMenuStatus(result, context)).toEqual({
      state: 'error',
      message: 'Could not register the Explorer menu',
      detail: [
        'The registry could not be updated. Pending changes:',
        'Added menu item "Merge PDF"',
        '',
        String.raw`Details are in the log: C:\Users\u\AppData\Local\ContextHelper\logs`,
      ].join('\n'),
    });
  });

  it('explains entries that still differ after writing', () => {
    const result = { ok: false, error: null, remainingLines: ['Fixed menu item "Merge PDF"'] };
    expect(describeMenuStatus(result, context).detail.split('\n')[0]).toBe('Some entries still differ after writing them:');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/shell-menu-status-view.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/main/shell-menu/status-view.js`

```js
// Text of the window opened from the Start-menu shortcut, built from a syncMenu result.
function describeMenuStatus(result, { exePath, itemCount, logDir }) {
  const program = `Program: ${exePath}`;
  if (result.ok && result.changes.length === 0) {
    return { state: 'info', message: 'Explorer menu is registered', detail: [`${itemCount} menu items are in place.`, program].join('\n') };
  }
  if (result.ok) {
    return { state: 'info', message: 'Explorer menu repaired', detail: [...result.lines, '', program].join('\n') };
  }
  const reason = result.error
    ? 'The registry could not be updated. Pending changes:'
    : 'Some entries still differ after writing them:';
  return {
    state: 'error',
    message: 'Could not register the Explorer menu',
    detail: [reason, ...result.remainingLines, '', `Details are in the log: ${logDir}`].join('\n'),
  };
}

module.exports = { describeMenuStatus };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/shell-menu-status-view.test.js`
Expected: 4 passed.

---

### Task 6: Real `reg.exe` integration + coverage gate

**Files:**
- Test: `tests/unit/shell-menu-integration.test.js`
- Modify: `vitest.config.js`

**Interfaces:**
- Consumes: `createReg` (Task 3), `syncMenu` / `unregisterMenu` (Task 4), `desiredState` (Task 2).

- [ ] **Step 1: Write the test** — `tests/unit/shell-menu-integration.test.js`

```js
const { spawnSync } = require('node:child_process');
const { createReg } = require('../../src/main/shell-menu/reg');
const { syncMenu, unregisterMenu } = require('../../src/main/shell-menu/sync');
const { desiredState } = require('../../src/main/shell-menu/entries');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));
const TEST_PARENT = 'HKCU\\Software\\ContextHelperTest';

describe.runIf(process.platform === 'win32')('shell menu against the real reg.exe', () => {
  const exePath = String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe`;
  const manifests = [{ id: 'flatten-folder', label: 'Flatten folder' }, { id: 'merge-pdf', label: 'Merge PDF' }];
  const reg = createReg();
  let root;

  const readAll = async () => {
    const all = new Map();
    for (const key of [String.raw`Directory\shell\ContextHelper`, String.raw`*\shell\ContextHelper`, String.raw`Directory\Background\shell\ContextHelper`, String.raw`Directory\ContextHelperRoot`, String.raw`Directory\ContextHelperFolders`]) {
      for (const [name, values] of (await reg.exportKey(`${root}\\${key}`)).tree) all.set(name, values);
    }
    return all;
  };

  beforeEach(() => {
    root = `HKEY_CURRENT_USER\\Software\\ContextHelperTest\\${process.pid}-${Date.now()}`;
  });
  afterAll(() => {
    spawnSync('reg.exe', ['delete', TEST_PARENT, '/f'], { windowsHide: true });
  });

  it('registers the menu and reads back exactly what was written, Cyrillic path included', async () => {
    const result = await syncMenu({ exePath, manifests, reg, root });
    expect(result.ok).toBe(true);
    expect(toObject(await readAll())).toEqual(toObject(desiredState({ exePath, manifests, root })));
    const command = (await reg.exportKey(`${root}\\Directory\\ContextHelperRoot\\shell\\merge-pdf\\command`)).tree;
    expect(command.get(`${root}\\Directory\\ContextHelperRoot\\shell\\merge-pdf\\command`).get(''))
      .toBe(String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=merge-pdf "%V"`);
    expect((await syncMenu({ exePath, manifests, reg, root })).changes).toEqual([]);
  }, 30000);

  it('repairs a tampered menu', async () => {
    await syncMenu({ exePath, manifests, reg, root });
    await reg.importFile([
      'Windows Registry Editor Version 5.00', '',
      `[${root}\\Directory\\ContextHelperRoot\\shell\\flatten-folder\\command]`, '@="old.exe"', '',
      `[-${root}\\Directory\\ContextHelperRoot\\shell\\merge-pdf]`, '',
      `[${root}\\Directory\\ContextHelperRoot\\shell\\old-plugin\\command]`, '@="old.exe"', '',
      `[${root}\\Directory\\shell\\ContextHelper]`, '"SubCommands"=""', '',
      `[${root}\\Directory\\ContextHelperFolders\\shell]`, '',
    ].join('\r\n'));

    const result = await syncMenu({ exePath, manifests, reg, root });
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(expect.arrayContaining([
      'Fixed menu item "Flatten folder"',
      'Added menu item "Merge PDF"',
      'Removed stale menu item "old-plugin"',
      String.raw`Fixed Directory\shell\ContextHelper`,
      String.raw`Removed Directory\ContextHelperFolders`,
    ]));
    expect((await syncMenu({ exePath, manifests, reg, root })).changes).toEqual([]);
  }, 30000);

  it('unregisters every key', async () => {
    await syncMenu({ exePath, manifests, reg, root });
    expect(await unregisterMenu({ reg, root })).toEqual({ ok: true, remaining: [], error: null });
    expect((await readAll()).size).toBe(0);
  }, 30000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/unit/shell-menu-integration.test.js`
Expected: 3 passed. If a test fails, the unit-tested modules disagree with real `reg.exe` behaviour. Fix the module and add a unit test for the discovered behaviour.

- [ ] **Step 3: Add the coverage gate** — `vitest.config.js`, `thresholds`:

```js
      thresholds: {
        'plugins/flatten-folder/**': FULL,
        'plugins/flatten-folder-keep-order/**': FULL,
        'src/main/shell-menu/**': FULL,
      },
```

- [ ] **Step 4: Verify coverage**

Run: `npm run test:coverage`
Expected: all tests pass, no `ERROR: Coverage for … does not meet "src/main/shell-menu/**"` lines.

---

### Task 7: CLI modes (`cli.js`)

**Files:**
- Modify: `src/main/cli.js`
- Test: `tests/unit/cli.test.js`

**Interfaces:**
- Produces: `parseCli(['--register']) → { kind: 'register' }`, `parseCli(['--unregister']) → { kind: 'unregister' }`. Combining either with other arguments throws.

- [ ] **Step 1: Add failing tests** — append to the `describe('parseCli')` block in `tests/unit/cli.test.js`

```js
  it('parses --register and --unregister', () => {
    expect(parseCli(['--register'])).toEqual({ kind: 'register' });
    expect(parseCli(['--unregister'])).toEqual({ kind: 'unregister' });
  });

  it('rejects --register or --unregister combined with other arguments', () => {
    expect(() => parseCli(['--register', '--action=x'])).toThrow(/--register cannot be combined/);
    expect(() => parseCli(['--action=x', 'C:\\A', '--unregister'])).toThrow(/--unregister cannot be combined/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/cli.test.js`
Expected: 2 failed (`flag "--register" missing "=value"`).

- [ ] **Step 3: Implement** — in `src/main/cli.js`, first statement inside `for (const arg of argv) {`:

```js
    if (arg === '--register' || arg === '--unregister') {
      if (argv.length !== 1) throw new Error(`parseCli: ${arg} cannot be combined with other arguments`);
      return { kind: arg.slice(2) };
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/cli.test.js`
Expected: 11 passed.

---

### Task 8: Dispatcher modes + Electron wiring

**Files:**
- Modify: `src/main/dispatcher.js`, `src/main/index.js`, `src/main/runners/window-runner.js` (export `makeShellController`)
- Test: `tests/unit/dispatcher.test.js`

**Interfaces:**
- Consumes (new dispatcher deps):
  - `isPackaged: boolean`;
  - `syncShellMenu({ manifests }) → Promise<syncMenu result>`;
  - `unregisterShellMenu() → Promise<unregisterMenu result>`;
  - `showMenuStatus(result, { itemCount }) → Promise<void>`;
  - optional `menuSyncTimeoutMs` (default 5000).
- Produces: exit codes per Global Constraints.

- [ ] **Step 1: Add failing tests** — append to `tests/unit/dispatcher.test.js`

```js
describe('dispatch and the Explorer menu', () => {
  const inSync = { ok: true, changes: [], lines: [], remaining: [], remainingLines: [], error: null, exportErrors: [] };
  const failed = { ok: false, changes: [], lines: [], remaining: [{}], remainingLines: ['x'], error: 'denied', exportErrors: [] };
  const P_MANIFEST = { id: 'p', label: 'P', accepts: ['folders'], ui: 'dialog', minSelection: 1, maxSelection: 999 };
  const recordingLogger = () => ({ infos: [], errors: [], info(m) { this.infos.push(m); }, error(m) { this.errors.push(m); } });

  describe('menu click', () => {
    it('syncs the menu with the loaded plugin manifests in the packaged app', async () => {
      const calls = [];
      const code = await dispatch({ argv: [] }, makeDeps({ isPackaged: true, syncShellMenu: async (arg) => { calls.push(arg); return inSync; } }));
      expect(code).toBe(0);
      expect(calls).toEqual([{ manifests: [P_MANIFEST] }]);
    });

    it('leaves the menu alone in a dev run', async () => {
      let called = false;
      await dispatch({ argv: [] }, makeDeps({ isPackaged: false, syncShellMenu: async () => { called = true; return inSync; } }));
      expect(called).toBe(false);
    });

    it('does not sync from an aggregator follower', async () => {
      let called = false;
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        aggregateTargets: async () => ({ role: 'follower', targets: [] }),
        syncShellMenu: async () => { called = true; return inSync; },
      }));
      expect(code).toBe(0);
      expect(called).toBe(false);
    });

    it('keeps the plugin exit code when the sync throws, and logs it', async () => {
      const logger = recordingLogger();
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        logger,
        createRunner: () => ({ execute: async () => 1 }),
        syncShellMenu: async () => { throw new Error('reg.exe missing'); },
      }));
      expect(code).toBe(1);
      expect(logger.errors).toContain('shell-menu: failed');
    });

    it('logs in-sync, repaired and failed results', async () => {
      for (const [result, bucket, message] of [
        [inSync, 'infos', 'shell-menu: in sync'],
        [{ ...inSync, changes: [{}], lines: ['Added menu item "P"'] }, 'infos', 'shell-menu: repaired'],
        [failed, 'errors', 'shell-menu: failed'],
      ]) {
        const logger = recordingLogger();
        await dispatch({ argv: [] }, makeDeps({ isPackaged: true, logger, syncShellMenu: async () => result }));
        expect(logger[bucket]).toContain(message);
      }
    });

    it('waits for a running sync before returning', async () => {
      const order = [];
      await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        createRunner: () => ({ execute: async () => { order.push('plugin'); return 0; } }),
        syncShellMenu: () => new Promise((resolve) => setTimeout(() => { order.push('sync'); resolve(inSync); }, 30)),
      }));
      order.push('returned');
      expect(order).toEqual(['plugin', 'sync', 'returned']);
    });

    it('stops waiting for a hung sync after the timeout', async () => {
      const code = await dispatch({ argv: [] }, makeDeps({
        isPackaged: true,
        menuSyncTimeoutMs: 20,
        syncShellMenu: () => new Promise(() => {}),
      }));
      expect(code).toBe(0);
    });
  });

  describe('no arguments (Start menu)', () => {
    const none = { parseCli: () => ({ kind: 'none' }) };

    it('shows the menu status and returns 0 when the menu is fine', async () => {
      const shown = [];
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none, isPackaged: true, syncShellMenu: async () => inSync,
        showMenuStatus: async (result, info) => { shown.push({ result, info }); },
      }));
      expect(code).toBe(0);
      expect(shown).toEqual([{ result: inSync, info: { itemCount: 1 } }]);
    });

    it('returns 5 when the menu cannot be registered', async () => {
      let shownResult = null;
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none, isPackaged: true, syncShellMenu: async () => failed,
        showMenuStatus: async (result) => { shownResult = result; },
      }));
      expect(code).toBe(5);
      expect(shownResult).toBe(failed);
    });

    it('reports a plugin load failure as a failed registration', async () => {
      let shownResult = null;
      const code = await dispatch({ argv: [] }, makeDeps({
        ...none, isPackaged: true, loadAll: () => { throw new Error('boom'); },
        showMenuStatus: async (result) => { shownResult = result; },
      }));
      expect(code).toBe(5);
      expect(shownResult).toMatchObject({ ok: false, error: 'boom' });
    });

    it('exits 0 without a window in a dev run', async () => {
      let shown = false;
      const code = await dispatch({ argv: [] }, makeDeps({ ...none, isPackaged: false, showMenuStatus: async () => { shown = true; } }));
      expect(code).toBe(0);
      expect(shown).toBe(false);
    });
  });

  describe('--register and --unregister', () => {
    const register = { parseCli: () => ({ kind: 'register' }) };
    const unregister = { parseCli: () => ({ kind: 'unregister' }) };

    it('return 4 outside the packaged app', async () => {
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: false }))).toBe(4);
      expect(await dispatch({ argv: [] }, makeDeps({ ...unregister, isPackaged: false }))).toBe(4);
    });

    it('--register returns 0 when the menu is in place and 5 when it is not', async () => {
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: true, syncShellMenu: async () => inSync }))).toBe(0);
      expect(await dispatch({ argv: [] }, makeDeps({ ...register, isPackaged: true, syncShellMenu: async () => failed }))).toBe(5);
    });

    it('--unregister returns 0 when every key is gone and 5 otherwise', async () => {
      const deps = (unregisterShellMenu) => makeDeps({ ...unregister, isPackaged: true, unregisterShellMenu });
      expect(await dispatch({ argv: [] }, deps(async () => ({ ok: true, remaining: [], error: null })))).toBe(0);
      expect(await dispatch({ argv: [] }, deps(async () => ({ ok: false, remaining: ['k'], error: null })))).toBe(5);
      expect(await dispatch({ argv: [] }, deps(async () => { throw new Error('boom'); }))).toBe(5);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/dispatcher.test.js`
Expected: the new tests fail (sync never called, exit codes 0 / undefined). The 10 existing tests still pass.

- [ ] **Step 3: Implement** — replace `src/main/dispatcher.js` with:

```js
const { binDir } = require('./utils/bin-paths');

const MENU_SYNC_TIMEOUT_MS = 5000;

function waitAtMost(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never throws: a failure becomes an ok:false result so callers only map it to an exit code.
async function checkShellMenu(deps, plugins) {
  const { logger } = deps;
  try {
    const manifests = [...(plugins || deps.loadAll(deps.pluginsDir)).values()].map((p) => p.manifest);
    const result = await deps.syncShellMenu({ manifests });
    if (!result.ok) {
      logger.error('shell-menu: failed', { error: result.error, remaining: result.remainingLines, exportErrors: result.exportErrors });
    } else if (result.changes.length > 0) {
      logger.info('shell-menu: repaired', { lines: result.lines });
    } else {
      logger.info('shell-menu: in sync');
    }
    return { result, itemCount: manifests.length };
  } catch (err) {
    logger.error('shell-menu: failed', { error: err.message });
    const result = { ok: false, changes: [], lines: [], remaining: [], remainingLines: [], error: err.message, exportErrors: [] };
    return { result, itemCount: 0 };
  }
}

async function runStatusMode(deps) {
  if (!deps.isPackaged) {
    deps.logger.info('dispatch: no CLI args; the menu check runs only in the packaged build');
    return 0;
  }
  const { result, itemCount } = await checkShellMenu(deps);
  await deps.showMenuStatus(result, { itemCount });
  return result.ok ? 0 : 5;
}

async function runRegisterMode(deps) {
  if (!deps.isPackaged) {
    deps.logger.error('dispatch: --register works only in the packaged build');
    return 4;
  }
  const { result } = await checkShellMenu(deps);
  return result.ok ? 0 : 5;
}

async function runUnregisterMode(deps) {
  const { logger } = deps;
  if (!deps.isPackaged) {
    logger.error('dispatch: --unregister works only in the packaged build');
    return 4;
  }
  try {
    const result = await deps.unregisterShellMenu();
    if (result.ok) logger.info('shell-menu: unregistered');
    else logger.error('shell-menu: unregister failed', { error: result.error, remaining: result.remaining });
    return result.ok ? 0 : 5;
  } catch (err) {
    logger.error('shell-menu: unregister failed', { error: err.message });
    return 5;
  }
}

async function runSelection(cli, plugin, targets, deps) {
  const { classify, validate, createRunner, dialog, fs, logger } = deps;
  const selection = classify(targets, fs);

  const v = validate(plugin.manifest, selection);
  if (!v.ok) {
    logger.error('dispatch: validation rejected', { action: cli.action, reason: v.reason });
    dialog.showErrorBox(plugin.manifest.label || 'ContextHelper', v.body);
    return 2;
  }
  const effectiveTargets = v.effectiveTargets || targets;
  const enrichedSelection = { ...selection, skipped: v.skipped || [] };

  let instance;
  try {
    instance = new plugin.Cls();
  } catch (err) {
    logger.error('dispatch: plugin instantiation failed', { plugin: cli.action, message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin "${cli.action}" failed to instantiate: ${err.message}`);
    return 4;
  }

  const runner = createRunner(plugin.manifest.ui, deps);
  try {
    return await runner.execute({
      manifest: plugin.manifest,
      plugin: instance,
      pluginDir: plugin.dir,
      targets: effectiveTargets,
      selection: enrichedSelection,
      binDir: binDir(),
    });
  } catch (err) {
    logger.error('dispatch: runner crashed', { plugin: cli.action, message: err.message, stack: err.stack });
    dialog.showErrorBox('ContextHelper', `Internal error: ${err.message}`);
    return 3;
  }
}

async function runPluginMode(cli, deps) {
  const { loadAll, aggregateTargets, dialog, logger } = deps;

  let plugins;
  try {
    plugins = loadAll(deps.pluginsDir);
  } catch (err) {
    logger.error('dispatch: plugin load failed', { message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin load failed: ${err.message}`);
    return 4;
  }

  const plugin = plugins.get(cli.action);
  if (!plugin) {
    logger.error('dispatch: unknown action', { action: cli.action });
    dialog.showErrorBox('ContextHelper', `Unknown action: ${cli.action}`);
    return 4;
  }

  let targets = cli.targets;
  if (targets.length === 1) {
    const pipeName = `contexthelper-${cli.action}-${process.env.USERNAME || 'user'}`;
    try {
      const agg = await aggregateTargets({ pipeName, myTarget: targets[0], waitMs: 250 });
      if (agg.role === 'follower') { logger.info('dispatch: follower exiting'); return 0; }
      targets = agg.targets;
    } catch (err) {
      logger.error('dispatch: aggregator failed', { message: err.message });
    }
  }

  // Only the leader gets here, so one multi-selection triggers one background check.
  const menuCheck = deps.isPackaged ? checkShellMenu(deps, plugins) : null;
  try {
    return await runSelection(cli, plugin, targets, deps);
  } finally {
    if (menuCheck) await waitAtMost(menuCheck, deps.menuSyncTimeoutMs || MENU_SYNC_TIMEOUT_MS);
  }
}

async function dispatch({ argv }, deps) {
  const cli = deps.parseCli(argv);
  if (cli.kind === 'none') return runStatusMode(deps);
  if (cli.kind === 'register') return runRegisterMode(deps);
  if (cli.kind === 'unregister') return runUnregisterMode(deps);
  if (cli.kind !== 'run') { deps.logger.error('dispatch: unknown CLI mode', { cli }); return 4; }
  return runPluginMode(cli, deps);
}

module.exports = { dispatch };
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/dispatcher.test.js`
Expected: all tests pass (10 existing + 14 new).

- [ ] **Step 5: Export the shell controller** — `src/main/runners/window-runner.js`, last line:

```js
module.exports = { runWindowPlugin, readUiHtmlFromDisk, makeShellController };
```

- [ ] **Step 6: Wire Electron** — `src/main/index.js`
  - Replace the window-runner require with: `const { runWindowPlugin, readUiHtmlFromDisk, makeShellController } = require('./runners/window-runner');`
  - Add after the other requires:

```js
const { createReg } = require('./shell-menu/reg');
const { syncMenu, unregisterMenu } = require('./shell-menu/sync');
const { describeMenuStatus } = require('./shell-menu/status-view');
```

  - Add before `async function main()`:

```js
async function showMenuStatus(result, { itemCount }) {
  const shellWindow = createShellWindow();
  const shell = makeShellController({ shellWindow, ipcMain });
  await new Promise((resolve) => shell.onReady(resolve));
  shell.sendState(describeMenuStatus(result, { exePath: process.execPath, itemCount, logDir: logger.LOG_ROOT }));
  await shell.waitForAction();
  shell.close();
}
```

  - Extend the `dispatch` deps object:

```js
    isPackaged: app.isPackaged,
    syncShellMenu: ({ manifests }) => syncMenu({ exePath: process.execPath, manifests, reg: createReg() }),
    unregisterShellMenu: () => unregisterMenu({ reg: createReg() }),
    showMenuStatus,
```

- [ ] **Step 7: Full suite**

Run: `npm test && npm run smoke`
Expected: all green.

---

### Task 9: Installer config, remove the `.bat` pipeline, docs

**Files:**
- Create: `build/installer.nsh`
- Modify: `electron-builder.yml`, `package.json`, `.gitignore`, `README.md`, `CLAUDE.md`
- Delete: `scripts/gen-register-bat.js`, `tests/unit/gen-register-bat.test.js`, `src/main/registry/menu-tree.js`, `tests/unit/menu-tree.test.js`, `register.bat`, `unregister.bat`

- [ ] **Step 1: `build/installer.nsh`**

```nsis
; electron-builder NSIS hooks. The app registers its own Explorer menu (--register);
; uninstall removes the keys directly so it works even if the exe is damaged.

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

- [ ] **Step 2: `electron-builder.yml`** (full file)

```yaml
appId: dev.contexthelper.app
productName: ContextHelper
directories:
  output: dist
files:
  - "src/**/*"
  - "plugins/**/*"
  - "package.json"
extraResources:
  - from: plugins
    to: plugins
  - from: resources/bin
    to: bin
    filter:
      - '**/*'
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

- [ ] **Step 3: `package.json` scripts** — remove `gen-register`; set `"package": "electron-builder --win"`.

- [ ] **Step 4: `.gitignore`** — add after `dist/builder-debug.yml`:

```
dist/*.blockmap
dist/builder-effective-config.yaml
```

- [ ] **Step 5: Delete the old pipeline**

```bash
rm scripts/gen-register-bat.js tests/unit/gen-register-bat.test.js src/main/registry/menu-tree.js tests/unit/menu-tree.test.js register.bat unregister.bat
```

Run: `npm test`
Expected: all green; no test references the deleted files.

- [ ] **Step 6: README** — replace these sections.

`## Install`:

```markdown
## Install

Run `dist/ContextHelper-Setup-<version>.exe` (a Git LFS file — download it from GitHub or clone with `git lfs install` first). It installs for the current user into `%LOCALAPPDATA%\Programs\context-helper` without admin rights, registers the Explorer menu and adds a **ContextHelper** shortcut to the Start menu. The installer is not code-signed, so SmartScreen may ask for confirmation (**More info → Run anyway**).

Open **ContextHelper** from the Start menu to check the menu: it repairs missing or outdated entries and shows what it changed. Every menu click also re-checks the registration in the background.

Uninstall from **Settings → Apps → ContextHelper**. Running a newer Setup updates the app in place.

**Portable use:** copy `dist/win-unpacked` anywhere and run `ContextHelper.exe --register` there; `ContextHelper.exe --unregister` removes the menu.
```

`## Build`:

````markdown
## Build

```
npm run package                   # electron-builder → dist/win-unpacked/ + dist/ContextHelper-Setup-<version>.exe
```

Bump `version` in `package.json` before building a release — the installer file name follows it.

> **`npm run package` caveat:** (keep the existing winCodeSign paragraph unchanged)
````

- Development exit codes line: append `· `5` the Explorer menu could not be registered or verified`.
- Architecture block:
  - replace the `src/main/registry/` line with `src/main/registry/             plugin-loader (manifest checks)`;
  - replace the `scripts/gen-register-bat.js` line with `src/main/shell-menu/           writes, verifies and repairs the Explorer menu in HKCU via reg.exe` and `build/installer.nsh            NSIS hooks: --register after install, key cleanup on uninstall`.
- Adding a plugin, step 5: `5. Add tests/unit/<id>.test.js, run npm test, then npm run package; installing the new Setup (or running ContextHelper.exe --register) adds the menu item.`

- [ ] **Step 7: CLAUDE.md**
  - **Commands table:** delete the `gen-register` row. The `package` row becomes `electron-builder → dist/win-unpacked/ + dist/ContextHelper-Setup-<version>.exe (NSIS, per-user).` Add the row `npm run test:coverage` | `Vitest with coverage; flatten plugins and src/main/shell-menu must stay at 100%.`
  - **Registry-layout bullet:** replace `See scripts/gen-register-bat.js.` with `The app owns these keys: src/main/shell-menu/ (entries → desired state, sync → diff/repair/verify via reg export/import). ContextHelper.exe --register / --unregister; every packaged menu click re-syncs in the background.`
  - **Adding a new plugin section:** replace with:

```markdown
## Adding a new plugin

1. `mkdir plugins/<id>` and create `plugin.js` exporting `class extends BasePlugin` with `static get manifest()` (`id`, `label`, `description`, `accepts`, `minSelection`, `maxSelection`, `ui`), `preflight()` and `run()`.
2. Optional `ui.html` (window mode) — form values keyed by `name` become `options`.
3. Add `tests/unit/<id>.test.js`; run `npm test`.
4. `npm run package`, then install the new Setup (or run `ContextHelper.exe --register`) to add the menu item.
```

  - **PR checklist:** replace the gen-register item with `- [ ] If you changed manifests: npm run package and install the Setup (or --register) to check the menu in Explorer.`

---

### Task 10: Build and verify the installer

**Files:** `dist/win-unpacked/`, `dist/ContextHelper-Setup-0.1.0.exe`

- [ ] **Step 1: Full verification before building**

Run: `npm run test:coverage && npm run smoke`
Expected: green, no threshold errors.

- [ ] **Step 2: Build**

Run: `npm run package`
Expected: exit 0; `dist/ContextHelper-Setup-0.1.0.exe` exists; `dist/win-unpacked/ContextHelper.exe` exists.

- [ ] **Step 3: Inspect the installer payload**

Run: `resources/bin/7z.exe l dist/ContextHelper-Setup-0.1.0.exe`
Expected: the archive lists an app package (`$PLUGINSDIR/app-64.7z`). `resources/bin/7z.exe l` on that inner archive, extracted to the scratchpad, lists `ContextHelper.exe`, `resources/app.asar`, `resources/bin/ffmpeg.exe` and the other bundled tools.

- [ ] **Step 4: Ask the user before touching the live menu.** Continue only after an explicit yes.

- [ ] **Step 5: Install silently and check**

Run: `dist/ContextHelper-Setup-0.1.0.exe /S` (wait for exit), then `powershell -ExecutionPolicy Bypass -File <scratchpad>/diag/diagnose.ps1 -Dist "$env:LOCALAPPDATA\Programs\context-helper"`. electron-builder names the per-user install folder after `name` in `package.json`, not `productName`.

Expected:
- the registered exe is `%LOCALAPPDATA%\Programs\context-helper\ContextHelper.exe`, 12 plugins;
- `Checked … 0 missing, 0 binary files with wrong size` (the manifest is regenerated from the new `dist/win-unpacked` first);
- the direct launch shows a window;
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\ContextHelper.lnk` exists;
- the log has `shell-menu:` lines.

- [ ] **Step 6: Update path** — run the same Setup `/S` again. Expected: registry keys still present afterwards (diagnose section 2).

- [ ] **Step 7: Uninstall** — run `"%LOCALAPPDATA%\Programs\context-helper\Uninstall ContextHelper.exe" /S`. Expected: every ContextHelper key under `HKCU\Software\Classes` is gone.

- [ ] **Step 8: Final install** — run Setup `/S` once more so the user keeps a working installation. Report the results; the user commits and pushes.
