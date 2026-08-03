import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY_DB = {
  users: {},
  copytrade: {},
  sniper: {},
  signals: {},
  limits: {},
};

let db = null;

/* ---------- encryption ---------- */

function deriveKey() {
  return crypto.scryptSync(config.walletSecret, 'tg-bot-salt', 32);
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch (err) {
    logger.error('Failed to decrypt wallet secret', { error: err.message });
    return null;
  }
}

/* ---------- load / save ---------- */

export function load() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = { ...EMPTY_DB, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    } catch (err) {
      logger.warn('Corrupt db.json, starting fresh', { error: err.message });
      db = structuredClone(EMPTY_DB);
    }
  } else {
    db = structuredClone(EMPTY_DB);
  }
  migrate();
  return db;
}

/* Migrate legacy wallet shape {address,encKey} -> {active, items:{id:wallet}} */
function migrate() {
  let changed = false;
  for (const u of Object.values(db.users || {})) {
    for (const chainId of Object.keys(u.wallets || {})) {
      const w = u.wallets[chainId];
      if (w && w.address && !w.items) {
        const id = 'w0';
        u.wallets[chainId] = { active: id, items: { [id]: { ...w, id } } };
        changed = true;
      }
    }
    if (!u.trades) u.trades = [];
    if (!u.positions) u.positions = {};
    if (!u.feesOwed) u.feesOwed = {};
  }
  if (changed) save();
}

export function save() {
  if (!db) load();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- user helpers ---------- */

function ensureUser(tgId) {
  const id = String(tgId);
  if (!db.users[id]) {
    db.users[id] = {
      id,
      createdAt: Date.now(),
      defaultChain: 'solana',
      slippage: 3,
      wallets: {},
      trades: [],
      positions: {},
      feesOwed: {},
    };
  }
  return db.users[id];
}

export function getUser(tgId) {
  return db.users[String(tgId)] || null;
}

export function getOrCreateUser(tgId) {
  return ensureUser(tgId);
}

export function setUserField(tgId, field, value) {
  const u = ensureUser(tgId);
  u[field] = value;
  save();
  return u;
}

/* ---------- multi-wallet ---------- */

export function getWallet(tgId, chainId) {
  const u = getUser(tgId);
  const group = u?.wallets?.[chainId];
  if (!group?.items) return null;
  return group.items[group.active] || Object.values(group.items)[0] || null;
}

export function getWallets(tgId, chainId) {
  const u = getUser(tgId);
  const group = u?.wallets?.[chainId];
  return group?.items ? Object.values(group.items) : [];
}

export function getActiveWalletId(tgId, chainId) {
  const u = getUser(tgId);
  return u?.wallets?.[chainId]?.active || null;
}

export function addWallet(tgId, chainId, wallet) {
  const u = ensureUser(tgId);
  if (!u.wallets[chainId]) u.wallets[chainId] = { active: null, items: {} };
  const group = u.wallets[chainId];
  const id = `w${Object.keys(group.items).length}`;
  group.items[id] = { id, ...wallet, createdAt: wallet.createdAt || Date.now() };
  if (!group.active) group.active = id;
  save();
  return group.items[id];
}

export function setActiveWallet(tgId, chainId, id) {
  const u = ensureUser(tgId);
  if (!u.wallets[chainId]?.items?.[id]) throw new Error('Wallet not found');
  u.wallets[chainId].active = id;
  save();
  return u.wallets[chainId].items[id];
}

/* ---------- trades / positions / fees ---------- */

export function addTrade(tgId, trade) {
  const u = ensureUser(tgId);
  u.trades.unshift({ ts: Date.now(), ...trade });
  if (u.trades.length > 500) u.trades.length = 500;
  save();
}

export function getTrades(tgId, limit = 20) {
  return (getUser(tgId)?.trades || []).slice(0, limit);
}

export function addFee(tgId, chainId, amountRaw) {
  const u = ensureUser(tgId);
  u.feesOwed[chainId] = (u.feesOwed[chainId] || 0) + amountRaw;
  save();
}

export function getFees(tgId) {
  return getUser(tgId)?.feesOwed || {};
}

export function getPosition(tgId, chainId, token) {
  return getUser(tgId)?.positions?.[chainId]?.[token.toLowerCase()] || null;
}

export function upsertPosition(tgId, chainId, token, data) {
  const u = ensureUser(tgId);
  if (!u.positions[chainId]) u.positions[chainId] = {};
  u.positions[chainId][token.toLowerCase()] = data;
  save();
  return data;
}

export function deletePosition(tgId, chainId, token) {
  const u = getUser(tgId);
  if (u?.positions?.[chainId]) {
    delete u.positions[chainId][token.toLowerCase()];
    save();
  }
}

export function getPositions(tgId) {
  return getUser(tgId)?.positions || {};
}

/* ---------- copytrade / sniper / signals / limits ---------- */

export function getCopytradeState() {
  if (!db.copytrade) db.copytrade = { enabled: false, targets: [] };
  return db.copytrade;
}

export function setCopytrade(state) {
  db.copytrade = state;
  save();
}

export function getSniperState() {
  if (!db.sniper) db.sniper = { enabled: false, users: [], filters: {} };
  if (!Array.isArray(db.sniper.users)) db.sniper.users = [];
  return db.sniper;
}

export function setSniper(state) {
  db.sniper = state;
  save();
}

export function getSignalsState() {
  if (!db.signals) db.signals = { sources: [] };
  return db.signals;
}

export function setSignals(state) {
  db.signals = state;
  save();
}

export function getLimitsState() {
  if (!db.limits) db.limits = { orders: [] };
  return db.limits;
}

export function setLimits(state) {
  db.limits = state;
  save();
}

export { DATA_DIR };
