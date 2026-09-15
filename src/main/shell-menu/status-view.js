// Text of the window opened from the Start-menu shortcut, built from a syncMenu result.
function describeMenuStatus(result, { exePath, itemCount, logDir }) {
  const program = `Program: ${exePath}`;
  if (result.ok && result.changes.length === 0) {
    return { state: 'info', message: 'Explorer menu is registered', detail: [`${itemCount} menu items are in place.`, program].join('\n') };
  }
  if (result.ok) {
    return { state: 'info', message: 'Explorer menu repaired', detail: [...result.lines, '', program].join('\n') };
  }
  const reason = result.error
    ? 'The registry could not be updated. Pending changes:'
    : 'Some entries still differ after writing them:';
  return {
    state: 'error',
    message: 'Could not register the Explorer menu',
    detail: [reason, ...result.remainingLines, '', `Details are in the log: ${logDir}`].join('\n'),
  };
}

module.exports = { describeMenuStatus };
