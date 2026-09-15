// The Explorer menu ContextHelper registers, as registry keys and REG_SZ values.
const CLASSES_ROOT = 'HKEY_CURRENT_USER\\Software\\Classes';
const MENU_ROOT = 'Directory\\ContextHelperRoot';
const ENTRY_POINTS = [
  'Directory\\shell\\ContextHelper',
  '*\\shell\\ContextHelper',
  'Directory\\Background\\shell\\ContextHelper',
];
const LEGACY_KEYS = ['Directory\\ContextHelperFolders', 'Directory\\ContextHelperFiles'];

function desiredState({ exePath, manifests, root = CLASSES_ROOT }) {
  const key = (relative) => `${root}\\${relative}`;
  const state = new Map();
  for (const entry of ENTRY_POINTS) {
    state.set(key(entry), new Map([
      ['MUIVerb', 'ContextHelper'],
      ['Icon', `${exePath},0`],
      ['ExtendedSubCommandsKey', MENU_ROOT],
    ]));
  }
  state.set(key(MENU_ROOT), new Map());
  state.set(key(`${MENU_ROOT}\\shell`), new Map());
  for (const m of [...manifests].sort((a, b) => a.id.localeCompare(b.id))) {
    state.set(key(`${MENU_ROOT}\\shell\\${m.id}`), new Map([['MUIVerb', m.label], ['MultiSelectModel', 'Player']]));
    state.set(key(`${MENU_ROOT}\\shell\\${m.id}\\command`), new Map([['', `"${exePath}" --action=${m.id} "%V"`]]));
  }
  return state;
}

// Keys whose whole subtree ContextHelper owns: anything inside that is not desired gets removed.
const ownedRoots = (root = CLASSES_ROOT) => [...ENTRY_POINTS, MENU_ROOT].map((k) => `${root}\\${k}`);
const legacyKeys = (root = CLASSES_ROOT) => LEGACY_KEYS.map((k) => `${root}\\${k}`);

module.exports = { CLASSES_ROOT, desiredState, ownedRoots, legacyKeys };
