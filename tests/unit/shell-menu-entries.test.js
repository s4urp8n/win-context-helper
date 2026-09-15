const { desiredState, ownedRoots, legacyKeys } = require('../../src/main/shell-menu/entries');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));

describe('shell-menu entries', () => {
  const exePath = String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe`;

  it('describes the entry points, the menu root and one item per plugin', () => {
    const state = desiredState({
      exePath,
      root: String.raw`HKEY_CURRENT_USER\T`,
      manifests: [{ id: 'merge-pdf', label: 'Merge PDF' }, { id: 'flatten-folder', label: 'Flatten folder' }],
    });
    const entry = {
      MUIVerb: 'ContextHelper',
      Icon: String.raw`C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe,0`,
      ExtendedSubCommandsKey: String.raw`Directory\ContextHelperRoot`,
    };
    expect(toObject(state)).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\Directory\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\*\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\Directory\Background\shell\ContextHelper`]: entry,
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder`]: { MUIVerb: 'Flatten folder', MultiSelectModel: 'Player' },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command`]: {
        '': String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=flatten-folder "%V"`,
      },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\merge-pdf`]: { MUIVerb: 'Merge PDF', MultiSelectModel: 'Player' },
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\merge-pdf\command`]: {
        '': String.raw`"C:\Users\Иван Петров\AppData\Local\Programs\ContextHelper\ContextHelper.exe" --action=merge-pdf "%V"`,
      },
    });
  });

  it('targets the current user classes root by default', () => {
    expect([...desiredState({ exePath, manifests: [] }).keys()][0])
      .toBe(String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`);
  });

  it('lists the keys it owns and the legacy keys it removes', () => {
    expect(ownedRoots()).toEqual([
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\*\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\ContextHelper`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperRoot`,
    ]);
    expect(legacyKeys()).toEqual([
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperFolders`,
      String.raw`HKEY_CURRENT_USER\Software\Classes\Directory\ContextHelperFiles`,
    ]);
  });
});
