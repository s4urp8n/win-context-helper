# Plan 3c — archive-each (7z, dialog)

> **Status:** ✅ Tasks 1–2 implementation complete (2026-05-20). 183/183 unit tests + package + register installed. Awaiting user to drop `7z.exe` + `7z.dll` into `resources/bin/` and run the Explorer matrix.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the `archive-each` plugin from spec §4.3 — for each selected folder/file, create a `.7z` archive next to it using bundled `7z.exe`. Dialog-mode (default 7z max compression, no user options). First binary-backed plugin: validates the spawnTool + binDir flow shipped in Plan 3a.

**Architecture:** `class ArchiveEach extends BasePlugin`. `preflight` walks each selected item (folder = recursive size sum, file = stat size), returns `{ items: [{ basename, isFolder, sizeBytes }], totalItems, totalBytes }`. `run` iterates items, calling `spawnTool({ exe: path.join(ctx.binDir, '7z.exe'), args: ['a', '-t7z', '-mx=9', outputPath, sourcePath] })`. Progress parsed from 7z stdout (lines like `42% - Compressing ...`). The plugin's constructor accepts an optional `{ spawnTool }` override for tests (default falls back to `require('../../src/shared/spawn').spawnTool`).

**Tech Stack:** Node 20+, CJS, Vitest globals. Uses spawnTool from `src/shared/spawn.js` and binDir from `ctx.binDir`.

**Reference spec:** `docs/superpowers/specs/2026-05-20-plan-3-design.md` §4.3. Plan 3a infrastructure required ✅.

**Binary requirement:** User must place `7z.exe` and `7z.dll` in `C:\YandexDisk\Software\bin\ContextHelper\resources\bin\` BEFORE running the plugin in Explorer. Tests use mocked spawnTool so they pass without the binary.

---

## File map

```
ContextHelper/
├── plugins/
│   └── archive-each/
│       ├── plugin.js                       # NEW (Task 1)
│       └── icon.png                        # NEW (Task 1, copied)
└── tests/unit/
    └── archive-each.test.js                # NEW (Task 1)
```

No `ui.html` — dialog mode has no form.

---

## Task 1: `archive-each` plugin

**Files:**
- Create: `plugins/archive-each/plugin.js`
- Copy: `plugins/archive-each/icon.png` (from `plugins/flatten-folder/icon.png`)
- Create: `tests/unit/archive-each.test.js`

### Step 1: Create `tests/unit/archive-each.test.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ArchiveEach = require('../../plugins/archive-each/plugin');

function tree(root, layout) {
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe('ArchiveEach', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-archive-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ArchiveEach.manifest;
    expect(m).toMatchObject({
      id: 'archive-each',
      label: 'Archive each',
      accepts: ['folders', 'files'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    });
  });

  it('preflight returns per-item entries with size + isFolder flag', async () => {
    const folder = path.join(tmp, 'docs');
    fs.mkdirSync(folder);
    tree(folder, { 'a.txt': 'AAA', 'sub/b.txt': 'BBBBB' });
    const file = path.join(tmp, 'report.pdf');
    fs.writeFileSync(file, 'X'.repeat(100));

    const result = await new ArchiveEach().preflight({ targets: [folder, file] });
    expect(result.totalItems).toBe(2);
    const byName = Object.fromEntries(result.items.map((i) => [i.basename, i]));
    expect(byName['docs']).toMatchObject({ isFolder: true });
    expect(byName['docs'].sizeBytes).toBe(8); // 'AAA' + 'BBBBB'
    expect(byName['report.pdf']).toMatchObject({ isFolder: false, sizeBytes: 100 });
    expect(result.totalBytes).toBe(108);
  });

  it('preflight handles single-file target', async () => {
    const file = path.join(tmp, 'lonely.txt');
    fs.writeFileSync(file, 'x');
    const result = await new ArchiveEach().preflight({ targets: [file] });
    expect(result.totalItems).toBe(1);
    expect(result.items[0].isFolder).toBe(false);
    expect(result.items[0].sizeBytes).toBe(1);
  });

  it('preflight does not mutate the filesystem', async () => {
    const folder = path.join(tmp, 'a');
    fs.mkdirSync(folder);
    tree(folder, { 'x.txt': 'hi' });
    const before = fs.statSync(path.join(folder, 'x.txt')).mtimeMs;
    await new ArchiveEach().preflight({ targets: [folder] });
    expect(fs.statSync(path.join(folder, 'x.txt')).mtimeMs).toBe(before);
  });

  it('run calls spawnTool with 7z args per item and reports processed', async () => {
    const folder1 = path.join(tmp, 'A');
    const folder2 = path.join(tmp, 'B');
    fs.mkdirSync(folder1); fs.mkdirSync(folder2);
    fs.writeFileSync(path.join(folder1, 'x.txt'), 'x');
    fs.writeFileSync(path.join(folder2, 'y.txt'), 'y');

    const calls = [];
    const mockSpawn = async (args) => {
      calls.push(args);
      return { ok: true, stdout: '', stderr: '' };
    };
    const plugin = new ArchiveEach({ spawnTool: mockSpawn });
    const result = await plugin.run({
      targets: [folder1, folder2],
      binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].exe).toBe(path.join('/fake/bin', '7z.exe'));
    expect(calls[0].args).toEqual(['a', '-t7z', '-mx=9', path.join(tmp, 'A.7z'), folder1]);
    expect(calls[1].args[3]).toBe(path.join(tmp, 'B.7z'));
  });

  it('run resolves output collision with (N) suffix', async () => {
    const folder = path.join(tmp, 'X');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    // Pre-existing output file at the default name
    fs.writeFileSync(path.join(tmp, 'X.7z'), 'existing');

    const calls = [];
    const plugin = new ArchiveEach({
      spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; },
    });
    await plugin.run({ targets: [folder], binDir: '/fake/bin', onProgress: () => {} });
    expect(calls[0].args[3]).toBe(path.join(tmp, 'X (2).7z'));
  });

  it('run records errors when spawnTool throws and continues', async () => {
    const f1 = path.join(tmp, 'A'); fs.mkdirSync(f1);
    const f2 = path.join(tmp, 'B'); fs.mkdirSync(f2);
    let call = 0;
    const plugin = new ArchiveEach({
      spawnTool: async () => {
        call++;
        if (call === 1) throw new Error('7z exited 2: bad input');
        return { ok: true, stdout: '', stderr: '' };
      },
    });
    const result = await plugin.run({
      targets: [f1, f2],
      binDir: '/fake/bin',
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/7z exited 2/);
  });

  it('buildRunningLabel returns "Archiving…"', () => {
    expect(new ArchiveEach().buildRunningLabel({})).toBe('Archiving…');
  });

  it('buildConfirmMessage lists items and total size', () => {
    const p = new ArchiveEach();
    const pre = {
      items: [
        { basename: 'Photos', isFolder: true, sizeBytes: 1024 * 1024 * 10 },
        { basename: 'report.pdf', isFolder: false, sizeBytes: 1024 * 1024 * 2 },
      ],
      totalItems: 2,
      totalBytes: 1024 * 1024 * 12,
    };
    const out = p.buildConfirmMessage({}, pre);
    expect(out.message).toMatch(/Archive 2 items/);
    expect(out.detail).toMatch(/• Photos/);
    expect(out.detail).toMatch(/• report\.pdf/);
    expect(out.detail).toMatch(/12\.00 MB/);
  });
});
```

### Step 2: Run, expect fail

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test -- tests/unit/archive-each.test.js
```

