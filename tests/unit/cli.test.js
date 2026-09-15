const { parseCli } = require('../../src/main/cli');

describe('parseCli', () => {
  it('parses --action and --target', () => {
    const r = parseCli(['--action=flatten-folder', '--target=C:\\Photos']);
    expect(r).toEqual({ kind: 'run', action: 'flatten-folder', targets: ['C:\\Photos'] });
  });

  it('parses --action and quoted --target', () => {
    const r = parseCli(['--action=flatten-folder', '--target=C:\\Some Folder\\With Spaces']);
    expect(r.targets).toEqual(['C:\\Some Folder\\With Spaces']);
  });

  it('accepts positional targets', () => {
    const r = parseCli(['--action=flatten-folder', 'C:\\A', 'C:\\B', 'C:\\C']);
    expect(r.targets).toEqual(['C:\\A', 'C:\\B', 'C:\\C']);
  });

  it('accepts mixed --target and positional', () => {
    const r = parseCli(['--action=x', '--target=C:\\A', 'C:\\B']);
    expect(r.targets).toEqual(['C:\\A', 'C:\\B']);
  });

  it('accepts multiple --target flags', () => {
    const r = parseCli(['--action=x', '--target=C:\\A', '--target=C:\\B']);
    expect(r.targets).toEqual(['C:\\A', 'C:\\B']);
  });

  it('errors when --action is missing', () => {
    expect(() => parseCli(['--target=C:\\foo'])).toThrow(/--action/);
  });

  it('errors when no target given', () => {
    expect(() => parseCli(['--action=flatten-folder'])).toThrow(/target/);
  });

  it('errors on unknown flag', () => {
    expect(() => parseCli(['--action=x', '--target=y', '--bogus=z'])).toThrow(/--bogus/);
  });

  it('returns kind:none when argv is empty', () => {
    expect(parseCli([])).toEqual({ kind: 'none' });
  });

  it('parses --register and --unregister', () => {
    expect(parseCli(['--register'])).toEqual({ kind: 'register' });
    expect(parseCli(['--unregister'])).toEqual({ kind: 'unregister' });
  });

  it('rejects --register or --unregister combined with other arguments', () => {
    expect(() => parseCli(['--register', '--action=x'])).toThrow(/--register cannot be combined/);
    expect(() => parseCli(['--action=x', 'C:\\A', '--unregister'])).toThrow(/--unregister cannot be combined/);
  });
});
