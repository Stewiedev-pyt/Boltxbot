import { getAdapter } from '../chains/index.js';

const PAIRS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

const PRICE_CACHE = new Map();
const PRICE_TTL = 60_000;

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* Best-effort USD price for a token via DEXScreener (cached 60s). Returns null
   if unknown. 'native' resolves to the wrapped token for EVM chains. */
export async function getUsdPrice(chainId, token) {
  const adapter = getAdapter(chainId);
  const address = adapter.normalizeAddress(token);
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = PRICE_CACHE.get(key);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;
  try {
    const { pairs } = await fetchJson(`${PAIRS_URL}${address}`);
    const pair = pairs?.find(
      (p) => p.chainId === chainId && p.priceUsd && Number(p.priceUsd) > 0
    );
    const price = pair ? Number(pair.priceUsd) : null;
    PRICE_CACHE.set(key, { price, ts: Date.now() });
    return price;
  } catch {
    PRICE_CACHE.set(key, { price: null, ts: Date.now() });
    return null;
  }
}

function usd(n) {
  if (n === null || n === undefined) return 'n/a';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${Number(n).toFixed(4)}`;
}

function pct(n) {
  if (n === null || n === undefined) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/* Returns a human-readable safety report for a token on a chain. */
export async function scanToken(chainId, token) {
  const adapter = getAdapter(chainId);
  const address = adapter.normalizeAddress(token);
  const info = await adapter.getTokenInfo(address);
  const report = {
    chainId,
    address,
    name: null,
    symbol: info.symbol,
    decimals: info.decimals,
    price: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    priceChange7d: null,
    liquidityUsd: null,
    volumeUsd24h: null,
    fdv: null,
    marketCap: null,
    pairAgeHours: null,
    dexId: null,
    quoteSymbol: null,
    pairAddress: null,
    url: null,
    holders: null,
    mintAuthorityRevoked: null,
    sellable: null,
    flags: [],
  };

  try {
    const { pairs } = await fetchJson(`${PAIRS_URL}${address}`);
    const pair = pairs?.find(
      (p) => p.chainId === chainId && p.dexId && p.liquidity && Number(p.liquidity.usd) > 0
    );
    if (pair) {
      report.name = pair.baseToken?.name || null;
      report.symbol = pair.baseToken?.symbol || info.symbol;
      report.price = pair.priceUsd ? Number(pair.priceUsd) : null;
      const ch = pair.priceChange || {};
      report.priceChange1h = ch.m5 != null ? Number(ch.m5) : ch.h1 != null ? Number(ch.h1) : null;
      report.priceChange6h = ch.h6 != null ? Number(ch.h6) : null;
      report.priceChange24h = ch.h24 != null ? Number(ch.h24) : null;
      report.priceChange7d = ch.d1 != null ? Number(ch.d1) : null;
      report.liquidityUsd = Number(pair.liquidity.usd);
      report.volumeUsd24h = pair.volume ? Number(pair.volume.h24) : null;
      report.fdv = pair.fdv != null ? Number(pair.fdv) : null;
      report.marketCap = pair.marketCap != null ? Number(pair.marketCap) : null;
      report.dexId = pair.dexId;
      report.quoteSymbol = pair.quoteToken?.symbol || null;
      report.pairAddress = pair.pairAddress || null;
      report.url = pair.url || null;
      if (pair.pairCreatedAt) {
        report.pairAgeHours = (Date.now() - pair.pairCreatedAt) / 3600000;
      }
      if (pair.info && Array.isArray(pair.info.holders)) {
        const total = pair.info.holders.reduce((s, h) => s + (h.percentage || 0), 0);
        report.holders = { top10: total, count: pair.info.holders.length };
      }
    }
  } catch {
    // DEXScreener unavailable; continue with on-chain checks only
  }

  if (chainId === 'solana') {
    report.mintAuthorityRevoked = await adapter.isMintAuthorityRevoked(address);
    if (report.mintAuthorityRevoked === false) {
      report.flags.push('Mint authority NOT revoked (dev can mint more)');
    }
  } else {
    try {
      report.sellable = await adapter.checkSellable(address);
    } catch {
      report.sellable = null;
    }
    if (report.sellable === false) {
      report.flags.push('Sell simulation failed (possible honeypot / tax)');
    }
  }

  if (report.liquidityUsd !== null && report.liquidityUsd < 5000) {
    report.flags.push('Low liquidity (< $5k) - high risk');
  }
  if (report.holders && report.holders.top10 > 50) {
    report.flags.push(`Top-10 holders own ${report.holders.top10.toFixed(0)}% (rug risk)`);
  }

  return report;
}

export function formatScan(report) {
  const lines = [
    `\u{1F50D} ${report.name || report.symbol} (${report.symbol})`,
    `\u{1F3EC} ${report.chainId} \u2022 \`${report.address}\``,
  ];
  lines.push(`Price: ${usd(report.price)}`);
  const changes = [
    `1h ${pct(report.priceChange1h)}`,
    `6h ${pct(report.priceChange6h)}`,
    `24h ${pct(report.priceChange24h)}`,
    `7d ${pct(report.priceChange7d)}`,
  ];
  lines.push(`Change: ${changes.join('  ')}`);
  lines.push(`Liquidity: ${usd(report.liquidityUsd)}`);
  if (report.volumeUsd24h !== null && report.volumeUsd24h !== undefined) {
    lines.push(`Volume 24h: ${usd(report.volumeUsd24h)}`);
  }
  if (report.fdv !== null && report.fdv !== undefined) {
    lines.push(`FDV: ${usd(report.fdv)}${report.marketCap != null ? `  \u2022  MCap: ${usd(report.marketCap)}` : ''}`);
  }
  if (report.dexId) {
    const age = report.pairAgeHours !== null && report.pairAgeHours !== undefined
      ? ` \u2022 age ${report.pairAgeHours < 1 ? `${Math.round(report.pairAgeHours * 60)}m` : `${report.pairAgeHours.toFixed(1)}h`}`
      : '';
    lines.push(`DEX: ${report.dexId}${report.quoteSymbol ? `/${report.quoteSymbol}` : ''}${age}`);
  }
  if (report.holders) lines.push(`Top-10 holders: ${report.holders.top10.toFixed(1)}%`);
  if (report.mintAuthorityRevoked !== null) {
    lines.push(`Mint authority revoked: ${report.mintAuthorityRevoked ? 'YES' : 'NO'}`);
  }
  if (report.sellable !== null) {
    lines.push(`Sellable (sim): ${report.sellable ? 'YES' : 'NO'}`);
  }
  if (report.flags.length > 0) {
    lines.push('', '\u26A0\uFE0F Flags:');
    for (const f of report.flags) lines.push(`- ${f}`);
  } else {
    lines.push('', '\u2705 No obvious red flags');
  }
  if (report.url) lines.push('', report.url);
  return lines.join('\n');
}

