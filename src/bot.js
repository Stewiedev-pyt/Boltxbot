import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { logger } from './logger.js';
import { registerCommands, registerCallbacks } from './commands.js';
import { wizardMiddleware, hasWizard, clearWizard } from './wizard.js';
import { listSignalSources, parseSignal, isSignalChat } from './services/signals.js';
import { buy, sell, getSlippage } from './trading.js';
import { getAdapter } from './chains/index.js';

export function createBot() {
  if (!config.botToken) {
    throw new Error('BOT_TOKEN is required (see .env.example)');
  }
  const bot = new Telegraf(config.botToken);

  bot.use(async (ctx, next) => {
    if (config.allowedUserIds.length > 0 && ctx.from && !config.allowedUserIds.includes(String(ctx.from.id))) {
      logger.warn('Blocked user', { id: ctx.from.id, username: ctx.from.username });
      if (ctx.chat?.type === 'private') {
        await ctx.reply('You are not authorized to use this bot.');
      }
      return;
    }
    return next();
  });

  registerCommands(bot);
  registerCallbacks(bot);

  bot.use(wizardMiddleware());

  bot.command('cancel', (ctx) => {
    clearWizard(ctx.from.id);
    ctx.reply('Cancelled.');
  });

  bot.on('message', async (ctx) => {
    if (!isSignalChat(ctx.chat.id)) return;
    const text = ctx.message.text || ctx.message.caption || '';
    const signal = parseSignal(text);
    if (!signal) return;

    const source = listSignalSources().find((s) => Number(s.chatId) === Number(ctx.chat.id));
    if (!source) return;
    const chainId = source.chain;
    const adapter = getAdapter(chainId);
    const amount = signal.amount || source.maxAmount || '0.01';

    logger.info('Signal received', { chat: ctx.chat.id, dir: signal.dir, token: signal.token, amount });
    try {
      if (signal.dir === 'buy') {
        const r = await buy(source.tgId, chainId, signal.token, String(amount));
        await ctx.reply(
          `\u{1F3C6} Signal BUY executed (${chainId})\nBought ~${r.amountOutHuman} ${r.quote.outSymbol} for ${amount} ${adapter.nativeSymbol}\nTX: \`${r.txid}\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        const r = await sell(source.tgId, chainId, signal.token, signal.amount || 'all');
        await ctx.reply(
          `\u{1F3C6} Signal SELL executed (${chainId})\nSold for ~${r.quote.amountOutHuman} ${r.quote.outSymbol}\nTX: \`${r.txid}\``,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      logger.error('Signal execution failed', { error: err.message });
      await ctx.reply(`\u274C Signal failed: ${err.message}`);
    }
  });

  bot.catch((err, ctx) => {
    logger.error('Bot error', { error: err.message, ctx: ctx?.update?.update_id });
  });

  return bot;
}
