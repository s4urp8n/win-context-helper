const MAX_ERRORS_IN_BODY = 10;

class BasePlugin {
  static get manifest() {
    throw new Error(`${this.name}: subclass must declare static get manifest()`);
  }

  async preflight(_ctx) {
    throw new Error(`${this.constructor.name}: must implement preflight()`);
  }

  async run(_ctx) {
    throw new Error(`${this.constructor.name}: must implement run()`);
  }

  isEmpty(_ctx, pre) {
    return !!(pre && pre.totalFiles === 0);
  }

  buildNothingToDoBody(_ctx, _pre) {
    return {
      message: 'Nothing to do.',
      detail: 'The current selection is already in the desired state.',
    };
  }

  buildConfirmMessage(_ctx, pre) {
    const n = (pre && pre.folders && pre.folders.length) || 1;
    return { message: `Process ${n} item(s)?`, detail: '' };
  }

  buildRejectedBody(_ctx, rejected) {
    const lines = [`Selection contains ${rejected.length} invalid path(s):`];
    for (const r of rejected.slice(0, MAX_ERRORS_IN_BODY)) lines.push(`  • ${r.basename}`);
    if (rejected.length > MAX_ERRORS_IN_BODY) {
      lines.push(`  … and ${rejected.length - MAX_ERRORS_IN_BODY} more`);
    }
    return lines.join('\n');
  }

  buildErrorBody(_ctx, errors, processed, total) {
    const lines = [
      `${processed} of ${total} processed.`,
      `${errors.length} could not be processed:`,
    ];
    for (const e of errors.slice(0, MAX_ERRORS_IN_BODY)) {
      lines.push(`  • ${e.file} — ${e.message}`);
    }
    if (errors.length > MAX_ERRORS_IN_BODY) {
      lines.push(`  … and ${errors.length - MAX_ERRORS_IN_BODY} more`);
    }
    return lines.join('\n');
  }

  buildScanningLabel(_ctx) { return 'Scanning…'; }
  buildRunningLabel(_ctx) { return 'Working…'; }
}

module.exports = { BasePlugin };
