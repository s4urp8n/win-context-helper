function safeHook(plugin, name, defaultFn, logger, ...args) {
  if (plugin && typeof plugin[name] === 'function') {
    try {
      return plugin[name](...args);
    } catch (err) {
      logger.error('plugin hook threw', {
        plugin: plugin.constructor ? plugin.constructor.name : 'unknown',
        hook: name,
        message: err.message,
      });
    }
  }
  return defaultFn(...args);
}

module.exports = { safeHook };
