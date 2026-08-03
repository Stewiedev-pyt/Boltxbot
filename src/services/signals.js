import { getSignalsState, setSignals } from '../db/store.js';
import { getAdapter } from '../chains/index.js';
import { logger } from '../logger.js';

const ADDR_RE = /\b(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
const AMOUNT_RE = /(?:with|for|of|amount[:=]?)\s*(\d+(?:\.\d+)?)/i;

export function parseSignal(text) {
  const t = String(text || '');
  const upper = t.toUpperCase();
  let dir = null;
  if (/\bBUY\b|\bLONG\b/.test(upper)) dir = 'buy';
  else if (/\bSELL\b|\bSHORT\b/.test(upper)) dir = 'sell';
  if (!dir) return null;

  const matches = t.match(ADDR_RE);
  if (!matches) return null;

  const amtMatch = t.match(AMOUNT_RE);
  return {
    dir,
    token: matches[0],
    amount: amtMatch ? amtMatch[1] : null,
  };
}

export function addSignalSource(chatId, tgId, chain) {
  const state = getSignalsState();
  if (!state.sources) state.sources = [];
  if (state.sources.some((s) => Number(s.chatId) === Number(chatId))) {
    throw new Error('Source already added');
  }
  const adapter = getAdapter(chain);
  const src = {
    chatId: String(chatId),
    tgId: String(tgId),
    chain,
    maxAmount: null,
  };
  state.sources.push(src);
  setSignals(state);
  return src;
}

export function removeSignalSource(chatId) {
  const state = getSignalsState();
  const before = state.sources.length;
  state.sources = state.sources.filter((s) => Number(s.chatId) !== Number(chatId));
  if (state.sources.length !== before) {
    setSignals(state);
    return true;
  }
  return false;
}

export function listSignalSources() {
  return getSignalsState().sources || [];
}

export function isSignalChat(chatId) {
  return listSignalSources().some((s) => Number(s.chatId) === Number(chatId));
}

