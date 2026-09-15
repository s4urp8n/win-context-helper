const { syncMenu, unregisterMenu } = require('../../src/main/shell-menu/sync');

const ROOT = String.raw`HKEY_CURRENT_USER\T`;
const EXE = String.raw`C:\Apps\ContextHelper\ContextHelper.exe`;
const MANIFESTS = [{ id: 'flatten-folder', label: 'Flatten folder' }];
const k = (relative) => `${ROOT}\\${relative}`;
const regText = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines].join('\r\n');
const tree = (object) => new Map(Object.entries(object).map(([key, values]) => [key, new Map(Object.entries(values))]));

function registered(exe = EXE) {
  const entry = { MUIVerb: 'ContextHelper', Icon: `${exe},0`, ExtendedSubCommandsKey: String.raw`Directory\ContextHelperRoot` };
  return {
    [k(String.raw`Directory\shell\ContextHelper`)]: entry,
    [k(String.raw`*\shell\ContextHelper`)]: entry,
    [k(String.raw`Directory\Background\shell\ContextHelper`)]: entry,
    [k(String.raw`Directory\ContextHelperRoot`)]: {},
    [k(String.raw`Directory\ContextHelperRoot\shell`)]: {},
    [k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder`)]: { MUIVerb: 'Flatten folder', MultiSelectModel: 'Player' },
    [k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder\command`)]: { '': `"${exe}" --action=flatten-folder "%V"` },
  };
}

// Serves `before` until the first import, then `after`; records every exported key and imported .reg text.
function scriptedReg(before, after = before) {
  const imports = [];
  const exported = [];
  let state = before;
  return {
    imports,
    exported,
    async exportKey(key) {
      exported.push(key);
      const prefix = key.toLowerCase();
      const found = new Map([...state].filter(([name]) => name.toLowerCase() === prefix || name.toLowerCase().startsWith(`${prefix}\\`)));
      return { tree: found, error: found.size ? null : `missing ${key}` };
    },
    async importFile(text) {
      imports.push(text);
      state = after;
    },
  };
}

const sync = (reg) => syncMenu({ exePath: EXE, manifests: MANIFESTS, reg, root: ROOT });

