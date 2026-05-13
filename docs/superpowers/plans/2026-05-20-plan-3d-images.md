# Plan 3d — Image plugins (convert-image + images-to-pdf, magick)

> **Status:** ✅ Tasks 1–3 implementation complete (2026-05-20). 199/199 unit tests + package + register installed. Awaiting user to drop `magick.exe` into `resources/bin/` and run Explorer matrix.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended).

**Goal:** Add `convert-image` (per-file format conversion) and `images-to-pdf` (combine into single PDF) from spec §4.4–4.5. Both window-mode, both use bundled `magick.exe` from `resources/bin/`. Same spawnTool/DI pattern as 3c.

**Tech Stack:** Node 20+, CJS, Vitest globals. Uses spawnTool + binDir threading from 3a.

**Binary requirement:** User must place `magick.exe` (single-file ImageMagick build) in `resources/bin/` before runtime. Tests use mocked spawnTool.

**Reference spec:** `docs/superpowers/specs/2026-05-20-plan-3-design.md` §4.4, §4.5.

---

## File map

```
ContextHelper/plugins/
  convert-image/
    plugin.js                       # NEW (Task 1)
    ui.html                         # NEW (Task 1)
    icon.png                        # NEW (Task 1, copied)
  images-to-pdf/
    plugin.js                       # NEW (Task 2)
    ui.html                         # NEW (Task 2)
    icon.png                        # NEW (Task 2)

ContextHelper/tests/unit/
  convert-image.test.js             # NEW (Task 1)
  images-to-pdf.test.js             # NEW (Task 2)
```

---

## Task 1: convert-image

**Files:**
- Create: `plugins/convert-image/plugin.js`
- Create: `plugins/convert-image/ui.html`
- Copy: `plugins/convert-image/icon.png`
- Create: `tests/unit/convert-image.test.js`

### Step 1: Create `tests/unit/convert-image.test.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ConvertImage = require('../../plugins/convert-image/plugin');

