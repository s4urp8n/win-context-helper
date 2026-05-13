const { generateRegisterBat } = require('../../scripts/gen-register-bat');

const flatten = { id: 'flatten-folder', label: 'Flatten folder', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
const mergePdf = { id: 'merge-pdf', label: 'Merge PDF', accepts: ['files:.pdf'], minSelection: 2, maxSelection: 999, ui: 'dialog' };
const rename = { id: 'rename', label: 'Rename', accepts: ['folders', 'files'], minSelection: 1, maxSelection: 999, ui: 'window' };

describe('generateRegisterBat', () => {
  it('writes three top-level entry points', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/HKCU\\Software\\Classes\\Directory\\shell\\ContextHelper/);
    expect(out).toMatch(/HKCU\\Software\\Classes\\\*\\shell\\ContextHelper/);
    expect(out).toMatch(/HKCU\\Software\\Classes\\Directory\\Background\\shell\\ContextHelper/);
  });

  it('all three entry points reference the same ContextHelperRoot', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    const matches = out.match(/ExtendedSubCommandsKey \/t REG_SZ \/d "Directory\\ContextHelperRoot"/g);
    expect(matches).toHaveLength(3);
  });

  it('plugins are emitted flat under ContextHelperRoot (no group keys)', () => {
    const out = generateRegisterBat([flatten, mergePdf], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/Directory\\ContextHelperRoot\\shell\\flatten-folder/);
    expect(out).toMatch(/Directory\\ContextHelperRoot\\shell\\merge-pdf/);
    expect(out).not.toMatch(/ContextHelperRoot\\shell\\Folders/);
    expect(out).not.toMatch(/ContextHelperRoot\\shell\\Files/);
    expect(out).not.toMatch(/ContextHelperFolders/);
    expect(out).not.toMatch(/ContextHelperFiles/);
  });

  it('per-plugin command uses quoted %V and MultiSelectModel=Player', () => {
    const out = generateRegisterBat([flatten], '%~dp0ContextHelper.exe');
    expect(out).toMatch(/MultiSelectModel \/t REG_SZ \/d "Player"/);
    expect(out).toMatch(/--action=flatten-folder \\"%%V\\"/);
  });

  it('plugin accepting both kinds is registered ONCE (no duplication)', () => {
    const out = generateRegisterBat([rename], '%~dp0ContextHelper.exe');
    const matches = out.match(/ContextHelperRoot\\shell\\rename(?![A-Za-z0-9])/g) || [];
    // The path appears multiple times (3 reg add lines), but only under the same shell\\rename path.
    expect(matches.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/ContextHelperFolders/);
    expect(out).not.toMatch(/ContextHelperFiles/);
  });

  it('plugins are sorted alphabetically in output', () => {
    const zip = { id: 'zip-each', label: 'Zip each', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
    const aaa = { id: 'aaa', label: 'Aaa', accepts: ['folders'], minSelection: 1, maxSelection: 999, ui: 'dialog' };
    const out = generateRegisterBat([zip, flatten, aaa], '%~dp0ContextHelper.exe');
    const idxA = out.indexOf('shell\\aaa');
    const idxF = out.indexOf('shell\\flatten-folder');
    const idxZ = out.indexOf('shell\\zip-each');
    expect(idxA).toBeLessThan(idxF);
    expect(idxF).toBeLessThan(idxZ);
  });
});
