const path = require('node:path');
const { BrowserWindow } = require('electron');

function createPluginWindow({ manifest }) {
  return new BrowserWindow({
    width: 560,
    height: 480,
    title: 'ContextHelper — ' + manifest.label,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'plugin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
}

function createSpinnerWindow({ label = 'Working…' } = {}) {
  const win = new BrowserWindow({
    width: 320, height: 100, frame: false, resizable: false,
    minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  const file = path.join(__dirname, '..', 'renderer', 'spinner.html');
  const url = `file://${file.replace(/\\/g, '/')}?label=${encodeURIComponent(label)}`;
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  return win;
}

function createShellWindow() {
  const win = new BrowserWindow({
    width: 460, height: 180,
    useContentSize: true,
    frame: false, resizable: false,
    minimizable: true, maximizable: false,
    alwaysOnTop: true, skipTaskbar: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // need preload with require()
    },
  });
  win.removeMenu();
  const file = path.join(__dirname, '..', 'renderer', 'shell.html');
  win.loadFile(file);
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = { createPluginWindow, createSpinnerWindow, createShellWindow };
