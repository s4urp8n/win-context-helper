const LONG_PREFIX = '\\\\?\\';
const UNC_LONG_PREFIX = '\\\\?\\UNC\\';

function toLongPath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('toLongPath: expected non-empty string');
  }
  const normalised = p.replace(/\//g, '\\');
  if (normalised.startsWith(LONG_PREFIX)) return normalised;
  if (normalised.startsWith('\\\\')) {
    // UNC: \\server\share\... → \\?\UNC\server\share\...
    return UNC_LONG_PREFIX + normalised.slice(2);
  }
  if (/^[A-Za-z]:[\\/]/.test(normalised)) {
    return LONG_PREFIX + normalised;
  }
  throw new Error(`toLongPath: expected absolute path, got "${p}"`);
}

function fromLongPath(p) {
  if (p.startsWith(UNC_LONG_PREFIX)) return '\\\\' + p.slice(UNC_LONG_PREFIX.length);
  if (p.startsWith(LONG_PREFIX)) return p.slice(LONG_PREFIX.length);
  return p;
}

module.exports = { toLongPath, fromLongPath };
