const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAll } = require('../../src/main/registry/plugin-loader');

function mkPlugin(root, id, sourceJs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.js'), sourceJs);
  return dir;
}

const VALID_CLASS_SRC = (id = 'p1') => `
const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
class P extends BasePlugin {
  static get manifest() {
    return { id: ${JSON.stringify(id)}, label: 'L', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'dialog' };
  }
  async preflight() { return { folders: [], totalFiles: 0, totalCollisions: 0 }; }
  async run() { return { ok: true, processed: 0, skipped: 0, errors: [] }; }
}
module.exports = P;
`;

describe('plugin-loader', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-loader-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('loads a valid class plugin', () => {
    mkPlugin(tmp, 'p1', VALID_CLASS_SRC('p1'));
    const reg = loadAll(tmp);
    const entry = reg.get('p1');
    expect(entry).toBeDefined();
    expect(entry.manifest.id).toBe('p1');
    expect(typeof entry.Cls).toBe('function');
    expect(entry.dir).toBe(path.join(tmp, 'p1'));
  });

  it('ignores subdirectories without plugin.js', () => {
    fs.mkdirSync(path.join(tmp, 'empty'));
    const reg = loadAll(tmp);
    expect(reg.size).toBe(0);
  });

  it('throws when plugin.js has a syntax error', () => {
    mkPlugin(tmp, 'broken', 'class { syntax error');
    expect(() => loadAll(tmp)).toThrow(/Plugin "broken"/);
  });

  it('throws when plugin export is not a function', () => {
    mkPlugin(tmp, 'notfn', 'module.exports = { foo: 1 };');
    expect(() => loadAll(tmp)).toThrow(/Plugin "notfn".*class/i);
  });

  it('throws when static manifest is missing', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin { async preflight() {} async run() {} }
      module.exports = P;
    `;
    mkPlugin(tmp, 'nomanifest', src);
    expect(() => loadAll(tmp)).toThrow(/manifest/);
  });

  it('throws when manifest id mismatches folder name', () => {
    mkPlugin(tmp, 'p1', VALID_CLASS_SRC('WRONG'));
    expect(() => loadAll(tmp)).toThrow(/id mismatch/i);
  });

  it('throws when manifest is missing required fields', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin {
        static get manifest() { return { id: 'p1' }; }
        async preflight() {} async run() {}
      }
      module.exports = P;
    `;
    mkPlugin(tmp, 'p1', src);
    expect(() => loadAll(tmp)).toThrow(/label/);
  });

  it('throws on invalid ui value', () => {
    const src = `
      const { BasePlugin } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/base-plugin'))});
      class P extends BasePlugin {
        static get manifest() {
          return { id: 'p1', label: 'L', description: 'D', accepts: ['folders'], minSelection: 1, maxSelection: 1, ui: 'invalid' };
        }
        async preflight() {} async run() {}
      }
      module.exports = P;
    `;
    mkPlugin(tmp, 'p1', src);
    expect(() => loadAll(tmp)).toThrow(/ui.*must be/i);
  });
});
