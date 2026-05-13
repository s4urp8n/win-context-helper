const path = require('node:path');

describe('bin-paths', () => {
  let originalResourcesPath;
  beforeEach(() => {
    originalResourcesPath = process.resourcesPath;
    delete require.cache[require.resolve('../../src/main/utils/bin-paths')];
  });
  afterEach(() => {
    if (originalResourcesPath === undefined) delete process.resourcesPath;
    else process.resourcesPath = originalResourcesPath;
    delete require.cache[require.resolve('../../src/main/utils/bin-paths')];
  });

  it('binDir uses process.resourcesPath/bin when defined', () => {
    process.resourcesPath = 'C:\\fake\\resources';
    const { binDir } = require('../../src/main/utils/bin-paths');
    expect(binDir()).toBe(path.join('C:\\fake\\resources', 'bin'));
  });

  it('binDir falls back to repo-root resources/bin in dev', () => {
    delete process.resourcesPath;
    const { binDir } = require('../../src/main/utils/bin-paths');
    expect(binDir().endsWith(path.join('resources', 'bin'))).toBe(true);
  });

  it('binPath joins binDir with the tool name', () => {
    process.resourcesPath = 'C:\\fake\\resources';
    const { binPath } = require('../../src/main/utils/bin-paths');
    expect(binPath('7z.exe')).toBe(path.join('C:\\fake\\resources', 'bin', '7z.exe'));
  });
});
