const FlattenFolder = require('../flatten-folder/plugin');

class FlattenFolderKeepOrder extends FlattenFolder {
  constructor() {
    super({ keepOrder: true });
  }

  static get manifest() {
    return {
      ...FlattenFolder.manifest,
      id: 'flatten-folder-keep-order',
      label: 'Flatten folder (keep order)',
      description: 'Move nested files into the root, prefixing each name with its folder path',
    };
  }
}

module.exports = FlattenFolderKeepOrder;
