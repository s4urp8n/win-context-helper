const { spawnSync } = require('node:child_process');
const { createReg } = require('../../src/main/shell-menu/reg');
const { syncMenu, unregisterMenu } = require('../../src/main/shell-menu/sync');
const { desiredState } = require('../../src/main/shell-menu/entries');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));
const TEST_PARENT = 'HKCU\\Software\\ContextHelperTest';

describe.runIf(process.platform === 'win32')('shell menu against the real reg.exe', () => {
  const exePath = String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe`;
  const manifests = [{ id: 'flatten-folder', label: 'Flatten folder' }, { id: 'merge-pdf', label: 'Merge PDF' }];
  const reg = createReg();
  let root;

  const readAll = async () => {
    const all = new Map();
    const keys = [
      String.raw`Directory\shell\ContextHelper`,
      String.raw`*\shell\ContextHelper`,
      String.raw`Directory\Background\shell\ContextHelper`,
      String.raw`Directory\ContextHelperRoot`,
      String.raw`Directory\ContextHelperFolders`,
    ];
    for (const key of keys) {
      for (const [name, values] of (await reg.exportKey(`${root}\\${key}`)).tree) all.set(name, values);
    }
    return all;
  };

  beforeEach(() => {
    root = `HKEY_CURRENT_USER\\Software\\ContextHelperTest\\${process.pid}-${Date.now()}`;
  });
  afterAll(() => {
    spawnSync('reg.exe', ['delete', TEST_PARENT, '/f'], { windowsHide: true });
  });

  it('registers the menu and reads back exactly what was written, Cyrillic path included', async () => {
    const result = await syncMenu({ exePath, manifests, reg, root });
    expect(result.ok).toBe(true);
    expect(toObject(await readAll())).toEqual(toObject(desiredState({ exePath, manifests, root })));
    const commandKey = `${root}\\Directory\\ContextHelperRoot\\shell\\merge-pdf\\command`;
    expect((await reg.exportKey(commandKey)).tree.get(commandKey).get(''))
      .toBe(String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=merge-pdf "%V"`);
    expect((await syncMenu({ exePath, manifests, reg, root })).changes).toEqual([]);
  }, 30000);

  it('repairs a tampered menu', async () => {
    await syncMenu({ exePath, manifests, reg, root });
    await reg.importFile([
      'Windows Registry Editor Version 5.00', '',
      `[${root}\\Directory\\ContextHelperRoot\\shell\\flatten-folder\\command]`, '@="old.exe"', '',
      `[-${root}\\Directory\\ContextHelperRoot\\shell\\merge-pdf]`, '',
      `[${root}\\Directory\\ContextHelperRoot\\shell\\old-plugin\\command]`, '@="old.exe"', '',
      `[${root}\\Directory\\shell\\ContextHelper]`, '"SubCommands"=""', '',
      `[${root}\\Directory\\ContextHelperFolders\\shell]`, '',
    ].join('\r\n'));

    const result = await syncMenu({ exePath, manifests, reg, root });
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(expect.arrayContaining([
      'Fixed menu item "Flatten folder"',
      'Added menu item "Merge PDF"',
      'Removed stale menu item "old-plugin"',
      String.raw`Fixed Directory\shell\ContextHelper`,
      String.raw`Removed Directory\ContextHelperFolders`,
    ]));
    expect((await syncMenu({ exePath, manifests, reg, root })).changes).toEqual([]);
  }, 30000);

  it('unregisters every key', async () => {
    await syncMenu({ exePath, manifests, reg, root });
    expect(await unregisterMenu({ reg, root })).toEqual({ ok: true, remaining: [], error: null });
    expect((await readAll()).size).toBe(0);
  }, 30000);
});
