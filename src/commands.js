import { Markup } from 'telegraf';
import { CHAIN_IDS, CHAIN_LABELS } from './config.js';
import {
  getOrCreateUser,
  getUser,
  setUserField,
  getTrades,
  getFees,
  getPositions,
  updateWalletLabel,
} from './db/store.js';
import {
  createWallet,
  importWallet,
  saveWallet,
  switchWallet,
  listWallets,
  getSigner,
  exportWallet,
} from './wallet.js';
import { getAdapter } from './chains/index.js';
import { buy, sell, getQuoteForUser, getSlippage, withdraw, getPrice } from './trading.js';
import { addTarget, removeTarget, listTargets, setTargetSize } from './services/copytrader.js';
import { setSniperUser, getSniperUser, setSniperEnabled } from './services/sniper.js';
import { addSignalSource, removeSignalSource, listSignalSources } from './services/signals.js';
import { listLimitOrders, cancelLimitOrder } from './services/limits.js';
import { addDcaPlan, cancelDcaPlan, listDcaPlans } from './services/dca.js';
import { getTpSlSettings, setTpSlSettings } from './services/tpsl.js';
import { scanToken, formatScan, getUsdPrice } from './services/scanner.js';
import { startWizard } from './wizard.js';
import { logger } from './logger.js';

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
  if (!Number.isFinite(n)) return 'n/a';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function nativeHuman(chainId, raw) {
  const adapter = getAdapter(chainId);
  return (Number(raw) / 10 ** adapter.nativeDecimals).toFixed(6);
}

function chainMenu() {
  return Markup.inlineKeyboard(
    CHAIN_IDS.map((c) => Markup.button.callback(`\u{1F9ED} ${CHAIN_LABELS[c]}`, `chain:${c}`)),
    { columns: 3 }
  );
}

function walletActionMenu(chainId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('\u{1F511} Create wallet', `wallet:create:${chainId}`),
      Markup.button.callback('\u{1F4E5} Import', `wallet:import:${chainId}`),
    ],
    [Markup.button.callback('\u2190 Back', 'wallet:list')],
  ]);
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('\u{1F4B5} Buy', 'menu:buy'),
      Markup.button.callback('\u{1F4E4} Sell', 'menu:sell'),
      Markup.button.callback('\u{1F4C8} Quote', 'menu:quote'),
    ],
    [
      Markup.button.callback('\u{1F4BC} Portfolio', 'menu:portfolio'),
      Markup.button.callback('\u{1F511} Wallets', 'menu:wallet'),
      Markup.button.callback('\u{1F504} Switch Chain', 'menu:chain'),
    ],
    [
      Markup.button.callback('\u{1F4CB} Positions', 'menu:positions'),
      Markup.button.callback('\u{1F50D} Scan', 'menu:scan'),
      Markup.button.callback('\u{1F4E5} Withdraw', 'menu:withdraw'),
    ],
    [
      Markup.button.callback('\u{23F3} Limit', 'menu:limit'),
      Markup.button.callback('\u{1F4C8} Trending', 'menu:trending'),
      Markup.button.callback('\u{1F4C1} History', 'menu:history'),
    ],
    [
      Markup.button.callback('\u{1F4C9} TP/SL', 'menu:tpsl'),
      Markup.button.callback('\u{1F4B0} DCA', 'menu:dca'),
      Markup.button.callback('\u{1F4B0} Fees', 'menu:fee'),
    ],
    [
      Markup.button.callback('\u{1F3AF} Sniper', 'menu:sniper'),
      Markup.button.callback('\u{1F501} Copy-trade', 'menu:copytrade'),
      Markup.button.callback('\u{1F4E1} Signals', 'menu:signals'),
    ],
  ]);
}

function chainSwitchMenu() {
  const rows = CHAIN_IDS.map((c) => [
    Markup.button.callback(`\u{1F7E2} ${CHAIN_LABELS[c]}`, `setchain:${c}`),
  ]);
  rows.push([Markup.button.callback('\u2190 Back', 'menu')]);
  return Markup.inlineKeyboard(rows);
}

function positionMenu(chainId, token) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Sell 25%', `posell:${chainId}:${token}:25`),
      Markup.button.callback('Sell 50%', `posell:${chainId}:${token}:50`),
      Markup.button.callback('Sell 100%', `posell:${chainId}:${token}:100`),
    ],
  ]);
}

function mainMenuReply(text) {
  return Markup.inlineKeyboard([[Markup.button.callback('\u{1F4CE} Main menu', 'menu')]]);
}

/* ---------- portfolio / positions ---------- */

