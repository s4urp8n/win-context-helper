const fs = require('node:fs');
const path = require('node:path');
const { app, Menu, dialog } = require('electron');
const { parseCli } = require('./cli');
const { loadAll } = require('./registry/plugin-loader');
const { aggregateTargets } = require('./named-pipe');
const { classify } = require('./selection/classify');
const { validate } = require('./selection/validate');
const { runPreflight, runWorker } = require('./worker-runner');
const { runDialogPlugin } = require('./runners/dialog-runner');
const { runWindowPlugin, readUiHtmlFromDisk, makeShellController } = require('./runners/window-runner');
const { createSpinnerWindow, createShellWindow } = require('./window-manager');
const { createReg } = require('./shell-menu/reg');
const { syncMenu, unregisterMenu } = require('./shell-menu/sync');
const { describeMenuStatus } = require('./shell-menu/status-view');
const { dispatch } = require('./dispatcher');
const logger = require('./logger');
const { ipcMain } = require('electron');

const PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');

function createRunner(uiMode) {
  if (uiMode === 'dialog') {
    return {
      execute: (ctx) => runDialogPlugin({
        ...ctx,
        openShell: () => createShellWindow(),
        ipcMain,
        runPreflight,
        runWorker,
        logger,
      }),
    };
  }
  return {
    execute: (ctx) => runWindowPlugin({
      ...ctx,
      openShell: () => createShellWindow(),
      ipcMain,
      runPreflight,
      runWorker,
      readUiHtml: readUiHtmlFromDisk,
      logger,
    }),
  };
}

async function showMenuStatus(result, { itemCount }) {
  const shellWindow = createShellWindow();
  const shell = makeShellController({ shellWindow, ipcMain });
  await new Promise((resolve) => shell.onReady(resolve));
  shell.sendState(describeMenuStatus(result, { exePath: process.execPath, itemCount, logDir: logger.LOG_ROOT }));
  await shell.waitForAction();
  shell.close();
}

async function main() {
  Menu.setApplicationMenu(null);
  logger.pruneOld();
  const argv = process.argv.slice(process.defaultApp ? 2 : 1);
  const code = await dispatch({ argv }, {
    parseCli, loadAll, aggregateTargets, classify, validate, createRunner,
    dialog, fs, logger, pluginsDir: PLUGINS_DIR,
    isPackaged: app.isPackaged,
    syncShellMenu: ({ manifests }) => syncMenu({ exePath: process.execPath, manifests, reg: createReg() }),
    unregisterShellMenu: () => unregisterMenu({ reg: createReg() }),
    showMenuStatus,
  });
  logger.info('main: exit', { code });
  app.exit(code);
}

app.whenReady().then(main).catch((err) => {
  logger.error('fatal startup error', { message: err.message, stack: err.stack });
  app.exit(3);
});

app.on('window-all-closed', () => { /* do not auto-quit — runners drive lifecycle */ });
