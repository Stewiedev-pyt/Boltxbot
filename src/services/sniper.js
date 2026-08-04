import { getSniperState, setSniper } from '../db/store.js';
import { getAdapter } from '../chains/index.js';
import { buy } from '../trading.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

const PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';

let seen = new Set();
const seenCap = 2000;
const safetyCache = new Map();

function keepSeen(tokens) {
  seen.add(tokens);
  if (seen.size > seenCap) {
    seen = new Set([...seen].slice(-seenCap));
  }
}

/* Anti-rug guard: reject tokens that can be minted freely or cannot be sold back.
   Results are cached per token to keep the poll loop fast. */
async function isSafeToken(chainId, tokenAddress) {
  const key = `${chainId}:${tokenAddress.toLowerCase()}`;
  if (safetyCache.has(key)) return safetyCache.get(key);
  let safe = true;
  try {
    const adapter = getAdapter(chainId);
    if (chainId === 'solana') {
      const revoked = await adapter.isMintAuthorityRevoked(tokenAddress);
      if (revoked === false) safe = false;
    } else {
      const sellable = await adapter.checkSellable(tokenAddress);
      if (sellable === false) safe = false;
    }
  } catch {
    // on-chain check failed -> allow through; liquidity/other checks still apply
  }
  safetyCache.set(key, safe);
  return safe;
}

async function tokenLiquidity(chainId, tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (!res.ok) return 0;
    const { pairs } = await res.json();
    if (!pairs) return 0;
    const pair = pairs.find((p) => p.chainId === chainId && p.liquidity && p.liquidity.usd > 0);
    return pair ? Number(pair.liquidity.usd) : 0;
  } catch {
    return 0;
  }
}

async function pollOnce() {
  const state = getSniperState();
  if (!state.enabled || !state.users?.length) return;

  let profiles;
  try {
    const res = await fetch(PROFILES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    profiles = await res.json();
  } catch (err) {
    logger.error('Sniper: failed to fetch profiles', { error: err.message });
    return;
  }

  for (const profile of profiles || []) {
    const tokenAddress = profile.tokenAddress;
    if (!tokenAddress || seen.has(tokenAddress)) continue;
    keepSeen(tokenAddress);

    for (const user of state.users) {
      const adapter = getAdapter(user.chain);
      if (!adapter.isValidAddress(tokenAddress)) continue;
      if (profile.chainId !== user.chain) continue;

      try {
        const liq = await tokenLiquidity(user.chain, tokenAddress);
        if (liq < (user.minLiquidity ?? 5000)) continue;
        if (user.antiRug !== false) {
          const safe = await isSafeToken(user.chain, tokenAddress);
          if (!safe) {
            logger.info('Sniper skipped unsafe token', { tgId: user.tgId, chain: user.chain, token: tokenAddress });
            continue;
          }
        }
        await buy(String(user.tgId), user.chain, tokenAddress, String(user.amount ?? 0.01));
        logger.info('Sniper BUY', { tgId: user.tgId, chain: user.chain, token: tokenAddress, liq });
      } catch (err) {
        logger.error('Sniper buy failed', { tgId: user.tgId, token: tokenAddress, error: err.message });
      }
    }
  }
}

export async function startSniper() {
  const pollMs = Number(config.sniperPollMs) || 10000;
  await pollOnce();
  setInterval(pollOnce, pollMs);
  logger.info('Sniper started', { pollMs });
}

export function setSniperUser(tgId, opts) {
  const state = getSniperState();
  if (!state.users) state.users = [];
  let user = state.users.find((u) => u.tgId === String(tgId));
  if (!user) {
    user = { tgId: String(tgId), chain: 'solana', amount: 0.01, minLiquidity: 5000, enabled: true };
    state.users.push(user);
  }
  if (opts.enabled !== undefined) user.enabled = opts.enabled;
  Object.assign(user, { ...opts, enabled: user.enabled });
  state.enabled = state.users.some((u) => u.enabled);
  setSniper(state);
  return user;
}

export function getSniperUser(tgId) {
  return (getSniperState().users || []).find((u) => u.tgId === String(tgId)) || null;
}

export function getSniperEnabled() {
  return getSniperState().enabled;
}

export function setSniperEnabled(enabled) {
  const state = getSniperState();
  state.enabled = enabled && state.users?.some((u) => u.enabled);
  setSniper(state);
  return state.enabled;
}