describe('ConvertImage', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cvtimg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ConvertImage.manifest;
    expect(m).toMatchObject({
      id: 'convert-image',
      label: 'Convert image',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight returns per-file info', async () => {
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'X'.repeat(10));
    fs.writeFileSync(path.join(tmp, 'b.png'), 'Y'.repeat(20));
    const result = await new ConvertImage().preflight({ targets: [path.join(tmp, 'a.jpg'), path.join(tmp, 'b.png')] });
    expect(result.totalFiles).toBe(2);
    expect(result.byExt['.jpg']).toBe(1);
    expect(result.byExt['.png']).toBe(1);
    expect(result.files[0]).toHaveProperty('basename');
    expect(result.files[0]).toHaveProperty('sizeBytes');
  });

  it('preflight totalFiles 0 when no targets', async () => {
    const result = await new ConvertImage().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.jpg');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ConvertImage().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run builds magick args with quality for lossy target', async () => {
    const input = path.join(tmp, 'a.jpg');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertImage({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.jpg', quality: 85, deleteOriginal: false },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'magick.exe'));
    expect(calls[0].args).toEqual(['-monitor', input, '-quality', '85', path.join(tmp, 'a (2).jpg')]);
  });

  it('run omits -quality for lossless target', async () => {
    const input = path.join(tmp, 'a.jpg');
    fs.writeFileSync(input, 'X');
    const calls = [];
    const plugin = new ConvertImage({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [input], binDir: '/fake/bin',
      options: { format: '.png', deleteOriginal: false },
      onProgress: () => {},
    });
    expect(calls[0].args).not.toContain('-quality');
    expect(calls[0].args[calls[0].args.length - 1]).toBe(path.join(tmp, 'a.png'));
  });

  it('run records errors on spawn failure and continues', async () => {
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'X');
    fs.writeFileSync(path.join(tmp, 'b.jpg'), 'Y');
    let call = 0;
    const plugin = new ConvertImage({
      spawnTool: async () => { call++; if (call === 1) throw new Error('magick exited 1: bad format'); return { ok: true, stdout: '', stderr: '' }; },
    });
    const result = await plugin.run({
      targets: [path.join(tmp, 'a.jpg'), path.join(tmp, 'b.jpg')],
      binDir: '/fake/bin',
      options: { format: '.png' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.processed).toBe(1);
    expect(result.errors[0].message).toMatch(/magick exited 1/);
  });

  it('buildRunningLabel returns "Converting…"', () => {
    expect(new ConvertImage().buildRunningLabel({})).toBe('Converting…');
  });
});
```

### Step 2: Run, expect fail

```
cd C:\YandexDisk\Software\bin\ContextHelper && npm test -- tests/unit/convert-image.test.js
```

### Step 3: Create `plugins/convert-image/plugin.js`

```js
const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);
const LOSSY = new Set(['.jpg', '.jpeg', '.webp']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return name.slice(i).toLowerCase();
}

function parseMagickProgress(text) {
  // ImageMagick -monitor emits "load image: <path>" + "<n> of <m>" lines on stderr
  const m = /(\d+)\s+of\s+(\d+)/i.exec(text);
  if (m) return { processed: Number(m[1]), total: Number(m[2]) };
  return null;
}

class ConvertImage extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'convert-image',
      label: 'Convert image',
      description: 'Convert images to a chosen target format and quality',
      icon: 'icon.png',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets }) {
    const files = [];
    const byExt = {};
    let totalBytes = 0;
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      const basename = path.basename(t);
      const ext = extOf(basename);
      files.push({ basename, sizeBytes: stat.size, ext, path: t });
      totalBytes += stat.size;
      if (ext) byExt[ext] = (byExt[ext] || 0) + 1;
    }
    return { files, totalFiles: files.length, totalBytes, byExt };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const fmt = String(options.format || '.png').toLowerCase();
    const targetExt = fmt.startsWith('.') ? fmt : '.' + fmt;
    const quality = options.quality !== undefined ? Number(options.quality) : 90;
    const deleteOriginal = !!options.deleteOriginal;
    const exe = path.join(binDir, 'magick.exe');

    const takenByParent = new Map();
    const reserveOutput = (input) => {
      const parent = path.dirname(input);
      const baseNoExt = path.basename(input, path.extname(input));
      const defaultName = `${baseNoExt}${targetExt}`;
      let taken = takenByParent.get(parent);
      if (!taken) {
        taken = new Set();
        try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); }
        catch {}
        takenByParent.set(parent, taken);
      }
      const chosen = resolveCollision(defaultName, taken);
      taken.add(chosen);
      return path.join(parent, chosen);
    };

    let processed = 0; let skipped = 0;
    const errors = [];
    const total = targets.length;

    for (const input of targets) {
      if (signal && signal.aborted) return { ok: false, processed, skipped, errors, aborted: true };
      const output = reserveOutput(input);
      const args = ['-monitor', input];
      if (LOSSY.has(targetExt)) args.push('-quality', String(quality));
      args.push(output);
      try {
        await this._spawnTool({
          exe, args,
          parseProgress: parseMagickProgress,
          onProgress: (p) => onProgress({ processed, total, itemProgress: p }),
          signal,
        });
        processed++;
        if (deleteOriginal) { try { fs.unlinkSync(input); } catch {} }
      } catch (err) {
        errors.push({ file: path.basename(input), message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to convert.', detail: 'No images selected.' }; }

  buildFormMessage(_ctx, pre) {
    return `Convert ${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')}`;
  }
  buildFormSummary(_ctx, pre) {
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    const exts = Object.entries(pre.byExt).map(([e, n]) => `${e}: ${n}`).join(', ');
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'file', 'files')} (${mb} MB). ${exts}.`;
  }
  buildRunningLabel() { return 'Converting…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'image', 'images')} converted.`,
      `${errors.length} could not be converted:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = ConvertImage;
```

### Step 4: Create `plugins/convert-image/ui.html`

```html
<label class="field-row">
  <span>Target format:</span>
  <select name="format">
    <option value=".png" selected>PNG</option>
    <option value=".jpg">JPG</option>
    <option value=".webp">WebP</option>
    <option value=".bmp">BMP</option>
    <option value=".tiff">TIFF</option>
  </select>
</label>
<label class="field-row">
  <span>Quality (1-100, lossy only):</span>
  <input type="number" name="quality" value="90" min="1" max="100" />
</label>
<label class="field-row">
  <input type="checkbox" name="deleteOriginal" />
  Delete original after convert
</label>
```

### Step 5: Copy icon

```
copy "C:\YandexDisk\Software\bin\ContextHelper\plugins\flatten-folder\icon.png" "C:\YandexDisk\Software\bin\ContextHelper\plugins\convert-image\icon.png"
```

### Step 6: Run tests, expect 8 pass

```
npm test -- tests/unit/convert-image.test.js
```

### Step 7: Full suite, expect 191 (183 + 8)

```
npm test
```

### Step 8: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/convert-image/ ContextHelper/tests/unit/convert-image.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(plugins): add convert-image plugin (magick, window)

Per-file image format conversion via magick.exe -monitor. Window form
picks target format (png/jpg/webp/bmp/tiff), quality (1-100, applied
to lossy targets), and optional delete-original flag. Sibling output
with (N) collision suffix. Constructor DI for spawnTool — 8 tests
mocked without the real binary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: images-to-pdf

**Files:**
- Create: `plugins/images-to-pdf/plugin.js`
- Create: `plugins/images-to-pdf/ui.html`
- Copy: `plugins/images-to-pdf/icon.png`
- Create: `tests/unit/images-to-pdf.test.js`

### Step 1: Create `tests/unit/images-to-pdf.test.js`

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ImagesToPdf = require('../../plugins/images-to-pdf/plugin');

describe('ImagesToPdf', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-imgpdf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('static manifest is well-formed', () => {
    const m = ImagesToPdf.manifest;
    expect(m).toMatchObject({
      id: 'images-to-pdf',
      label: 'Images to PDF',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    });
  });

  it('preflight sorts files by basename and reports totals', async () => {
    fs.writeFileSync(path.join(tmp, 'b.jpg'), 'BB');
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'A');
    fs.writeFileSync(path.join(tmp, 'c.jpg'), 'CCC');
    const result = await new ImagesToPdf().preflight({ targets: [path.join(tmp, 'b.jpg'), path.join(tmp, 'a.jpg'), path.join(tmp, 'c.jpg')] });
    expect(result.files.map((f) => f.basename)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(result.totalFiles).toBe(3);
    expect(result.totalBytes).toBe(6);
  });

  it('preflight returns totalFiles 0 with no targets', async () => {
    const result = await new ImagesToPdf().preflight({ targets: [] });
    expect(result.totalFiles).toBe(0);
  });

  it('preflight does not mutate the filesystem', async () => {
    const p = path.join(tmp, 'a.jpg');
    fs.writeFileSync(p, 'X');
    const before = fs.statSync(p).mtimeMs;
    await new ImagesToPdf().preflight({ targets: [p] });
    expect(fs.statSync(p).mtimeMs).toBe(before);
  });

  it('run calls magick once with all inputs + output PDF', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const b = path.join(tmp, 'b.jpg'); fs.writeFileSync(b, 'B');
    const calls = [];
    const plugin = new ImagesToPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    const result = await plugin.run({
      targets: [a, b], binDir: '/fake/bin',
      options: { output: 'Photos.pdf', pageSize: 'Original' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].exe).toBe(path.join('/fake/bin', 'magick.exe'));
    expect(calls[0].args[0]).toBe('-monitor');
    expect(calls[0].args.slice(1, 3)).toEqual([a, b]);
    expect(calls[0].args.at(-1)).toBe(path.join(tmp, 'Photos.pdf'));
  });

  it('run inserts -page for non-Original page sizes', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const calls = [];
    const plugin = new ImagesToPdf({ spawnTool: async (args) => { calls.push(args); return { ok: true, stdout: '', stderr: '' }; } });
    await plugin.run({
      targets: [a], binDir: '/fake/bin',
      options: { output: 'P.pdf', pageSize: 'A4' },
      onProgress: () => {},
    });
    expect(calls[0].args).toContain('-page');
    expect(calls[0].args).toContain('A4');
  });

  it('run records error when magick fails', async () => {
    const a = path.join(tmp, 'a.jpg'); fs.writeFileSync(a, 'A');
    const plugin = new ImagesToPdf({ spawnTool: async () => { throw new Error('magick exited 1: format error'); } });
    const result = await plugin.run({
      targets: [a], binDir: '/fake/bin',
      options: { output: 'P.pdf', pageSize: 'Original' },
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('buildRunningLabel returns "Building PDF…"', () => {
    expect(new ImagesToPdf().buildRunningLabel({})).toBe('Building PDF…');
  });
});
```

### Step 2: Run, expect fail

```
npm test -- tests/unit/images-to-pdf.test.js
```

### Step 3: Create `plugins/images-to-pdf/plugin.js`

```js
const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function parseMagickProgress(text) {
  const m = /(\d+)\s+of\s+(\d+)/i.exec(text);
  if (m) return { processed: Number(m[1]), total: Number(m[2]) };
  return null;
}

class ImagesToPdf extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'images-to-pdf',
      label: 'Images to PDF',
      description: 'Combine selected images into a single PDF',
      icon: 'icon.png',
      accepts: ['files:.jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp,.gif'],
      minSelection: 1, maxSelection: 999,
      ui: 'window',
    };
  }

  async preflight({ targets }) {
    const files = [];
    let totalBytes = 0;
    for (const t of targets) {
      let stat;
      try { stat = fs.statSync(t); } catch { continue; }
      files.push({ basename: path.basename(t), sizeBytes: stat.size, path: t });
      totalBytes += stat.size;
    }
    files.sort((a, b) => a.basename.localeCompare(b.basename));
    return { files, totalFiles: files.length, totalBytes };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const sorted = [...targets].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    let outputName = String(options.output || 'Images.pdf');
    if (!outputName.toLowerCase().endsWith('.pdf')) outputName += '.pdf';
    const pageSize = String(options.pageSize || 'Original');
    const parent = path.dirname(sorted[0]);

    let taken = new Set();
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); } catch {}
    const finalName = resolveCollision(outputName, taken);
    const output = path.join(parent, finalName);

    const exe = path.join(binDir, 'magick.exe');
    const args = ['-monitor', ...sorted];
    if (pageSize !== 'Original') args.push('-page', pageSize);
    args.push(output);

    if (signal && signal.aborted) return { ok: false, processed: 0, skipped: 0, errors: [], aborted: true };

    try {
      await this._spawnTool({
        exe, args,
        parseProgress: parseMagickProgress,
        onProgress: (p) => onProgress(p),
        signal,
      });
      return { ok: true, processed: targets.length, skipped: 0, errors: [] };
    } catch (err) {
      return { ok: false, processed: 0, skipped: targets.length, errors: [{ file: finalName, message: err.message }] };
    }
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalFiles === 0); }
  buildNothingToDoBody() { return { message: 'Nothing to combine.', detail: 'No images selected.' }; }

  buildFormMessage(_ctx, pre) {
    return `Combine ${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')} into a PDF`;
  }
  buildFormSummary(_ctx, pre) {
    const mb = (pre.totalBytes / (1024 * 1024)).toFixed(1);
    return `${pre.totalFiles} ${plural(pre.totalFiles, 'image', 'images')} (${mb} MB). Files will be sorted alphabetically.`;
  }
  buildRunningLabel() { return 'Building PDF…'; }

  buildErrorBody(_ctx, errors) {
    return errors.map((e) => `  • ${e.file} — ${e.message}`).join('\n');
  }
}

