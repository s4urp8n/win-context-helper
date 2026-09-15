const fs = require('node:fs');
const { createReg, createRunner } = require('../../src/main/shell-menu/reg');
const { encode } = require('../../src/main/shell-menu/reg-file');

describe('shell-menu reg', () => {
  it('exportKey runs reg export into a temp file, parses it and deletes the file', async () => {
    const calls = [];
    const reg = createReg({
      runReg: async (args) => {
        calls.push(args);
        fs.writeFileSync(args[2], encode('Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\T\\k]\r\n"MUIVerb"="Flatten folder"\r\n'));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const { tree, error } = await reg.exportKey('HKEY_CURRENT_USER\\T\\k');
    expect(error).toBeNull();
    expect(Object.fromEntries(tree.get('HKEY_CURRENT_USER\\T\\k'))).toEqual({ MUIVerb: 'Flatten folder' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('export');
    expect(calls[0][1]).toBe('HKEY_CURRENT_USER\\T\\k');
    expect(calls[0][2]).toMatch(/\.reg$/);
    expect(calls[0][3]).toBe('/y');
    expect(fs.existsSync(calls[0][2])).toBe(false);
  });

  it('exportKey returns an empty tree with the reg.exe message when export fails', async () => {
    const reg = createReg({ runReg: async () => ({ code: 1, stdout: '', stderr: 'ERROR: not found\r\n' }) });
    const { tree, error } = await reg.exportKey('HKEY_CURRENT_USER\\T\\missing');
    expect(tree.size).toBe(0);
    expect(error).toBe('ERROR: not found');
  });

  it('exportKey reports the exit code when reg.exe prints nothing', async () => {
    const reg = createReg({ runReg: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect((await reg.exportKey('HKEY_CURRENT_USER\\T\\missing')).error).toBe('reg export exited 1');
  });

  it('importFile writes UTF-16 text to a temp file, runs reg import and deletes the file', async () => {
    let seen = null;
    const reg = createReg({
      runReg: async (args) => {
        seen = { args, bytes: fs.readFileSync(args[1]) };
        return { code: 0, stdout: '', stderr: 'The operation completed successfully.' };
      },
    });
    await reg.importFile('Windows Registry Editor Version 5.00\r\n');
    expect(seen.args[0]).toBe('import');
    expect(seen.args).toHaveLength(2);
    expect([...seen.bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x57, 0x00]);
    expect(fs.existsSync(seen.args[1])).toBe(false);
  });

  it('importFile throws with the exit code and stderr, and still deletes the file', async () => {
    let file = null;
    const reg = createReg({
      runReg: async (args) => { file = args[1]; return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' }; },
    });
    await expect(reg.importFile('x')).rejects.toMatchObject({ exitCode: 1, stderr: 'ERROR: Access is denied.' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('createRunner reports an executable that cannot start as code -1', async () => {
    const result = await createRunner('contexthelper-no-such-reg.exe')(['query']);
    expect(result.code).toBe(-1);
    expect(result.stderr).toMatch(/ENOENT/);
  });

  it.runIf(process.platform === 'win32')('createRunner returns the exit code of the real reg.exe', async () => {
    const result = await createRunner()(['query', 'HKCU\\Software\\ContextHelperDefinitelyMissingKey']);
    expect(result.code).toBe(1);
  });
});
