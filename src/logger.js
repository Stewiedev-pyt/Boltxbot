import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_FILE = path.resolve(process.cwd(), 'bot.log');

function ts() {
  return new Date().toISOString();
}

function write(level, msg, meta) {
  const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const line = `${ts()} [${level.toUpperCase()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // never let logging break the bot
  }
  if (level === 'error') console.error(line.trimEnd());
  else console.log(line.trimEnd());
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
