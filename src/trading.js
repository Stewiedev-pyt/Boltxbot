import { getAdapter } from './chains/index.js';
import { getSigner } from './wallet.js';
import { getOrCreateUser } from './db/store.js';
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

export function formatAmount(raw, decimals) {
  return fromRaw(raw, decimals);
}

export function getSlippage(tgId) {
  return getOrCreateUser(tgId).slippage ?? 3;
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

export async function buy(tgId, chainId, token, amountHuman) {
  const adapter = getAdapter(chainId);
  const signerCtx = getSigner(tgId, chainId);
  if (!signerCtx) throw new Error('No wallet on this chain. Use /wallet create');
  const slippage = getSlippage(tgId);

  const outToken = adapter.normalizeAddress(token);
  const outInfo = await adapter.getTokenInfo(outToken);
  const amountInRaw = toRaw(adapter, amountHuman, adapter.nativeDecimals).toString();
  const quote = await adapter.getQuote({ input: 'native', output: outToken, amountInRaw, slippagePercent: slippage });

  const nativeInfo = { decimals: adapter.nativeDecimals };
  const nativeBalance = await adapter.getNativeBalance(signerCtx.signer);
  if (BigInt(nativeBalance) < BigInt(quote.amountInRaw)) {
    throw new Error(`Insufficient ${adapter.nativeSymbol} balance`);
  }

  const result = await adapter.executeSwap({ wallet: signerCtx.signer, quote, slippagePercent: slippage });
  logger.info('Buy executed', { tgId, chainId, token, amountHuman, txid: result.txid });
  return {
    ...result,
    quote,
    amountOutHuman: fromRaw(quote.amountOutRaw, outInfo.decimals),
  };
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
  logger.info('Sell executed', { tgId, chainId, token, amountInRaw, txid: result.txid });
  return { ...result, quote };
}
