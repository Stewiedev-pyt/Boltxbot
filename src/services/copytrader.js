import { getCopytradeState, setCopytrade } from '../db/store.js';
import { getAdapter } from '../chains/index.js';
import { getSigner } from '../wallet.js';
import { buy, sell } from '../trading.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const snapshots = new Map();

function canonical(target) {
  return `${target.chain}:${target.address.toLowerCase()}`;
}

async function snapshot(chainId, address) {
  const adapter = getAdapter(chainId);
  const signer = chainId === 'solana'
    ? { publicKey: new (await import('@solana/web3.js')).PublicKey(address) }
    : { address };
  const balances = await adapter.getBalances(signer);
  return balances.reduce((acc, b) => {
    if (b.token && b.token !== adapter.nativeSymbol) acc[b.token.toLowerCase()] = b.raw;
    return acc;
  }, {});
}

async function diff(chainId, address, previous) {
  const current = await snapshot(chainId, address);
  const changes = [];
  const tokens = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const token of tokens) {
    const prev = BigInt(previous[token] || 0);
    const now = BigInt(current[token] || 0);
    if (now > prev) {
      changes.push({ token, delta: (now - prev).toString(), dir: 'buy' });
    } else if (now < prev) {
      changes.push({ token, delta: (prev - now).toString(), dir: 'sell' });
    }
  }
  return { current, changes };
}

async function handleChange(target, change) {
  const tgId = String(target.tgId);
  const signerCtx = getSigner(tgId, target.chain);
  if (!signerCtx) {
    logger.warn('Copy target has no wallet for user', { tgId, chain: target.chain });
    return;
  }
  const maxPerTrade = target.maxPerTrade ?? 0.05;
  try {
    if (change.dir === 'buy') {
      const amount = target.useMaxPerTrade ? maxPerTrade : Math.min(maxPerTrade, maxPerTrade);
      await buy(tgId, target.chain, change.token, String(amount));
      logger.info('Copy BUY', { tgId, chain: target.chain, token: change.token, amount });
    } else {
      await sell(tgId, target.chain, change.token, 'all');
      logger.info('Copy SELL', { tgId, chain: target.chain, token: change.token });
    }
  } catch (err) {
    logger.error('Copy trade failed', { tgId, chain: target.chain, token: change.token, error: err.message });
  }
}

export async function startCopytrader() {
  const pollMs = Number(config.copyTradePollMs) || 15000;
  const run = async () => {
    const state = getCopytradeState();
    if (!state.enabled || !state.targets?.length) return;
    for (const target of state.targets) {
      const key = canonical(target);
      try {
        const prev = snapshots.get(key);
        if (prev) {
          const { current, changes } = await diff(target.chain, target.address, prev);
          snapshots.set(key, current);
          for (const change of changes) {
            await handleChange(target, change);
          }
        } else {
          snapshots.set(key, await snapshot(target.chain, target.address));
        }
      } catch (err) {
        logger.error('Copytrader poll failed', { target: key, error: err.message });
      }
    }
  };

  await run();
  setInterval(run, pollMs);
  logger.info('Copy-trader started', { pollMs, targets: getCopytradeState().targets?.length ?? 0 });
}

export function addTarget(tgId, chain, address, opts = {}) {
  const state = getCopytradeState();
  if (!state.targets) state.targets = [];
  if (state.targets.some((t) => t.address.toLowerCase() === address.toLowerCase() && t.chain === chain)) {
    throw new Error('Target already tracked');
  }
  const target = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tgId,
    chain,
    address,
    label: opts.label || address.slice(0, 6) + '...' + address.slice(-4),
    maxPerTrade: opts.maxPerTrade ?? 0.05,
  };
  state.targets.push(target);
  state.enabled = true;
  setCopytrade(state);
  snapshots.delete(canonical(target));
  return target;
}

export function removeTarget(id) {
  const state = getCopytradeState();
  const before = state.targets.length;
  state.targets = state.targets.filter((t) => t.id !== id);
  if (state.targets.length !== before) {
    if (state.targets.length === 0) state.enabled = false;
    setCopytrade(state);
    return true;
  }
  return false;
}

export function listTargets() {
  return getCopytradeState().targets || [];
}

