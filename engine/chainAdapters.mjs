/**
 * Pluggable Multi-Chain Adapters (Solana, BSC, Robinhood Chain, Arc)
 *
 * Provides a clean boundary between the Copy-Trading Domain Engine and
 * underlying chain execution (Paper/Simulated by default, with pluggable hooks
 * for live RPCs, Jupiter/Pump.fun on Solana, and 0x/DEX routers on EVM).
 */

export const CHAINS = {
  solana: {
    id: 'solana',
    name: 'Solana',
    shortName: 'SOL',
    nativeAsset: 'SOL',
    stableAsset: 'USDC',
    nativePriceUsd: 185.0,
    gasReserveNative: 0.015, // Held back when trading native SOL so positions can always sell
    launchpad: 'pump.fun',
    mevProtection: 'Private Solana Route',
    explorerTxUrl: 'https://solscan.io/tx/',
    explorerTokenUrl: 'https://dexscreener.com/solana/',
    color: '#9945ff',
  },
  bsc: {
    id: 'bsc',
    name: 'BSC',
    shortName: 'BNB',
    nativeAsset: 'BNB',
    stableAsset: 'USDC',
    nativePriceUsd: 610.0,
    gasReserveNative: 0.005,
    launchpad: 'Flap / four.meme',
    mevProtection: 'BSC Private Relay',
    explorerTxUrl: 'https://bscscan.com/tx/',
    explorerTokenUrl: 'https://dexscreener.com/bsc/',
    color: '#f3ba2f',
  },
  robinhood: {
    id: 'robinhood',
    name: 'Robinhood Chain',
    shortName: 'RH',
    nativeAsset: 'ETH',
    stableAsset: 'USDG',
    nativePriceUsd: 2650.0,
    gasReserveNative: 0.0015,
    launchpad: 'pons',
    mevProtection: 'FIFO Sequencer (No Priority Outbidding)',
    explorerTxUrl: 'https://explorer.robinhood.com/tx/',
    explorerTokenUrl: 'https://dexscreener.com/robinhood/',
    color: '#c5f135',
  },
  arc: {
    id: 'arc',
    name: 'Arc',
    shortName: 'ARC',
    nativeAsset: 'USDC',
    stableAsset: 'USDC',
    nativePriceUsd: 1.0,
    gasReserveNative: 2.0, // $2 USDC reserve for gas on Arc
    launchpad: null, // Arc has no launchpad
    mevProtection: 'Standard',
    explorerTxUrl: 'https://explorer.arc.network/tx/',
    explorerTokenUrl: 'https://dexscreener.com/arc/',
    color: '#3b6ef5',
  },
};

export const PRIORITY_FEE_PRESETS = {
  normal: {
    id: 'normal',
    label: 'Normal',
    solanaSol: 0.0002,
    evmMultiplier: 1.0,
  },
  fast: {
    id: 'fast',
    label: 'Fast',
    solanaSol: 0.001,
    evmMultiplier: 1.5,
  },
  turbo: {
    id: 'turbo',
    label: 'Turbo',
    solanaSol: 0.005,
    evmMultiplier: 2.0,
  },
  custom: {
    id: 'custom',
    label: 'Custom',
    solanaSol: 0.002,
    evmMultiplier: 1.0,
  },
};

/**
 * Default Paper/Simulated Chain Adapter.
 * Replace or extend methods in `liveHooks` to wire real RPCs / Privy signing.
 */
/**
 * Paper fees on Solana = what a real trade through Jupiter pays (see README "How paper PnL is counted"):
 *   venue fee   pump.fun bonding curve 1.25%; PumpSwap (graduated pump.fun) tiered from 1.25% for
 *               small coins down to 0.30% for the largest; other DEX pools ~0.25%
 *   router fee  Jupiter: 0.5% for tokens under 24 h old, 0.1% otherwise
 *   network     priority fee preset + 5000 lamports; first buy of a token also opens a token
 *               account (0.00203928 SOL rent, not refunded — Jupiter doesn't close it)
 */
export const PAPER_SOLANA_FEES = {
  pumpCurvePct: 1.25,
  pumpSwapMaxPct: 1.25,
  pumpSwapMinPct: 0.3,
  pumpSwapMaxFeeMcUsd: 100_000, // at or below: max tier
  pumpSwapMinFeeMcUsd: 20_000_000, // at or above: min tier
  otherDexPct: 0.25,
  jupiterNewTokenPct: 0.5,
  jupiterPct: 0.1,
  tokenAccountRentSol: 0.00203928,
  realSwapNetworkSol: 0.00003, // base fee + Jupiter's own priority/landing fee, per swap (measured)
};

