import { makeSolanaAdapter } from './solana.js';
import { makeEvmAdapter } from './evm.js';

const adapters = {
  solana: makeSolanaAdapter(),
  ethereum: makeEvmAdapter('ethereum'),
  bnb: makeEvmAdapter('bnb'),
  robinhood: makeEvmAdapter('robinhood'),
};

export function getAdapter(chainId) {
  const a = adapters[chainId];
  if (!a) throw new Error(`Unsupported chain: ${chainId}`);
  return a;
}

export function listAdapters() {
  return Object.values(adapters);
}
