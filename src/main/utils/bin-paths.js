const path = require('node:path');

function binDir() {
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(__dirname, '..', '..', '..', 'resources', 'bin');
}

function binPath(name) {
  return path.join(binDir(), name);
}

module.exports = { binDir, binPath };
