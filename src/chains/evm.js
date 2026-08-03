import { JsonRpcProvider, Contract, Wallet, parseUnits, formatUnits, MaxUint256 } from 'ethers';
import { config } from '../config.js';
import { logger } from '../logger.js';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

const ROUTER_ABI = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
];

const NATIVE_ALIASES = new Set(['native', 'eth', 'bnb', 'bsc', 'weth', 'wbnb', 'wrap', 'wrapped']);

const INFO_CACHE = new Map();

export function makeEvmAdapter(chainId) {
  const cfg = config.chains[chainId];
  const provider = new JsonRpcProvider(cfg.rpc, undefined, { staticNetwork: true });
  const router = new Contract(cfg.router, ROUTER_ABI, provider);

  function normalizeAddress(input) {
    const v = String(input || '').trim();
    if (NATIVE_ALIASES.has(v.toLowerCase()) || v.toLowerCase() === 'native') return cfg.wrapped;
    if (/^(0x)?[0-9a-fA-F]{40}$/.test(v)) {
      const cleaned = v.startsWith('0x') ? v : `0x${v}`;
      return cleaned.toLowerCase();
    }
    return v;
  }

  function isValidAddress(a) {
    try {
      return /^0x[0-9a-fA-F]{40}$/.test(a);
    } catch {
      return false;
    }
  }

  async function getTokenInfo(address) {
    const addr = normalizeAddress(address);
    if (addr === cfg.wrapped) {
      return { address: cfg.wrapped, symbol: cfg.native, decimals: 18, wrapped: true };
    }
    if (INFO_CACHE.has(addr)) return INFO_CACHE.get(addr);
    let info = { address: addr, symbol: addr.slice(0, 6).toUpperCase(), decimals: 18 };
    try {
      const tok = new Contract(addr, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([tok.symbol(), tok.decimals()]);
      info = { address: addr, symbol, decimals: Number(decimals) };
    } catch {
      // keep defaults
    }
    INFO_CACHE.set(addr, info);
    return info;
  }

  async function getNativeBalance(wallet) {
    return (await provider.getBalance(wallet.address)).toString();
  }

  async function getTokenBalance(wallet, address) {
    const addr = normalizeAddress(address);
    if (addr === cfg.wrapped) return getNativeBalance(wallet);
    const tok = new Contract(addr, ERC20_ABI, provider);
    return (await tok.balanceOf(wallet.address)).toString();
  }

  async function getBalances(wallet) {
    const nativeRaw = await getNativeBalance(wallet);
    const balances = [
      { token: cfg.wrapped, symbol: cfg.native, raw: nativeRaw, human: formatUnits(nativeRaw, 18), decimals: 18 },
    ];
    return balances;
  }

  function buildPath(input, output) {
    return [normalizeAddress(input), normalizeAddress(output)];
  }

  async function getQuote({ input, output, amountInRaw, amountOutHuman, slippagePercent }) {
    const inAddr = normalizeAddress(input);
    const outAddr = normalizeAddress(output);
    const path = buildPath(input, output);
    const inInfo = await getTokenInfo(inAddr);
    const outInfo = await getTokenInfo(outAddr);
    const slippageBps = Math.round((slippagePercent || 3) * 100);

    let amountsIn;
    let amountsOut;
    if (amountInRaw) {
      amountsOut = await router.getAmountsOut(amountInRaw, path);
      amountsIn = [amountInRaw];
    } else if (amountOutHuman) {
      const outRaw = parseUnits(amountOutHuman.toString(), outInfo.decimals);
      amountsIn = await router.getAmountsIn(outRaw, path);
      amountsOut = await router.getAmountsOut(amountsIn[0], path);
    } else {
      throw new Error('Either amountInRaw or amountOutHuman is required');
    }

    const outRaw = amountsOut[amountsOut.length - 1];
    const price =
      Number(outRaw) / 10 ** outInfo.decimals / (Number(amountsIn[0]) / 10 ** inInfo.decimals);
    const direct = await router.getAmountsOut(amountsIn[0], path);
    const priceImpactPct =
      direct.length > 1 && direct[direct.length - 1] > 0n
        ? Math.max(0, (1 - Number(outRaw) / Number(direct[direct.length - 1])) * 100)
        : 0;

    return {
      input: inAddr,
      output: outAddr,
      inSymbol: inInfo.symbol,
      outSymbol: outInfo.symbol,
      amountInRaw: amountsIn[0].toString(),
      amountOutRaw: outRaw.toString(),
      amountOutHuman: formatUnits(outRaw, outInfo.decimals),
      priceImpactPct,
      slippageBps,
      path,
      raw: { amountsIn: amountsIn.map((a) => a.toString()), amountsOut: amountsOut.map((a) => a.toString()) },
    };
  }

  async function ensureApproved(signer, tokenAddr, amountRaw) {
    const tok = new Contract(tokenAddr, ERC20_ABI, signer);
    const allowance = await tok.allowance(signer.address, cfg.router);
    if (allowance >= BigInt(amountRaw)) return;
    logger.info('Approving token for router', { chain: chainId, token: tokenAddr });
    const tx = await tok.approve(cfg.router, MaxUint256);
    await tx.wait();
  }

  async function executeSwap({ wallet, quote, slippagePercent }) {
    const signer = new Wallet(wallet.privateKey, provider);
    const to = wallet.address;
    const slippageBps = Math.round((slippagePercent || quote.slippageBps / 100) * 100);
    const minOut = (BigInt(quote.amountOutRaw) * BigInt(10000 - slippageBps)) / 10000n;
    const amountIn = BigInt(quote.amountInRaw);
    const path = quote.path;
    const buyWithNative = quote.input === cfg.wrapped && quote.output !== cfg.wrapped;
    const sellToNative = quote.output === cfg.wrapped && quote.input !== cfg.wrapped;

    let tx;
    if (buyWithNative) {
      tx = await router
        .connect(signer)
        .swapExactETHForTokensSupportingFeeOnTransferTokens(minOut, path, to, Math.floor(Date.now() / 1000) + 300, {
          value: amountIn,
          gasLimit: 400000,
        });
    } else if (sellToNative) {
      await ensureApproved(signer, quote.input, amountIn);
      tx = await router
        .connect(signer)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          amountIn,
          minOut,
          path,
          to,
          Math.floor(Date.now() / 1000) + 300,
          { gasLimit: 400000 }
        );
    } else {
      await ensureApproved(signer, quote.input, amountIn);
      tx = await router
        .connect(signer)
        .swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amountIn,
          minOut,
          path,
          to,
          Math.floor(Date.now() / 1000) + 300,
          { gasLimit: 400000 }
        );
    }
    const receipt = await tx.wait();
    logger.info('EVM swap confirmed', { chain: chainId, txid: receipt.hash });
    return { txid: receipt.hash, receipt };
  }

  return {
    chainId,
    nativeSymbol: cfg.native,
    nativeDecimals: 18,
    normalizeAddress,
    isValidAddress,
    getTokenInfo,
    getNativeBalance,
    getTokenBalance,
    getBalances,
    getQuote,
    executeSwap,
    needsApprove: true,
  };
}
