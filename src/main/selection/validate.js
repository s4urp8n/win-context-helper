const MAX_LIST = 10;

function plural(n, one, many) { return n === 1 ? one : many; }

function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return name.slice(i).toLowerCase();
}

function acceptsFolders(accepts) {
  return accepts.some((p) => p === 'folder' || p === 'folders');
}

function acceptsAnyFile(accepts) {
  return accepts.some((p) => p === 'files' || p === 'file' || p.startsWith('files:') || p.startsWith('file:'));
}

function allowedExts(accepts) {
  const out = new Set();
  let acceptsAllFiles = false;
  for (const p of accepts) {
    if (p === 'files' || p === 'file') acceptsAllFiles = true;
    else if (p.startsWith('files:')) {
      for (const e of p.slice('files:'.length).split(',')) out.add(e.trim().toLowerCase());
    } else if (p.startsWith('file:')) {
      for (const e of p.slice('file:'.length).split(',')) out.add(e.trim().toLowerCase());
    }
  }
  return { acceptsAllFiles, exts: [...out] };
}

function partition(accepts, selection) {
  const { folders, files } = selection;
  const acceptF = acceptsFolders(accepts);
  const acceptFile = acceptsAnyFile(accepts);
  const { acceptsAllFiles, exts: allowed } = allowedExts(accepts);

  const effectiveTargets = [];
  const skipped = [];

  for (const p of folders) {
    if (acceptF) effectiveTargets.push(p);
    else skipped.push({ path: p, basename: basenameOf(p), reason: 'WRONG_TYPE' });
  }
  for (const p of files) {
    const base = basenameOf(p);
    if (!acceptFile) {
      skipped.push({ path: p, basename: base, reason: 'WRONG_TYPE' });
    } else if (!acceptsAllFiles && !allowed.includes(extOf(base))) {
      skipped.push({ path: p, basename: base, reason: 'WRONG_EXTENSION' });
    } else {
      effectiveTargets.push(p);
    }
  }
  return { effectiveTargets, skipped };
}

function rangeText(min, max) {
  if (min === max) return `exactly ${min} ${plural(min, 'item', 'items')}`;
  return `between ${min} and ${max} items`;
}

function validate(manifest, selection) {
  const { missing } = selection;
  const { accepts, minSelection, maxSelection, label } = manifest;

  // 1. MISSING — hard reject
  if (missing.length > 0) {
    const body = [
      `Selection contains ${missing.length} ${plural(missing.length, 'path', 'paths')} that no longer exist or are inaccessible:`,
      ...missing.slice(0, MAX_LIST).map((m) => `  • ${m}`),
    ];
    if (missing.length > MAX_LIST) body.push(`  … and ${missing.length - MAX_LIST} more`);
    body.push('Operation cancelled.');
    return { ok: false, reason: 'MISSING', body: body.join('\n') };
  }

  // 2. Partition by accepts
  const { effectiveTargets, skipped } = partition(accepts, selection);

  // 3. All-skipped — let plugin's nothing-to-do flow handle it
  if (effectiveTargets.length === 0) {
    return { ok: true, effectiveTargets, skipped, allSkipped: true };
  }

  // 4. COUNT — based on effective
  if (effectiveTargets.length < minSelection || effectiveTargets.length > maxSelection) {
    return {
      ok: false,
      reason: 'COUNT',
      body: `"${label}" accepts ${rangeText(minSelection, maxSelection)}, but ${effectiveTargets.length} ${plural(effectiveTargets.length, 'was', 'were')} eligible.`,
    };
  }

  return { ok: true, effectiveTargets, skipped };
}

module.exports = { validate };