async function buildPortfolio(id) {
  const lines = ['\u{1F4B0} Portfolio'];
  for (const c of CHAIN_IDS) {
    const signerCtx = getSigner(id, c);
    if (!signerCtx) {
      lines.push(`${CHAIN_LABELS[c]}: no wallet`);
      continue;
    }
    try {
      const adapter = getAdapter(c);
      const balances = await adapter.getBalances(signerCtx.signer);
      const native = balances.find((b) => b.token === adapter.normalizeAddress('native'));
      const nativeUsd = await getUsdPrice(c, adapter.normalizeAddress('native'));
      const linesChain = [`${CHAIN_LABELS[c]} (\`${fmtAddr(signerCtx.stored.address)}\`):`];
      if (native) {
        const usd = nativeUsd != null ? `  (${fmtUsd(Number(native.human) * nativeUsd)})` : '';
        linesChain.push(`  ${native.human} ${adapter.nativeSymbol}${usd}`);
      }
      for (const b of balances.filter((b) => b !== native)) {
        let usd = '';
        try {
          const p = await getUsdPrice(c, b.token);
          if (p != null) usd = `  (${fmtUsd(Number(b.human) * p)})`;
        } catch {
          // skip
        }
        linesChain.push(`  ${b.human} ${b.symbol} (\`${fmtAddr(b.token)}\`)${usd}`);
      }
      lines.push(...linesChain);
    } catch (err) {
      lines.push(`${CHAIN_LABELS[c]}: error (${err.message})`);
    }
  }
  return lines.join('\n');
}

async function buildPositions(id) {
  const positions = getPositions(id);
  const lines = ['\u{1F4CB} Positions'];
  let count = 0;
  for (const chainId of CHAIN_IDS) {
    const chainPositions = positions[chainId] || {};
    for (const [token, pos] of Object.entries(chainPositions)) {
      count++;
      try {
        const adapter = getAdapter(chainId);
        const price = await getPrice(id, chainId, token);
        const currentValue = parseFloat(pos.qty) * price;
        const pnl = currentValue - parseFloat(pos.entryValue);
        const pnlPct = (parseFloat(pos.entryValue) > 0 ? (pnl / parseFloat(pos.entryValue)) * 100 : 0);
        const arrow = pnl >= 0 ? '\u{1F7E2}' : '\u{1F534}';
        lines.push(
          `${arrow} ${pos.token === token ? fmtAddr(token) : fmtAddr(token)} (${CHAIN_LABELS[chainId]})` +
            `\n  Qty ${pos.qty} \u2022 entry ${pos.entryPrice}\n` +
            `  ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} (${pnlPct.toFixed(2)}%)`
        );
      } catch (err) {
        lines.push(`${fmtAddr(token)} (${CHAIN_LABELS[chainId]}): price error (${err.message})`);
      }
    }
  }
  if (count === 0) lines.push('  No open positions.');
  return lines.join('\n');
}

async function sendPositions(ctx, id) {
  const positions = getPositions(id);
  const text = await buildPositions(id);
  const buttons = [];
  for (const chainId of CHAIN_IDS) {
    for (const token of Object.keys(positions[chainId] || {})) {
      buttons.push(Markup.button.callback(`\u{1F4E4} ${fmtAddr(token)}`, `posell:${chainId}:${token}:100`));
    }
  }
  const kb = buttons.length
    ? Markup.inlineKeyboard([buttons])
    : mainMenuReply(text);
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

/* ---------- trending ---------- */

async function fetchTrending(chainId) {
  const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!res.ok) throw new Error(`DEXScreener HTTP ${res.status}`);
  const data = await res.json();
  const boosts = (data.boosts || []).filter((b) => !chainId || b.chainId === chainId);
  return boosts.slice(0, 10);
}

