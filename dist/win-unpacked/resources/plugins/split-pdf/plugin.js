const fs = require('node:fs');
const path = require('node:path');
const { BasePlugin } = require('../../src/shared/base-plugin');
const { resolveCollision } = require('../../src/main/utils/collision');

const plural = (n, one, many) => (n === 1 ? one : many);

function parseRanges(text, maxPage) {
  const spans = [];
  for (const part of String(text || '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(t);
    if (!m) continue;
    const start = Math.max(1, Math.min(Number(m[1]), maxPage));
    const end = m[2] ? Math.max(start, Math.min(Number(m[2]), maxPage)) : start;
    spans.push({ start, end });
  }
  return spans;
}

class SplitPdf extends BasePlugin {
  constructor({ spawnTool: spawnOverride } = {}) {
    super();
    this._spawnTool = spawnOverride || require('../../src/shared/spawn').spawnTool;
  }

  static get manifest() {
    return {
      id: 'split-pdf',
      label: 'Split PDF',
      description: 'Split a PDF into per-page or per-range files',
      icon: 'icon.png',
      accepts: ['files:.pdf'],
      minSelection: 1, maxSelection: 1, ui: 'window',
    };
  }

  async preflight({ targets, binDir }) {
    const input = targets[0];
    const exe = path.join(binDir || '', 'gswin64c.exe');
    let totalPages = 0;
    let preflightError = null;
    try {
      const result = await this._spawnTool({
        exe,
        args: ['-q', '-dNODISPLAY', '-dNOSAFER', '-c', `(${input.replace(/\\/g, '/')}) (r) file runpdfbegin pdfpagecount = quit`],
      });
      const m = /^\s*(\d+)\s*$/m.exec(result.stdout || '');
      if (m) totalPages = Number(m[1]);
      else preflightError = `Could not parse page count from gs output: ${(result.stdout || '').slice(0, 200)}`;
    } catch (err) {
      preflightError = err.message;
      totalPages = 0;
    }
    return { basename: path.basename(input), totalPages, preflightError };
  }

  async run({ targets, binDir, options = {}, onProgress = () => {}, signal }) {
    const input = targets[0];
    const parent = path.dirname(input);
    const baseNoExt = path.basename(input, path.extname(input));
    const prefix = String(options.prefix || `${baseNoExt}-`);
    const totalPages = Number(options.totalPages || 0);
    const mode = String(options.mode || 'per-page');
    const exe = path.join(binDir, 'gswin64c.exe');

    let spans = [];
    if (mode === 'by-ranges') {
      spans = parseRanges(options.ranges, totalPages);
    } else {
      for (let i = 1; i <= totalPages; i++) spans.push({ start: i, end: i });
    }

    let taken = new Set();
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isFile()) taken.add(e.name); } catch {}

    let processed = 0;
    let skipped = 0;
    const errors = [];
    const total = spans.length;

    for (const span of spans) {
      if (signal && signal.aborted) return { ok: false, processed, skipped, errors, aborted: true };
      const namePart = span.start === span.end ? `${span.start}` : `${span.start}-${span.end}`;
      const defaultName = `${prefix}${namePart}.pdf`;
      const finalName = resolveCollision(defaultName, taken);
      taken.add(finalName);
      const output = path.join(parent, finalName);
      const args = [
        '-dBATCH', '-dNOPAUSE', '-q', '-dNOSAFER',
        '-sDEVICE=pdfwrite',
        '-dPDFSETTINGS=/prepress',
        `-dFirstPage=${span.start}`,
        `-dLastPage=${span.end}`,
        `-sOutputFile=${output}`,
        input,
      ];
      try {
        await this._spawnTool({ exe, args, signal });
        processed++;
      } catch (err) {
        errors.push({ file: finalName, message: err.message });
        skipped++;
      }
      onProgress({ processed: processed + skipped, total });
    }
    return { ok: errors.length === 0, processed, skipped, errors };
  }

  isEmpty(_ctx, pre) { return !!(pre && pre.totalPages === 0); }
  buildNothingToDoBody(_ctx, pre) {
    const detail = pre && pre.preflightError
      ? `Could not read PDF: ${pre.preflightError}`
      : 'Selected PDF has no pages (or could not be parsed).';
    return { message: 'Nothing to split.', detail };
  }

  buildFormHtml(_ctx, pre) {
    const totalPages = (pre && pre.totalPages) || 0;
    return `
<label class="field-row">
  <input type="radio" name="mode" value="per-page" checked />
  Per page (one file per page)
</label>
<label class="field-row">
  <input type="radio" name="mode" value="by-ranges" />
  By page ranges
</label>
<label class="field-row">
  <span>Ranges (e.g. 1-5, 7, 10-12; max page ${totalPages}):</span>
  <input type="text" name="ranges" value="" />
</label>
<label class="field-row">
  <span>Output prefix:</span>
  <input type="text" name="prefix" value="" placeholder="defaults to <basename>-" />
</label>
<input type="hidden" name="totalPages" value="${totalPages}" />
`;
  }

  buildFormMessage(_ctx, pre) { return `Split "${pre.basename}" (${pre.totalPages} ${plural(pre.totalPages, 'page', 'pages')})`; }
  buildFormSummary(_ctx, pre) {
    return `Choose a split mode below. Output files will be created next to the source.`;
  }
  buildRunningLabel() { return 'Splitting…'; }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} ${plural(total, 'piece', 'pieces')} extracted.`,
      `${errors.length} could not be extracted:`,
    ];
    for (const e of errors.slice(0, 10)) lines.push(`  • ${e.file} — ${e.message}`);
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    return lines.join('\n');
  }
}

module.exports = SplitPdf;
