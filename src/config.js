import 'dotenv/config';

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  walletSecret: process.env.WALLET_SECRET || 'change-me-to-a-strong-passphrase',

  logLevel: process.env.LOG_LEVEL || 'info',

  chains: {
    solana: {
      name: 'solana',
      rpc: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
      jupiterQuoteApi:
        process.env.JUPITER_QUOTE_API ||
        'https://public.jupiter.community/v6,https://quote-api.jup.ag/v6',
    },
    ethereum: {
      name: 'ethereum',
      rpc: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com',
      router: process.env.ETH_ROUTER || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      wrapped: process.env.ETH_WRAPPED || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      baseToken: process.env.ETH_BASE_TOKEN || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      native: 'ETH',
    },
    bnb: {
      name: 'bnb',
      rpc: process.env.BNB_RPC || 'https://bsc-dataseed.binance.org',
      router: process.env.BNB_ROUTER || '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      wrapped: process.env.BNB_WRAPPED || '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      baseToken: process.env.BNB_BASE_TOKEN || '0x55d398326f99059fF775485246999027B3197955',
      native: 'BNB',
    },
  },
};

export const CHAIN_IDS = Object.keys(config.chains);
export const CHAIN_LABELS = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  bnb: 'BNB Chain',
};