export function registerCommands(bot) {
  bot.command('start', (ctx) =>
    ctx.reply(
      `Welcome to the multi-chain trading bot \u{1F680}\n\n` +
        `DEX swaps on Solana (Jupiter), Ethereum (Uniswap), BNB Chain (PancakeSwap) and Robinhood Chain.\n\n` +
        `Commands:\n` +
        `/wallet create|import|show|list|switch \u2014 manage wallets per chain\n` +
        `/buy <token> <amount> [chain] \u2014 swap native \u2192 token\n` +
        `/sell <token> [amount|%|all] [chain] \u2014 swap token \u2192 native\n` +
        `/quote <token> <amount> [chain] \u2014 preview a swap\n` +
        `/portfolio \u2014 balances on all chains\n` +
        `/positions \u2014 open positions with quick-sell\n` +
        `/scan <token> [chain] \u2014 token safety scanner\n` +
        `/withdraw <token|native> <address> <amount|all|%> [chain]\n` +
        `/limit buy|sell <token> <price> <amount> [chain] \u2014 limit/TP/SL orders\n` +
        `/limit list | /limit cancel <id>\n` +
        `/tpsl <tp%> <sl%> \u2014 auto TP/SL on every buy\n` +
        `/dca <token> <amount> <rounds> <intervalMin> [chain] \u2014 dollar-cost averaging\n` +
        `/dca list | /dca cancel <id>\n` +
        `/trending [chain] \u2014 trending tokens\n` +
        `/history \u2014 recent trades\n` +
        `/fees \u2014 outstanding service fees\n` +
        `/setchain <chain> \u2014 default chain\n` +
        `/slippage <pct> \u2014 slippage tolerance\n` +
        `/sniper on|off|<amount>|minliq <usd> \u2014 auto-buy new tokens\n` +
        `/copytrade add|remove|size \u2014 follow wallets\n` +
        `/signals add|remove \u2014 execute trades from channel messages\n` +
        `/menu \u2014 button menu\n` +
        `/help \u2014 this list\n\n` +
        `Start with /wallet create to make wallets.`
    )
  );

  bot.command('help', (ctx) => ctx.reply('Use /start to see the command list.'));

  bot.command('menu', (ctx) => ctx.reply('\u{1F4CE} Main menu', mainMenu()));

  /* ---------------- wallet ---------------- */

  bot.command('wallet', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/);
    const action = (parts[1] || '').toLowerCase();
    const chainArg = parts[2];
    const extra = parts.slice(3).join(' ');
    const chainId = resolveChain(ctx, chainArg);

    if (!action || action === 'show' || action === 'list') {
      const user = getUser(ctx.from.id);
      const lines = ['Wallets:'];
      for (const c of CHAIN_IDS) {
        const group = user?.wallets?.[c];
        const activeId = group?.active;
        const wallets = group?.items ? Object.values(group.items) : [];
        if (wallets.length === 0) {
          lines.push(`${CHAIN_LABELS[c]}: \u2014 none`);
          continue;
        }
        for (const w of wallets) {
          const marker = w.id === activeId ? '\u2705' : '\u{1F4E4}';
          lines.push(`${marker} ${CHAIN_LABELS[c]} ${w.id}${w.label ? ` (${w.label})` : ''}: \`${w.address}\``);
        }
      }
      return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', ...chainMenu() });
    }

    if (action === 'create') {
      try {
        const chains = chainArg ? [chainId] : CHAIN_IDS;
        const lines = [];
        for (const c of chains) {
          const w = createWallet(c);
          saveWallet(ctx.from.id, c, w);
          lines.push(`\u{1F511} ${CHAIN_LABELS[c]}: \`${w.address}\``);
        }
        await ctx.reply(
          `${lines.join('\n')}\n\nPrivate keys stored encrypted. Add funds before trading.`,
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
            `Solana: base58 secret key or 12/24-word recovery phrase\n` +
            `Ethereum/BNB: 0x private key or 12/24-word recovery phrase`
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

    if (action === 'switch') {
      const wid = parts[3];
      if (!wid) return ctx.reply('Usage: /wallet switch <chain> <walletId>');
      try {
        const w = switchWallet(ctx.from.id, chainId, wid);
        await ctx.reply(`\u2705 Active ${CHAIN_LABELS[chainId]} wallet: \`${w.address}\``, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        await ctx.reply(`\u274C ${err.message}`);
      }
      return;
    }

    if (action === 'export') {
      const wid = parts[3] || null;
      if (chainArg && !CHAIN_IDS.includes(chainArg)) {
        return ctx.reply('Usage: /wallet export <chain> [walletId]');
      }
      try {
        const { wallet: w, secret } = exportWallet(ctx.from.id, chainId, wid || null);
        await ctx.reply(
          `\u{1F512} ${CHAIN_LABELS[chainId]} wallet ${w.id} ${w.label ? `\u2014 ${w.label}` : ''}\n` +
            `Address: \`${w.address}\`\nSecret:\n\`\`\`${secret}\`\`\`\n\n` +
            `Never share this secret with anyone.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        await ctx.reply(`\u274C ${err.message}`);
      }
      return;
    }

    if (action === 'rename') {
      const wid = parts[3];
      const label = parts.slice(4).join(' ').trim();
      if (!wid || !label) return ctx.reply('Usage: /wallet rename <chain> <walletId> <label>');
      try {
        const w = updateWalletLabel(ctx.from.id, chainId, wid, label);
        await ctx.reply(`\u2705 Wallet ${w.id} renamed to \u201C${w.label}\u201D`);
      } catch (err) {
        await ctx.reply(`\u274C ${err.message}`);
      }
      return;
    }

    await ctx.reply(
      'Usage:\n/wallet create [chain]\n/wallet import <chain> <secret>\n' +
        '/wallet show [chain]\n/wallet switch <chain> <walletId>\n' +
        '/wallet export <chain> [walletId]\n/wallet rename <chain> <walletId> <label>'
    );
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

  bot.command('quote', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const chainId = resolveChain(ctx, parts[2]);
    if (parts.length < 2) {
      startWizard(ctx.from.id, 'quote', chainId);
      return ctx.reply(
        `\u{1F4C8} Quote on ${CHAIN_LABELS[chainId]}\n\nSend the token contract address:`
      );
    }
    const adapter = getAdapter(chainId);
    try {
      const q = await getQuoteForUser(ctx.from.id, chainId, {
        input: 'native',
        output: parts[0],
        amountInHuman: parts[1],
      });
      await ctx.reply(
        `\u{1F4C8} Quote (${CHAIN_LABELS[chainId]})\n` +
          `In:  ${parts[1]} ${adapter.nativeSymbol} (${q.inSymbol})\n` +
          `Out: ~${q.amountOutHuman} ${q.outSymbol}\n` +
          `Price impact: ${q.priceImpactPct.toFixed(2)}%\n` +
          `Slippage: ${getSlippage(ctx.from.id)}%`
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  bot.command('buy', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const chainId = resolveChain(ctx, parts[2]);
    if (parts.length < 2) {
      startWizard(ctx.from.id, 'buy', chainId);
      return ctx.reply(
        `\u{1F4B0} Buy on ${CHAIN_LABELS[chainId]}\n\nSend the token contract address:`
      );
    }
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
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const chainId = resolveChain(ctx, parts[2]);
    if (parts.length < 1) {
      startWizard(ctx.from.id, 'sell', chainId);
      return ctx.reply(
        `\u{1F4E4} Sell on ${CHAIN_LABELS[chainId]}\n\nSend the token contract address:`
      );
    }
    const amount = parts[1] || 'all';
    try {
      const r = await sell(ctx.from.id, chainId, parts[0], amount);
      await ctx.reply(
        `\u2705 Sell executed (${CHAIN_LABELS[chainId]})\n` +
          `Sold for ~${r.quote.amountOutHuman} ${r.quote.outSymbol}\n` +
          `TX: \`${r.txid}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  /* ---------------- portfolio / positions ---------------- */

  bot.command('portfolio', async (ctx) => {
    try {
      const text = await buildPortfolio(ctx.from.id);
      await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  bot.command('positions', async (ctx) => {
    await sendPositions(ctx, ctx.from.id);
  });

  /* ---------------- scanner ---------------- */

  bot.command('scan', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const chainId = resolveChain(ctx, parts[1]);
    if (parts.length < 1) {
      startWizard(ctx.from.id, 'scan', chainId);
      return ctx.reply(
        `\u{1F50D} Token scanner (${CHAIN_LABELS[chainId]})\n\nSend the token contract address:`
      );
    }
    try {
      const report = await scanToken(chainId, parts[0]);
      await ctx.reply(formatScan(report), { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  /* ---------------- withdraw ---------------- */

  bot.command('withdraw', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const chainId = resolveChain(ctx, parts[3]);
    if (parts.length < 3) {
      startWizard(ctx.from.id, 'withdraw', chainId);
      return ctx.reply(
        `\u{1F4E5} Withdraw (${CHAIN_LABELS[chainId]})\n\nToken (\`native\` or address), destination, amount:\n` +
          `e.g. /withdraw native 0x... 100%`
      );
    }
    try {
      const r = await withdraw(ctx.from.id, chainId, parts[0], parts[1], parts[2]);
      await ctx.reply(
        `\u2705 Withdrawn ${r.amountHuman} ${r.symbol} to \`${parts[1]}\`\nTX: \`${r.txid}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  /* ---------------- limit orders ---------------- */

  bot.command('limit', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'list') {
      const orders = listLimitOrders(ctx.from.id);
      if (orders.length === 0) return ctx.reply('No active limit orders.');
      const lines = orders.map(
        (o) =>
          `${o.dir.toUpperCase()} \`${fmtAddr(o.token)}\` @ ${o.targetPrice} (${CHAIN_LABELS[o.chain]}) amt ${o.amount} \u2022 id \`${o.id}\``
      );
      return ctx.reply(`\u{23F3} Active orders:\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    }

    if (cmd === 'cancel') {
      const ok = cancelLimitOrder(ctx.from.id, parts[1]);
      return ctx.reply(ok ? '\u2705 Order cancelled' : '\u274C Order not found');
    }

    if (cmd === 'buy' || cmd === 'sell') {
      if (parts.length < 4) {
        startWizard(ctx.from.id, 'limit', resolveChain(ctx, parts[4]), { dir: cmd });
        return ctx.reply(
          `\u{23F3} Limit ${cmd.toUpperCase()} (${CHAIN_LABELS[resolveChain(ctx, parts[4])]})\n\nSend the token contract address:`
        );
      }
      const chainId = resolveChain(ctx, parts[4]);
      try {
        const o = addLimitOrder(ctx.from.id, chainId, cmd, parts[1], parts[2], parts[3]);
        return ctx.reply(
          `\u2705 Limit ${cmd.toUpperCase()} set\nID: \`${o.id}\`\nToken: \`${parts[1]}\`\n` +
            `Target: ${o.targetPrice} ${getAdapter(chainId).nativeSymbol}/token\nAmount: ${o.amount}`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        return ctx.reply(`\u274C ${err.message}`);
      }
    }

    return ctx.reply(
      'Usage:\n/limit buy|sell <token> <price> <amount> [chain]\n/limit list\n/limit cancel <id>'
    );
  });

  /* ---------------- TP/SL ---------------- */

  bot.command('tpsl', (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (parts[0] || '').toLowerCase();
    const s = getTpSlSettings(ctx.from.id);

    if (cmd === 'on') {
      setTpSlSettings(ctx.from.id, { enabled: true });
      return ctx.reply(
        `\u2705 Auto TP/SL ON: every buy opens a limit sell at TP ${s.tpPct}% and SL ${s.slPct}%.`
      );
    }
    if (cmd === 'off') {
      setTpSlSettings(ctx.from.id, { enabled: false });
      return ctx.reply('Auto TP/SL OFF.');
    }
    const tp = parseFloat(parts[0]);
    const sl = parseFloat(parts[1]);
    if (Number.isFinite(tp) && Number.isFinite(sl) && tp > 0 && sl > 0) {
      const next = setTpSlSettings(ctx.from.id, { tpPct: tp, slPct: sl, enabled: true });
      return ctx.reply(
        `\u2705 TP/SL set: TP +${next.tpPct}% / SL -${next.slPct}% and enabled.`
      );
    }
    return ctx.reply(
      `\u{1F4C9} Auto TP/SL\nStatus: ${s.enabled ? 'ON' : 'OFF'}\n` +
        `Take profit: +${s.tpPct}%  Stop loss: -${s.slPct}%\n\n` +
        `Usage:\n/tpsl <tp%> <sl%> \u2014 set levels and enable\n/tpsl on | /tpsl off`
    );
  });

  /* ---------------- DCA ---------------- */

  bot.command('dca', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const cmd = (parts[0] || '').toLowerCase();

    if (cmd === 'list') {
      const plans = listDcaPlans(ctx.from.id);
      if (plans.length === 0) return ctx.reply('No active DCA plans.');
      const lines = plans.map(
        (p) =>
          `${p.id} \u2022 ${p.roundsDone}/${p.totalRounds} rounds done\n` +
          `  ${p.amountPerRound} ${getAdapter(p.chain).nativeSymbol} \u2192 \`${fmtAddr(p.token)}\` every ${Math.round(p.intervalMs / 60000)}m (${CHAIN_LABELS[p.chain]})`
      );
      return ctx.reply(`\u{1F4B0} DCA plans:\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
    }

    if (cmd === 'cancel') {
      const ok = cancelDcaPlan(ctx.from.id, parts[1]);
      return ctx.reply(ok ? '\u2705 DCA plan cancelled' : '\u274C Plan not found');
    }

    if (parts.length >= 4) {
      const chainId = resolveChain(ctx, parts[4]);
      try {
        const p = addDcaPlan(
          ctx.from.id,
          chainId,
          parts[0],
          parts[1],
          parseInt(parts[2], 10),
          parseFloat(parts[3]) * 60000
        );
        return ctx.reply(
          `\u2705 DCA plan started\nID: \`${p.id}\`\n` +
            `Token: \`${parts[0]}\`\nAmount: ${p.amountPerRound} ${getAdapter(chainId).nativeSymbol}/round\n` +
            `Rounds: ${p.totalRounds} \u2022 every ${parts[3]}m (${CHAIN_LABELS[chainId]})`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        return ctx.reply(`\u274C ${err.message}`);
      }
    }

    return ctx.reply(
      'Usage:\n/dca <token> <amountPerRound> <rounds> <intervalMinutes> [chain]\n' +
        '/dca list | /dca cancel <id>\n\n' +
        'Buys the token on a fixed schedule. Interval must be >= 1 minute.'
    );
  });

  /* ---------------- trending ---------------- */

  bot.command('trending', async (ctx) => {
    const chainId = resolveChain(ctx, ctx.message.text.split(/\s+/)[1]);
    try {
      const boosts = await fetchTrending(chainId === 'solana' ? 'solana' : chainId);
      if (boosts.length === 0) return ctx.reply('No trending tokens right now.');
      const lines = boosts.map(
        (b, i) =>
          `${i + 1}. ${fmtAddr(b.tokenAddress)} (${CHAIN_LABELS[b.chainId]})\n   ${b.description || 'no description'}\n`
      );
      await ctx.reply(`\u{1F4C8} Trending tokens:\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`\u274C ${err.message}`);
    }
  });

  /* ---------------- history / fees ---------------- */

  bot.command('history', (ctx) => {
    const trades = getTrades(ctx.from.id, 15);
    if (trades.length === 0) return ctx.reply('No trades yet.');
    const lines = trades.map((t) => {
      const dirIcon = t.dir === 'buy' ? '\u{1F7E2} BUY' : '\u{1F534} SELL';
      const amt =
        t.dir === 'buy'
          ? `${t.amountInHuman} ${getAdapter(t.chain).nativeSymbol} -> ${t.amountOutHuman} ${t.symbol}`
          : `${t.amountInHuman} ${t.symbol} -> ${t.amountOutHuman} ${getAdapter(t.chain).nativeSymbol}`;
      return `${fmtTime(t.ts)} ${dirIcon} ${CHAIN_LABELS[t.chain]}\n${amt}\n\`${t.txid}\``;
    });
    ctx.reply(`\u{1F4C1} Recent trades:\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
  });

  bot.command('fees', (ctx) => {
    const fees = getFees(ctx.from.id);
    const lines = ['\u{1F4B0} Outstanding service fees:'];
    let total = 0;
    for (const c of CHAIN_IDS) {
      const raw = fees[c];
      if (!raw || Number(raw) <= 0) continue;
      total += Number(raw);
      lines.push(`${CHAIN_LABELS[c]}: ${nativeHuman(c, raw)} ${getAdapter(c).nativeSymbol}`);
    }
    if (total === 0) lines.push('  none owed');
    lines.push('', `Service fee rate: 0.9% per swap (per chain ledger).`);
    ctx.reply(lines.join('\n'));
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
      if (!getSniperUser(ctx.from.id)?.enabled) setSniperEnabled(false);
      return ctx.reply('Sniper OFF');
    }
    if (cmd === 'minliq') {
      const usd = parseFloat(args[1]);
      if (!Number.isFinite(usd) || usd < 0) return ctx.reply('Usage: /sniper minliq <usd>');
      setSniperUser(ctx.from.id, { minLiquidity: usd });
      return ctx.reply(`\u2705 Sniper min liquidity = $${usd}`);
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
        `Usage:\n/sniper on [chain]\n/sniper off\n/sniper <amount> [chain]\n/sniper minliq <usd>`
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

    if (cmd === 'size') {
      const id = parts[1];
      const amt = parseFloat(parts[2]);
      if (!id || !Number.isFinite(amt) || amt <= 0) {
        return ctx.reply('Usage: /copytrade size <targetId> <nativeAmountPerTrade>');
      }
      try {
        setTargetSize(id, amt);
        return ctx.reply(`\u2705 Copy-trade size for ${id} = ${amt} ${getAdapter(chainId).nativeSymbol}/trade`);
      } catch (err) {
        return ctx.reply(`\u274C ${err.message}`);
      }
    }

    const targets = listTargets();
    const lines = ['\u{1F50D} Copy-trading targets:'];
    if (targets.length === 0) lines.push('  none');
    for (const t of targets) {
      lines.push(`  ${t.id} \u2022 ${t.label} (${CHAIN_LABELS[t.chain]}) \u2022 ${t.maxPerTrade}/trade`);
    }
    lines.push('', 'Usage: /copytrade add <wallet> [chain] | /copytrade remove <id> | /copytrade size <id> <amount>');
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
    const data = ctx.callbackQuery.data || '';
    const id = ctx.from.id;
    const parts = data.split(':');
    const action = parts[0];
    const param = parts[1];

    const user = getUser(id) || getOrCreateUser(id);
    const chainId = resolveChain(ctx, param);

    try {
      /* ---------- main menu ---------- */
      if (action === 'menu') {
        await ctx.answerCbQuery();
        if (param === 'chain') return ctx.editMessageText('Switch chain:', chainSwitchMenu());
        if (param === 'buy') {
          startWizard(id, 'buy', user.defaultChain);
          return ctx.reply(`\u{1F4B0} Buy on ${CHAIN_LABELS[user.defaultChain]}\n\nSend the token contract address:`);
        }
        if (param === 'sell') {
          startWizard(id, 'sell', user.defaultChain);
          return ctx.reply(`\u{1F4E4} Sell on ${CHAIN_LABELS[user.defaultChain]}\n\nSend the token contract address:`);
        }
        if (param === 'quote') {
          startWizard(id, 'quote', user.defaultChain);
          return ctx.reply(`\u{1F4C8} Quote on ${CHAIN_LABELS[user.defaultChain]}\n\nSend the token contract address:`);
        }
        if (param === 'scan') {
          startWizard(id, 'scan', user.defaultChain);
          return ctx.reply(`\u{1F50D} Scan on ${CHAIN_LABELS[user.defaultChain]}\n\nSend the token contract address:`);
        }
        if (param === 'withdraw') {
          startWizard(id, 'withdraw', user.defaultChain);
          return ctx.reply(`\u{1F4E5} Withdraw on ${CHAIN_LABELS[user.defaultChain]}\n\nToken (\`native\` or address):`);
        }
        if (param === 'limit') {
          return ctx.reply(
            `\u{23F3} Limit orders\n\n` +
              `/limit buy <token> <price> <amount> \u2014 buy when price drops to target\n` +
              `/limit sell <token> <price> <amount> \u2014 TP/SL: sell when price reaches target\n` +
              `/limit list \u2022 /limit cancel <id>`,
            Markup.inlineKeyboard([
              [
                Markup.button.callback('New limit BUY', 'limit:buy'),
                Markup.button.callback('New limit SELL', 'limit:sell'),
              ],
              [Markup.button.callback('\u{1F4C1} List active', 'limit:list')],
            ])
          );
        }
        if (param === 'portfolio') {
          const text = await buildPortfolio(id);
          return ctx.reply(text, { parse_mode: 'Markdown', ...mainMenuReply(text) });
        }
        if (param === 'positions') return sendPositions(ctx, id);
        if (param === 'history') {
          const trades = getTrades(id, 15);
          if (trades.length === 0) return ctx.reply('No trades yet.');
          const lines = trades.map((t) => {
            const dirIcon = t.dir === 'buy' ? '\u{1F7E2} BUY' : '\u{1F534} SELL';
            const amt =
              t.dir === 'buy'
                ? `${t.amountInHuman} ${getAdapter(t.chain).nativeSymbol} -> ${t.amountOutHuman} ${t.symbol}`
                : `${t.amountInHuman} ${t.symbol} -> ${t.amountOutHuman} ${getAdapter(t.chain).nativeSymbol}`;
            return `${fmtTime(t.ts)} ${dirIcon} ${CHAIN_LABELS[t.chain]}\n${amt}\n\`${t.txid}\``;
          });
          return ctx.reply(`\u{1F4C1} Recent trades:\n\n${lines.join('\n\n')}`, {
            parse_mode: 'Markdown',
            ...mainMenuReply(''),
          });
        }
        if (param === 'fee') {
          const fees = getFees(id);
          const lines = ['\u{1F4B0} Outstanding service fees:'];
          let total = 0;
          for (const c of CHAIN_IDS) {
            const raw = fees[c];
            if (!raw || Number(raw) <= 0) continue;
            total += Number(raw);
            lines.push(`${CHAIN_LABELS[c]}: ${nativeHuman(c, raw)} ${getAdapter(c).nativeSymbol}`);
          }
          if (total === 0) lines.push('  none owed');
          return ctx.reply(lines.join('\n'), mainMenuReply(''));
        }
        if (param === 'trending') {
          try {
            const boosts = await fetchTrending(user.defaultChain);
            if (boosts.length === 0) return ctx.reply('No trending tokens right now.');
            const lines = boosts.map(
              (b, i) =>
                `${i + 1}. ${fmtAddr(b.tokenAddress)} (${CHAIN_LABELS[b.chainId]})\n   ${b.description || 'no description'}\n`
            );
            return ctx.reply(`\u{1F4C8} Trending tokens:\n${lines.join('\n')}`, {
              parse_mode: 'Markdown',
              ...mainMenuReply(''),
            });
          } catch (err) {
            return ctx.reply(`\u274C ${err.message}`);
          }
        }
        if (param === 'wallet') {
          const lines = ['Wallets:'];
          for (const c of CHAIN_IDS) {
            const group = user.wallets?.[c];
            const activeId = group?.active;
            const wallets = group?.items ? Object.values(group.items) : [];
            if (wallets.length === 0) {
              lines.push(`${CHAIN_LABELS[c]}: \u2014 none`);
              continue;
            }
            for (const w of wallets) {
              const marker = w.id === activeId ? '\u2705' : '\u{1F4E4}';
              lines.push(`${marker} ${CHAIN_LABELS[c]} ${w.id}: \`${w.address}\``);
            }
          }
          const rows = [];
          for (const c of CHAIN_IDS) {
            const wallets = listWallets(id, c);
            if (wallets.length > 1) {
              rows.push(
                wallets.map((w) =>
                  Markup.button.callback(`\u{1F504} ${w.id}`, `wswitch:${c}:${w.id}`)
                )
              );
            }
          }
          rows.push([
            Markup.button.callback('\u{1F511} New wallet', `wallet:create:${user.defaultChain}`),
            Markup.button.callback('\u2190 Back', 'menu'),
          ]);
          return ctx.editMessageText(lines.join('\n'), {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(rows),
          });
        }
        if (param === 'sniper') return ctx.reply('Sniper: /sniper on | /sniper off | /sniper <amount> | /sniper minliq <usd>');
        if (param === 'copytrade') return ctx.reply('Copy-trade: /copytrade add <wallet> [chain]');
        if (param === 'signals') return ctx.reply('Signals: /signals add <chatId> [chain]');
        if (param === 'tpsl') {
          const s = getTpSlSettings(id);
          return ctx.reply(
            `\u{1F4C9} Auto TP/SL\nStatus: ${s.enabled ? 'ON' : 'OFF'}\n` +
              `Take profit: +${s.tpPct}%  Stop loss: -${s.slPct}%\n\n` +
              `/tpsl <tp%> <sl%> \u2014 set levels and enable\n/tpsl on | /tpsl off`
          );
        }
        if (param === 'dca') {
          return ctx.reply(
            `\u{1F4B0} DCA (dollar-cost averaging)\n\n` +
              `/dca <token> <amount> <rounds> <intervalMin> [chain]\n` +
              `/dca list | /dca cancel <id>\n\n` +
              `Buys the token on a fixed schedule. Interval >= 1 minute.`
          );
        }
        return ctx.editMessageText('\u{1F4CE} Main menu', mainMenu());
      }

      /* ---------- chain switch / select ---------- */
      if (action === 'setchain') {
        setUserField(id, 'defaultChain', param);
        await ctx.answerCbQuery(`Default chain -> ${CHAIN_LABELS[param]}`);
        return ctx.editMessageText(
          `\u2705 Default chain set to ${CHAIN_LABELS[param]}\n\nAll buy/sell/quote commands will now use ${CHAIN_LABELS[param]}.`,
          mainMenu()
        );
      }

      if (action === 'chain') {
        setUserField(id, 'defaultChain', param);
        await ctx.answerCbQuery(`${CHAIN_LABELS[param]} selected`);
        return ctx.editMessageText(
          `\u2705 Default chain set to ${CHAIN_LABELS[param]}\n\n` +
            `What do you want to do on ${CHAIN_LABELS[param]}?`,
          walletActionMenu(param)
        );
      }

      /* ---------- wallets ---------- */
      if (action === 'wallet') {
        if (param === 'list') {
          const lines = ['Wallets:'];
          for (const c of CHAIN_IDS) {
            const group = user.wallets?.[c];
            const activeId = group?.active;
            const wallets = group?.items ? Object.values(group.items) : [];
            if (wallets.length === 0) {
              lines.push(`${CHAIN_LABELS[c]}: \u2014 none`);
              continue;
            }
            for (const w of wallets) {
              const marker = w.id === activeId ? '\u2705' : '\u{1F4E4}';
              lines.push(`${marker} ${CHAIN_LABELS[c]} ${w.id}: \`${w.address}\``);
            }
          }
          await ctx.answerCbQuery();
          return ctx.editMessageText(lines.join('\n'), { parse_mode: 'Markdown', ...chainMenu() });
        }

        if (param === 'create') {
          const c = parts[2];
          const w = createWallet(c);
          saveWallet(id, c, w);
          await ctx.answerCbQuery('Wallet created');
          return ctx.editMessageText(
            `\u{1F511} Created ${CHAIN_LABELS[c]} wallet\n` +
              `Address: \`${w.address}\`\n\n` +
              `Fund it with ${getAdapter(c).nativeSymbol} before trading.`,
            { parse_mode: 'Markdown' }
          );
        }

        if (param === 'import') {
          const c = parts[2];
          await ctx.answerCbQuery();
          return ctx.editMessageText(
            `\u{1F4E5} Import into ${CHAIN_LABELS[c]}\n\n` +
              `Send your secret in a private message:\n\n` +
              `/wallet import ${c} <secret>\n\n` +
              `Solana: base58 secret key or 12/24-word recovery phrase\n` +
              `Ethereum/BNB: 0x private key or 12/24-word recovery phrase`
          );
        }
      }

      if (action === 'wswitch') {
        const c = parts[1];
        const wid = parts[2];
        const w = switchWallet(id, c, wid);
        await ctx.answerCbQuery(`Active wallet -> ${w.address.slice(0, 6)}...`);
        return ctx.editMessageText(`\u2705 Active ${CHAIN_LABELS[c]} wallet: \`${w.address}\``, {
          parse_mode: 'Markdown',
          ...mainMenuReply(''),
        });
      }

      /* ---------- quick sell from positions ---------- */
      if (action === 'posell') {
        const c = parts[1];
        const token = parts[2];
        const pct = parts[3] || '100';
        try {
          const r = await sell(id, c, token, `${pct}%`);
          await ctx.answerCbQuery(`Sold ${pct}%`);
          return ctx.reply(
            `\u2705 Sold ${pct}% of \`${token}\` (${CHAIN_LABELS[c]}) for ~${r.quote.amountOutHuman} ${r.quote.outSymbol}\n` +
              `TX: \`${r.txid}\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          await ctx.answerCbQuery(`Error: ${err.message}`);
          return ctx.reply(`\u274C ${err.message}`);
        }
      }

      /* ---------- limit orders ---------- */
      if (action === 'limit') {
        if (param === 'buy' || param === 'sell') {
          startWizard(id, 'limit', user.defaultChain, { dir: param });
          await ctx.answerCbQuery();
          return ctx.reply(`\u{23F3} Limit ${param.toUpperCase()} on ${CHAIN_LABELS[user.defaultChain]}\n\nSend the token contract address:`);
        }
        if (param === 'list') {
          const orders = listLimitOrders(id);
          if (orders.length === 0) return ctx.reply('No active limit orders.');
          const lines = orders.map(
            (o) =>
              `${o.dir.toUpperCase()} \`${fmtAddr(o.token)}\` @ ${o.targetPrice} (${CHAIN_LABELS[o.chain]}) amt ${o.amount} \u2022 id \`${o.id}\``
          );
          await ctx.answerCbQuery();
          return ctx.reply(`\u{23F3} Active orders:\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
        }
      }
    } catch (err) {
      logger.error('Callback failed', { data, error: err.message });
      await ctx.answerCbQuery(`Error: ${err.message}`).catch(() => {});
      return ctx.reply(`\u274C ${err.message}`).catch(() => {});
    }

    await ctx.answerCbQuery('Unknown action').catch(() => {});
  });
}