describe('syncMenu', () => {
  it('does not write anything when the registry already matches', async () => {
    const reg = scriptedReg(tree(registered()));
    const result = await sync(reg);
    expect(result).toMatchObject({ ok: true, changes: [], lines: [], remaining: [], remainingLines: [], error: null });
    expect(reg.imports).toEqual([]);
  });

  it('compares key and value names case-insensitively', async () => {
    const upper = Object.fromEntries(Object.entries(registered()).map(([key, values]) => [
      key.toUpperCase(),
      Object.fromEntries(Object.entries(values).map(([name, data]) => [name.toUpperCase(), data])),
    ]));
    const reg = scriptedReg(tree(upper));
    expect((await sync(reg)).ok).toBe(true);
    expect(reg.imports).toEqual([]);
  });

  it('registers the whole menu in one import on an empty registry', async () => {
    const reg = scriptedReg(new Map(), tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Added Directory\shell\ContextHelper`,
      String.raw`Added *\shell\ContextHelper`,
      String.raw`Added Directory\Background\shell\ContextHelper`,
      String.raw`Added Directory\ContextHelperRoot`,
      String.raw`Added Directory\ContextHelperRoot\shell`,
      'Added menu item "Flatten folder"',
    ]);
    const entry = [
      '"MUIVerb"="ContextHelper"',
      String.raw`"Icon"="C:\\Apps\\ContextHelper\\ContextHelper.exe,0"`,
      String.raw`"ExtendedSubCommandsKey"="Directory\\ContextHelperRoot"`,
      '',
    ];
    expect(reg.imports).toEqual([regText(
      `[${k(String.raw`Directory\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`*\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`Directory\Background\shell\ContextHelper`)}]`, ...entry,
      `[${k(String.raw`Directory\ContextHelperRoot`)}]`, '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell`)}]`, '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder`)}]`, '"MUIVerb"="Flatten folder"', '"MultiSelectModel"="Player"', '',
      `[${k(String.raw`Directory\ContextHelperRoot\shell\flatten-folder\command`)}]`,
      String.raw`@="\"C:\\Apps\\ContextHelper\\ContextHelper.exe\" --action=flatten-folder \"%V\""`, '',
    )]);
  });

  it('rewrites only the values that point at the old program location', async () => {
    const reg = scriptedReg(tree(registered(String.raw`C:\Old\ContextHelper.exe`)), tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Fixed Directory\shell\ContextHelper`,
      String.raw`Fixed *\shell\ContextHelper`,
      String.raw`Fixed Directory\Background\shell\ContextHelper`,
      'Fixed menu item "Flatten folder"',
    ]);
    expect(reg.imports[0]).toContain(String.raw`@="\"C:\\Apps\\ContextHelper\\ContextHelper.exe\" --action=flatten-folder \"%V\""`);
    expect(reg.imports[0]).not.toContain('MultiSelectModel');
  });

  it('removes unexpected values, stale plugins and legacy keys', async () => {
    const entryKey = k(String.raw`Directory\shell\ContextHelper`);
    const before = tree({
      ...registered(),
      [entryKey]: { ...registered()[entryKey], SubCommands: '' },
      [k(String.raw`Directory\ContextHelperRoot\shell\old-plugin`)]: { MUIVerb: 'Old' },
      [k(String.raw`Directory\ContextHelperRoot\shell\old-plugin\command`)]: { '': 'old' },
      [k(String.raw`Directory\ContextHelperFolders`)]: {},
      [k(String.raw`Directory\ContextHelperFolders\shell`)]: {},
    });
    const reg = scriptedReg(before, tree(registered()));
    const result = await sync(reg);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      String.raw`Fixed Directory\shell\ContextHelper`,
      'Removed stale menu item "old-plugin"',
      String.raw`Removed Directory\ContextHelperFolders`,
    ]);
    expect(reg.imports).toEqual([regText(
      `[-${k(String.raw`Directory\ContextHelperRoot\shell\old-plugin`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFolders`)}]`, '',
      `[${entryKey}]`, '"SubCommands"=-', '',
    )]);
  });

  it('reports what still differs when the written values do not stick', async () => {
    const reg = scriptedReg(new Map());
    const result = await sync(reg);
    expect(result.ok).toBe(false);
    expect(result.error).toBeNull();
    expect(result.remainingLines).toContain('Added menu item "Flatten folder"');
    expect(result.exportErrors).toContain(`missing ${k(String.raw`Directory\ContextHelperFolders`)}`);
  });

  it('returns the import error instead of throwing', async () => {
    const reg = {
      exportKey: async () => ({ tree: new Map(), error: 'missing' }),
      importFile: async () => { throw new Error('reg import exited 1: ERROR: Access is denied.'); },
    };
    const result = await sync(reg);
    expect(result).toMatchObject({ ok: false, error: 'reg import exited 1: ERROR: Access is denied.' });
    expect(result.remaining).toHaveLength(result.changes.length);
    expect(result.remainingLines).toContain('Added menu item "Flatten folder"');
  });

  it('reads the real menu location when no root is given', async () => {
    const reg = scriptedReg(new Map());
    await syncMenu({ exePath: EXE, manifests: MANIFESTS, reg });
    expect(reg.exported[0]).toBe(String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`);
  });
});

describe('unregisterMenu', () => {
  it('deletes every owned and legacy key in one import', async () => {
    const reg = scriptedReg(tree(registered()), new Map());
    expect(await unregisterMenu({ reg, root: ROOT })).toEqual({ ok: true, remaining: [], error: null });
    expect(reg.imports).toEqual([regText(
      `[-${k(String.raw`Directory\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`*\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`Directory\Background\shell\ContextHelper`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperRoot`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFolders`)}]`, '',
      `[-${k(String.raw`Directory\ContextHelperFiles`)}]`, '',
    )]);
  });

  it('lists the outermost keys that survived', async () => {
    const result = await unregisterMenu({ reg: scriptedReg(tree(registered())), root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([
      k(String.raw`Directory\shell\ContextHelper`),
      k(String.raw`*\shell\ContextHelper`),
      k(String.raw`Directory\Background\shell\ContextHelper`),
      k(String.raw`Directory\ContextHelperRoot`),
    ]);
  });

  it('returns the import error instead of throwing', async () => {
    const reg = { exportKey: async () => ({ tree: new Map(), error: null }), importFile: async () => { throw new Error('denied'); } };
    expect(await unregisterMenu({ reg, root: ROOT })).toMatchObject({ ok: false, error: 'denied' });
  });

  it('deletes the real menu location when no root is given', async () => {
    const reg = scriptedReg(new Map());
    await unregisterMenu({ reg });
    expect(reg.imports[0]).toContain(String.raw`[-HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperRoot]`);
  });
});
