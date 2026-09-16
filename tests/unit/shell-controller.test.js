const { makeShellController, asBody } = require('../../src/main/runners/shell-controller');

function makeWindow() {
  const ipc = {};
  const win = {};
  const calls = [];
  let size = [460, 180];
  const shellWindow = {
    webContents: {
      send: (channel, payload) => calls.push(['send', channel, payload]),
      once: (event, cb) => { if (event === 'did-finish-load') cb(); },
    },
    on: (event, fn) => { win[event] = fn; },
    destroy: () => calls.push(['destroy']),
    minimize: () => calls.push(['minimize']),
    getContentSize: () => size,
    setContentSize: (w, h) => { calls.push(['size', w, h]); size = [w, h]; },
    center: () => calls.push(['center']),
  };
  const ipcMain = {
    on: (channel, fn) => { ipc[channel] = fn; },
    removeListener: (channel) => { delete ipc[channel]; },
  };
  const shell = makeShellController({ shellWindow, ipcMain });
  return { shell, ipc, win, calls };
}

describe('makeShellController', () => {
  it('resolves the action payload sent by the renderer', async () => {
    const { shell, ipc } = makeWindow();
    const pending = shell.waitForAction();
    ipc['shell:action']({}, { action: 'start', options: { q: 1 } });
    expect(await pending).toEqual({ action: 'start', options: { q: 1 } });
  });

  it('treats the close button as cancel and destroys the window', async () => {
    const { shell, ipc, calls } = makeWindow();
    shell.sendState({ state: 'confirm', message: 'Go?' });
    const pending = shell.waitForAction();
    ipc['shell:close']();
    expect(await pending).toEqual({ action: 'cancel' });
    expect(calls).toContainEqual(['destroy']);
  });

  it('answers cancel at once after the window is gone', async () => {
    const { shell, win } = makeWindow();
    win.closed();
    expect(await shell.waitForAction()).toEqual({ action: 'cancel' });
  });

  it('resolves a pending action with cancel when the window is gone', async () => {
    const { shell, win } = makeWindow();
    const pending = shell.waitForAction();
    win.closed();
    expect(await pending).toEqual({ action: 'cancel' });
  });

  it('ignores the close button while the operation runs', () => {
    const { shell, ipc, calls } = makeWindow();
    shell.sendState({ state: 'running', label: 'Working…' });
    ipc['shell:close']();
    expect(calls).not.toContainEqual(['destroy']);
  });

  it('keeps the window open on Alt+F4 while the operation runs', () => {
    const { shell, win } = makeWindow();
    const event = { preventDefault: vi.fn() };
    shell.sendState({ state: 'running', label: 'Working…' });
    win.close(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('lets the window close once the operation is over', () => {
    const { shell, win, ipc, calls } = makeWindow();
    const event = { preventDefault: vi.fn() };
    shell.sendState({ state: 'running', label: 'Working…' });
    shell.sendState({ state: 'error', message: 'Done with errors' });
    win.close(event);
    ipc['shell:close']();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(calls).toContainEqual(['destroy']);
  });

  it('minimizes on request', () => {
    const { ipc, calls } = makeWindow();
    ipc['shell:min']();
    expect(calls).toContainEqual(['minimize']);
  });

  it('widens and re-centers the window when asked for more width', () => {
    const { ipc, calls } = makeWindow();
    ipc['shell:resize']({}, { height: 400, width: 760 });
    expect(calls).toEqual([['size', 760, 400], ['center']]);
  });

  it('keeps the width when asked only for height, and never narrows', () => {
    const { ipc, calls } = makeWindow();
    ipc['shell:resize']({}, { height: 300 });
    ipc['shell:resize']({}, { height: 250, width: 300 });
    expect(calls).toEqual([['size', 460, 300], ['size', 460, 250]]);
  });

  it('keeps the height within limits and caps the width', () => {
    const { ipc, calls } = makeWindow();
    ipc['shell:resize']({}, { height: 50, width: 5000 });
    ipc['shell:resize']({}, { height: 5000 });
    expect(calls).toEqual([['size', 1000, 180], ['center'], ['size', 1000, 800]]);
  });

  it('survives a window that is already destroyed', () => {
    const { shell, ipc } = makeWindow();
    shell.close();
    expect(() => shell.sendState({ state: 'info' })).not.toThrow();
    expect(ipc['shell:action']).toBeUndefined();
  });

  it('survives a malformed resize request', () => {
    const { ipc, calls } = makeWindow();
    expect(() => ipc['shell:resize']({}, undefined)).not.toThrow();
    expect(calls).toEqual([['size', 460, 180]]);
  });
});

describe('asBody', () => {
  it('turns text into the detail under the given message', () => {
    expect(asBody('some text', 'Title')).toEqual({ message: 'Title', detail: 'some text' });
  });

  it('keeps only message, detail and table of an object', () => {
    const table = { columns: ['A'], rows: [] };
    expect(asBody({ message: 'Own', detail: 'd', table, state: 'form', uiHtml: '<b>' }, 'Title'))
      .toEqual({ message: 'Own', detail: 'd', table });
  });

  it('falls back to the given message', () => {
    expect(asBody({ detail: 'd' }, 'Title')).toEqual({ message: 'Title', detail: 'd' });
    expect(asBody(null, 'Title')).toEqual({ message: 'Title' });
  });
});
