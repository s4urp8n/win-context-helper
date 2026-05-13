const { safeHook } = require('../../src/main/runners/safe-hook');

describe('safeHook', () => {
  it('returns override result when plugin defines the hook', () => {
    const plugin = { greet: (name) => `hello ${name}` };
    const logger = { error: () => {} };
    const out = safeHook(plugin, 'greet', (name) => `default ${name}`, logger, 'world');
    expect(out).toBe('hello world');
  });

  it('falls back to default when plugin does not define the hook', () => {
    const plugin = {};
    const logger = { error: () => {} };
    const out = safeHook(plugin, 'greet', (name) => `default ${name}`, logger, 'world');
    expect(out).toBe('default world');
  });

  it('falls back to default and logs when override throws', () => {
    const plugin = {
      constructor: { name: 'BadPlugin' },
      boom: () => { throw new Error('oops'); },
    };
    const logged = [];
    const logger = { error: (msg, meta) => logged.push({ msg, meta }) };
    const out = safeHook(plugin, 'boom', () => 'default', logger);
    expect(out).toBe('default');
    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toMatch(/hook threw/);
    expect(logged[0].meta).toMatchObject({ plugin: 'BadPlugin', hook: 'boom', message: 'oops' });
  });
});
