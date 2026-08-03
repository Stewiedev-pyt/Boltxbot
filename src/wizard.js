import { buy, sell, getQuoteForUser, getSlippage, withdraw } from './trading.js';
import { scanToken, formatScan } from './services/scanner.js';
import { addLimitOrder } from './services/limits.js';
import { getAdapter } from './chains/index.js';
import { CHAIN_LABELS } from './config.js';
import { logger } from './logger.js';

const sessions = new Map();

export function startWizard(userId, type, chainId, extra = {}) {
  sessions.set(String(userId), { type, chainId, step: 0, data: extra });
}

export function clearWizard(userId) {
  sessions.delete(String(userId));
}

export function hasWizard(userId) {
  return sessions.has(String(userId));
}

function reply(ctx, text, opts = {}) {
  return ctx.reply(text, { parse_mode: 'Markdown', ...opts });
}

const STEPS = {
  buy: [
    async (ctx, s) => {
      s.data.token = ctx.message.text.trim();
      const adapter = getAdapter(s.chainId);
      await reply(ctx, `How much ${adapter.nativeSymbol} to spend on \`${s.data.token}\`?`);
    },
    async (ctx, s) => {
      const adapter = getAdapter(s.chainId);
      const r = await buy(ctx.from.id, s.chainId, s.data.token, ctx.message.text.trim());
      await reply(ctx,
        `\u2705 Buy executed (${CHAIN_LABELS[s.chainId]})\n` +
        `Bought ~${r.amountOutHuman} ${r.quote.outSymbol} for ${ctx.message.text.trim()} ${adapter.nativeSymbol}\n` +
        `Impact: ${r.quote.priceImpactPct.toFixed(2)}%  Slippage: ${getSlippage(ctx.from.id)}%\n` +
        `TX: \`${r.txid}\``
      );
    },
  ],
  sell: [
    async (ctx, s) => {
      s.data.token = ctx.message.text.trim();
      await reply(ctx, `Amount to sell (\`all\`, \`50%\`, or a number)?`);
    },
    async (ctx, s) => {
      const r = await sell(ctx.from.id, s.chainId, s.data.token, ctx.message.text.trim());
      await reply(ctx,
        `\u2705 Sell executed (${CHAIN_LABELS[s.chainId]})\n` +
        `Sold for ~${r.quote.amountOutHuman} ${r.quote.outSymbol}\n` +
        `TX: \`${r.txid}\``
      );
    },
  ],
  quote: [
    async (ctx, s) => {
      s.data.token = ctx.message.text.trim();
      const adapter = getAdapter(s.chainId);
      await reply(ctx, `Amount of ${adapter.nativeSymbol} to quote?`);
    },
    async (ctx, s) => {
      const q = await getQuoteForUser(ctx.from.id, s.chainId, {
        input: 'native',
        output: s.data.token,
        amountInHuman: ctx.message.text.trim(),
      });
      await reply(ctx,
        `\u{1F4C8} Quote (${CHAIN_LABELS[s.chainId]})\n` +
        `In:  ${ctx.message.text.trim()} ${q.inSymbol}\n` +
        `Out: ~${q.amountOutHuman} ${q.outSymbol}\n` +
        `Price impact: ${q.priceImpactPct.toFixed(2)}%\n` +
        `Slippage: ${getSlippage(ctx.from.id)}%`
      );
    },
  ],
  scan: [
    async (ctx, s) => {
      const report = await scanToken(s.chainId, ctx.message.text.trim());
      await reply(ctx, formatScan(report));
    },
  ],
  withdraw: [
    async (ctx, s) => {
      s.data.token = ctx.message.text.trim();
      await reply(ctx, `Destination wallet address:`);
    },
    async (ctx, s) => {
      s.data.to = ctx.message.text.trim();
      const adapter = getAdapter(s.chainId);
      await reply(ctx, `Amount (\`all\`, \`50%\`, or a number) of ${s.data.token === 'native' ? adapter.nativeSymbol : s.data.token}:`);
    },
    async (ctx, s) => {
      const r = await withdraw(ctx.from.id, s.chainId, s.data.token, s.data.to, ctx.message.text.trim());
      await reply(ctx, `\u2705 Withdrawn ${r.amountHuman} ${r.symbol} to \`${s.data.to}\`\nTX: \`${r.txid}\``);
    },
  ],
  limit: [
    async (ctx, s) => {
      s.data.token = ctx.message.text.trim();
      await reply(ctx, `Target price in ${getAdapter(s.chainId).nativeSymbol} per token:`);
    },
    async (ctx, s) => {
      s.data.price = ctx.message.text.trim();
      const adapter = getAdapter(s.chainId);
      if (s.data.dir === 'sell') {
        await reply(ctx, `Amount to sell when triggered (\`all\`, \`50%\`, or a number):`);
      } else {
        await reply(ctx, `Amount of ${adapter.nativeSymbol} to buy when triggered:`);
      }
    },
    async (ctx, s) => {
      const o = addLimitOrder(ctx.from.id, s.chainId, s.data.dir, s.data.token, s.data.price, ctx.message.text.trim());
      await reply(ctx,
        `\u2705 Limit ${s.data.dir.toUpperCase()} set\n` +
        `ID: \`${o.id}\`\n` +
        `Token: \`${s.data.token}\`\n` +
        `Target: ${o.targetPrice} ${getAdapter(s.chainId).nativeSymbol}/token\n` +
        `Amount: ${o.amount}`
      );
    },
  ],
};

export function wizardMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const s = sessions.get(String(userId));
    if (!s) return next();
    if (!ctx.message?.text) {
      await ctx.reply('Send a text message to continue, or /cancel to abort.');
      return;
    }
    if (ctx.message.text.startsWith('/')) return next();

    const text = ctx.message.text.trim();
    if (text.toLowerCase() === 'cancel') {
      clearWizard(userId);
      await ctx.reply('Cancelled.');
      return;
    }

    const steps = STEPS[s.type];
    if (!steps) {
      clearWizard(userId);
      return next();
    }

    try {
      const stepFn = steps[s.step];
      await stepFn(ctx, s);
      s.step += 1;
      if (s.step >= steps.length) clearWizard(userId);
    } catch (err) {
      clearWizard(userId);
      logger.error('Wizard step failed', { error: err.message });
      await ctx.reply(`\u274C ${err.message}`);
    }
  };
}
