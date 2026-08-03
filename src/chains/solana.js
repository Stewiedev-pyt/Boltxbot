import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_ALIASES = {
  sol: SOL_MINT,
  wsol: SOL_MINT,
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};

const INFO_CACHE = new Map();

async function fetchRetry(url, options, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function quoteApiHosts(cfg) {
  return (cfg.jupiterQuoteApi || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

async function apiFetch(cfg, path, options = {}) {
  const hosts = quoteApiHosts(cfg);
  let lastErr;
  for (const host of hosts) {
    const url = `${host.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    try {
      const res = await fetchRetry(url, options);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No Jupiter host available');
}

export function makeSolanaAdapter() {
  const cfg = config.chains.solana;
  const connection = new Connection(cfg.rpc, 'confirmed');

  function normalizeAddress(input) {
    const v = String(input || '').trim();
    return TOKEN_ALIASES[v.toLowerCase()] || v;
  }

  function isValidAddress(a) {
    try {
      new PublicKey(a);
      return true;
    } catch {
      return false;
    }
  }

  async function getTokenInfo(mint) {
    const addr = normalizeAddress(mint);
    if (INFO_CACHE.has(addr)) return INFO_CACHE.get(addr);
    let info = { address: addr, symbol: addr.slice(0, 6), decimals: 6 };
    try {
      if (addr === SOL_MINT) {
        info = { address: addr, symbol: 'SOL', decimals: 9 };
      } else {
        const supply = await connection.getTokenSupply(new PublicKey(addr));
        info = { address: addr, symbol: addr.slice(0, 6).toUpperCase(), decimals: supply.value.decimals };
      }
    } catch {
      // keep defaults
    }
    INFO_CACHE.set(addr, info);
    return info;
  }

  async function getNativeBalance(wallet) {
    return (await connection.getBalance(wallet.publicKey)).toString();
  }

  async function getTokenBalance(wallet, mint) {
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(normalizeAddress(mint)),
    });
    const total = accounts.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.raw || 0), 0);
    return total.toString();
  }

  async function getBalances(wallet) {
    const native = await getNativeBalance(wallet);
    const balances = [{ token: SOL_MINT, symbol: 'SOL', raw: native, human: (Number(native) / 1e9).toString() }];
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey);
    for (const a of accounts.value) {
      const parsed = a.account.data.parsed.info;
      const raw = parsed.tokenAmount.raw;
      if (raw === '0' || parsed.tokenAmount.uiAmount === 0) continue;
      const info = await getTokenInfo(parsed.mint);
      balances.push({
        token: parsed.mint,
        symbol: info.symbol,
        raw,
        human: parsed.tokenAmount.uiAmountString,
        decimals: parsed.tokenAmount.decimals,
      });
    }
    return balances;
  }

  async function getQuote({ input, output, amountInRaw, slippagePercent }) {
    const inputMint = normalizeAddress(input);
    const outputMint = normalizeAddress(output);
    const slippageBps = Math.round((slippagePercent || 3) * 100);
    const url = `quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInRaw}&slippageBps=${slippageBps}&onlyDirectRoutes=true`;
    const res = await apiFetch(cfg, url);
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text()}`);
    const q = await res.json();
    if (!q.routePlan || q.routePlan.length === 0) throw new Error('No route found');
    const inInfo = await getTokenInfo(inputMint);
    const outInfo = await getTokenInfo(outputMint);
    const outRaw = BigInt(q.outAmount);
    const inRaw = BigInt(q.inAmount);
    const price =
      Number(outRaw) / 10 ** outInfo.decimals / (Number(inRaw) / 10 ** inInfo.decimals);
    return {
      input: inputMint,
      output: outputMint,
      inSymbol: inInfo.symbol,
      outSymbol: outInfo.symbol,
      amountInRaw: inRaw.toString(),
      amountOutRaw: outRaw.toString(),
      amountOutHuman: (Number(outRaw) / 10 ** outInfo.decimals).toString(),
      priceImpactPct: Number(q.priceImpactPct || 0),
      slippageBps,
      raw: q,
    };
  }

  async function executeSwap({ wallet, quote, slippagePercent }) {
    const swapPayload = {
      quoteResponse: quote.raw,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
      slippageBps: Math.round((slippagePercent || quote.slippageBps / 100) * 100),
    };
    const res = await apiFetch(cfg, 'swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapPayload),
    });
    if (!res.ok) throw new Error(`Jupiter swap failed: ${res.status} ${await res.text()}`);
    const { swapTransaction } = await res.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([wallet.keypair]);
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 3,
    });
    logger.info('Solana swap sent', { sig });
    return { txid: sig };
  }

  return {
    chainId: 'solana',
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    normalizeAddress,
    isValidAddress,
    getTokenInfo,
    getNativeBalance,
    getTokenBalance,
    getBalances,
    getQuote,
    executeSwap,
    needsApprove: false,
  };
}
