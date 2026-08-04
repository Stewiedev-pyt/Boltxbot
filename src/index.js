import { load } from './db/store.js';
import { createBot } from './bot.js';
import { startCopytrader } from './services/copytrader.js';
import { startSniper } from './services/sniper.js';
import { startLimitEngine } from './services/limits.js';
import { startDca } from './services/dca.js';
import { config } from './config.js';
import { logger } from './logger.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Telegraf's bot.launch() never resolves (the long-poll loop runs forever), so we
   cannot gate on it. Instead: retry the connection phase (getMe + deleteWebhook),
   then kick off long polling in the background. Polling handles transient network
   errors internally and only rejects on fatal errors (401/409). */
async function startBot(bot, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      bot.botInfo = await bot.telegram.getMe();
      await bot.telegram.deleteWebhook();
      bot.startPolling().catch((err) => logger.error('Polling stopped', { error: err.message }));
      logger.info('Bot connected', { username: bot.botInfo.username });
      return;
    } catch (err) {
      logger.warn('Bot connection failed, retrying', { attempt: i + 1, error: err.message });
      await sleep(5000 * (i + 1));
    }
  }
  throw new Error('Bot connection failed after retries');
}

async function main() {
  load();
  logger.info('DB loaded');

  const bot = createBot();
  await startBot(bot);

  startCopytrader().catch((err) => logger.error('Copytrader failed to start', { error: err.message }));
  startSniper().catch((err) => logger.error('Sniper failed to start', { error: err.message }));
  startLimitEngine().catch((err) => logger.error('Limit engine failed to start', { error: err.message }));
  startDca().catch((err) => logger.error('DCA engine failed to start', { error: err.message }));

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
