import { getCopytradeState, setCopytrade } from '../db/store.js';
import { getAdapter } from '../chains/index.js';
import { getSigner } from '../wallet.js';
import { buy, sell } from '../trading.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const snapshots = new Map();
const evmCursors = new Map();
const recentTx = new Map();

const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function canonical(target) {
  return `${target.chain}:${target.address.toLowerCase()}`;
}

function topic(address) {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/* ---------- Solana: token-balance delta tracking ---------- */

async function solanaSnapshot(chainId, address) {
  const adapter = getAdapter(chainId);
  const { PublicKey } = await import('@solana/web3.js');
  const balances = await adapter.getBalances({ publicKey: new PublicKey(address) });
  return balances.reduce((acc, b) => {
    if (b.token) acc[b.token.toLowerCase()] = b.raw;
    return acc;
  }, {});
}

/* ---------- EVM: Transfer event scanning ---------- */

async function evmEvents(chainId, address) {
  const adapter = getAdapter(chainId);
  const provider = adapter.provider;
  const key = `${chainId}:${address.toLowerCase()}`;
  const current = await provider.getBlockNumber();

  const prev = evmCursors.get(key) || current - 1;
  const fromBlock = Math.max(prev + 1, current - 400);
  const toBlock = current;
  evmCursors.set(key, current);
  if (fromBlock > toBlock) return [];

  const toTopic = topic(address);
  const [buys, sells] = await Promise.all([
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_SIG, null, toTopic] }),
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_SIG, toTopic] }),
  ]);

  const seen = new Set(recentTx.get(key) || []);
  const events = [];
  for (const log of [...buys, ...sells]) {
    const isBuy = buys.includes(log);
    if (seen.has(log.transactionHash)) continue;
    seen.add(log.transactionHash);
    events.push({ token: log.address, dir: isBuy ? 'buy' : 'sell', txid: log.transactionHash, block: log.blockNumber });
  }
  recentTx.set(key, [...seen].slice(-200));
  return events;
}

/* ---------- dispatch ---------- */

async function processEvent(target, event) {
  const tgId = String(target.tgId);
  try {
    if (event.dir === 'buy') {
      const amount = String(target.maxPerTrade ?? 0.05);
      await buy(tgId, target.chain, event.token, amount);
      logger.info('Copy BUY', { tgId, chain: target.chain, token: event.token, amount });
    } else {
      await sell(tgId, target.chain, event.token, 'all');
      logger.info('Copy SELL', { tgId, chain: target.chain, token: event.token });
    }
  } catch (err) {
    logger.error('Copy trade failed', { tgId, chain: target.chain, token: event.token, error: err.message });
  }
}

async function pollTarget(target) {
  const key = canonical(target);
  try {
    if (target.chain === 'solana') {
      const prev = snapshots.get(key);
      const current = await solanaSnapshot(target.chain, target.address);
      snapshots.set(key, current);
      if (!prev) return;
      const tokens = new Set([...Object.keys(prev), ...Object.keys(current)]);
      for (const token of tokens) {
        const before = BigInt(prev[token] || 0);
        const now = BigInt(current[token] || 0);
        if (now > before) await processEvent(target, { token, dir: 'buy' });
        else if (now < before) await processEvent(target, { token, dir: 'sell' });
      }
    } else {
      const events = await evmEvents(target.chain, target.address);
      for (const event of events) {
        await processEvent(target, event);
      }
    }
  } catch (err) {
    logger.error('Copytrader poll failed', { target: key, error: err.message });
  }
}

export async function startCopytrader() {
  const pollMs = Number(config.copyTradePollMs) || 15000;
  const run = async () => {
    const state = getCopytradeState();
    if (!state.enabled || !state.targets?.length) return;
    for (const target of state.targets) {
      await pollTarget(target);
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
    label: opts.label || `${address.slice(0, 6)}...${address.slice(-4)}`,
    maxPerTrade: opts.maxPerTrade ?? 0.05,
  };
  state.targets.push(target);
  state.enabled = true;
  setCopytrade(state);
  const key = canonical(target);
  snapshots.delete(key);
  evmCursors.delete(key);
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

export function setTargetSize(id, nativeAmount) {
  const state = getCopytradeState();
  const t = (state.targets || []).find((x) => x.id === id);
  if (!t) throw new Error('Target not found');
  t.maxPerTrade = nativeAmount;
  setCopytrade(state);
  return t;
}
