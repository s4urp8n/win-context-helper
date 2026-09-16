const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildFlattenFixture() {
  const dir = mkdtemp('ch-smoke-flatten-');
  const layout = {
    'a/1.txt': '1',
    'a/b/2.txt': '2',
    'a/b/c/3.txt': '3',
    'collision/photo.jpg': 'A',
    'other/photo.jpg': 'B',
  };
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// Three levels of 95-character folder names: joined, the name passes the 255-character limit.
function buildLongNamesFixture() {
  const dir = mkdtemp('ch-smoke-long-');
  const long = (tag) => `${tag} ${'x'.repeat(93)}`;
  const layout = {
    [`${long('A')}/short.txt`]: 'a',
    [`${long('B')}/${long('C')}/${long('D')}/deep.txt`]: 'deep',
    [`${long('E')}/other.txt`]: 'e',
  };
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

module.exports = { buildFlattenFixture, buildLongNamesFixture };
