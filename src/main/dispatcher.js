const { binDir } = require('./utils/bin-paths');

async function dispatch({ argv }, deps) {
  const {
    parseCli, loadAll, aggregateTargets, classify, validate,
    createRunner, dialog, fs, logger,
  } = deps;

  const cli = parseCli(argv);
  if (cli.kind === 'none') { logger.error('dispatch: no CLI args'); return 0; }
  if (cli.kind !== 'run')  { logger.error('dispatch: unknown CLI mode', { cli }); return 4; }

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

module.exports = { dispatch };
