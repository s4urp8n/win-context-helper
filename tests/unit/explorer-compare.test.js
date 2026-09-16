const { explorerCompare, approximateCompare, loadWindowsCompare, pickCompare } = require('../../src/main/utils/explorer-compare');

const sorted = (names, compare) => [...names].sort(compare);

describe('explorerCompare', () => {
  it('sorts like Explorer: case ignored, numbers by value', () => {
    expect(sorted(['lesson 10', 'Lesson 2', 'LESSON 1'], explorerCompare)).toEqual(['LESSON 1', 'Lesson 2', 'lesson 10']);
  });

  it.runIf(process.platform === 'win32')('puts a video before its subtitles, as Windows does', () => {
    expect(sorted(['X_en.vtt', 'X.mp4'], explorerCompare)).toEqual(['X.mp4', 'X_en.vtt']);
  });
});

describe('approximateCompare', () => {
  it('compares numbers by value and ignores case', () => {
    expect(sorted(['b10', 'B9', 'a'], approximateCompare)).toEqual(['a', 'B9', 'b10']);
  });

  it('ignores hyphens and apostrophes', () => {
    expect(approximateCompare('Co-op', 'Coop')).toBe(0);
    expect(approximateCompare("it's", 'its')).toBe(0);
  });
});

describe('pickCompare', () => {
  it('prefers the Windows function and falls back to the approximation', () => {
    const windows = () => 0;
    expect(pickCompare(windows)).toBe(windows);
    expect(pickCompare(null)).toBe(approximateCompare);
  });
});

describe('loadWindowsCompare', () => {
  it('is not available outside Windows', () => {
    const loadKoffi = vi.fn();
    expect(loadWindowsCompare(loadKoffi, 'linux')).toBeNull();
    expect(loadKoffi).not.toHaveBeenCalled();
  });

  it('is not available when the FFI module cannot be loaded', () => {
    expect(loadWindowsCompare(() => { throw new Error('Cannot find module koffi'); }, 'win32')).toBeNull();
  });

  it('declares StrCmpLogicalW from shlwapi.dll', () => {
    const compare = () => 0;
    const func = vi.fn(() => compare);
    const load = vi.fn(() => ({ func }));
    expect(loadWindowsCompare(() => ({ load }), 'win32')).toBe(compare);
    expect(load).toHaveBeenCalledWith('shlwapi.dll');
    expect(func).toHaveBeenCalledWith('__stdcall', 'StrCmpLogicalW', 'int', ['str16', 'str16']);
  });

  it.runIf(process.platform === 'win32')('loads the real function on this machine', () => {
    const compare = loadWindowsCompare();
    expect(typeof compare).toBe('function');
    expect(Math.sign(compare('Lesson 2', 'Lesson 10'))).toBe(-1);
  });
});
