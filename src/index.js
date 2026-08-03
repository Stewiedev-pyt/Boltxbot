import { load } from './db/store.js';
import { createBot } from './bot.js';
import { startCopytrader } from './services/copytrader.js';
import { startSniper } from './services/sniper.js';
import { startLimitEngine } from './services/limits.js';
import { config } from './config.js';
import { logger } from './logger.js';

async function launchWithRetry(bot, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      await bot.launch();
      return;
    } catch (err) {
      logger.warn('Bot launch failed, retrying', { attempt: i + 1, error: err.message });
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw new Error('Bot launch failed after retries');
}

async function main() {
  load();
  logger.info('DB loaded');

  const bot = createBot();
  await launchWithRetry(bot);

  startCopytrader().catch((err) => logger.error('Copytrader failed to start', { error: err.message }));
  startSniper().catch((err) => logger.error('Sniper failed to start', { error: err.message }));
  startLimitEngine().catch((err) => logger.error('Limit engine failed to start', { error: err.message }));

  logger.info('Bot launched', { chains: Object.keys(config.chains) });

  const shutdown = async (signal) => {
    logger.info('Shutting down', { signal });
    bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal', { error: err.stack || err.message });
  process.exit(1);
});
