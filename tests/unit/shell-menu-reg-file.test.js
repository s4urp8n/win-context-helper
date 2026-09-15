const { serialize, parse, encode, decode } = require('../../src/main/shell-menu/reg-file');

const toObject = (tree) => Object.fromEntries([...tree].map(([key, values]) => [key, Object.fromEntries(values)]));
const regText = (...lines) => ['Windows Registry Editor Version 5.00', '', ...lines].join('\r\n');

describe('reg-file serialize', () => {
  it('writes the default value as @ and escapes backslashes and quotes', () => {
    const sets = new Map([[String.raw`HKEY_CURRENT_USER\T\shell\p\command`, new Map([
      ['', String.raw`"C:\Program Files\ContextHelper.exe" --action=p "%V"`],
      ['MUIVerb', 'Flatten folder'],
    ])]]);
    expect(serialize({ sets })).toBe(regText(
      String.raw`[HKEY_CURRENT_USER\T\shell\p\command]`,
      String.raw`@="\"C:\\Program Files\\ContextHelper.exe\" --action=p \"%V\""`,
      '"MUIVerb"="Flatten folder"',
      '',
    ));
  });

  it('writes key deletions first, then value deletions and empty keys', () => {
    const text = serialize({
      deleteKeys: [String.raw`HKEY_CURRENT_USER\T\stale`],
      deleteValues: new Map([[String.raw`HKEY_CURRENT_USER\T\entry`, ['SubCommands']]]),
      sets: new Map([[String.raw`HKEY_CURRENT_USER\T\empty`, new Map()]]),
    });
    expect(text).toBe(regText(
      String.raw`[-HKEY_CURRENT_USER\T\stale]`,
      '',
      String.raw`[HKEY_CURRENT_USER\T\entry]`,
      '"SubCommands"=-',
      '',
      String.raw`[HKEY_CURRENT_USER\T\empty]`,
      '',
    ));
  });
});

describe('reg-file parse', () => {
  it('reads a file exported by reg.exe', () => {
    const exported = regText(
      String.raw`[HKEY_CURRENT_USER\T\Directory\ContextHelperRoot]`,
      '',
      String.raw`[HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command]`,
      String.raw`@="\"C:\\Users\\Иван Петров\\ContextHelper.exe\" --action=flatten-folder \"%V\""`,
      '"MultiSelectModel"="Player"',
      '',
    );
    expect(toObject(parse(exported))).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot`]: {},
      [String.raw`HKEY_CURRENT_USER\T\Directory\ContextHelperRoot\shell\flatten-folder\command`]: {
        '': String.raw`"C:\Users\Иван Петров\ContextHelper.exe" --action=flatten-folder "%V"`,
        MultiSelectModel: 'Player',
      },
    });
  });

  it('keeps non-string values as written, joins wrapped lines and ignores stray lines', () => {
    const text = regText(
      '"Orphan"="no key yet"',
      String.raw`[HKEY_CURRENT_USER\T\k]`,
      '"Flag"=dword:00000001',
      '"Bin"=hex:01,02,\\',
      '  03,04',
      'garbage',
      '',
    );
    expect(toObject(parse(text))).toEqual({
      [String.raw`HKEY_CURRENT_USER\T\k`]: { Flag: 'dword:00000001', Bin: 'hex:01,02,03,04' },
    });
  });

  it('parses back what serialize writes, including quotes and backslashes', () => {
    const sets = new Map([[String.raw`HKEY_CURRENT_USER\T\k`, new Map([
      ['we"ird\\name', String.raw`a"b\c\\d`],
      ['', ''],
    ])]]);
    expect(toObject(parse(serialize({ sets })))).toEqual(toObject(sets));
  });
});

describe('reg-file encoding', () => {
  it('encodes as UTF-16LE with a byte order mark', () => {
    expect([...encode('Ж')]).toEqual([0xff, 0xfe, 0x16, 0x04]);
  });

  it('decode strips the byte order mark', () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x16, 0x04]))).toBe('Ж');
  });
});
