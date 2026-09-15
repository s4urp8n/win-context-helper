const { CLASSES_ROOT, desiredState, ownedRoots, legacyKeys } = require('./entries');
const { serialize } = require('./reg-file');

const PLUGIN_KEY = /^Directory\\ContextHelperRoot\\shell\\([^\\]+)/i;
const lower = (text) => text.toLowerCase();

// Deleting a key removes its subtree, so only keys without a deleted ancestor matter.
const outermostKeys = (keys) => keys.filter((key) => !keys.some((other) => lower(key).startsWith(`${lower(other)}\\`)));

async function readState(reg, root) {
  const actual = new Map();
  const exportErrors = [];
  for (const key of [...ownedRoots(root), ...legacyKeys(root)]) {
    const { tree, error } = await reg.exportKey(key);
    if (error) exportErrors.push(error);
    for (const [name, values] of tree) actual.set(name, values);
  }
  return { actual, exportErrors };
}

// Registry key and value names are case-insensitive.
function diff(desired, actual) {
  const have = new Map();
  for (const [key, values] of actual) {
    have.set(lower(key), { key, values: new Map([...values].map(([name, data]) => [lower(name), { name, data }])) });
  }
  const changes = [];
  for (const [key, values] of desired) {
    const current = have.get(lower(key));
    if (!current && values.size === 0) changes.push({ kind: 'createKey', key });
    for (const [name, data] of values) {
      const found = current && current.values.get(lower(name));
      if (!found || found.data !== data) changes.push({ kind: 'set', key, name, data, actual: found ? found.data : null });
    }
    if (!current) continue;
    const wanted = new Set([...values.keys()].map(lower));
    for (const { name, data } of current.values.values()) {
      if (!wanted.has(lower(name))) changes.push({ kind: 'deleteValue', key, name, actual: data });
    }
  }
  const desiredKeys = new Set([...desired.keys()].map(lower));
  for (const { key } of have.values()) {
    if (!desiredKeys.has(lower(key))) changes.push({ kind: 'deleteKey', key });
  }
  return changes;
}

function toRegFile(changes) {
  const sets = new Map();
  const deleteValues = new Map();
  const deleteKeys = [];
  const bucket = (map, key, make) => map.get(key) || map.set(key, make()).get(key);
  for (const change of changes) {
    if (change.kind === 'deleteKey') deleteKeys.push(change.key);
    else if (change.kind === 'deleteValue') bucket(deleteValues, change.key, () => []).push(change.name);
    else {
      const values = bucket(sets, change.key, () => new Map());
      if (change.kind === 'set') values.set(change.name, change.data);
    }
  }
  return serialize({ sets, deleteValues, deleteKeys: outermostKeys(deleteKeys) });
}

// One line per plugin or per key, e.g. `Added menu item "Flatten folder"`.
function summarize(changes, root, labels) {
  const deleted = outermostKeys(changes.filter((c) => c.kind === 'deleteKey').map((c) => c.key));
  const groups = new Map();
  for (const change of changes) {
    if (change.kind === 'deleteKey' && !deleted.includes(change.key)) continue;
    const relative = change.key.slice(root.length + 1);
    const plugin = PLUGIN_KEY.exec(relative);
    const id = plugin ? `plugin:${lower(plugin[1])}` : `key:${lower(relative)}`;
    if (!groups.has(id)) groups.set(id, { pluginId: plugin && plugin[1], relative, changes: [] });
    groups.get(id).changes.push(change);
  }
  return [...groups.values()].map(({ pluginId, relative, changes: group }) => {
    const added = group.every((c) => (c.kind === 'set' || c.kind === 'createKey') && c.actual == null);
    if (pluginId) {
      const label = labels.get(lower(pluginId));
      if (!label) return `Removed stale menu item "${pluginId}"`;
      return `${added ? 'Added' : 'Fixed'} menu item "${label}"`;
    }
    if (group.some((c) => c.kind === 'deleteKey')) return `Removed ${relative}`;
    return `${added ? 'Added' : 'Fixed'} ${relative}`;
  });
}

async function syncMenu({ exePath, manifests, reg, root = CLASSES_ROOT }) {
  const desired = desiredState({ exePath, manifests, root });
  const labels = new Map(manifests.map((m) => [lower(m.id), m.label]));
  const before = await readState(reg, root);
  const changes = diff(desired, before.actual);
  const lines = summarize(changes, root, labels);
  if (changes.length === 0) {
    return { ok: true, changes, lines, remaining: [], remainingLines: [], error: null, exportErrors: [] };
  }
  try {
    await reg.importFile(toRegFile(changes));
  } catch (err) {
    return { ok: false, changes, lines, remaining: changes, remainingLines: lines, error: err.message, exportErrors: before.exportErrors };
  }
  const after = await readState(reg, root);
  const remaining = diff(desired, after.actual);
  return {
    ok: remaining.length === 0,
    changes,
    lines,
    remaining,
    remainingLines: summarize(remaining, root, labels),
    error: null,
    exportErrors: after.exportErrors,
  };
}

async function unregisterMenu({ reg, root = CLASSES_ROOT }) {
  const keys = [...ownedRoots(root), ...legacyKeys(root)];
  try {
    await reg.importFile(serialize({ deleteKeys: keys }));
  } catch (err) {
    return { ok: false, remaining: keys, error: err.message };
  }
  const { actual } = await readState(reg, root);
  const remaining = outermostKeys([...actual.keys()]);
  return { ok: remaining.length === 0, remaining, error: null };
}

module.exports = { syncMenu, unregisterMenu };
