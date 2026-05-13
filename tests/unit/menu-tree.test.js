const { buildMenuTree, buildFlatMenu, categoriseAccepts } = require('../../src/main/registry/menu-tree');

const p = (id, accepts) => ({ manifest: { id, accepts, label: id } });

describe('categoriseAccepts', () => {
  it('folder/folders → folders', () => {
    expect(categoriseAccepts(['folder']).sort()).toEqual(['folders']);
    expect(categoriseAccepts(['folders']).sort()).toEqual(['folders']);
  });
  it('files/files:* → files', () => {
    expect(categoriseAccepts(['files']).sort()).toEqual(['files']);
    expect(categoriseAccepts(['files:.pdf']).sort()).toEqual(['files']);
  });
  it('both kinds → both', () => {
    expect(categoriseAccepts(['folders', 'files:.pdf']).sort()).toEqual(['files', 'folders']);
  });
});

describe('buildMenuTree', () => {
  it('folder-only plugin appears only in folders group', () => {
    const tree = buildMenuTree([p('flatten-folder', ['folders'])]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['flatten-folder']);
    expect(tree.files).toEqual([]);
  });

  it('file-only plugin appears only in files group', () => {
    const tree = buildMenuTree([p('merge-pdf', ['files:.pdf'])]);
    expect(tree.folders).toEqual([]);
    expect(tree.files.map((x) => x.manifest.id)).toEqual(['merge-pdf']);
  });

  it('plugin accepting both kinds appears in both groups', () => {
    const tree = buildMenuTree([p('rename', ['folders', 'files'])]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['rename']);
    expect(tree.files.map((x) => x.manifest.id)).toEqual(['rename']);
  });

  it('plugins sorted alphabetically within a group', () => {
    const tree = buildMenuTree([
      p('zip', ['folders']),
      p('aaa', ['folders']),
      p('mid', ['folders']),
    ]);
    expect(tree.folders.map((x) => x.manifest.id)).toEqual(['aaa', 'mid', 'zip']);
  });

  it('empty groups returned as empty arrays', () => {
    const tree = buildMenuTree([p('flatten-folder', ['folders'])]);
    expect(tree.files).toEqual([]);
  });

  it('unknown accepts pattern is ignored', () => {
    const tree = buildMenuTree([p('weird', ['nonsense:x'])]);
    expect(tree.folders).toEqual([]);
    expect(tree.files).toEqual([]);
  });
});

describe('buildFlatMenu', () => {
  it('returns all plugins sorted alphabetically regardless of accepts', () => {
    const list = buildFlatMenu([
      p('zip', ['folders']),
      p('aaa', ['files:.pdf']),
      p('mid', ['folders', 'files']),
    ]);
    expect(list.map((x) => x.manifest.id)).toEqual(['aaa', 'mid', 'zip']);
  });

  it('returns an empty array when no plugins', () => {
    expect(buildFlatMenu([])).toEqual([]);
  });

  it('preserves plugin object reference (no clone)', () => {
    const original = p('flatten', ['folders']);
    const list = buildFlatMenu([original]);
    expect(list[0]).toBe(original);
  });
});
