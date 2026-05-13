const fs = require('node:fs');
const path = require('node:path');

const LOG_ROOT = path.join(process.env.LOCALAPPDATA || process.env.TMP || '.', 'ContextHelper', 'logs');
const RETENTION_DAYS = 14;

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function logFilePath() {
  return path.join(LOG_ROOT, `${todayStamp()}.log`);
}

function ensureLogDir() {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
}

function pruneOld() {
  if (!fs.existsSync(LOG_ROOT)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(LOG_ROOT)) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(LOG_ROOT, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // best-effort
    }
  }
}

function log(level, message, meta) {
  ensureLogDir();
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch (err) {
    process.stderr.write(`logger: failed to write — ${err.message}\n`);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  pruneOld,
  logFilePath,
  LOG_ROOT,
};
