function categoriseAccepts(accepts) {
  const cats = new Set();
  for (const pat of accepts) {
    if (pat === 'folder' || pat === 'folders') cats.add('folders');
    else if (pat === 'files' || pat === 'file' || pat.startsWith('files:') || pat.startsWith('file:')) cats.add('files');
  }
  return [...cats];
}

function buildMenuTree(plugins) {
  const folders = [];
  const files = [];
  for (const p of plugins) {
    const cats = categoriseAccepts(p.manifest.accepts);
    if (cats.includes('folders')) folders.push(p);
    if (cats.includes('files')) files.push(p);
  }
  const byId = (a, b) => a.manifest.id.localeCompare(b.manifest.id);
  folders.sort(byId);
  files.sort(byId);
  return { folders, files };
}

function buildFlatMenu(plugins) {
  return [...plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

module.exports = { buildMenuTree, buildFlatMenu, categoriseAccepts };
