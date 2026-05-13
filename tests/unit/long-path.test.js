const { toLongPath, fromLongPath } = require('../../src/main/utils/long-path');

describe('toLongPath', () => {
  it('prefixes a drive-letter path', () => {
    expect(toLongPath('C:\\Users\\test\\file.txt')).toBe('\\\\?\\C:\\Users\\test\\file.txt');
  });

  it('leaves an already-prefixed path alone', () => {
    expect(toLongPath('\\\\?\\C:\\foo')).toBe('\\\\?\\C:\\foo');
  });

  it('prefixes a UNC path correctly', () => {
    expect(toLongPath('\\\\server\\share\\file.txt')).toBe('\\\\?\\UNC\\server\\share\\file.txt');
  });

  it('normalises forward slashes', () => {
    expect(toLongPath('C:/Users/test')).toBe('\\\\?\\C:\\Users\\test');
  });

  it('throws on a relative path', () => {
    expect(() => toLongPath('relative\\path')).toThrow(/absolute/i);
  });
});

describe('fromLongPath', () => {
  it('strips a drive-letter prefix', () => {
    expect(fromLongPath('\\\\?\\C:\\foo')).toBe('C:\\foo');
  });

  it('strips a UNC prefix', () => {
    expect(fromLongPath('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');
  });

  it('leaves a non-prefixed path alone', () => {
    expect(fromLongPath('C:\\foo')).toBe('C:\\foo');
  });
});