/* Fast, best-effort one-line summary for a token (used when a CA is pasted
   into the buy/sell/quote flows). Returns null if unknown. */
export async function quickInfo(chainId, token) {
  const adapter = getAdapter(chainId);
  const address = adapter.normalizeAddress(token);
  try {
    const { pairs } = await fetchJson(`${PAIRS_URL}${address}`);
    const pair = pairs?.find((p) => p.chainId === chainId && p.pairAddress && p.priceUsd);
    if (!pair) return null;
    return {
      address,
      name: pair.baseToken?.name || null,
      symbol: pair.baseToken?.symbol || null,
      price: pair.priceUsd ? Number(pair.priceUsd) : null,
      priceChange24h: pair.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null,
      liquidity: pair.liquidity?.usd ? Number(pair.liquidity.usd) : null,
      url: pair.url || null,
    };
  } catch {
    return null;
  }
}

export function formatQuick(info) {
  if (!info) return null;
  const parts = [];
  if (info.name) parts.push(info.name);
  if (info.symbol) parts.push(`(${info.symbol})`);
  if (info.price !== null) parts.push(`\u2022 ${usd(info.price)}`);
  if (info.priceChange24h !== null) parts.push(`24h ${pct(info.priceChange24h)}`);
  if (info.liquidity !== null) parts.push(`Liq ${usd(info.liquidity)}`);
  return parts.join(' ');
}
