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
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}

/* Returns a human-readable safety report for a token on a chain. */
export async function scanToken(chainId, token) {
  const adapter = getAdapter(chainId);
  const address = adapter.normalizeAddress(token);
  const info = await adapter.getTokenInfo(address);
  const report = {
    chainId,
    address,
    symbol: info.symbol,
    decimals: info.decimals,
    price: null,
    liquidityUsd: null,
    priceChange24h: null,
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
      report.price = pair.priceUsd ? Number(pair.priceUsd) : null;
      report.liquidityUsd = Number(pair.liquidity.usd);
      report.priceChange24h = pair.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null;
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
    `\u{1F50D} Token scan: ${report.symbol}`,
    `Chain: ${report.chainId}  Address: \`${report.address}\``,
  ];
  lines.push(`Price: ${report.price ? usd(report.price) : 'n/a'}`);
  lines.push(`Liquidity: ${report.liquidityUsd !== null ? usd(report.liquidityUsd) : 'n/a'}`);
  if (report.priceChange24h !== null) {
    const pct = report.priceChange24h;
    lines.push(`24h: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
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
  return lines.join('\n');
}
