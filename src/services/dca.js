import { getDcaState, setDca } from '../db/store.js';
import { buy } from '../trading.js';
import { getAdapter } from '../chains/index.js';
import { logger } from '../logger.js';

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function addDcaPlan(tgId, chain, token, amountPerRound, rounds, intervalMs) {
  if (!Number.isFinite(Number(amountPerRound)) || Number(amountPerRound) <= 0) {
    throw new Error('Amount must be > 0');
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 500) {
    throw new Error('Rounds must be 1-500');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 60000) {
    throw new Error('Interval must be at least 1 minute');
  }
  const state = getDcaState();
  if (!state.plans) state.plans = [];
  const plan = {
    id: genId(),
    tgId: String(tgId),
    chain,
    token,
    amountPerRound: String(amountPerRound),
    totalRounds: rounds,
    intervalMs,
    nextRun: Date.now() + intervalMs,
    roundsDone: 0,
    status: 'active',
    createdAt: Date.now(),
  };
  state.plans.push(plan);
  setDca(state);
  return plan;
}

export function cancelDcaPlan(tgId, id) {
  const state = getDcaState();
  const plan = state.plans.find((p) => p.id === id && String(p.tgId) === String(tgId));
  if (!plan) return false;
  plan.status = 'cancelled';
  setDca(state);
  return true;
}

export function listDcaPlans(tgId) {
  return (getDcaState().plans || []).filter(
    (p) => String(p.tgId) === String(tgId) && p.status === 'active'
  );
}

async function runDuePlans() {
  const state = getDcaState();
  const now = Date.now();
  for (const plan of state.plans || []) {
    if (plan.status !== 'active' || now < plan.nextRun) continue;
    try {
      const r = await buy(plan.tgId, plan.chain, plan.token, plan.amountPerRound);
      plan.roundsDone += 1;
      plan.lastTxid = r.txid;
      plan.lastRound = now;
      plan.nextRun = now + plan.intervalMs;
      if (plan.roundsDone >= plan.totalRounds) plan.status = 'completed';
      setDca(state);
      logger.info('DCA round executed', {
        id: plan.id,
        tgId: plan.tgId,
        chain: plan.chain,
        token: plan.token,
        round: plan.roundsDone,
        txid: r.txid,
      });
    } catch (err) {
      plan.lastError = err.message;
      plan.nextRun = now + plan.intervalMs;
      setDca(state);
      logger.error('DCA round failed', { id: plan.id, error: err.message });
    }
  }
}

export async function startDca() {
  await runDuePlans();
  setInterval(runDuePlans, 15000);
  logger.info('DCA engine started');
}
