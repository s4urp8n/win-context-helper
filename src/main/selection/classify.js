function basenameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return name.slice(i).toLowerCase();
}

function classify(targets, fs) {
  const folders = [];
  const files = [];
  const missing = [];
  const exts = new Set();
  const basenames = [];
  for (const t of targets) {
    const base = basenameOf(t);
    basenames.push(base);
    try {
      const st = fs.statSync(t);
      if (st.isDirectory()) {
        folders.push(t);
      } else if (st.isFile()) {
        files.push(t);
        const ext = extOf(base);
        if (ext) exts.add(ext);
      } else {
        missing.push(t);
      }
    } catch (_err) {
      missing.push(t);
    }
  }
  return { folders, files, missing, exts: [...exts], basenames };
}

module.exports = { classify, basenameOf };
