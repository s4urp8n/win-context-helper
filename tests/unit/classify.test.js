const { classify } = require('../../src/main/selection/classify');

function makeFs(map) {
  return {
    statSync: (p) => {
      if (!(p in map)) {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      if (map[p] === 'enoent') {
        const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
      }
      if (map[p] === 'eacces') {
        const err = new Error('EACCES'); err.code = 'EACCES'; throw err;
      }
      return {
        isDirectory: () => map[p] === 'dir',
        isFile:      () => map[p] === 'file',
      };
    },
  };
}

describe('classify', () => {
  it('all folders', () => {
    const r = classify(['/a', '/b'], makeFs({ '/a': 'dir', '/b': 'dir' }));
    expect(r.folders).toEqual(['/a', '/b']);
    expect(r.files).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.exts).toEqual([]);
    expect(r.basenames).toEqual(['a', 'b']);
  });

  it('all files', () => {
    const r = classify(['/a.pdf', '/b.txt'], makeFs({ '/a.pdf': 'file', '/b.txt': 'file' }));
    expect(r.folders).toEqual([]);
    expect(r.files).toEqual(['/a.pdf', '/b.txt']);
    expect(r.exts.sort()).toEqual(['.pdf', '.txt']);
  });

  it('mixed folders + files', () => {
    const r = classify(['/d', '/f.pdf'], makeFs({ '/d': 'dir', '/f.pdf': 'file' }));
    expect(r.folders).toEqual(['/d']);
    expect(r.files).toEqual(['/f.pdf']);
    expect(r.exts).toEqual(['.pdf']);
  });

  it('all missing', () => {
    const r = classify(['/x', '/y'], makeFs({ '/x': 'enoent', '/y': 'enoent' }));
    expect(r.missing).toEqual(['/x', '/y']);
    expect(r.folders).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it('mix of missing + valid', () => {
    const r = classify(['/a', '/gone', '/b.pdf'], makeFs({ '/a': 'dir', '/gone': 'enoent', '/b.pdf': 'file' }));
    expect(r.missing).toEqual(['/gone']);
    expect(r.folders).toEqual(['/a']);
    expect(r.files).toEqual(['/b.pdf']);
  });

  it('EACCES treated as missing', () => {
    const r = classify(['/locked'], makeFs({ '/locked': 'eacces' }));
    expect(r.missing).toEqual(['/locked']);
  });

  it('extensions normalized to lowercase', () => {
    const r = classify(['/A.PDF', '/B.JpG'], makeFs({ '/A.PDF': 'file', '/B.JpG': 'file' }));
    expect(r.exts.sort()).toEqual(['.jpg', '.pdf']);
  });

  it('files without extension yield no ext entry', () => {
    const r = classify(['/README'], makeFs({ '/README': 'file' }));
    expect(r.exts).toEqual([]);
    expect(r.files).toEqual(['/README']);
  });
});
