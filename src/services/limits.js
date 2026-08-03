import { getLimitsState, setLimits } from '../db/store.js';
import { getAdapter } from '../chains/index.js';
import { buy, sell } from '../trading.js';
import { logger } from '../logger.js';

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function addLimitOrder(tgId, chain, dir, token, targetPrice, amount) {
  const state = getLimitsState();
  if (!state.orders) state.orders = [];
  const order = {
    id: genId(),
    tgId: String(tgId),
    chain,
    dir,
    token,
    targetPrice: Number(targetPrice),
    amount: String(amount),
    status: 'active',
    createdAt: Date.now(),
  };
  if (!Number.isFinite(order.targetPrice) || order.targetPrice <= 0) {
    throw new Error('Invalid target price');
  }
  state.orders.push(order);
  setLimits(state);
  return order;
}

export function cancelLimitOrder(tgId, id) {
  const state = getLimitsState();
  const order = state.orders.find((o) => o.id === id && String(o.tgId) === String(tgId));
  if (!order) return false;
  order.status = 'cancelled';
  setLimits(state);
  return true;
}

export function listLimitOrders(tgId) {
  return (getLimitsState().orders || []).filter((o) => String(o.tgId) === String(tgId) && o.status === 'active');
}

export function listAllActiveOrders() {
  return (getLimitsState().orders || []).filter((o) => o.status === 'active');
}

async function evaluateOrder(order) {
  const adapter = getAdapter(order.chain);
  let current;
  try {
    current = await adapter.getPrice(order.token);
  } catch (err) {
    logger.warn('Limit: price fetch failed', { id: order.id, error: err.message });
    return;
  }
  if (order.dir === 'buy' && current > order.targetPrice) return;
  if (order.dir === 'sell' && current < order.targetPrice) return;

  const state = getLimitsState();
  const live = state.orders.find((o) => o.id === order.id);
  if (!live || live.status !== 'active') return;

  try {
    let result;
    if (order.dir === 'buy') {
      result = await buy(order.tgId, order.chain, order.token, order.amount);
    } else {
      result = await sell(order.tgId, order.chain, order.token, order.amount);
    }
    live.status = 'executed';
    live.filledAt = Date.now();
    live.filledPrice = current;
    live.txid = result.txid;
    setLimits(state);
    logger.info('Limit order executed', { id: order.id, dir: order.dir, price: current, txid: result.txid });
  } catch (err) {
    live.status = 'failed';
    live.error = err.message;
    setLimits(state);
    logger.error('Limit order failed', { id: order.id, error: err.message });
  }
}

export async function startLimitEngine() {
  const run = async () => {
    const orders = listAllActiveOrders();
    if (orders.length === 0) return;
    for (const order of orders) {
      await evaluateOrder(order);
    }
  };
  await run();
  setInterval(run, 15000);
  logger.info('Limit order engine started');
}
