const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_FIELDS = ['id', 'label', 'description', 'accepts', 'minSelection', 'maxSelection'];

function validateManifest(manifest, folderName) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Plugin "${folderName}": static manifest must be an object`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`Plugin "${folderName}": manifest missing required field "${field}"`);
    }
  }
  if (typeof manifest.label !== 'string' || manifest.label.length === 0) {
    throw new Error(`Plugin "${folderName}": "label" must be a non-empty string`);
  }
  if (typeof manifest.description !== 'string') {
    throw new Error(`Plugin "${folderName}": "description" must be a string`);
  }
  if (!Number.isInteger(manifest.minSelection) || manifest.minSelection < 1) {
    throw new Error(`Plugin "${folderName}": "minSelection" must be a positive integer`);
  }
  if (!Number.isInteger(manifest.maxSelection) || manifest.maxSelection < manifest.minSelection) {
    throw new Error(`Plugin "${folderName}": "maxSelection" must be an integer ≥ minSelection`);
  }
  if (manifest.id !== folderName) {
    throw new Error(`Plugin "${folderName}": id mismatch (manifest says "${manifest.id}")`);
  }
  if (!Array.isArray(manifest.accepts) || manifest.accepts.length === 0) {
    throw new Error(`Plugin "${folderName}": "accepts" must be a non-empty array`);
  }
  for (const pattern of manifest.accepts) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error(`Plugin "${folderName}": "accepts" entries must be non-empty strings`);
    }
  }
  if (manifest.ui !== undefined && manifest.ui !== 'window' && manifest.ui !== 'dialog') {
    throw new Error(`Plugin "${folderName}": "ui" must be "window" or "dialog" (got ${JSON.stringify(manifest.ui)})`);
  }
}

function loadAll(pluginsDir) {
  const registry = new Map();
  if (!fs.existsSync(pluginsDir)) return registry;
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginPath = path.join(pluginsDir, entry.name, 'plugin.js');
    if (!fs.existsSync(pluginPath)) continue;
    let Cls;
    try {
      delete require.cache[require.resolve(pluginPath)];
      Cls = require(pluginPath);
    } catch (err) {
      throw new Error(`Plugin "${entry.name}": failed to load — ${err.message}`);
    }
    if (typeof Cls !== 'function' || !Cls.prototype || typeof Cls.prototype.run !== 'function') {
      throw new Error(`Plugin "${entry.name}": does not export a class with run()`);
    }
    let manifest;
    try {
      manifest = Cls.manifest;
    } catch (err) {
      throw new Error(`Plugin "${entry.name}": reading static manifest threw — ${err.message}`);
    }
    validateManifest(manifest, entry.name);
    const normalized = { ...manifest, ui: manifest.ui || 'window' };
    registry.set(manifest.id, {
      Cls,
      manifest: normalized,
      dir: path.join(pluginsDir, entry.name),
    });
  }
  return registry;
}

module.exports = { loadAll, validateManifest };
