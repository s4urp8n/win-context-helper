function parseCli(argv) {
  if (!Array.isArray(argv)) throw new Error('parseCli: argv must be an array');
  if (argv.length === 0) return { kind: 'none' };

  const flags = {};
  const targets = [];
  for (const arg of argv) {
    if (arg === '--register' || arg === '--unregister') {
      if (argv.length !== 1) throw new Error(`parseCli: ${arg} cannot be combined with other arguments`);
      return { kind: arg.slice(2) };
    }
    if (!arg.startsWith('--')) {
      // positional → target
      targets.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) throw new Error(`parseCli: flag "${arg}" missing "=value"`);
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'target') {
      targets.push(value);
      continue;
    }
    if (key !== 'action') {
      throw new Error(`parseCli: unknown flag --${key}`);
    }
    flags[key] = value;
  }

  if (!flags.action) throw new Error('parseCli: --action is required');
  if (targets.length === 0) throw new Error('parseCli: at least one target is required');
  return { kind: 'run', action: flags.action, targets };
}

module.exports = { parseCli };