module.exports = ImagesToPdf;
```

### Step 4: Create `plugins/images-to-pdf/ui.html`

```html
<label class="field-row">
  <span>Output filename:</span>
  <input type="text" name="output" value="Images.pdf" />
</label>
<label class="field-row">
  <span>Page size:</span>
  <select name="pageSize">
    <option value="Original" selected>Original (fit each image)</option>
    <option value="A4">A4</option>
    <option value="Letter">Letter</option>
  </select>
</label>
```

### Step 5: Copy icon

```
copy "C:\YandexDisk\Software\bin\ContextHelper\plugins\flatten-folder\icon.png" "C:\YandexDisk\Software\bin\ContextHelper\plugins\images-to-pdf\icon.png"
```

### Step 6: Run tests, expect 8 pass

```
npm test -- tests/unit/images-to-pdf.test.js
```

### Step 7: Full suite, expect 199 (191 + 8)

```
npm test
```

### Step 8: Commit

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/plugins/images-to-pdf/ ContextHelper/tests/unit/images-to-pdf.test.js
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
feat(plugins): add images-to-pdf plugin (magick, window)

Combine N images into a single PDF via one magick.exe -monitor call.
Inputs sorted alphabetically by basename. Form accepts output filename
(default Images.pdf) and page size (Original / A4 / Letter). Output
lives in the parent of the first selected image with (N) collision
suffix.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rebuild + register + finalize

### Step 1: Regenerate register.bat + rebuild

```
cd C:\YandexDisk\Software\bin\ContextHelper
node scripts/gen-register-bat.js
npm run package
Copy-Item register.bat,unregister.bat -Destination dist\win-unpacked\ -Force
Set-Location dist\win-unpacked
.\unregister.bat
.\register.bat
```

### Step 2: Mark Plan 3d complete

Edit top:
```markdown
> **Status:** ✅ Tasks 1–2 implementation complete (YYYY-MM-DD). Awaiting user to place magick.exe in resources/bin/ and run Explorer matrix.
```

Update CLAUDE.md "Resume here" — 3d done, next is 3e (PDF plugins via gswin64c).

### Step 3: Commit docs

```
git -C "C:\YandexDisk\Software\bin" add ContextHelper/docs/superpowers/plans/2026-05-20-plan-3d-images.md ContextHelper/CLAUDE.md ContextHelper/register.bat ContextHelper/unregister.bat
git -C "C:\YandexDisk\Software\bin" commit -m "$(cat <<'EOF'
docs(ContextHelper): mark Plan 3d (image plugins) implementation complete

convert-image + images-to-pdf shipped. 199/199 tests + package +
register installed. User to place magick.exe in resources/bin/ for
runtime. Plan 3e (PDF plugins via gswin64c) is next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- §4.4 convert-image: window form, target format / quality / delete-original → Task 1 ✓
- §4.5 images-to-pdf: window form, output filename / page size → Task 2 ✓
- Both use spawnTool with constructor DI → 16 tests mocked, no binary required at test time ✓
- Sibling output for convert; parent-of-first for images-to-pdf; both with (N) collision → ✓
- 8 mandatory tests per plugin → ✓