export function solanaTradeFeePct(token = {}, now = Date.now()) {
  const F = PAPER_SOLANA_FEES;
  // pump.fun coins: mint address ends in "pump"
  const pump = /pump$/i.test(String(token.address || '')) || token.venue === 'pumpfun' || token.venue === 'pumpswap';
  let venuePct;
  if (pump && token.stage === 'pre-grad') venuePct = F.pumpCurvePct;
  else if (pump) {
    const mc = Number(token.marketCapUsd) || 0;
    if (mc <= F.pumpSwapMaxFeeMcUsd) venuePct = F.pumpSwapMaxPct;
    else if (mc >= F.pumpSwapMinFeeMcUsd) venuePct = F.pumpSwapMinPct;
    else {
      // log-scale step down between the two market caps
      const t = Math.log(mc / F.pumpSwapMaxFeeMcUsd) / Math.log(F.pumpSwapMinFeeMcUsd / F.pumpSwapMaxFeeMcUsd);
      venuePct = F.pumpSwapMaxPct - t * (F.pumpSwapMaxPct - F.pumpSwapMinPct);
    }
  } else venuePct = F.otherDexPct;
  const created = Number(token.createdAt) || null;
  // unknown age: pump.fun coins are almost always under a day old when copied
  const young = created ? now - created < 86_400_000 : true;
  const routerPct = young ? F.jupiterNewTokenPct : F.jupiterPct;
  return { venuePct, routerPct, totalPct: venuePct + routerPct };
}

export class ChainExecutionAdapter {
  constructor(options = {}) {
    this.mode = options.mode || 'paper'; // 'paper' | 'live'
    this.liveHooks = options.liveHooks || {};
    // Real trading per trade: () => true when the real trader is set up (key loaded)
    this.realEnabled = options.realEnabled || null;
  }

  /**
   * Is this trade a real one? `paper` comes from the trade itself (Paper Trading at buy time,
   * or the position's own flag on a sell), so paper positions always settle on paper.
   */
  useLive({ paper, chainId } = {}) {
    if (this.mode === 'live') return Boolean(this.liveHooks.executeSwap);
    return paper === false && chainId === 'solana' && typeof this.realEnabled === 'function' && Boolean(this.realEnabled()) && Boolean(this.liveHooks.executeSwap);
  }

  /**
   * Step 2 Safety Audit: Checks token contract/mint authorities and runs practice sell on EVM.
   */
  async inspectTokenSafety(chainId, token) {
    if (this.mode === 'live' && this.liveHooks.inspectTokenSafety) {
      return this.liveHooks.inspectTokenSafety(chainId, token);
    }

    const safety = token.safety || {};
    if (chainId === 'solana') {
      const nonTransferable = Boolean(safety.nonTransferable);
      const frozenDefault = Boolean(safety.frozenDefault);
      const transferFeePct = Number(safety.transferFeePct || 0);
      // A failed practice sale / honeypot flag is refused on every chain, independent of
      // the "Block risky coins" switch (previously only enforced on EVM chains).
      if (safety.honeypot || safety.practiceSellFailed) {
        return { hardBlocked: true, reason: 'blocked by your safety filter' };
      }
      // Always-on Solana refusal rules
      if (nonTransferable || frozenDefault || transferFeePct >= 10) {
        return {
          hardBlocked: true,
          reason: transferFeePct >= 10 ? "token's transfer fee is too high" : 'token could not be sold safely',
        };
      }
      return {
        hardBlocked: false,
        hasFreezeOrHookOrDelegate: Boolean(
          safety.freezeAuthority || safety.transferHook || safety.permanentDelegate || safety.feeAuthority
        ),
        isMintable: Boolean(safety.mintAuthority),
        safetyVerified: safety.safetyVerified !== false,
      };
    }

    // EVM chains (BSC, Robinhood Chain, Arc): practice sale & tax checks
    const practiceSellFailed = Boolean(safety.honeypot || safety.practiceSellFailed);
    if (practiceSellFailed) {
      return {
        hardBlocked: true,
        reason: 'token could not be sold safely',
      };
    }

    return {
      hardBlocked: false,
      hasRiskyOwnerControls: Boolean(
        safety.canChangeTax || safety.canBlacklist || safety.canPauseTrading || Number(safety.sellTaxPct || 0) > 25
      ),
      isMintableOrMutable: Boolean(safety.canChangeTax || safety.canBlacklist || safety.canPauseTrading),
      buyTaxPct: Number(safety.buyTaxPct || 0),
      sellTaxPct: Number(safety.sellTaxPct || 0),
      snipeTaxPct: Number(safety.snipeTaxPct || 0),
      safetyVerified: safety.safetyVerified !== false,
    };
  }

