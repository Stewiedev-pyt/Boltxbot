import { load } from './db/store.js';
import { createBot } from './bot.js';
import { startCopytrader } from './services/copytrader.js';
import { startSniper } from './services/sniper.js';
import { config } from './config.js';
import { logger } from './logger.js';

async function main() {
  load();
  logger.info('DB loaded');

  const bot = createBot();
  await bot.launch();

  startCopytrader().catch((err) => logger.error('Copytrader failed to start', { error: err.message }));
  startSniper().catch((err) => logger.error('Sniper failed to start', { error: err.message }));

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
