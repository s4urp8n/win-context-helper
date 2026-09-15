const { describeMenuStatus } = require('../../src/main/shell-menu/status-view');

const context = {
  exePath: String.raw`C:\Apps\ContextHelper.exe`,
  itemCount: 12,
  logDir: String.raw`C:\Users\u\AppData\Local\ContextHelper\logs`,
};

describe('describeMenuStatus', () => {
  it('confirms a menu that is already registered', () => {
    expect(describeMenuStatus({ ok: true, changes: [], lines: [] }, context)).toEqual({
      state: 'info',
      message: 'Explorer menu is registered',
      detail: ['12 menu items are in place.', String.raw`Program: C:\Apps\ContextHelper.exe`].join('\n'),
    });
  });

  it('lists what was repaired', () => {
    const result = { ok: true, changes: [{ kind: 'set' }], lines: ['Added menu item "Flatten folder (keep order)"'] };
    expect(describeMenuStatus(result, context)).toEqual({
      state: 'info',
      message: 'Explorer menu repaired',
      detail: ['Added menu item "Flatten folder (keep order)"', '', String.raw`Program: C:\Apps\ContextHelper.exe`].join('\n'),
    });
  });

  it('explains a registry that could not be written and points to the log', () => {
    const result = { ok: false, error: 'reg import exited 1', remainingLines: ['Added menu item "Merge PDF"'] };
    expect(describeMenuStatus(result, context)).toEqual({
      state: 'error',
      message: 'Could not register the Explorer menu',
      detail: [
        'The registry could not be updated. Pending changes:',
        'Added menu item "Merge PDF"',
        '',
        String.raw`Details are in the log: C:\Users\u\AppData\Local\ContextHelper\logs`,
      ].join('\n'),
    });
  });

  it('explains entries that still differ after writing', () => {
    const result = { ok: false, error: null, remainingLines: ['Fixed menu item "Merge PDF"'] };
    expect(describeMenuStatus(result, context).detail.split('\n')[0]).toBe('Some entries still differ after writing them:');
  });
});
