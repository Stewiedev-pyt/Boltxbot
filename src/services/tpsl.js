import { getUser, setUserField } from '../db/store.js';
import { addLimitOrder } from './limits.js';
import { logger } from '../logger.js';

export function getTpSlSettings(tgId) {
  return getUser(tgId)?.tpSl || { enabled: false, tpPct: 20, slPct: 10 };
}

export function setTpSlSettings(tgId, opts) {
  const current = getTpSlSettings(tgId);
  const next = { ...current, ...opts };
  setUserField(tgId, 'tpSl', next);
  return next;
}

/* After a successful buy, auto-open take-profit and/or stop-loss limit sell
   orders for the purchased quantity at entry + TP% / entry - SL%. */
export function maybeOpenTpSl(tgId, chainId, token, entryPrice, qtyHuman) {
  const s = getTpSlSettings(tgId);
  if (!s.enabled) return [];
  const opened = [];
  try {
    if (Number(s.tpPct) > 0) {
      const price = entryPrice * (1 + Number(s.tpPct) / 100);
      const o = addLimitOrder(tgId, chainId, 'sell', token, price, qtyHuman);
      o.tag = 'tp';
      opened.push(o);
    }
    if (Number(s.slPct) > 0) {
      const price = entryPrice * (1 - Number(s.slPct) / 100);
      const o = addLimitOrder(tgId, chainId, 'sell', token, price, qtyHuman);
      o.tag = 'sl';
      opened.push(o);
    }
  } catch (err) {
    logger.warn('Auto TP/SL open failed', { tgId, chainId, token, error: err.message });
  }
  if (opened.length) {
    logger.info('Auto TP/SL orders opened', { tgId, chainId, token, count: opened.length });
  }
  return opened;
}
