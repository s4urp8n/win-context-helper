const { binDir } = require('./utils/bin-paths');

const MENU_SYNC_TIMEOUT_MS = 5000;

function waitAtMost(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Never throws: a failure becomes an ok:false result so callers only map it to an exit code.
async function checkShellMenu(deps, plugins) {
  const { logger } = deps;
  try {
    const manifests = [...(plugins || deps.loadAll(deps.pluginsDir)).values()].map((p) => p.manifest);
    const result = await deps.syncShellMenu({ manifests });
    if (!result.ok) {
      logger.error('shell-menu: failed', { error: result.error, remaining: result.remainingLines, exportErrors: result.exportErrors });
    } else if (result.changes.length > 0) {
      logger.info('shell-menu: repaired', { lines: result.lines });
    } else {
      logger.info('shell-menu: in sync');
    }
    return { result, itemCount: manifests.length };
  } catch (err) {
    logger.error('shell-menu: failed', { error: err.message });
    const result = { ok: false, changes: [], lines: [], remaining: [], remainingLines: [], error: err.message, exportErrors: [] };
    return { result, itemCount: 0 };
  }
}

async function runStatusMode(deps) {
  if (!deps.isPackaged) {
    deps.logger.info('dispatch: no CLI args; the menu check runs only in the packaged build');
    return 0;
  }
  const { result, itemCount } = await checkShellMenu(deps);
  await deps.showMenuStatus(result, { itemCount });
  return result.ok ? 0 : 5;
}

async function runRegisterMode(deps) {
  if (!deps.isPackaged) {
    deps.logger.error('dispatch: --register works only in the packaged build');
    return 4;
  }
  const { result } = await checkShellMenu(deps);
  return result.ok ? 0 : 5;
}

async function runUnregisterMode(deps) {
  const { logger } = deps;
  if (!deps.isPackaged) {
    logger.error('dispatch: --unregister works only in the packaged build');
    return 4;
  }
  try {
    const result = await deps.unregisterShellMenu();
    if (result.ok) logger.info('shell-menu: unregistered');
    else logger.error('shell-menu: unregister failed', { error: result.error, remaining: result.remaining });
    return result.ok ? 0 : 5;
  } catch (err) {
    logger.error('shell-menu: unregister failed', { error: err.message });
    return 5;
  }
}

async function runSelection(cli, plugin, targets, deps) {
  const { classify, validate, createRunner, dialog, fs, logger } = deps;
  const selection = classify(targets, fs);

  const v = validate(plugin.manifest, selection);
  if (!v.ok) {
    logger.error('dispatch: validation rejected', { action: cli.action, reason: v.reason });
    dialog.showErrorBox(plugin.manifest.label || 'ContextHelper', v.body);
    return 2;
  }
  const effectiveTargets = v.effectiveTargets || targets;
  const enrichedSelection = { ...selection, skipped: v.skipped || [] };

  let instance;
  try {
    instance = new plugin.Cls();
  } catch (err) {
    logger.error('dispatch: plugin instantiation failed', { plugin: cli.action, message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin "${cli.action}" failed to instantiate: ${err.message}`);
    return 4;
  }

  const runner = createRunner(plugin.manifest.ui, deps);
  try {
    return await runner.execute({
      manifest: plugin.manifest,
      plugin: instance,
      pluginDir: plugin.dir,
      targets: effectiveTargets,
      selection: enrichedSelection,
      binDir: binDir(),
    });
  } catch (err) {
    logger.error('dispatch: runner crashed', { plugin: cli.action, message: err.message, stack: err.stack });
    dialog.showErrorBox('ContextHelper', `Internal error: ${err.message}`);
    return 3;
  }
}

async function runPluginMode(cli, deps) {
  const { loadAll, aggregateTargets, dialog, logger } = deps;

  let plugins;
  try {
    plugins = loadAll(deps.pluginsDir);
  } catch (err) {
    logger.error('dispatch: plugin load failed', { message: err.message });
    dialog.showErrorBox('ContextHelper', `Plugin load failed: ${err.message}`);
    return 4;
  }

  const plugin = plugins.get(cli.action);
  if (!plugin) {
    logger.error('dispatch: unknown action', { action: cli.action });
    dialog.showErrorBox('ContextHelper', `Unknown action: ${cli.action}`);
    return 4;
  }

  let targets = cli.targets;
  if (targets.length === 1) {
    const pipeName = `contexthelper-${cli.action}-${process.env.USERNAME || 'user'}`;
    try {
      const agg = await aggregateTargets({ pipeName, myTarget: targets[0], waitMs: 250 });
      if (agg.role === 'follower') { logger.info('dispatch: follower exiting'); return 0; }
      targets = agg.targets;
    } catch (err) {
      logger.error('dispatch: aggregator failed', { message: err.message });
    }
  }

  // Only the leader gets here, so one multi-selection triggers one background check.
  const menuCheck = deps.isPackaged ? checkShellMenu(deps, plugins) : null;
  try {
    return await runSelection(cli, plugin, targets, deps);
  } finally {
    if (menuCheck) await waitAtMost(menuCheck, deps.menuSyncTimeoutMs || MENU_SYNC_TIMEOUT_MS);
  }
}

async function dispatch({ argv }, deps) {
  const cli = deps.parseCli(argv);
  if (cli.kind === 'none') return runStatusMode(deps);
  if (cli.kind === 'register') return runRegisterMode(deps);
  if (cli.kind === 'unregister') return runUnregisterMode(deps);
  if (cli.kind !== 'run') { deps.logger.error('dispatch: unknown CLI mode', { cli }); return 4; }
  return runPluginMode(cli, deps);
}

module.exports = { dispatch };
