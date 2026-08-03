import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { Wallet as EvmWallet } from 'ethers';
import { getAdapter } from './chains/index.js';
import {
  getOrCreateUser,
  addWallet,
  getWallet,
  getWallets,
  setActiveWallet,
  encryptSecret,
  decryptSecret,
} from './db/store.js';

function newSolanaWallet() {
  const kp = Keypair.generate();
  return {
    address: kp.publicKey.toBase58(),
    secretB64: Buffer.from(kp.secretKey).toString('base64'),
  };
}

function newEvmWallet() {
  const w = EvmWallet.createRandom();
  return { address: w.address, secretB64: Buffer.from(w.privateKey.slice(2), 'hex').toString('base64') };
}

function importSolanaSecret(input) {
  let secret;
  try {
    secret = bs58.decode(input.trim());
  } catch {
    try {
      secret = Buffer.from(input.trim(), 'base64');
    } catch {
      throw new Error('Invalid Solana secret key format (expected base58)');
    }
  }
  if (secret.length === 32) {
    secret = Keypair.fromSeed(secret).secretKey;
  }
  if (secret.length !== 64) throw new Error('Invalid Solana secret key length');
  const kp = Keypair.fromSecretKey(secret);
  return { address: kp.publicKey.toBase58(), secretB64: Buffer.from(secret).toString('base64') };
}

function importEvmSecret(input) {
  let pk = input.trim();
  if (!pk.startsWith('0x')) pk = `0x${pk}`;
  const w = new EvmWallet(pk);
  return { address: w.address, secretB64: Buffer.from(w.privateKey.slice(2), 'hex').toString('base64') };
}

export function createWallet(chainId) {
  const adapter = getAdapter(chainId);
  if (chainId === 'solana') return newSolanaWallet();
  if (adapter.needsApprove) return newEvmWallet();
  throw new Error(`No wallet generator for ${chainId}`);
}

export function importWallet(chainId, secret) {
  if (chainId === 'solana') return importSolanaSecret(secret);
  const adapter = getAdapter(chainId);
  if (adapter.needsApprove) return importEvmSecret(secret);
  throw new Error(`No wallet importer for ${chainId}`);
}

export function saveWallet(tgId, chainId, wallet) {
  getOrCreateUser(tgId);
  const stored = {
    address: wallet.address,
    encKey: encryptSecret(wallet.secretB64),
  };
  return addWallet(tgId, chainId, stored);
}

export function switchWallet(tgId, chainId, id) {
  return setActiveWallet(tgId, chainId, id);
}

export function listWallets(tgId, chainId) {
  return getWallets(tgId, chainId);
}

function toSigner(chainId, stored) {
  const secretB64 = decryptSecret(stored.encKey);
  if (!secretB64) throw new Error('Could not decrypt wallet key');
  if (chainId === 'solana') {
    const kp = Keypair.fromSecretKey(Buffer.from(secretB64, 'base64'));
    return { publicKey: kp.publicKey, keypair: kp };
  }
  const pk = `0x${Buffer.from(secretB64, 'base64').toString('hex')}`;
  return { address: stored.address, privateKey: pk };
}

export function getSigner(tgId, chainId) {
  const stored = getWallet(tgId, chainId);
  if (!stored) return null;
  return { stored, signer: toSigner(chainId, stored) };
}