  /**
   * Step 4 Quote Fetch: Returns live swap quote vs trader fill price.
   */
  async getSwapQuote(args) {
    const { side, token, amountUsd, slippagePct } = args;
    if (this.useLive(args) && this.liveHooks.getSwapQuote) {
      return this.liveHooks.getSwapQuote(args);
    }

    const currentPriceUsd = Number(token.currentPriceUsd || token.traderFillPriceUsd || 0.001);
    // Real liquidity when known; otherwise only an internal estimate for the price-impact maths
    // (never reported as the token's liquidity)
    const knownLiquidity = Number(token.liquidityUsd) > 0 ? Number(token.liquidityUsd) : null;
    const impactBasis = knownLiquidity || Math.max(25000, (token.marketCapUsd || 80000) * 0.22);
    const liquidityUsd = knownLiquidity;
    const priceImpactPct = Math.min(99, (amountUsd / Math.max(1000, impactBasis)) * 100);

    let fillPriceUsd =
      side === 'buy'
        ? currentPriceUsd * (1 + priceImpactPct / 100)
        : currentPriceUsd * Math.max(0.01, 1 - priceImpactPct / 100);
    let impactPct = priceImpactPct;
    // exact curve fill computed by the engine (pump.fun bonding curve)
    if (side === 'buy' && Number(token.paperFillPriceUsd) > 0) {
      fillPriceUsd = Number(token.paperFillPriceUsd);
      impactPct = Math.max(0, (fillPriceUsd / currentPriceUsd - 1) * 100);
    } else if (side === 'sell' && Number(token.paperSellFillPriceUsd) > 0) {
      fillPriceUsd = Number(token.paperSellFillPriceUsd);
      impactPct = Math.max(0, (1 - fillPriceUsd / currentPriceUsd) * 100);
    }

    return {
      quotedPriceUsd: currentPriceUsd,
      expectedFillPriceUsd: fillPriceUsd,
      priceImpactPct: impactPct,
      liquidityUsd,
      maxAllowedSlippagePct: slippagePct,
      timestamp: Date.now(),
    };
  }

  /**
   * Step 5 Swap Execution: Signs & submits via private route/relay (or simulates paper fill).
   */
  async executeSwap(args) {
    const { chainId, amountUsd, quote, priorityFee, gasless } = args;
    if (this.useLive(args) && this.liveHooks.executeSwap) {
      return this.liveHooks.executeSwap(args);
    }

    const delayMs = typeof this.paperDelayMs === 'function' ? Number(this.paperDelayMs(args)) || 0 : Number(this.paperDelayMs) || 0;
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    let fillPriceUsd = quote.expectedFillPriceUsd;
    if (typeof this.paperLiveFillPrice === 'function') {
      try {
        const livePx = await this.paperLiveFillPrice({ ...args, fillPriceUsd });
        if (Number(livePx) > 0) fillPriceUsd = Number(livePx);
      } catch {
        // keep quoted expectedFillPriceUsd
      }
    }

    const effectiveAmountUsd = args.side === 'sell' && Number(args.positionTokens) > 0 ? Number(args.positionTokens) * fillPriceUsd : amountUsd;
    let platformFeeUsd;
    let networkFeeUsd;
    if (chainId === 'solana') {
      // same fees a real Jupiter trade pays (venue + router + gas, + token-account rent on a first buy)
      platformFeeUsd = effectiveAmountUsd * (solanaTradeFeePct(args.token).totalPct / 100);
      networkFeeUsd = this.estimateNetworkFeeUsd(chainId, priorityFee, false);
      if (args.side === 'buy' && args.newTokenAccount) networkFeeUsd += PAPER_SOLANA_FEES.tokenAccountRentSol * CHAINS.solana.nativePriceUsd;
    } else {
      // Platform fee: max($0.30, 1%) per buy and sell
      platformFeeUsd = Math.max(0.3, effectiveAmountUsd * 0.01);
      networkFeeUsd = this.estimateNetworkFeeUsd(chainId, priorityFee, gasless);
    }

    // Paper fill: no transaction is sent, so there is no transaction hash or explorer link
    return {
      ok: true,
      paper: true,
      txHash: null,
      explorerUrl: null,
      fillPriceUsd,
      platformFeeUsd,
      networkFeeUsd,
      gaslessSponsored: Boolean(gasless),
      executedAt: Date.now(),
    };
  }

  /** Network (gas / priority) fee in USD for one paper swap on a chain. */
  estimateNetworkFeeUsd(chainId, priorityFee, gasless = false) {
    const chain = CHAINS[chainId];
    let networkFeeUsd = 0;
    if (!gasless && chain) {
      if (chainId === 'solana') {
        // Real swaps go through Jupiter, which sets its own priority fee (the Priority Fee setting is
        // not used), so paper charges what real swaps actually paid: measured on the bot wallet at
        // about 0.000006–0.00003 SOL per swap. Token-account rent on a first buy is added separately.
        networkFeeUsd = PAPER_SOLANA_FEES.realSwapNetworkSol * chain.nativePriceUsd;
      } else if (chainId === 'bsc') {
        const mult = (PRIORITY_FEE_PRESETS[priorityFee?.mode || 'normal'] || PRIORITY_FEE_PRESETS.normal).evmMultiplier;
        networkFeeUsd = 0.08 * mult;
      } else if (chainId === 'robinhood') {
        networkFeeUsd = 0.02; // FIFO sequencer, priority fee has no effect
      } else if (chainId === 'arc') {
        const mult = (PRIORITY_FEE_PRESETS[priorityFee?.mode || 'normal'] || PRIORITY_FEE_PRESETS.normal).evmMultiplier;
        networkFeeUsd = 0.05 * mult;
      }
    }
    return networkFeeUsd;
  }
}
