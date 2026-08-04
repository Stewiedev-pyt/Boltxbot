import { getAdapter } from './chains/index.js';
import { getSigner } from './wallet.js';
import {
  getOrCreateUser,
  addTrade,
  addFee,
  upsertPosition,
  getPosition,
  deletePosition,
} from './db/store.js';
import { config } from './config.js';
import { logger } from './logger.js';

function toRaw(adapter, human, decimals) {
  const parts = String(human).split('.');
  const frac = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(parts[0] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

function fromRaw(raw, decimals) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const str = abs.toString().padStart(decimals + 1, '0');
  const intPart = str.slice(0, -decimals) || '0';
  const fracPart = str.slice(-decimals);
  const trimmed = fracPart.replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${trimmed ? '.' + trimmed : ''}`;
}

export function getSlippage(tgId) {
  return getOrCreateUser(tgId).slippage ?? 3;
}

function feeFor(amountInRaw) {
  return (BigInt(Math.round(amountInRaw * (config.feePercent / 100)))).toString();
}

function trackBuy(tgId, chainId, token, qtyHuman, spentHuman, priceHuman) {
  const key = token.toLowerCase();
  const prev = getPosition(tgId, chainId, key);
  let qty = parseFloat(qtyHuman);
  let value = parseFloat(spentHuman);
  if (prev) {
    qty += parseFloat(prev.qty);
    value += parseFloat(prev.entryValue);
  }
  upsertPosition(tgId, chainId, key, {
    chain: chainId,
    token: key,
    qty: qty.toString(),
    entryValue: value.toString(),
    entryPrice: (qty > 0 ? value / qty : 0).toString(),
    ts: Date.now(),
  });
}

function trackSell(tgId, chainId, token, soldQtyHuman) {
  const key = token.toLowerCase();
  const prev = getPosition(tgId, chainId, key);
  if (!prev) return;
  let qty = parseFloat(prev.qty) - parseFloat(soldQtyHuman);
  if (qty <= 1e-18) {
    deletePosition(tgId, chainId, key);
    return;
  }
  const newValue = parseFloat(prev.entryValue) * (qty / parseFloat(prev.qty));
  upsertPosition(tgId, chainId, key, {
    chain: chainId,
    token: key,
    qty: qty.toString(),
    entryValue: newValue.toString(),
    entryPrice: (newValue / qty).toString(),
    ts: prev.ts,
  });
}

export async function getQuoteForUser(tgId, chainId, { input, output, amountInHuman, amountOutHuman }) {
  const adapter = getAdapter(chainId);
  const inToken = adapter.normalizeAddress(input || 'native');
  const outToken = adapter.normalizeAddress(output || 'native');

  if (amountInHuman) {
    const inInfo = await adapter.getTokenInfo(inToken);
    const amountInRaw = toRaw(adapter, amountInHuman, inInfo.decimals).toString();
    return adapter.getQuote({ input: inToken, output: outToken, amountInRaw });
  }
  if (amountOutHuman) {
    return adapter.getQuote({ input: inToken, output: outToken, amountOutHuman });
  }
  throw new Error('Provide amount to quote');
}

export async function getPrice(tgId, chainId, token) {
  const adapter = getAdapter(chainId);
  const signerCtx = getSigner(tgId, chainId);
  const _ = signerCtx; // price quotes do not require a wallet
  return adapter.getPrice(token);
}

export async function buy(tgId, chainId, token, amountHuman) {
  const adapter = getAdapter(chainId);
  const signerCtx = getSigner(tgId, chainId);
  if (!signerCtx) throw new Error('No wallet on this chain. Use /wallet create');
  const slippage = getSlippage(tgId);

  const outToken = adapter.normalizeAddress(token);
  const outInfo = await adapter.getTokenInfo(outToken);
  const amountInRaw = toRaw(adapter, amountHuman, adapter.nativeDecimals).toString();
  const quote = await adapter.getQuote({ input: 'native', output: outToken, amountInRaw, slippagePercent: slippage });

  const nativeBalance = await adapter.getNativeBalance(signerCtx.signer);
  if (BigInt(nativeBalance) < BigInt(quote.amountInRaw)) {
    throw new Error(`Insufficient ${adapter.nativeSymbol} balance`);
  }

  const result = await adapter.executeSwap({ wallet: signerCtx.signer, quote, slippagePercent: slippage });
  const qtyHuman = fromRaw(quote.amountOutRaw, outInfo.decimals);
  const spentHuman = amountHuman;
  const priceHuman = parseFloat(spentHuman) / (parseFloat(qtyHuman) || 1);

  trackBuy(tgId, chainId, outToken, qtyHuman, spentHuman, priceHuman);
  const feeRaw = feeFor(quote.amountInRaw);
  addFee(tgId, chainId, feeRaw);
  addTrade(tgId, {
    chain: chainId,
    dir: 'buy',
    token: outToken,
    symbol: outInfo.symbol,
    amountIn: quote.amountInRaw,
    amountOut: quote.amountOutRaw,
    amountInHuman: amountHuman,
    amountOutHuman: qtyHuman,
    txid: result.txid,
    wallet: signerCtx.stored.address,
  });

  try {
    const { maybeOpenTpSl } = await import('./services/tpsl.js');
    await maybeOpenTpSl(tgId, chainId, outToken, priceHuman, qtyHuman);
  } catch {
    // auto TP/SL is best-effort; never fail a completed buy
  }

  logger.info('Buy executed', { tgId, chainId, token, amountHuman, txid: result.txid });
  return { ...result, quote, amountOutHuman: qtyHuman };
}

export async function sell(tgId, chainId, token, amountInput) {
  const adapter = getAdapter(chainId);
  const signerCtx = getSigner(tgId, chainId);
  if (!signerCtx) throw new Error('No wallet on this chain. Use /wallet create');
  const slippage = getSlippage(tgId);

  const inToken = adapter.normalizeAddress(token);
  const inInfo = await adapter.getTokenInfo(inToken);
  const balanceRaw = await adapter.getTokenBalance(signerCtx.signer, inToken);

  let amountInRaw;
  if (amountInput === 'all') {
    amountInRaw = balanceRaw;
  } else if (typeof amountInput === 'string' && amountInput.endsWith('%')) {
    const pct = Math.min(100, Math.max(0, parseFloat(amountInput)));
    amountInRaw = (BigInt(balanceRaw) * BigInt(Math.round(pct * 100))) / 10000n;
  } else {
    amountInRaw = toRaw(adapter, amountInput, inInfo.decimals).toString();
  }

  if (BigInt(amountInRaw) <= 0n) throw new Error('Nothing to sell');
  if (BigInt(amountInRaw) > BigInt(balanceRaw)) {
    throw new Error(`Balance too low. You hold ${fromRaw(balanceRaw, inInfo.decimals)} ${inInfo.symbol}`);
  }

  const quote = await adapter.getQuote({ input: inToken, output: 'native', amountInRaw, slippagePercent: slippage });
  const result = await adapter.executeSwap({ wallet: signerCtx.signer, quote, slippagePercent: slippage });

  const soldHuman = fromRaw(amountInRaw, inInfo.decimals);
  trackSell(tgId, chainId, inToken, soldHuman);
  const feeRaw = feeFor(quote.amountInRaw);
  addFee(tgId, chainId, feeRaw);
  addTrade(tgId, {
    chain: chainId,
    dir: 'sell',
    token: inToken,
    symbol: inInfo.symbol,
    amountIn: quote.amountInRaw,
    amountOut: quote.amountOutRaw,
    amountInHuman: soldHuman,
    amountOutHuman: quote.amountOutHuman,
    txid: result.txid,
    wallet: signerCtx.stored.address,
  });

  logger.info('Sell executed', { tgId, chainId, token, amountInRaw, txid: result.txid });
  return { ...result, quote };
}

export async function withdraw(tgId, chainId, token, to, amountInput) {
  const adapter = getAdapter(chainId);
  const signerCtx = getSigner(tgId, chainId);
  if (!signerCtx) throw new Error('No wallet on this chain. Use /wallet create');
  if (!adapter.isValidAddress(to)) throw new Error('Invalid destination address');

  const isNative = token === 'native' || adapter.normalizeAddress(token) === adapter.normalizeAddress('native');
  let amountRaw;

  if (isNative) {
    const bal = BigInt(await adapter.getNativeBalance(signerCtx.signer));
    amountRaw = amountInput === 'all' ? bal.toString() : toRaw(adapter, amountInput, adapter.nativeDecimals).toString();
    if (BigInt(amountRaw) <= 0n) throw new Error('Nothing to withdraw');
    if (BigInt(amountRaw) > bal) throw new Error('Insufficient balance');
    const result = await adapter.withdrawNative(signerCtx.signer, to, amountRaw);
    return { ...result, symbol: adapter.nativeSymbol, amountHuman: fromRaw(amountRaw, adapter.nativeDecimals) };
  }

  const info = await adapter.getTokenInfo(token);
  const bal = BigInt(await adapter.getTokenBalance(signerCtx.signer, token));
  amountRaw = amountInput === 'all' ? bal.toString() : toRaw(adapter, amountInput, info.decimals).toString();
  if (BigInt(amountRaw) <= 0n) throw new Error('Nothing to withdraw');
  if (BigInt(amountRaw) > bal) throw new Error(`Insufficient balance (${fromRaw(bal, info.decimals)} ${info.symbol})`);
  const result = await adapter.withdrawToken(signerCtx.signer, to, token, amountRaw);
  return { ...result, symbol: info.symbol, amountHuman: fromRaw(amountRaw, info.decimals) };
}
