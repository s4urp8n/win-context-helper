const { resolveCollision, splitExt } = require('../../src/main/utils/collision');

describe('splitExt', () => {
  it('splits at the last dot', () => {
    expect(splitExt('archive.tar.gz')).toEqual({ base: 'archive.tar', ext: '.gz' });
  });

  it('keeps a dotfile and a name without a dot whole', () => {
    expect(splitExt('.gitignore')).toEqual({ base: '.gitignore', ext: '' });
    expect(splitExt('README')).toEqual({ base: 'README', ext: '' });
  });
});

describe('resolveCollision', () => {
  it('returns original name when no collision', () => {
    expect(resolveCollision('photo.jpg', new Set())).toBe('photo.jpg');
  });

  it('appends (2) on first collision', () => {
    expect(resolveCollision('photo.jpg', new Set(['photo.jpg']))).toBe('photo (2).jpg');
  });

  it('appends (3) when (2) is also taken', () => {
    const taken = new Set(['photo.jpg', 'photo (2).jpg']);
    expect(resolveCollision('photo.jpg', taken)).toBe('photo (3).jpg');
  });

  it('handles names without extensions', () => {
    expect(resolveCollision('README', new Set(['README']))).toBe('README (2)');
  });

  it('handles multi-dot names — uses last dot', () => {
    expect(resolveCollision('archive.tar.gz', new Set(['archive.tar.gz']))).toBe('archive.tar (2).gz');
  });

  it('handles hidden dotfiles (no extension)', () => {
    expect(resolveCollision('.gitignore', new Set(['.gitignore']))).toBe('.gitignore (2)');
  });

  it('handles names that already end with (N)', () => {
    const taken = new Set(['photo (2).jpg']);
    expect(resolveCollision('photo (2).jpg', taken)).toBe('photo (2) (2).jpg');
  });

  it('mutates nothing — Set parameter unchanged', () => {
    const taken = new Set(['a.txt']);
    resolveCollision('a.txt', taken);
    expect(taken.size).toBe(1);
  });
});
