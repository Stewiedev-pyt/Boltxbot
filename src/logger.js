const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts() {
  return new Date().toISOString();
}

function write(level, msg, meta) {
  const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level.toUpperCase()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
