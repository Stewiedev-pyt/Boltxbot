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
  return db;
}

export function save() {
  if (!db) load();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- helpers ---------- */

function ensureUser(tgId) {
  const id = String(tgId);
  if (!db.users[id]) {
    db.users[id] = {
      id,
      createdAt: Date.now(),
      defaultChain: 'solana',
      slippage: 3,
      wallets: {},
    };
  }
  return db.users[id];
}

export function getUser(tgId) {
  const u = db.users[String(tgId)];
  return u || null;
}

export function getOrCreateUser(tgId) {
  const u = ensureUser(tgId);
  return u;
}

export function setUserField(tgId, field, value) {
  const u = ensureUser(tgId);
  u[field] = value;
  save();
  return u;
}

export function setWallet(tgId, chainId, wallet) {
  const u = ensureUser(tgId);
  u.wallets[chainId] = wallet;
  save();
  return wallet;
}

export function getWallet(tgId, chainId) {
  const u = getUser(tgId);
  return u?.wallets?.[chainId] || null;
}

export function getCopytradeState() {
  if (!db.copytrade) db.copytrade = { enabled: false, targets: [] };
  return db.copytrade;
}

export function setCopytrade(state) {
  db.copytrade = state;
  save();
}

export function getSniperState() {
  if (!db.sniper) db.sniper = { enabled: false, users: {}, filters: {} };
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

export { DATA_DIR };