### Step 3: Create `plugins/archive-each/plugin.js`

```js
const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function folderSizeRecursive(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  }
  return total;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function parse7zProgress(text) {
  // 7z prints lines like " 42% 12 + Compressing  file.txt"
  const m = /(\d+)%/.exec(text);
  if (m) return { percent: Number(m[1]) };
  return null;
}

class ArchiveEach extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'archive-each',
      label: 'Archive each',
      description: 'Create a .7z archive next to each selected item',
      icon: 'icon.png',
      accepts: ['folders', 'files'],
      minSelection: 1,
      maxSelection: 999,
      ui: 'dialog',
    };
  }

  async preflight({ targets }) {
    const items = [];
    let totalBytes = 0;
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      const isFolder = stat.isDirectory();
      const sizeBytes = isFolder ? folderSizeRecursive(t) : stat.size;
      items.push({ basename: path.basename(t), isFolder, sizeBytes, path: t });
      totalBytes += sizeBytes;
    }
    return { items, totalItems: items.length, totalBytes };
  }

  async run({ targets, binDir, onProgress = () => {}, signal }) {
    const exe = path.join(binDir, '7z.exe');
    let processed = 0;
    let skipped = 0;
    const errors = [];
    const total = targets.length;

    // Track taken output names per parent directory to handle collisions across siblings.
    const takenByParent = new Map();
    const reserveOutput = (sourcePath) => {
      const parent = path.dirname(sourcePath);
      const basename = path.basename(sourcePath);
      const defaultName = `${basename}.7z`;
      let taken = takenByParent.get(parent);
      if (!taken) {
        taken = new Set();
        // Seed with files already on disk
        try {
          for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
            if (e.isFile()) taken.add(e.name);
          }
        } catch {}
        takenByParent.set(parent, taken);
      }
      const chosen = resolveCollision(defaultName, taken);
      taken.add(chosen);
      return path.join(parent, chosen);
    };

    for (const source of targets) {
      if (signal && signal.aborted) {
        return { ok: false, processed, skipped, errors, aborted: true };
      }
      const outputPath = reserveOutput(source);
      try {
        await this._spawnTool({
          exe,
          args: ['a', '-t7z', '-mx=9', outputPath, source],
          parseProgress: (text) => parse7zProgress(text),
          onProgress: (p) => {
            // Per-item percent; report overall as items-done / total
            onProgress({ processed, total, itemPercent: p.percent, current: path.basename(source) });
          },
          signal,
        });
        processed++;
      } catch (err) {
        errors.push({ file: path.basename(source), message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }

    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalItems === 0); }

  buildNothingToDoBody(_ctx, _pre) {
    return { message: 'Nothing to archive.', detail: 'No items found in selection.' };
  }

  buildConfirmMessage(_ctx, pre) {
    const lines = [];
    for (const it of pre.items.slice(0, 10)) {
      lines.push(`  • ${it.basename}${it.isFolder ? '/' : ''}  (${formatBytes(it.sizeBytes)})`);
    }
    if (pre.items.length > 10) lines.push(`  … and ${pre.items.length - 10} more`);
    lines.push('');
    lines.push(`Total: ${formatBytes(pre.totalBytes)}. Output: <name>.7z next to each source.`);
    return {
      message: pre.totalItems === 1 ? 'Archive this item?' : `Archive ${pre.totalItems} items?`,
      detail: lines.join('\n'),
    };
  }

  buildRunningLabel(_ctx) { return 'Archiving…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'item', 'items')} archived.`,
      `${errors.length} ${plural(errors.length, 'item', 'items')} could not be archived:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ArchiveEach;
```

