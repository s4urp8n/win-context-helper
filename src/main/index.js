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
const { runWindowPlugin, readUiHtmlFromDisk } = require('./runners/window-runner');
const { createSpinnerWindow, createShellWindow } = require('./window-manager');
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

async function main() {
  Menu.setApplicationMenu(null);
  logger.pruneOld();
  const argv = process.argv.slice(process.defaultApp ? 2 : 1);
  const code = await dispatch({ argv }, {
    parseCli, loadAll, aggregateTargets, classify, validate, createRunner,
    dialog, fs, logger, pluginsDir: PLUGINS_DIR,
  });
  logger.info('main: exit', { code });
  app.exit(code);
}

app.whenReady().then(main).catch((err) => {
  logger.error('fatal startup error', { message: err.message, stack: err.stack });
  app.exit(3);
});

app.on('window-all-closed', () => { /* do not auto-quit — runners drive lifecycle */ });
