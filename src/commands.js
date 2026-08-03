import { Markup } from 'telegraf';
import { CHAIN_IDS, CHAIN_LABELS } from './config.js';
import { getOrCreateUser, setUserField, getUser } from './db/store.js';
import { createWallet, importWallet, saveWallet, getSigner } from './wallet.js';
import { getAdapter } from './chains/index.js';
import { buy, sell, getQuoteForUser, getSlippage } from './trading.js';
import { addTarget, removeTarget, listTargets } from './services/copytrader.js';
import { setSniperUser, getSniperUser, setSniperEnabled, getSniperState } from './services/sniper.js';
import { addSignalSource, removeSignalSource, listSignalSources } from './services/signals.js';

function resolveChain(ctx, arg) {
  const user = getOrCreateUser(ctx.from.id);
  const v = (arg || '').toLowerCase();
  if (CHAIN_IDS.includes(v)) return v;
  return user.defaultChain || 'solana';
}

function fmtAddr(a) {
  if (!a) return 'n/a';
  return a.length > 16 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

function fmtUsd(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function chainMenu() {
  return Markup.inlineKeyboard(
    CHAIN_IDS.map((c) => Markup.button.callback(`\u{1F9ED} ${CHAIN_LABELS[c]}`, `chain:${c}`)),
    { columns: 3 }
  );
}

export function registerCommands(bot) {
  bot.command('start', (ctx) =>
    ctx.reply(
      `Welcome to the multi-chain trading bot \u{1F680}\n\n` +
        `Trades DEX swaps on Solana (Jupiter), Ethereum (Uniswap) and BNB Chain (PancakeSwap).\n\n` +
        `Commands:\n` +
        `/wallet create|import|show \u2014 manage wallets per chain\n` +
        `/buy <token> <amount> \u2014 swap native \u2192 token\n` +
        `/sell <token> [amount|%|all] \u2014 swap token \u2192 native\n` +
        `/quote <token> <amount> \u2014 preview a swap\n` +
        `/portfolio \u2014 balances on all chains\n` +
        `/setchain <chain> \u2014 default chain\n` +
        `/slippage <pct> \u2014 slippage tolerance\n` +
        `/sniper on|off|<amount> \u2014 auto-buy new tokens\n` +
        `/copytrade \u2014 follow wallets and mirror trades\n` +
        `/signals \u2014 execute trades from channel messages\n` +
        `/help \u2014 this list\n\n` +
        `Start with /wallet create to make wallets.`
    )
  );

  bot.command('help', (ctx) => ctx.reply('Use /start to see the command list.'));

  /* ---------------- wallet ---------------- */

  bot.command('wallet', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const action = (parts[1] || '').toLowerCase();
    const chainArg = parts[2];
    const extra = parts.slice(3).join(' ');
    const chainId = resolveChain(ctx, chainArg);
    const adapter = getAdapter(chainId);

    if (!action || action === 'show') {
      const user = getUser(ctx.from.id);
      const lines = ['Wallets:'];
      for (const c of CHAIN_IDS) {
        const w = user?.wallets?.[c];
        lines.push(`${CHAIN_LABELS[c]}: ${w ? fmtAddr(w.address) : '\u2014 none'}`);
      }
      return ctx.reply(lines.join('\n'), chainMenu());
    }

    if (action === 'create') {
      try {
        const w = createWallet(chainId);
        saveWallet(ctx.from.id, chainId, w);
        await ctx.reply(
          `\u{1F511} Created ${CHAIN_LABELS[chainId]} wallet\n` +
            `Address: \`${w.address}\`\n` +
            `Private key stored encrypted. Add funds before trading.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await ctx.reply(`\u274C ${err.message}`);
      }
      return;
    }

    if (action === 'import') {
      if (!extra) {
        return ctx.reply(
          `Usage: /wallet import <chain> <secret>\n` +
            `Solana: base58 secret key\n` +
            `Ethereum/BNB: 0x private key`
        );
      }
      try {
        const w = importWallet(chainId, extra);
        saveWallet(ctx.from.id, chainId, w);
        await ctx.reply(`\u2705 Imported ${CHAIN_LABELS[chainId]} wallet \`${w.address}\``, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        await ctx.reply(`\u274C ${err.message}`);
      }
      return;
    }

    await ctx.reply('Usage: /wallet create [chain] | /wallet import [chain] <secret> | /wallet show');
  });

  /* ---------------- chain / slippage ---------------- */

  bot.command('setchain', (ctx) => {
    const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
    if (!CHAIN_IDS.includes(arg)) {
      return ctx.reply(`Pick a chain: ${CHAIN_IDS.join(', ')}`);
    }
    setUserField(ctx.from.id, 'defaultChain', arg);
    ctx.reply(`\u2705 Default chain set to ${CHAIN_LABELS[arg]}`);
  });

  bot.command('slippage', (ctx) => {
    const pct = parseFloat(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
      return ctx.reply('Usage: /slippage <pct> (0-50)');
    }
    setUserField(ctx.from.id, 'slippage', pct);
    ctx.reply(`\u2705 Slippage set to ${pct}%`);
  });

  /* ---------------- quote / buy / sell ---------------- */

  async function requireTokenArgs(ctx, min) {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < min) {
      await ctx.reply('Usage: /buy <token> <amount>  |  /sell <token> [amount|%|all]');
      return null;
    }
    return parts;
  }

  bot.command('quote', async (ctx) => {
    const parts = await requireTokenArgs(ctx, 2);
    if (!parts) return;
    const chainId = resolveChain(ctx, parts[2]);
    const adapter = getAdapter(chainId);
    try {
      const q = await getQuoteForUser(ctx.from.id, chainId, {
        input: 'native',
        output: parts[0],
        amountInHuman: parts[1],
      });
      const priceUsd = await usdPrice(adapter, q);
      await ctx.reply(
        `\u{1F4C8} Quote (${CHAIN_LABELS[chainId]})\n` +
          `In:  ${parts[1]} ${adapter.nativeSymbol} (${q.inSymbol})\n` +
          `Out: ~${q.amountOutHuman} ${q.outSymbol}\n` +
          `Price impact: ${q.priceImpactPct.toFixed(2)}%\n` +
          `Slippage: ${getSlippage(ctx.from.id)}%` +
          (priceUsd ? `\n~${fmtUsd(priceUsd)}/token` : '')
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  async function usdPrice(adapter, q) {
    try {
      const baseInfo = await adapter.getTokenInfo(adapter.chainId === 'solana' ? 'usdc' : 'usdt');
      const baseAddr = baseInfo.address;
      if (q.output.toLowerCase() === baseAddr.toLowerCase()) return 1;
      const priceQ = await adapter.getQuote({ input: q.output, output: baseAddr, amountInRaw: '1000000000' });
      const scale = 10 ** 9 / Number(priceQ.amountInRaw);
      return Number(priceQ.amountOutRaw) / 1e6 * scale;
    } catch {
      return null;
    }
  }

  bot.command('buy', async (ctx) => {
    const parts = await requireTokenArgs(ctx, 2);
    if (!parts) return;
    const chainId = resolveChain(ctx, parts[2]);
    try {
      const r = await buy(ctx.from.id, chainId, parts[0], parts[1]);
      await ctx.reply(
        `\u2705 Buy executed (${CHAIN_LABELS[chainId]})\n` +
          `Bought ~${r.amountOutHuman} ${r.quote.outSymbol} for ${parts[1]} ${r.quote.inSymbol}\n` +
          `Impact: ${r.quote.priceImpactPct.toFixed(2)}%  Slippage: ${getSlippage(ctx.from.id)}%\n` +
          `TX: \`${r.txid}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  bot.command('sell', async (ctx) => {
    const parts = await requireTokenArgs(ctx, 1);
    if (!parts) return;
    const chainId = resolveChain(ctx, parts[2]);
    const amount = parts[1] || 'all';
    try {
      const r = await sell(ctx.from.id, chainId, parts[0], amount);
      await ctx.reply(
        `\u2705 Sell executed (${CHAIN_LABELS[chainId]})\n` +
          `Sold ${r.quote.amountInRaw} raw ${r.quote.inSymbol} for ~${r.quote.amountOutHuman} ${r.quote.outSymbol}\n` +
          `TX: \`${r.txid}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  /* ---------------- portfolio ---------------- */

  bot.command('portfolio', async (ctx) => {
    const lines = ['\u{1F4B0} Portfolio'];
    for (const c of CHAIN_IDS) {
      const signerCtx = getSigner(ctx.from.id, c);
      if (!signerCtx) {
        lines.push(`${CHAIN_LABELS[c]}: no wallet`);
        continue;
      }
      try {
        const adapter = getAdapter(c);
        const balances = await adapter.getBalances(signerCtx.signer);
        const native = balances.find((b) => b.token === adapter.normalizeAddress('native'));
        lines.push(`${CHAIN_LABELS[c]} (\`${fmtAddr(signerCtx.stored.address)}\`):`);
        lines.push(`  ${native?.human || '0'} ${adapter.nativeSymbol}`);
        for (const b of balances.filter((b) => b !== native)) {
          lines.push(`  ${b.human} ${b.symbol} (\`${fmtAddr(b.token)}\`)`);
        }
      } catch (err) {
        lines.push(`${CHAIN_LABELS[c]}: error (${err.message})`);
      }
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  /* ---------------- sniper ---------------- */

  bot.command('sniper', async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (args[0] || '').toLowerCase();
    const chainId = resolveChain(ctx, args[1]);

    if (cmd === 'on') {
      setSniperUser(ctx.from.id, { chain: chainId, enabled: true });
      setSniperEnabled(true);
      return ctx.reply(`\u{1F3AF} Sniper ON for ${CHAIN_LABELS[chainId]}`);
    }
    if (cmd === 'off') {
      setSniperUser(ctx.from.id, { enabled: false });
      if (!getSniperState().users.some((u) => u.enabled)) setSniperEnabled(false);
      return ctx.reply('Sniper OFF');
    }
    if (Number.isFinite(parseFloat(cmd))) {
      setSniperUser(ctx.from.id, { amount: parseFloat(cmd), chain: chainId, enabled: true });
      setSniperEnabled(true);
      return ctx.reply(`\u2705 Sniper amount = ${parseFloat(cmd)} ${getAdapter(chainId).nativeSymbol}, chain=${CHAIN_LABELS[chainId]}`);
    }

    const u = getSniperUser(ctx.from.id);
    const cfg = u
      ? `${CHAIN_LABELS[u.chain]} \u2022 amount ${u.amount} ${getAdapter(u.chain).nativeSymbol} \u2022 minLiq $${u.minLiquidity}`
      : 'not configured';
    await ctx.reply(
      `\u{1F3AF} Sniper\nStatus: ${u?.enabled ? 'ON' : 'OFF'}\nConfig: ${cfg}\n\n` +
        `Usage:\n/sniper on [chain]\n/sniper off\n/sniper <amount> [chain]`
    );
  });

  /* ---------------- copytrade ---------------- */

  bot.command('copytrade', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (parts[0] || '').toLowerCase();
    const chainId = resolveChain(ctx, parts[2]);

    if (cmd === 'add') {
      const address = parts[1];
      if (!address) return ctx.reply('Usage: /copytrade add <walletAddress> [chain]');
      try {
        const adapter = getAdapter(chainId);
        if (!adapter.isValidAddress(address)) return ctx.reply('Invalid address for that chain');
        const t = addTarget(ctx.from.id, chainId, address);
        return ctx.reply(`\u2705 Now tracking ${t.label} (${CHAIN_LABELS[chainId]}). Mirrors its buys/sells.`);
      } catch (err) {
        return ctx.reply(`\u274C ${err.message}`);
      }
    }

    if (cmd === 'remove') {
      const ok = removeTarget(parts[1]);
      return ctx.reply(ok ? '\u2705 Removed target' : '\u274C Target not found');
    }

    const targets = listTargets();
    const lines = ['\u{1F50D} Copy-trading targets:'];
    if (targets.length === 0) lines.push('  none');
    for (const t of targets) {
      lines.push(`  ${t.id} \u2022 ${t.label} (${CHAIN_LABELS[t.chain]}) \u2022 $${t.maxPerTrade}/trade`);
    }
    lines.push('', 'Usage: /copytrade add <wallet> [chain] | /copytrade remove <id>');
    await ctx.reply(lines.join('\n'));
  });

  /* ---------------- signals ---------------- */

  bot.command('signals', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (parts[0] || '').toLowerCase();
    const chainId = resolveChain(ctx, parts[2]);

    if (cmd === 'add') {
      const chatId = parts[1];
      if (!chatId) return ctx.reply('Usage: /signals add <chatId> [chain]');
      try {
        const s = addSignalSource(Number(chatId), ctx.from.id, chainId);
        return ctx.reply(
          `\u2705 Listening for BUY/SELL signals in chat \`${s.chatId}\` (${CHAIN_LABELS[chainId]}).\n` +
            `Add the bot to that chat and post messages like:\nBUY <tokenAddress> [amount] or SELL <tokenAddress>`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        return ctx.reply(`\u274C ${err.message}`);
      }
    }

    if (cmd === 'remove') {
      const ok = removeSignalSource(Number(parts[1]));
      return ctx.reply(ok ? '\u2705 Removed source' : '\u274C Source not found');
    }

    const sources = listSignalSources();
    const lines = ['\u{1F4E1} Signal sources:'];
    if (sources.length === 0) lines.push('  none');
    for (const s of sources) {
      lines.push(`  chat ${s.chatId} \u2192 ${CHAIN_LABELS[s.chain]} (${s.tgId})`);
    }
    lines.push('', 'Usage: /signals add <chatId> [chain] | /signals remove <chatId>');
    await ctx.reply(lines.join('\n'));
  });
}

export function registerCallbacks(bot) {
  bot.on('callback_query', async (ctx) => {
    const [action, chainId] = (ctx.callbackQuery.data || '').split(':');
    if (action === 'chain') {
      setUserField(ctx.from.id, 'defaultChain', chainId);
      await ctx.answerCbQuery(`Default chain -> ${CHAIN_LABELS[chainId]}`);
      return ctx.editMessageText(`\u2705 Default chain set to ${CHAIN_LABELS[chainId]}`);
    }
    await ctx.answerCbQuery('Unknown action');
  });
}