### Step 4: Run tests, expect 9 pass

```
npm test -- tests/unit/archive-each.test.js
```

### Step 5: Copy icon placeholder

```
copy "C:\YandexDisk\Software\bin\ContextHelper\plugins\flatten-folder\icon.png" "C:\YandexDisk\Software\bin\ContextHelper\plugins\archive-each\icon.png"
```

### Step 6: Run full suite, expect 183 (174 + 9 new)

```
npm test
```

### Step 7: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/archive-each/ ContextHelper/tests/unit/archive-each.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(plugins): add archive-each plugin (7z, dialog)

For each selected folder or file, creates <basename>.7z next to it
using 7z.exe with max compression (-mx=9). Dialog mode — no user
options. Preflight computes total size per item (recursive walk for
folders). Output collisions resolved with (N) suffix using shared
collision util. Constructor accepts optional { spawnTool } override
for test mocking; production uses the real spawnTool from
src/shared/spawn. First binary-backed plugin — exercises the binDir
threading and spawnTool pattern shipped in Plan 3a.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rebuild + register + finalize

**Files:** none beyond docs.

### Step 1: Regenerate register.bat

```
cd C:\YandexDisk\Software\bin\ContextHelper
node scripts/gen-register-bat.js
```

The script automatically picks up the new plugin. archive-each accepts both folders and files, so it appears under BOTH Folders and Files groups.

### Step 2: Rebuild dist

```
npm run package
```

### Step 3: Copy register.bat + unregister.bat to dist and re-install

```
Copy-Item register.bat,unregister.bat -Destination dist\win-unpacked\ -Force
Set-Location dist\win-unpacked
.\unregister.bat
.\register.bat
```

### Step 4: Manual verification matrix (USER must place 7z.exe + 7z.dll in resources/bin/ first)

| # | Action | Expected |
|---|---|---|
| 1 | `resources/bin/` has `7z.exe` + `7z.dll` | Required prerequisite. Without it, runtime spawn ENOENT. |
| 2 | Right-click 1 folder → ContextHelper → Folders → Archive each | Confirm dialog: "Archive this item?", folder name listed, total size. Continue → progress bar → `<name>.7z` appears next to source. |
| 3 | Right-click 3 folders → Archive each | Confirm: "Archive 3 items?", bullet list. Continue → 3 archives created, each `<basename>.7z` next to source. |
| 4 | Right-click a `.pdf` file → ContextHelper → Files → Archive each | Same flow, `report.pdf.7z` next to source. |
| 5 | Right-click mixed (folder + file) → Files OR Folders → Archive each | Both work — archive-each accepts both kinds. |
| 6 | Right-click folder with existing `<name>.7z` next to it → Archive each | Output becomes `<name> (2).7z`. |
| 7 | Cancel mid-archive (close window ✕) | Half-written `.7z` may remain — known limitation per spec §5.3. |

### Step 5: Mark Plan 3c complete

Edit top of this plan file:

```markdown
> **Status:** ✅ COMPLETE (YYYY-MM-DD). 2 tasks executed; 183/183 tests + manual matrix verified.
```

Update CLAUDE.md "Resume here" — 3c done, next is 3d (convert-image + images-to-pdf via magick.exe).

### Step 6: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/docs/superpowers/plans/2026-05-20-plan-3c-archive.md ContextHelper/CLAUDE.md ContextHelper/register.bat ContextHelper/unregister.bat
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
docs(ContextHelper): mark Plan 3c (archive-each) complete

archive-each shipped with 9 unit tests (mocked spawnTool), 183 total
tests green, register.bat regenerated to include the new plugin under
both Folders and Files groups. Plan 3d (image plugins via magick) is
next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- Spec §4.3: per-item `.7z` next to source, max compression, `(N)` collision → Task 1 ✓
- Spec §5.6 mandatory 8 tests + buildConfirmMessage test → Task 1 has 9 tests ✓
- Mock spawnTool via constructor DI (no vi.mock complexity for CJS) → Task 1 ✓
- Binary requirement documented → Task 2 Step 4 ✓
- No placeholders. Type consistency between preflight result shape (items[], totalItems, totalBytes) and consumer hooks ✓
