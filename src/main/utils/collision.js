function splitExt(name) {
  // Treat leading dot (dotfile) as part of base name, not extension.
  // Find last '.' that is not at position 0.
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

function resolveCollision(desiredName, takenSet) {
  if (!takenSet.has(desiredName)) return desiredName;
  const { base, ext } = splitExt(desiredName);
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new Error(`resolveCollision: gave up after 10000 attempts for "${desiredName}"`);
}

module.exports = { resolveCollision };
