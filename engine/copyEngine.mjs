import { randomUUID } from 'node:crypto';
import { CHAINS, ChainExecutionAdapter, solanaTradeFeePct } from './chainAdapters.mjs';
import { pumpCurveCopyFill, pumpCurveSellFill } from './pumpCurve.mjs';

/**
 * Default 5-Rule Auto-Exit Engine Suggestions & Ranges (exact mofo.gg specification)
 */
export const DEFAULT_EXIT_RULES = {
  takeInitials: {
    enabled: false,
    takeAtPct: 25, // Range: +5% to +1000%
    sellSizePct: 75, // Range: 5% to 95%
  },
  moonbagTrail: {
    enabled: false,
    trailPct: 25, // Range: 5% to 90% off peak
    armsAtPct: 10, // Range: +0% to +500%
  },
  floor: {
    enabled: false,
    openingFloorPct: 45, // Stored as positive drop %: 45 means -45% (Range: 5% to 95%)
    tightensAfterSec: 50, // Range: 1s to 3600s
    tightFloorPct: 20, // Stored as positive drop %: 20 means -20% (Range: 5% to 95%)
  },
  waveCut: {
    enabled: false,
    afterSec: 90, // Range: 5s to 3600s
    needsPeakPct: 5, // Range: +0% to +500%
  },
  hardTimeCap: {
    enabled: false,
    timeCapSec: 300, // Range: 10s to 86400s (5 minutes default)
  },
};

// Ceiling for automatic sell-slippage widening when the Sell Slippage setting is blank
export const AUTO_WIDEN_SELL_SLIPPAGE_MAX_PCT = 30;

export function createDefaultExitRules(overrides = {}) {
  return {
    takeInitials: { ...DEFAULT_EXIT_RULES.takeInitials, ...(overrides.takeInitials || {}) },
    moonbagTrail: { ...DEFAULT_EXIT_RULES.moonbagTrail, ...(overrides.moonbagTrail || {}) },
    floor: { ...DEFAULT_EXIT_RULES.floor, ...(overrides.floor || {}) },
    waveCut: { ...DEFAULT_EXIT_RULES.waveCut, ...(overrides.waveCut || {}) },
    hardTimeCap: { ...DEFAULT_EXIT_RULES.hardTimeCap, ...(overrides.hardTimeCap || {}) },
  };
}

/** The recommended set: what "Auto-Exit" means when the user hasn't tuned any rule. */
export function recommendedExitRules() {
  return createDefaultExitRules({
    takeInitials: { enabled: true },
    moonbagTrail: { enabled: true },
    floor: { enabled: true },
    waveCut: { enabled: true },
    hardTimeCap: { enabled: true },
  });
}

/**
 * "Fast scalp": for traders whose coins pump and dump within 1–3 minutes. Every rule sells the
 * WHOLE position (no moonbag left behind): +12% take profit, 15% trailing stop from +8%,
 * a fixed −25% floor, close after 3 minutes. No wave-cut (it sold dips right before pumps).
 */
export function fastScalpExitRules() {
  return createDefaultExitRules({
    takeInitials: { enabled: true, takeAtPct: 12, sellSizePct: 100 },
    moonbagTrail: { enabled: true, trailPct: 15, armsAtPct: 8 },
    floor: { enabled: true, openingFloorPct: 25, tightensAfterSec: 3600, tightFloorPct: 25 },
    waveCut: { enabled: false, afterSec: 90, needsPeakPct: 5 },
    hardTimeCap: { enabled: true, timeCapSec: 180 },
  });
}

/**
 * "Follow the trader" preset, for skilled fast traders (Decu-style): sell the moment the
 * trader sells, take profit early at +12%, and a wide −40% floor + 5 min cap only as a safety
 * net for when the trader's own sell is slow or missed. No trailing stop: it sold normal dips
 * the trader held through and won.
 */
export function followTraderExitRules() {
  return createDefaultExitRules({
    takeInitials: { enabled: true, takeAtPct: 12, sellSizePct: 100 },
    moonbagTrail: { enabled: false, trailPct: 15, armsAtPct: 8 },
    floor: { enabled: true, openingFloorPct: 40, tightensAfterSec: 3600, tightFloorPct: 40 },
    waveCut: { enabled: false, afterSec: 90, needsPeakPct: 5 },
    hardTimeCap: { enabled: true, timeCapSec: 300 },
  });
}

export function activeExitRuleCount(rules) {
  return Object.values(rules || {}).filter((r) => r && r.enabled).length;
}

export function createDefaultScorecardSettings() {
  return {
    autoPause: true,
    minTrades: 10, // judge a trader only after this many closed copies
    maxSlipPct: 20, // round-trip slip: how much worse our entry + exit were than the trader's
    maxLagSec: 10, // average seconds from the trader's trade to our copy
  };
}

export function createDefaultUiSettings() {
  return {
    displayName: '',
    timeZone: 'local', // 'local' | 'utc'
    landingTab: 'positions', // tab opened on page load
    confirmSells: true, // ask before 50% / 100% / initials sells
    hideBalances: false, // blur dollar amounts (screen sharing)
    notify: { copies: true, sells: true, skips: true, problems: true, sound: false },
  };
}

/** SOL invested / returned for a closed position. Exact when the SOL price was recorded at the
 *  trades; older records fall back to today's SOL price and are flagged as estimates. */
function closedSol(p, boughtUsd, soldUsd) {
  const exact = p.investedSol != null && p.soldSol != null;
  const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
  const boughtSol = exact ? Number(p.investedSol) : px > 0 ? boughtUsd / px : null;
  const soldSol = exact ? Number(p.soldSol) : px > 0 ? soldUsd / px : null;
  if (boughtSol == null || soldSol == null) return { boughtSol: null, soldSol: null, pnlSol: null, solExact: false };
  return {
    boughtSol: Number(boughtSol.toFixed(4)),
    soldSol: Number(soldSol.toFixed(4)),
    pnlSol: Number((soldSol - boughtSol).toFixed(4)),
    solExact: exact,
  };
}

/** Settings safe to send to the browser: integration secrets removed. */
export function publicSettings(settings) {
  if (!settings) return settings;
  // the Dax report link's secret never leaves the server (the page only learns that one exists)
  if (settings.daxShare) settings = { ...settings, daxShare: { enabled: Boolean(settings.daxShare.token), createdAt: settings.daxShare.createdAt || null } };
  // the Dax (Claude) API key never leaves the server
  if (settings.daxAi) settings = { ...settings, daxAi: { configured: Boolean(settings.daxAi.apiKey), model: settings.daxAi.model || null } };
  if (!settings.integrations) return settings;
  const { telegram = {}, discord = {} } = settings.integrations;
  return {
    ...settings,
    integrations: {
      telegram: { enabled: Boolean(telegram.enabled), chatId: telegram.chatId || '', hasToken: Boolean(telegram.botToken), events: telegram.events || {} },
      discord: { enabled: Boolean(discord.enabled), hasWebhook: Boolean(discord.webhookUrl), events: discord.events || {} },
    },
  };
}

export class CopyTradingEngine {
  constructor(options = {}) {
    this.adapter = options.adapter || new ChainExecutionAdapter();
    this.listeners = new Set();
    this.resetToInitialState();
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(eventType, payload = {}) {
    for (const fn of this.listeners) {
      try {
        fn({ type: eventType, payload, timestamp: Date.now() });
      } catch {
        // Ignore listener error
      }
    }
  }

  resetToInitialState() {
    // Clean initial state — zero dummy positions, zero fake follows, zero fake balances
    this.wallets = [
      {
        id: 'w-main',
        index: 1,
        name: 'Main',
        active: true,
        archived: false,
        solanaAddress: '',
        evmAddress: '',
        exportedSolana: false,
        exportedEvm: false,
        balances: {
          solana: { native: 0, stable: 0 },
          bsc: { native: 0, stable: 0 },
          robinhood: { native: 0, stable: 0 },
          arc: { native: 0, stable: 0 },
        },
      },
    ];

    // Account-wide Trade Settings, Entry Filters, Safety Switches, and Risk Limits
    this.settings = {
      selectedChain: 'solana',
      paperTrading: true,
      // Profile, security and notification preferences (Settings page)
      ui: createDefaultUiSettings(),
      buySlippagePct: {
        solana: 15,
        evm: null, // null = dynamic default (at least 3%, or 6% for brand-new coin + token tax)
      },
      sellSlippagePct: null, // null = auto-widening (1% SOL TP/SL/manual, 15% SOL Mirror, 1%->10% EVM)
      priorityFee: {
        mode: 'normal', // 'normal' | 'fast' | 'turbo' | 'custom'
        customSol: 0.002,
      },
      tradingAsset: {
        solana: 'stable', // 'stable' (USDC gasless) | 'native' (SOL)
        bsc: 'stable', // 'stable' (USDC gasless) | 'native' (BNB)
        robinhood: 'stable', // 'stable' (USDG gasless) | 'native' (ETH)
        arc: 'stable', // USDC is Arc's native coin
      },
      // One copy per trader position: once a trader's entry in a coin is copied, their further
      // buys of that coin (top-ups) are not copied until they fully sell. true = copy every buy.
      copyTopUps: false,
      // Trader scorecard: pause a trader the bot can't keep up with (judged on the last trades)
      scorecard: createDefaultScorecardSettings(),
      cooldown: {
        enabled: true,
        mode: 'duration', // 'duration' | 'while_holding'
        durationSec: 600, // 10 minutes default
      },
      retryBuys: true,
      maxChasePct: 25, // 1% - 1000%, default 25%
      maxSignalAgeSec: 90, // never copy a buy detected more than 90s after it landed on-chain (paper)
      maxRealSignalAgeSec: 10, // real SOL: never copy a buy more than 10 s after the trader's buy landed
      muteWarnings: false,
      filters: {
        pumpOnly: false, // Launchpad-only on EVM
        minMarketCapUsd: null,
        maxMarketCapUsd: null,
        minTraderBuyNative: null,
        maxTraderBuyNative: null,
        stage: 'any', // 'any' | 'pre-grad' | 'graduated'
      },
      safety: {
        blockRiskyCoins: true, // ON by default
        blockMintableSupply: false,
        strictNonPump: false,
      },
      risk: {
        dailyLossLimitUsd: null,
        dailyLossTriggered: false,
        streakLimit: null, // 2 - 20 losses in a row
        exposureLimitUsd: null, // Solana total open cost basis limit
      },
      security: {
        pinSet: false,
        pinCode: null,
        failedPinAttempts: 0,
        pinLockedUntil: 0,
        addressCooldownEnabled: true,
        verifiedAddresses: {
          solana: { address: null, unlockedAt: 0 },
          bsc: { address: null, unlockedAt: 0 },
          robinhood: { address: null, unlockedAt: 0 },
          arc: { address: null, unlockedAt: 0 },
        },
        withdrawals24h: [],
      },
      referrals: {
        code: '',
        customCode: '',
        referredUsers: 0,
        volumeUsd: 0,
        earnedUsd: 0,
        claimedUsd: 0,
      },
    };

    this.follows = [];
    this.buyCooldownMap = new Map();
    this.positions = [];
    this.history = [];
    this.alerts = [];
    // Every realized sell (kept apart from History, so the PnL calendar survives "Clear history")
    this.realizedLog = [];
  }

  getActiveWallet() {
    return this.wallets.find((w) => w.active && !w.archived) || this.wallets[0];
  }

  /** The default wallet: can't be deleted and takes over when the active wallet is deleted.
   *  Older saves have none marked, so the first wallet becomes the default. */
  getDefaultWallet() {
    const list = this.wallets.filter((w) => !w.archived);
    let def = list.find((w) => w.isDefault);
    if (!def && list.length) {
      def = list[0];
      def.isDefault = true;
    }
    return def || null;
  }

  getWalletById(walletId) {
    return this.wallets.find((w) => w.id === walletId) || this.getActiveWallet();
  }

  /**
   * Computes spendable USD balance on a chain for a wallet, respecting native gas reserves.
   */
  getSpendableBalanceUsd(wallet, chainId) {
    if (this.settings.paperTrading) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      return wallet.paperBalanceUsd;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId] || { native: 0, stable: 0 };
    const assetMode = chainId === 'arc' ? 'stable' : this.settings.tradingAsset[chainId] || 'stable';

    if (chainId === 'arc') {
      return Math.max(0, bal.stable - chain.gasReserveNative);
    }

    if (assetMode === 'stable') {
      return Math.max(0, bal.stable);
    }

    const spendableNative = Math.max(0, bal.native - chain.gasReserveNative);
    return spendableNative * chain.nativePriceUsd;
  }

  debitWalletForBuy(wallet, chainId, totalCostUsd) {
    if (this.settings.paperTrading) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      wallet.paperBalanceUsd = Math.max(0, Number((wallet.paperBalanceUsd - totalCostUsd).toFixed(2)));
      return;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId];
    const assetMode = chainId === 'arc' ? 'stable' : this.settings.tradingAsset[chainId] || 'stable';

    if (chainId === 'arc') {
      bal.stable = Math.max(0, Number((bal.stable - totalCostUsd).toFixed(4)));
      bal.native = bal.stable;
      return;
    }

    if (assetMode === 'stable') {
      bal.stable = Math.max(0, Number((bal.stable - totalCostUsd).toFixed(4)));
    } else {
      const nativeAmt = totalCostUsd / chain.nativePriceUsd;
      bal.native = Math.max(0, Number((bal.native - nativeAmt).toFixed(6)));
    }
  }

  creditWalletForSell(wallet, chainId, netProceedsUsd, assetModeUsed = 'stable', isPaper = null) {
    // proceeds go back where the position's money came from (paper vs real), whatever the
    // Paper Trading switch says now
    if (isPaper === null ? this.settings.paperTrading : isPaper) {
      if (wallet.paperBalanceUsd === undefined) {
        wallet.paperBalanceUsd = 10000.0;
      }
      wallet.paperBalanceUsd = Number((wallet.paperBalanceUsd + netProceedsUsd).toFixed(2));
      return;
    }

    const chain = CHAINS[chainId];
    const bal = wallet.balances[chainId];

    if (chainId === 'arc') {
      bal.stable = Number((bal.stable + netProceedsUsd).toFixed(4));
      bal.native = bal.stable;
      return;
    }

    if (assetModeUsed === 'stable') {
      bal.stable = Number((bal.stable + netProceedsUsd).toFixed(4));
    } else {
      const nativeAmt = netProceedsUsd / chain.nativePriceUsd;
      bal.native = Number((bal.native + nativeAmt).toFixed(6));
    }
  }

  /**
   * Resolves effective filter for a follow: per-trader filter replaces account-wide filter completely.
   */
  getEffectiveFilters(follow) {
    const ov = follow.filtersOverride || {};
    const acc = this.settings.filters;
    // A per-trader value only overrides the account filter when it is actually set.
    // (Missing keys used to count as "set to undefined" and silently disabled the account filter.)
    const has = (v) => v !== null && v !== undefined;
    const mcOverride = has(ov.minMarketCapUsd) || has(ov.maxMarketCapUsd);
    const buySizeOverride = has(ov.minTraderBuyNative) || has(ov.maxTraderBuyNative);
    const orNull = (v) => (has(v) ? v : null);

    return {
      pumpOnly: has(ov.pumpOnly) ? ov.pumpOnly : acc.pumpOnly,
      pumpOnlySource: has(ov.pumpOnly) ? 'trader' : 'account',
      minMarketCapUsd: mcOverride ? orNull(ov.minMarketCapUsd) : orNull(acc.minMarketCapUsd),
      maxMarketCapUsd: mcOverride ? orNull(ov.maxMarketCapUsd) : orNull(acc.maxMarketCapUsd),
      mcSource: mcOverride ? 'trader' : 'account',
      minTraderBuyNative: buySizeOverride ? orNull(ov.minTraderBuyNative) : orNull(acc.minTraderBuyNative),
      maxTraderBuyNative: buySizeOverride ? orNull(ov.maxTraderBuyNative) : orNull(acc.maxTraderBuyNative),
      buySizeSource: buySizeOverride ? 'trader' : 'account',
      stage: has(ov.stage) ? ov.stage : acc.stage,
      stageSource: has(ov.stage) ? 'trader' : 'account',
    };
  }

  recordSkip({ follow, wallet, signal, reason, chaseGapPct = null, dryRun = false }) {
    // Dry runs (live "would we copy this?" checks) report the decision without touching history
    if (dryRun) return { status: 'skipped', reason, chaseGapPct, dryRun: true };
    const entry = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'skipped',
      side: signal.side || 'buy',
      cause: 'entry check',
      chainId: follow.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: follow.handle,
      followId: follow.id,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      symbol: signal.token.symbol,
      tokenAddress: signal.token.address,
      amountUsd: 0,
      tokens: 0,
      fillPriceUsd: signal.token.currentPriceUsd || null,
      traderPriceUsd: signal.token.traderFillPriceUsd || null,
      chaseGapPct,
      platformFeeUsd: 0,
      networkFeeUsd: 0,
      gasless: false,
      pnlUsd: null,
      pnlPct: null,
      reason,
      txHash: null,
      timestamp: Date.now(),
    };
    this.history.unshift(entry);
    this.emit('copy_skipped', entry);
    return { status: 'skipped', reason, chaseGapPct, entry };
  }

  /**
   * 6-Step Copy Pipeline for an incoming Trader Signal (Buy or Sell).
   */
  async processTraderSignal(signal) {
    const matchingFollows = this.follows.filter(
      (f) =>
        f.chainId === signal.chainId &&
        (f.handle.toLowerCase() === String(signal.traderHandle || '').toLowerCase() ||
          f.traderWallet.toLowerCase() === String(signal.traderWallet || '').toLowerCase())
    );

    const results = [];
    for (const follow of matchingFollows) {
      if (signal.side === 'sell') {
        const res = await this.handleLeaderSellSignal(follow, signal);
        results.push(res);
      } else {
        const res = await this.handleLeaderBuySignal(follow, signal);
        results.push(res);
      }
    }
    return results;
  }

  /**
   * @param {object} opts.dryRun  When true, run every entry check and sizing step but stop
   *                              before execution: nothing is bought, debited or recorded.
   */
  async handleLeaderBuySignal(follow, signal, opts = {}) {
    if (opts.dryRun || !signal?.token?.address) return this.handleLeaderBuySignalNow(follow, signal, opts);
    // One buy per trader + coin at a time. A buy takes seconds (a real swap up to a minute) and
    // the trader's next buy of the same coin can arrive meanwhile: without this lock both were
    // copied, because the "already copied" mark is only set once the first buy has filled.
    if (!this.buysInFlight) this.buysInFlight = new Set();
    const key = `${follow.id}:${signal.token.address}`;
    if (this.buysInFlight.has(key)) {
      return this.recordSkip({
        follow,
        wallet: this.getWalletById(follow.walletId),
        signal,
        reason: this.copyTopUpsFor(follow) ? 'a copy of this coin is already being bought' : 'trader is adding to a coin already copied (top-ups not copied)',
      });
    }
    this.buysInFlight.add(key);
    const spend = { entry: null }; // this buy's reservation against the trader's daily SOL limit
    try {
      const r = await this.handleLeaderBuySignalNow(follow, signal, { ...opts, spend });
      if (spend.entry) {
        if (r?.status === 'filled' && r.position) {
          // replace the reserved amount with what the buy really cost
          const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
          const sol = Number(r.position.investedSol) > 0 ? Number(r.position.investedSol) : px > 0 ? Number(r.position.initialCostUsd) / px : spend.entry.sol;
          spend.entry.sol = sol;
          spend.entry.pending = false;
        } else this.releaseTraderSpend(follow, spend.entry);
        spend.entry = null;
      }
      return r;
    } catch (err) {
      if (spend.entry) this.releaseTraderSpend(follow, spend.entry);
      throw err;
    } finally {
      this.buysInFlight.delete(key);
    }
  }

  /**
   * Dax's trader log: every buy / sell a followed trader made, with their price and whether each
   * follow copied it (and why not). Kept 7 days (max 6000 rows), saved with the engine, so the
   * trader's own result per coin and the missed trades can be reported later.
   */
  logTraderTrade(sig, outcomes = []) {
    if (!sig || sig.backfill || !sig.tokenMint) return;
    if (!Array.isArray(this.traderLog)) this.traderLog = [];
    const t = Number(sig.detectedAt) || Date.now();
    if (t < Date.now() - 7 * 24 * 3600_000) return; // older than the 7 days kept
    const copies = outcomes.map((o) => ({ fid: o.followId, ok: Boolean(o.ok), dry: Boolean(o.dry), reason: o.reason ? String(o.reason).slice(0, 160) : null }));
    if (sig.signature) {
      for (let i = this.traderLog.length - 1; i >= Math.max(0, this.traderLog.length - 50); i--) {
        if (this.traderLog[i]?.sig === sig.signature) {
          if (copies.length) this.traderLog[i].copies = copies;
          return;
        }
      }
    }
    this.traderLog.push({
      t,
      sig: sig.signature || null,
      w: sig.wallet,
      mint: sig.tokenMint,
      sym: sig.symbol || null,
      side: sig.side,
      px: Number(sig.txPriceUsd) || null,
      usd: Number(sig.usdValue) || null,
      share: sig.side === 'sell' ? Number(sig.sellSharePct) || null : null,
      mc: Number(sig.marketCapUsd) || null,
      lag: Number.isFinite(Number(sig.latencySec)) ? Number(sig.latencySec) : null,
      copies,
    });
    const since = Date.now() - 7 * 24 * 3600_000;
    if (this.traderLog.length > 6000 || (this.traderLog[0] && this.traderLog[0].t < since)) {
      this.traderLog = this.traderLog.filter((e) => e.t >= since).slice(-6000);
    }
  }

  /** Real SOL this trader's copies spent (or are spending right now) in the last 24 h. */
  traderRealSpent24hSol(follow) {
    const since = Date.now() - 24 * 3600_000;
    if (!Array.isArray(follow.realSpendLog)) follow.realSpendLog = [];
    follow.realSpendLog = follow.realSpendLog.filter((x) => x && x.t >= since);
    return follow.realSpendLog.reduce((a, x) => a + (Number(x.sol) || 0), 0);
  }

  releaseTraderSpend(follow, entry) {
    if (Array.isArray(follow.realSpendLog)) follow.realSpendLog = follow.realSpendLog.filter((x) => x !== entry);
  }

  /** Per-trader overrides (null = use the account setting). */
  copyTopUpsFor(follow) {
    return typeof follow?.copyTopUps === 'boolean' ? follow.copyTopUps : Boolean(this.settings.copyTopUps);
  }

  maxChaseFor(follow) {
    const v = Number(follow?.maxChasePct);
    return follow?.maxChasePct !== null && follow?.maxChasePct !== undefined && Number.isFinite(v) && v > 0 ? v : Number(this.settings.maxChasePct ?? 25);
  }

  /** Losses realized in the last 24 h for one mode (paper or real). */
  realizedLoss24h(paper) {
    const cutoff = Date.now() - 86_400_000;
    return (this.realizedLog || []).filter((r) => r.t >= cutoff && Boolean(r.paper) === Boolean(paper) && r.pnl < 0).reduce((a, r) => a + Math.abs(r.pnl), 0);
  }

  async handleLeaderBuySignalNow(follow, signal, opts = {}) {
    const { dryRun = false } = opts;
    const wallet = this.getWalletById(follow.walletId);
    const chain = CHAINS[follow.chainId];
    const token = signal.token;

    if (follow.status !== 'copying') {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: follow.pauseReason === 'panic_sell' ? 'trader paused (Panic sell) — press Resume to copy again' : follow.pauseReason === 'slow' ? "trader paused (bot can't keep up)" : follow.pauseReason === 'streak' ? 'trader paused (losing streak)' : 'trader paused — press Resume to copy again' });
    }

    // Late copies lose: by then the copier wave has moved the price (or the trader has left).
    // Real SOL: at most maxRealSignalAgeSec (10 s) after the trader's buy landed; paper keeps the
    // looser maxSignalAgeSec (90 s) so paper results stay comparable with earlier runs.
    const realCopy = !this.settings.paperTrading;
    const maxAge = follow.chainId === 'solana' ? Number(realCopy ? this.settings.maxRealSignalAgeSec ?? 10 : this.settings.maxSignalAgeSec ?? 90) : 30;
    if (Number.isFinite(Number(signal.ageSec)) && signal.ageSec > maxAge) {
      if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `trade is too old to copy (${Math.round(signal.ageSec)}s after the trader — limit ${maxAge}s)` });
    }
    // The trader already sold this coin after this buy (the buy reached us late, e.g. through a
    // backup check while the sell came through the live feed): never buy what they have left.
    if (follow.traderWallet && Array.isArray(this.traderLog)) {
      const buyAt = Number.isFinite(Number(signal.ageSec)) ? Date.now() - Number(signal.ageSec) * 1000 : null;
      const soldAfter = this.traderLog.some((e) => e.w === follow.traderWallet && e.mint === token.address && e.side === 'sell' && (buyAt === null ? Date.now() - e.t < 120_000 : e.t > buyAt - 1000) && (!e.sig || e.sig !== signal.signature));
      if (soldAfter) {
        if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'the trader already sold this coin — not buying after they left' });
      }
    }

    // the daily loss limit is a rolling 24 h window: lift the pause once old losses roll out
    if (this.settings.risk.dailyLossTriggered && !dryRun) {
      const lim = Number(this.settings.risk.dailyLossLimitUsd);
      if (!(lim > 0) || this.realizedLoss24h(Boolean(this.settings.paperTrading)) < lim) this.settings.risk.dailyLossTriggered = false;
    }
    if (this.settings.risk.dailyLossTriggered || follow.pauseReason === 'streak') {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'risk protection is active' });
    }

    const traderBuyUsd = Number(signal.traderBuyUsd ?? 100);
    // Top-up of a coin we never bought: the trader's first buy was missed (skipped, too late or not
    // seen), so this later buy would be a late entry — after the copier wave, usually a loss. This
    // applies even with "copy top-ups" on: top-ups only make sense on top of our first copy.
    if (token.address && this.isTopUpOfMissedEntry(follow, signal)) {
      if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'trader is adding to a coin we never bought (their first buy was missed) — late entry skipped' });
    }
    // Top-up of a coin we already copied in this trader position (they haven't fully sold yet)
    const copyTopUps = this.copyTopUpsFor(follow);
    if (!copyTopUps && token.address && this.copiedCycleActive(follow.id, token.address)) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'trader is adding to a coin already copied (top-ups not copied)' });
    }
    // The trader's first buy of this coin was missed (price had run / seen too late): their later
    // buys of the same position come even later, so they are not copied as a fresh entry either
    if (!copyTopUps && token.address && this.copiedCycleActive(follow.id, token.address, 'missed')) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: "trader's first buy was too late to copy — their top-ups are skipped too (top-ups not copied)" });
    }

    // Re-entry rule (trader Settings, off by default): the trader sold out and bought the same coin
    // again — skip it when our last copy of this coin closed less than N minutes ago
    const reentryMin = Number(follow.reentryCooldownMin);
    if (reentryMin > 0 && token.address) {
      const wantPaper = Boolean(this.settings.paperTrading);
      const lastClose = this.positions
        .filter((p) => p.followId === follow.id && p.tokenAddress === token.address && p.remainingTokens <= 0 && Boolean(p.isPaper) === wantPaper)
        .reduce((m, p) => Math.max(m, Number(p.closedAt || p.lastSellAt) || 0), 0);
      if (lastClose && Date.now() - lastClose < reentryMin * 60_000) {
        const ago = Math.max(1, Math.round((Date.now() - lastClose) / 60_000));
        // their top-ups of this skipped re-entry are not copied as a (later) fresh entry either
        if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: `re-entry skipped — our last copy of this coin closed ${ago} min ago (re-entry rule: ${reentryMin} min)` });
      }
    }

    if (traderBuyUsd < follow.minTradeUsd) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'below your minimum' });
    }

    const effFilters = this.getEffectiveFilters(follow);

    if (effFilters.pumpOnly) {
      if (follow.chainId === 'arc') {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'launchpad-only setting is on' });
      }
      if (!token.isLaunchpad) {
        const reason = follow.chainId === 'solana' ? 'pump-only is on' : 'launchpad-only setting is on';
        return this.recordSkip({ dryRun, follow, wallet, signal, reason });
      }
    }

    if (effFilters.stage && effFilters.stage !== 'any' && token.isLaunchpad && token.stage) {
      if (token.stage !== effFilters.stage) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'launch stage outside your filter' });
      }
    }

    if (token.marketCapUsd !== null && token.marketCapUsd !== undefined) {
      if (effFilters.minMarketCapUsd !== null && token.marketCapUsd < effFilters.minMarketCapUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'market cap outside your filter' });
      }
      if (effFilters.maxMarketCapUsd !== null && token.marketCapUsd >= effFilters.maxMarketCapUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'market cap outside your filter' });
      }
    }

    const traderBuyNative =
      signal.traderBuyNative !== undefined ? signal.traderBuyNative : traderBuyUsd / chain.nativePriceUsd;
    if (traderBuyNative !== null && traderBuyNative !== undefined) {
      if (effFilters.minTraderBuyNative !== null && traderBuyNative < effFilters.minTraderBuyNative) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: "trader's buy size outside your filter" });
      }
      if (effFilters.maxTraderBuyNative !== null && traderBuyNative > effFilters.maxTraderBuyNative) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: "trader's buy size outside your filter" });
      }
    }

    const safetyAudit = await this.adapter.inspectTokenSafety(follow.chainId, token);
    if (safetyAudit.hardBlocked) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: safetyAudit.reason });
    }
    if (this.settings.safety.strictNonPump && !token.isLaunchpad && !safetyAudit.safetyVerified) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
    }
    if (this.settings.safety.blockRiskyCoins) {
      if (follow.chainId === 'solana' && safetyAudit.hasFreezeOrHookOrDelegate) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
      if (follow.chainId !== 'solana' && safetyAudit.hasRiskyOwnerControls) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
    }
    if (this.settings.safety.blockMintableSupply) {
      if (
        (follow.chainId === 'solana' && safetyAudit.isMintable) ||
        (follow.chainId !== 'solana' && safetyAudit.isMintableOrMutable)
      ) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'blocked by your safety filter' });
      }
    }
    if (safetyAudit.snipeTaxPct && safetyAudit.snipeTaxPct > 20) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'snipe tax' });
    }

    if (this.settings.cooldown.enabled) {
      const cooldownKey = `${follow.chainId}:${token.address}`;
      const holdingPos = this.positions.find(
        (p) => p.chainId === follow.chainId && p.tokenAddress === token.address && p.remainingTokens > 0
      );
      if (this.settings.cooldown.mode === 'while_holding' && holdingPos) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'buy cooldown is active' });
      }
      const lastBoughtAt = this.buyCooldownMap.get(cooldownKey);
      if (lastBoughtAt && Date.now() - lastBoughtAt < this.settings.cooldown.durationSec * 1000) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'buy cooldown is active' });
      }
    }

    const followOpenPositions = this.positions.filter(
      (p) => p.followId === follow.id && p.chainId === follow.chainId && p.remainingTokens > 0
    );
    if (followOpenPositions.length >= follow.maxOpenPositions) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'position limit reached' });
    }

    const currentAtRiskUsd = followOpenPositions.reduce((sum, p) => sum + p.remainingCostUsd, 0);
    const remainingAtRiskRoomUsd = Math.max(0, follow.maxAtRiskUsd - currentAtRiskUsd);
    if (remainingAtRiskRoomUsd < 1) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'exposure limit reached for this token' });
    }

    const spendableUsd = this.getSpendableBalanceUsd(wallet, follow.chainId);
    let desiredUsd = 0;
    if (follow.sizing.type === 'fixed') {
      desiredUsd = Number(follow.sizing.amount);
    } else if (follow.sizing.type === 'percent') {
      desiredUsd = spendableUsd * (Number(follow.sizing.amount) / 100);
    } else if (follow.sizing.type === 'proportional') {
      desiredUsd = Math.min(traderBuyUsd, Number(follow.sizing.amount));
    }

    desiredUsd = Math.min(desiredUsd, remainingAtRiskRoomUsd);

    if (desiredUsd < 1) {
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: "below the venue's minimum" });
    }

    if (follow.chainId === 'solana' && this.settings.risk.exposureLimitUsd !== null) {
      const totalSolanaExposure = this.positions
        .filter((p) => p.chainId === 'solana' && p.remainingTokens > 0)
        .reduce((sum, p) => sum + p.remainingCostUsd, 0);
      if (totalSolanaExposure + desiredUsd > this.settings.risk.exposureLimitUsd) {
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'total exposure limit reached' });
      }
    }

    if (!dryRun && spendableUsd < desiredUsd) {
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'warning',
        title: `Copy skipped — not enough balance (${chain.shortName})`,
        message: `Needed $${desiredUsd.toFixed(2)}, spendable balance was $${spendableUsd.toFixed(2)}.`,
        timestamp: Date.now(),
      });
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'not enough balance' });
    }

    let buySlippagePct = 15;
    if (follow.chainId === 'solana') {
      buySlippagePct = Number(this.settings.buySlippagePct.solana || 15);
    } else {
      const taxPct = (safetyAudit.buyTaxPct || 0) + (safetyAudit.sellTaxPct || 0);
      const baseDefault = token.stage === 'pre-grad' ? 6 : 3;
      if (this.settings.buySlippagePct.evm !== null) {
        buySlippagePct = Number(this.settings.buySlippagePct.evm);
        if (taxPct + baseDefault > buySlippagePct) {
          return this.recordSkip({ dryRun, follow, wallet, signal, reason: 'round-trip cost too high on this token' });
        }
      } else {
        buySlippagePct = baseDefault + taxPct;
      }
    }

    const paper = Boolean(this.settings.paperTrading);
    const real = !paper && this.adapter.useLive?.({ paper, chainId: follow.chainId });
    if (!paper && !real) {
      // say WHY real trading is off (the server knows: missing key, missing site password, another copy running, restarting…)
      const why = (typeof this.realUnavailableReason === 'function' && this.realUnavailableReason()) || 'the bot wallet key ODEX_TRADER_KEY is missing (or turn Paper Trading on)';
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `real trading is off — ${why}` });
    }
    const buyAssetMode = follow.chainId === 'arc' ? 'stable' : this.settings.tradingAsset[follow.chainId] || 'stable';
    // Real buys: a trade size above the SOL caps (e.g. $50 with a 0.05 SOL limit) is bought at the
    // cap instead of being refused every time; nothing is bought once the daily cap is used up
    if (real && typeof this.adapter.realBuyRoomUsd === 'function') {
      const room = Number(this.adapter.realBuyRoomUsd());
      if (Number.isFinite(room)) {
        if (room < 1) return this.recordSkip({ dryRun, follow, wallet, signal, reason: "daily real-SOL limit reached (all traders) — change it in any trader's Settings" });
        desiredUsd = Math.min(desiredUsd, room);
      }
    }
    // This trader's own daily real-SOL limit (trader Settings; empty = none). The buy's SOL is
    // reserved right away so two buys at the same moment can't both pass the check.
    const traderCapSol = Number(follow.maxRealSolPerDay);
    if (real && traderCapSol > 0) {
      const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
      const roomUsd = px > 0 ? Math.max(0, traderCapSol - this.traderRealSpent24hSol(follow)) * px : 0;
      if (roomUsd < 1) return this.recordSkip({ dryRun, follow, wallet, signal, reason: `this trader's daily real-SOL limit reached (${traderCapSol} SOL) — change it in the trader's Settings` });
      desiredUsd = Math.min(desiredUsd, roomUsd);
      if (!dryRun && opts.spend) {
        opts.spend.entry = { t: Date.now(), sol: desiredUsd / px, pending: true };
        follow.realSpendLog.push(opts.spend.entry);
      }
    }

    // A paper copy can never buy cheaper than the trader did: their own buy already pushed the
    // price up, and the market feed (cached up to 60 s) often lags fast launches. Our own paper
    // buys of this token in the last 30 s have pushed it further, so they set a floor too.
    // (Real copies get a real Jupiter quote instead.)
    let quoteToken = paper ? this.paperBuyPriceFloor(follow.chainId, token) : token;
    // pump.fun bonding curve: fill where a copy really lands — after the trader's own buy moved
    // the curve, plus our buy's own move — instead of a flat impact estimate
    if (paper && follow.chainId === 'solana' && (/pump$/i.test(String(token.address || '')) || token.venue === 'pumpfun') && (signal.traderBuyNative > 0 || (Number(token.curve?.virtualSolReserves) > 0 && Number(token.curve?.virtualTokenReserves) > 0))) {
      const solPx = CHAINS.solana.nativePriceUsd;
      const feePct = solanaTradeFeePct(token).totalPct;
      const ourSol = (desiredUsd * (1 - feePct / 100)) / solPx;
      let c = null;
      if (Number(token.curve?.virtualSolReserves) > 0 && Number(token.curve?.virtualTokenReserves) > 0 && solPx > 0 && ourSol > 0) {
        const vSol = Number(token.curve.virtualSolReserves) / 1e9;
        const vTok = Number(token.curve.virtualTokenReserves) / 1e6;
        if (vSol > 0 && vTok > 0) {
          c = {
            postTraderPriceUsd: (vSol / vTok) * solPx,
            fillPriceUsd: ((vSol + ourSol) / vTok) * solPx,
          };
        }
      }
      if (!c && signal.traderBuyNative > 0) {
        c = pumpCurveCopyFill({
          traderPriceUsd: token.traderFillPriceUsd,
          traderSol: signal.traderPoolSol > 0 ? signal.traderPoolSol : signal.traderBuyNative,
          ourSol,
          solPriceUsd: solPx,
        });
      }
      if (c) {
        // our own copies in the last 30 s already pushed the curve further: never below them
        const ownFloor = Number(quoteToken.currentPriceUsd) > c.postTraderPriceUsd ? Number(quoteToken.currentPriceUsd) / c.postTraderPriceUsd : 1;
        quoteToken = { ...quoteToken, currentPriceUsd: c.postTraderPriceUsd * ownFloor, paperFillPriceUsd: c.fillPriceUsd * ownFloor, liquidityUsd: quoteToken.liquidityUsd };
      }
    }

    // Pre-cap slippage before the first quote when the known market/curve price has already moved
    // above the trader's fill price, avoiding a second round-trip quote to Jupiter.
    const maxChasePre = this.maxChaseFor(follow);
    if (real && follow.chainId === 'solana' && Number(token.traderFillPriceUsd) > 0 && maxChasePre < 1000 && Number(token.curve?.virtualSolReserves) > 0 && Number(token.curve?.virtualTokenReserves) > 0) {
      const solPxPre = Number(CHAINS.solana?.nativePriceUsd) || 0;
      const vSolPre = Number(token.curve.virtualSolReserves) / 1e9;
      const vTokPre = Number(token.curve.virtualTokenReserves) / 1e6;
      if (solPxPre > 0 && vSolPre > 0 && vTokPre > 0) {
        const postTraderPxUsd = (vSolPre / vTokPre) * solPxPre;
        const preGapPct = ((postTraderPxUsd - Number(token.traderFillPriceUsd)) / Number(token.traderFillPriceUsd)) * 100;
        if (preGapPct > maxChasePre) {
          if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
          return this.recordSkip({
            dryRun,
            follow,
            wallet,
            signal,
            reason: 'price moved too far before we could copy',
            chaseGapPct: Number(preGapPct.toFixed(2)),
          });
        }
        quoteToken = { ...quoteToken, currentPriceUsd: Math.max(Number(quoteToken.currentPriceUsd) || 0, postTraderPxUsd) };
      }
    }
    if (real && Number(token.traderFillPriceUsd) > 0 && maxChasePre < 1000 && Number(quoteToken.currentPriceUsd) > Number(token.traderFillPriceUsd) * 1.005) {
      const ceilingPre = Number(token.traderFillPriceUsd) * (1 + maxChasePre / 100);
      const roomPre = (1 - Number(quoteToken.currentPriceUsd) / ceilingPre) * 100;
      if (roomPre >= 0.5 && roomPre < buySlippagePct) {
        buySlippagePct = Math.max(0.5, Math.floor(roomPre * 10) / 10);
      }
    }

    let quote;
    try {
      quote = await this.adapter.getSwapQuote({
        chainId: follow.chainId,
        side: 'buy',
        token: quoteToken,
        amountUsd: desiredUsd,
        slippagePct: buySlippagePct,
        paper,
        assetMode: buyAssetMode,
      });
    } catch (err) {
      if (!real) throw err;
      if (!dryRun && err?.skipBuy) this.markCopiedCycle(follow.id, token.address, 'missed');
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: err?.skipBuy ? err.message : `real quote failed: ${err.message}` });
    }

    const traderFillPrice = Number(token.traderFillPriceUsd || quote.quotedPriceUsd);
    const chaseGapPct =
      traderFillPrice > 0 ? ((quote.quotedPriceUsd - traderFillPrice) / traderFillPrice) * 100 : 0;

    if (traderFillPrice > 0 && chaseGapPct > this.maxChaseFor(follow)) {
      if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason: 'price moved too far before we could copy',
        chaseGapPct: Number(chaseGapPct.toFixed(2)),
      });
    }

    // Real buys: max chase is a hard price CEILING for the fill, not only a check on the quote.
    // The swap's allowed slippage is cut so the fill can never land more than max chase above the
    // trader's own price (a quote 10% above them with 15% slippage could otherwise fill +26%).
    // No room left → skipped. One fresh quote at the tighter slippage when needed.
    const maxChase = this.maxChaseFor(follow);
    let entryCeilingUsd = null;
    if (real && Number(token.traderFillPriceUsd) > 0 && maxChase < 1000) {
      entryCeilingUsd = Number(token.traderFillPriceUsd) * (1 + maxChase / 100);
      // Jupiter's slippage is a minimum token amount: s% fewer tokens = paying up to 1/(1−s) more.
      // Largest slippage that keeps the fill at or under the ceiling: 1 − quote/ceiling.
      const roomFor = (q) => (1 - Number(q.quotedPriceUsd) / entryCeilingUsd) * 100;
      const tooHigh = (gap) => {
        if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
        return this.recordSkip({ dryRun, follow, wallet, signal, reason: `price moved too far before we could copy — the fill could land more than your ${maxChase}% max chase above the trader's price`, chaseGapPct: Number(gap.toFixed(2)) });
      };
      let room = roomFor(quote);
      if (!(room >= 0.5)) return tooHigh(chaseGapPct);
      if (room < buySlippagePct && !dryRun && quote?.route !== 'direct') {
        buySlippagePct = Math.max(0.5, Math.floor(room * 10) / 10);
        try {
          quote = await this.adapter.getSwapQuote({ chainId: follow.chainId, side: 'buy', token: quoteToken, amountUsd: desiredUsd, slippagePct: buySlippagePct, paper, assetMode: buyAssetMode });
        } catch (err) {
          return this.recordSkip({ dryRun, follow, wallet, signal, reason: `real quote failed: ${err.message}` });
        }
        room = roomFor(quote);
        const gap2 = ((Number(quote.quotedPriceUsd) - Number(token.traderFillPriceUsd)) / Number(token.traderFillPriceUsd)) * 100;
        // the price kept running while we re-quoted: the new quote + its slippage must still fit
        if (!(room >= buySlippagePct - 0.05)) return tooHigh(gap2);
      } else if (room < buySlippagePct) {
        buySlippagePct = Math.max(0.5, Math.floor(room * 10) / 10);
        if (quote && quote.route === 'direct') quote._slippagePct = buySlippagePct;
      }
    }

    if (dryRun) {
      return {
        status: 'would_copy',
        dryRun: true,
        sizeUsd: Number(desiredUsd.toFixed(2)),
        chaseGapPct: Number(chaseGapPct.toFixed(2)),
      };
    }

    const assetMode = follow.chainId === 'arc' ? 'stable' : this.settings.tradingAsset[follow.chainId] || 'stable';
    const gasless = follow.chainId !== 'arc' && assetMode === 'stable';

    let execResult;
    try {
      execResult = await this.adapter.executeSwap({
        chainId: follow.chainId,
        wallet,
        side: 'buy',
        token,
        amountUsd: desiredUsd,
        quote,
        priorityFee: this.settings.priorityFee,
        gasless,
        paper,
        assetMode: buyAssetMode,
        slippagePct: buySlippagePct,
        // first holding of this token opens a token account (rent) — same as a real buy
        newTokenAccount: !this.positions.some((p) => p.tokenAddress === token.address && p.remainingTokens > 0 && Boolean(p.isPaper) === paper),
        // real copies: the late-copy limit holds until the swap is SENT (detection + quote time count too)
        deadlineAt: real && follow.chainId === 'solana' && Number.isFinite(Number(signal.ageSec)) ? Date.now() - Number(signal.ageSec) * 1000 + Number(this.settings.maxRealSignalAgeSec ?? 10) * 1000 : null,
      });
    } catch (err) {
      if (!real) throw err;
      execResult = { ok: false, error: err.message };
    }
    // late-copy limit reached while detecting/quoting: nothing was sent — a normal skip, not an error
    if (real && execResult && execResult.ok === false && execResult.late) {
      if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `trade is too old to copy — ${execResult.error}` });
    }
    if (real && (!execResult || execResult.ok === false)) {
      const why = execResult?.error || 'unknown error';
      if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'danger',
        title: execResult?.unknown ? `REAL buy result unknown — check wallet ($${token.symbol})` : `Real buy not executed ($${token.symbol})`,
        message: why,
        timestamp: Date.now(),
      });
      this.emit('alerts_updated', {});
      return this.recordSkip({ dryRun, follow, wallet, signal, reason: `real buy failed: ${why}` });
    }

    // Paper buys also enforce maxChase as a hard price ceiling after the simulated execution delay
    // (`paperDelayMs` + `paperLiveFillPrice`), matching Real SOL's `minTokensOut` ceiling protection.
    if (paper && traderFillPrice > 0 && maxChase < 1000 && Number(execResult?.fillPriceUsd) > 0) {
      const fillChaseGapPct = ((Number(execResult.fillPriceUsd) - traderFillPrice) / traderFillPrice) * 100;
      if (fillChaseGapPct > maxChase + 1e-6) {
        if (!dryRun) this.markCopiedCycle(follow.id, token.address, 'missed');
        return this.recordSkip({
          dryRun,
          follow,
          wallet,
          signal,
          reason: `price moved too far before we could copy — the fill would land more than your ${maxChase}% max chase above the trader's price`,
          chaseGapPct: Number(fillChaseGapPct.toFixed(2)),
        });
      }
    }

    // Real fills report exactly what was spent and received; paper fills are modelled
    const spentUsd = Number.isFinite(execResult.spentUsd) ? execResult.spentUsd : desiredUsd;
    const totalDebitUsd = spentUsd + execResult.networkFeeUsd;
    this.debitWalletForBuy(wallet, follow.chainId, totalDebitUsd);

    const netInvestedUsd = Math.max(0.01, desiredUsd - execResult.platformFeeUsd);
    const tokensReceived = Number.isFinite(execResult.tokensReceived) && execResult.tokensReceived > 0 ? execResult.tokensReceived : netInvestedUsd / execResult.fillPriceUsd;
    // entry market cap at OUR fill price (same supply as the feed's market cap), so "Entry MC → now"
    // always moves with the position's own price
    const feedSupply = Number(token.marketCapUsd) > 0 && Number(token.currentPriceUsd) > 0 ? Number(token.marketCapUsd) / Number(token.currentPriceUsd) : null;
    const pumpSupply = /pump$/i.test(String(token.address || '')) || token.venue === 'pumpfun' || token.venue === 'pumpswap' ? 1_000_000_000 : null;
    const entryMc = Math.round(execResult.fillPriceUsd * (pumpSupply || feedSupply || 1e9));

    this.buyCooldownMap.set(`${follow.chainId}:${token.address}`, Date.now());
    if (paper) {
      if (!this.recentOwnBuys) this.recentOwnBuys = new Map();
      this.recentOwnBuys.set(`${follow.chainId}:${token.address}`, { priceUsd: execResult.fillPriceUsd, at: Date.now() });
    }

    const position = {
      id: `pos-${randomUUID().slice(0, 8)}`,
      walletId: wallet.id,
      followId: follow.id,
      traderHandle: follow.handle,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      chainId: follow.chainId,
      isPaper: paper,
      txHash: execResult.txHash || null,
      tokenAddress: token.address,
      symbol: token.symbol,
      name: token.name || token.symbol,
      imageUrl: token.imageUrl || null,
      launchpad: token.launchpad || chain.launchpad,
      tokenCreatedAt: Number(token.createdAt) || null,
      venue: token.venue || null,
      stage: token.stage || 'pre-grad',
      // only claim "renounced" when mint + freeze authority were actually checked and are empty
      renounced:
        typeof token.renounced === 'boolean'
          ? token.renounced
          : token.safety && 'mintAuthority' in token.safety && 'freezeAuthority' in token.safety
            ? !token.safety.mintAuthority && !token.safety.freezeAuthority
            : null,
      tradingAssetUsed: assetMode,
      entryPriceUsd: execResult.fillPriceUsd,
      // scorecard: how far behind the trader this copy got in
      traderEntryPriceUsd: traderFillPrice > 0 ? traderFillPrice : null,
      entrySlipPct: traderFillPrice > 0 ? Number(((execResult.fillPriceUsd / traderFillPrice - 1) * 100).toFixed(2)) : null,
      detectLagSec: Number.isFinite(Number(signal.ageSec)) ? Number(Number(signal.ageSec).toFixed(1)) : null,
      currentPriceUsd: execResult.fillPriceUsd,
      peakPriceUsd: execResult.fillPriceUsd,
      entryMarketCapUsd: entryMc,
      currentMarketCapUsd: entryMc,
      peakMarketCapUsd: entryMc,
      liquidityUsd: quote.liquidityUsd,
      sizeUsd: Number(spentUsd.toFixed(4)), // the order size (what was swapped)
      // cost basis = everything this buy took from the balance (size + network fee)
      initialCostUsd: Number(totalDebitUsd.toFixed(4)),
      remainingCostUsd: Number(totalDebitUsd.toFixed(4)),
      // SOL price at the moment of the buy, so the SOL invested stays exact later
      entrySolPriceUsd: CHAINS.solana?.nativePriceUsd || null,
      investedSol: CHAINS.solana?.nativePriceUsd > 0 ? Number((totalDebitUsd / CHAINS.solana.nativePriceUsd).toFixed(6)) : null,
      initialTokens: tokensReceived,
      remainingTokens: tokensReceived,
      realizedPnlUsd: 0,
      initialsTaken: false,
      trailArmed: false,
      exitStuck: false,
      openedAt: Date.now(),
      armedOrders: [],
    };
    this.positions.unshift(position);
    this.markCopiedCycle(follow.id, token.address);

    const receipt = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'filled',
      side: 'buy',
      cause: 'copied buy',
      isPaper: Boolean(this.settings.paperTrading),
      chainId: follow.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: follow.handle,
      followId: follow.id,
      traderWallet: follow.traderWallet || null,
      traderTx: signal.signature || null,
      symbol: token.symbol,
      tokenAddress: token.address,
      amountUsd: Number(spentUsd.toFixed(4)),
      tokens: tokensReceived,
      fillPriceUsd: execResult.fillPriceUsd,
      traderPriceUsd: traderFillPrice,
      chaseGapPct: Number(chaseGapPct.toFixed(2)),
      platformFeeUsd: execResult.platformFeeUsd,
      networkFeeUsd: execResult.networkFeeUsd,
      gasless,
      pnlUsd: null,
      pnlPct: null,
      reason: null,
      txHash: execResult.txHash,
      explorerUrl: execResult.explorerUrl || null,
      timestamp: Date.now(),
    };
    this.history.unshift(receipt);

    this.alerts.unshift({
      id: `alt-${randomUUID().slice(0, 8)}`,
      level: 'success',
      title: `Copied @${follow.handle} · Bought $${token.symbol} (${chain.shortName})`,
      message: `$${desiredUsd.toFixed(2)} → ${tokensReceived.toFixed(2)} $${token.symbol} @ $${execResult.fillPriceUsd.toFixed(6)} (${chaseGapPct >= 0 ? '+' : ''}${chaseGapPct.toFixed(1)}% vs trader).`,
      timestamp: Date.now(),
    });

    this.emit('position_opened', { position, receipt });
    return { status: 'filled', position, receipt };
  }

  async handleLeaderSellSignal(follow, signal, { dryRun = false } = {}) {
    const wallet = this.getWalletById(follow.walletId);
    // the trader fully exited: their next buy of this coin is a fresh entry again
    if (!dryRun && Number(signal.sellSharePct ?? 100) >= 99 && signal.token?.address) this.endCopiedCycle(follow.id, signal.token.address);
    // Auto-Exit can also sell when the trader sells ("Sell when the trader sells" on)
    const followSells = follow.mode === 'mirror' || (follow.mode === 'auto-exit' && follow.mirrorSells === true);
    if (!followSells) {
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason:
          follow.mode === 'auto-exit'
            ? "Auto-Exit mode manages exits itself, so trader sells aren't copied"
            : "your Buy & Hold mode doesn't copy sells",
      });
    }

    // prefer a position of the current mode (real vs paper) when both hold this token
    const wantPaper = Boolean(this.settings.paperTrading);
    const pos = [...this.positions].sort((a, b) => (Boolean(a.isPaper) === wantPaper ? 0 : 1) - (Boolean(b.isPaper) === wantPaper ? 0 : 1)).find(
      (p) =>
        p.followId === follow.id &&
        p.chainId === signal.chainId &&
        // match by token address; symbols are not unique (many tokens share a ticker)
        (signal.token.address ? p.tokenAddress === signal.token.address : p.symbol.toLowerCase() === String(signal.token.symbol || '').toLowerCase()) &&
        p.remainingTokens > 0
    );

    if (!pos) {
      return this.recordSkip({
        dryRun,
        follow,
        wallet,
        signal,
        reason: 'nothing tracked to sell for this holding',
      });
    }

    let sellPct = Math.min(100, Math.max(1, Number(signal.sellSharePct || 100)));
    // On Auto-Exit every exit closes the whole position: the trader selling half or more of
    // their bag is their exit, so we sell everything (smaller trims are mirrored as they are)
    if (follow.mode === 'auto-exit' && sellPct >= 50) sellPct = 100;
    if (dryRun) return { status: 'would_copy', dryRun: true, sellPct };
    return this.executePositionSell(pos.id, {
      sellPct,
      cause: follow.mode === 'auto-exit' ? 'trader sold' : 'Mirror sell',
      traderExitPriceUsd: Number(signal.token?.traderFillPriceUsd) || null,
      traderSellSol: Number(signal.traderPoolSol > 0 ? signal.traderPoolSol : signal.traderBuyNative) || null,
    });
  }

  /**
   * Fast trade detection read a trader trade before it was confirmed, and it never landed.
   * A copy opened by that buy is sold at once; a sell or top-up copy is only logged.
   */
  async handlePhantomTrade({ signature, side, mint, reason } = {}) {
    if (!signature) return { closed: 0 };
    if (!this.phantomLog) this.phantomLog = [];
    const opened = this.positions.filter((p) => p.traderTx === signature && p.remainingTokens > 0);
    this.phantomLog.unshift({ signature, side, mint, reason, at: Date.now(), positions: opened.map((p) => p.id) });
    this.phantomLog.length = Math.min(this.phantomLog.length, 50);
    this.emit('phantom_trade', { signature, side, mint, reason, positions: opened.length });
    let closed = 0;
    for (const p of opened) {
      try {
        const r = await this.executePositionSell(p.id, { sellPct: 100, cause: `auto-exit: ${reason}` });
        if (r?.ok !== false) closed += 1;
      } catch {
        // the normal exit rules still cover it
      }
    }
    return { closed };
  }

  async executePositionSell(positionId, opts = {}) {
    // A sell YOU press (manual, Sell all, Panic sell) always tries again, even if earlier checks
    // said the tokens were gone: a temporary balance-read problem must never trap a position.
    if (/manual|sell all|panic|initials/i.test(String(opts.cause || 'manual sell'))) {
      const p = this.positions.find((x) => x.id === positionId);
      if (p && p.realTokensMissing) {
        p.realTokensMissing = false;
        p.realMissingChecks = 0;
      }
    }
    // one sell per position at a time: real swaps take seconds and exits are checked every tick
    if (!this.sellsInFlight) this.sellsInFlight = new Set();
    if (this.sellsInFlight.has(positionId)) return { ok: false, error: 'A sell for this position is already in progress.', inFlight: true };
    this.sellsInFlight.add(positionId);
    try {
      return await this.executePositionSellNow(positionId, opts);
    } finally {
      this.sellsInFlight.delete(positionId);
    }
  }

  async executePositionSellNow(positionId, { sellPct = 100, exactTokens = null, cause = 'manual sell', traderExitPriceUsd = null, traderSellSol = null } = {}) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos || pos.remainingTokens <= 0) {
      return { ok: false, error: 'Position not found or already closed.' };
    }

    const wallet = this.getWalletById(pos.walletId);
    const chain = CHAINS[pos.chainId];

    let fraction = Math.min(1, Math.max(0.01, Number(sellPct) / 100));
    if (exactTokens !== null && exactTokens > 0) {
      fraction = Math.min(1, exactTokens / pos.remainingTokens);
    }

    // never leave dust behind: if what would remain is worth under $2, sell the whole position
    if (fraction < 1 && pos.remainingTokens * (1 - fraction) * (Number(pos.currentPriceUsd) || 0) < 2) fraction = 1;
    let tokensSold = pos.remainingTokens * fraction;
    const real = !pos.isPaper && this.adapter.useLive?.({ paper: false, chainId: pos.chainId });
    // A real position can only be sold for real. If real trading is unavailable right now (key not
    // loaded, site password missing, another copy of the bot running), never fake the sale on paper:
    // that would book a sell while the tokens stay in the wallet.
    if (pos.isPaper === false && !real) {
      const now = Date.now();
      if (!pos.lastSellBlockedAlertAt || now - pos.lastSellBlockedAlertAt > 60_000) {
        pos.lastSellBlockedAlertAt = now;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: `Real sell waiting — real trading is off ($${pos.symbol})`,
          message: 'This real position cannot be sold until real trading is available again on this copy (bot key, site password, only one copy running). It stays open and exits resume automatically.',
          timestamp: now,
        });
        this.emit('alerts_updated', {});
      }
      return { ok: false, error: 'Real trading is unavailable on this copy, so this real position was not sold.', realFailed: true, realUnavailable: true };
    }
    // a full sell of the only real position in this token sells the whole wallet balance (no dust)
    const othersInMint = this.positions.some((p) => p.id !== pos.id && p.tokenAddress === pos.tokenAddress && p.remainingTokens > 0 && !p.isPaper);
    const tokenAmount = real && fraction >= 0.9999 && !othersInMint ? 'all' : tokensSold;
    const grossValueUsd = tokensSold * pos.currentPriceUsd;

    if (grossValueUsd < 1 && fraction < 1) {
      return { ok: false, error: "what's left was too small to sell (< $1 minimum)." };
    }

    // Sell slippage: a value set in Settings is a hard cap. When it is blank ("Auto-widening"),
    // start from the chain default and widen to cover the quoted price impact (up to a ceiling),
    // so stop-losses and auto-exits on larger positions still execute instead of being refused.
    const userSellSlip =
      this.settings.sellSlippagePct !== null && this.settings.sellSlippagePct !== undefined && this.settings.sellSlippagePct !== ''
        ? Number(this.settings.sellSlippagePct)
        : null;
    const baseSellSlip = pos.chainId === 'solana' ? (cause === 'Mirror sell' || cause === 'trader sold' ? 15 : 1) : 5;
    // Real sells with no slippage set: Jupiter picks it from live conditions (a fixed 1% fails
    // most pump.fun sells). Paper keeps the modelled default.
    let sellSlippagePct = userSellSlip !== null ? userSellSlip : real ? null : baseSellSlip;
    // a real exit that keeps failing (price falling faster than the slippage allows) retries with
    // more room so it always gets out: Jupiter auto → 25% → 50%
    if (real && userSellSlip === null && pos.realSellFails > 0) sellSlippagePct = pos.realSellFails >= 2 ? 50 : 25;

    // a sell you press yourself never waits for an earlier failed sell's retry timer
    const sellPressed = /manual|sell all|panic|initials/i.test(String(cause || ''));
    let paperSellFillPriceUsd = null;
    if (pos.isPaper && pos.chainId === 'solana' && (/pump$/i.test(String(pos.tokenAddress || '')) || pos.venue === 'pumpfun') && Number(traderSellSol) > 0) {
      const solPx = CHAINS.solana.nativePriceUsd;
      const refPx = Number(traderExitPriceUsd) > 0 ? Number(traderExitPriceUsd) : Number(pos.currentPriceUsd);
      const sc = pumpCurveSellFill({
        traderPriceUsd: refPx,
        traderSol: Number(traderSellSol),
        ourSol: solPx > 0 ? (tokensSold * refPx) / solPx : 0,
        solPriceUsd: solPx,
      });
      if (sc?.fillPriceUsd > 0) paperSellFillPriceUsd = sc.fillPriceUsd;
    }
    let quote;
    try {
      quote = await this.adapter.getSwapQuote({
        chainId: pos.chainId,
        side: 'sell',
        token: {
          address: pos.tokenAddress,
          symbol: pos.symbol,
          currentPriceUsd: pos.currentPriceUsd,
          marketCapUsd: pos.currentMarketCapUsd,
          liquidityUsd: pos.liquidityUsd,
          paperSellFillPriceUsd,
        },
        amountUsd: grossValueUsd,
        slippagePct: sellSlippagePct,
        paper: Boolean(pos.isPaper),
        tokenAmount,
        assetMode: pos.tradingAssetUsed,
        urgent: sellPressed,
        positionTokens: tokensSold,
      });
    } catch (err) {
      if (!real) throw err;
      return this.realSellFailed(pos, err.message, { backoff: Boolean(err.backoff), noTokens: Boolean(err.noTokens) });
    }

    if (!real && userSellSlip === null && quote.priceImpactPct > sellSlippagePct) {
      sellSlippagePct = Math.min(AUTO_WIDEN_SELL_SLIPPAGE_MAX_PCT, Math.ceil((quote.priceImpactPct + 0.5) * 10) / 10);
    }

    // Paper only. A real quote is already the price the swap gets (Jupiter enforces slippage
    // between quote and landing); comparing it to our own, possibly lagging, price would block
    // stop-losses exactly when a coin crashes.
    if (!real && quote.priceImpactPct > sellSlippagePct) {
      // Auto-exits retry on every tick: only raise the alert once per minute per position
      const now = Date.now();
      if (!pos.lastSellBlockedAlertAt || now - pos.lastSellBlockedAlertAt > 60_000) {
        pos.lastSellBlockedAlertAt = now;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: `Sell not executed — price impact too high ($${pos.symbol})`,
          message: `Price impact (${quote.priceImpactPct.toFixed(2)}%) exceeded sell slippage limit (${sellSlippagePct}%). Raise sell slippage or sell a smaller part.`,
          timestamp: now,
        });
      }
      return {
        ok: false,
        error: `Price impact (${quote.priceImpactPct.toFixed(2)}%) exceeds sell slippage (${sellSlippagePct}%).`,
        realFailed: Boolean(real),
      };
    }

    const gasless = pos.chainId !== 'arc' && pos.tradingAssetUsed === 'stable';
    const execResult = await this.adapter.executeSwap({
      chainId: pos.chainId,
      wallet,
      side: 'sell',
      token: { address: pos.tokenAddress, symbol: pos.symbol, stage: pos.stage, launchpad: pos.launchpad, marketCapUsd: pos.currentMarketCapUsd, createdAt: pos.tokenCreatedAt, venue: pos.venue },
      // paper fee is 1% of what the sale actually fills at (after price impact)
      amountUsd: real ? grossValueUsd : tokensSold * quote.expectedFillPriceUsd,
      quote,
      priorityFee: this.settings.priorityFee,
      gasless,
      paper: Boolean(pos.isPaper),
      tokenAmount,
      assetMode: pos.tradingAssetUsed,
      slippagePct: sellSlippagePct,
      urgent: sellPressed,
      positionTokens: tokensSold,
    }).catch((err) => {
      if (!real) throw err;
      return { ok: false, error: err.message };
    });
    if (real && (!execResult || execResult.ok === false)) {
      return this.realSellFailed(pos, execResult?.error || 'unknown error', execResult);
    }
    if (real) pos.realSellFails = 0;
    if (real && Number(execResult.tokensSold) > 0) {
      // book exactly what left the wallet
      const actual = Number(execResult.tokensSold);
      if (tokenAmount === 'all' || actual >= pos.remainingTokens * 0.9999) {
        fraction = 1;
        tokensSold = pos.remainingTokens;
      } else {
        fraction = actual / pos.remainingTokens;
        tokensSold = actual;
      }
    }

    const realizedGrossUsd = real && Number.isFinite(execResult.receivedUsd) ? execResult.receivedUsd + execResult.platformFeeUsd : tokensSold * execResult.fillPriceUsd;
    const netProceedsUsd = Math.max(0, realizedGrossUsd - execResult.platformFeeUsd - execResult.networkFeeUsd);
    const costBasisSoldUsd = pos.remainingCostUsd * fraction;
    const pnlUsd = netProceedsUsd - costBasisSoldUsd;
    const pnlPct = costBasisSoldUsd > 0 ? (pnlUsd / costBasisSoldUsd) * 100 : 0;

    pos.remainingTokens = Number((pos.remainingTokens - tokensSold).toFixed(6));
    pos.remainingCostUsd = Number((pos.remainingCostUsd - costBasisSoldUsd).toFixed(4));
    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(4));
    pos.soldUsd = Number(((pos.soldUsd || 0) + netProceedsUsd).toFixed(4));
    pos.soldTokens = Number(((pos.soldTokens || 0) + tokensSold).toFixed(6));
    if (pos.investedSol != null && CHAINS.solana?.nativePriceUsd > 0) pos.soldSol = Number(((pos.soldSol || 0) + netProceedsUsd / CHAINS.solana.nativePriceUsd).toFixed(6));
    pos.lastSellAt = Date.now();
    // scorecard: our exit vs the trader's own sell price (negative = we sold lower)
    if (traderExitPriceUsd > 0 && execResult.fillPriceUsd > 0) pos.exitSlipPct = Number(((execResult.fillPriceUsd / traderExitPriceUsd - 1) * 100).toFixed(2));

    let positionClosed = false;
    if (fraction >= 0.9999 || pos.remainingTokens <= 0.000001) {
      pos.remainingTokens = 0;
      pos.remainingCostUsd = 0;
      pos.armedOrders = [];
      pos.closedAt = Date.now();
      pos.closeCause = cause;
      this.buyCooldownMap.delete(`${pos.chainId}:${pos.tokenAddress}`);
      positionClosed = true;
      // keep the closed list bounded (newest 300)
      const closed = this.positions.filter((p) => p.remainingTokens <= 0);
      if (closed.length > 300) {
        const drop = new Set(closed.sort((a, b) => (a.closedAt || a.openedAt) - (b.closedAt || b.openedAt)).slice(0, closed.length - 300).map((p) => p.id));
        this.positions = this.positions.filter((p) => !drop.has(p.id));
      }
    }

    this.creditWalletForSell(wallet, pos.chainId, netProceedsUsd, pos.tradingAssetUsed, Boolean(pos.isPaper));

    const receipt = {
      id: `hist-${randomUUID().slice(0, 8)}`,
      status: 'filled',
      side: 'sell',
      cause,
      isPaper: Boolean(pos.isPaper),
      chainId: pos.chainId,
      walletId: wallet.id,
      walletName: wallet.name,
      traderHandle: pos.traderHandle,
      followId: pos.followId || null,
      traderWallet: pos.traderWallet || null,
      symbol: pos.symbol,
      tokenAddress: pos.tokenAddress,
      amountUsd: netProceedsUsd,
      tokens: tokensSold,
      fillPriceUsd: execResult.fillPriceUsd,
      traderPriceUsd: null,
      chaseGapPct: null,
      platformFeeUsd: execResult.platformFeeUsd,
      networkFeeUsd: execResult.networkFeeUsd,
      gasless,
      pnlUsd: Number(pnlUsd.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      reason: null,
      txHash: execResult.txHash,
      explorerUrl: execResult.explorerUrl || null,
      timestamp: Date.now(),
    };
    this.history.unshift(receipt);
    // The permanent PnL log: the one source for every PnL figure (calendar, Period PnL, win rate,
    // Closed totals). Never trimmed by the 2-day cleanup.
    const solPxNow = Number(CHAINS.solana?.nativePriceUsd) || 0;
    this.realizedLog.push({
      t: receipt.timestamp,
      pnl: receipt.pnlUsd,
      paper: Boolean(receipt.isPaper),
      sym: receipt.symbol,
      cost: Number(costBasisSoldUsd.toFixed(4)), // cost basis of the part sold
      sol: solPxNow > 0 ? Number((receipt.pnlUsd / solPxNow).toFixed(6)) : null, // PnL in SOL at the sell
      pid: pos.id,
      closes: positionClosed, // this sell closed the position (one trade)
      posPnl: positionClosed ? Number(Number(pos.realizedPnlUsd || 0).toFixed(2)) : null, // whole trade's PnL
      fid: pos.followId || null,
      wallet: pos.traderWallet || null,
      // scorecard (closing sell only): hold time, entry / exit slip vs the trader, detection delay
      ...(positionClosed
        ? {
            held: Math.max(0, Math.round((pos.closedAt - pos.openedAt) / 1000)),
            slipIn: Number.isFinite(pos.entrySlipPct) ? pos.entrySlipPct : null,
            slipOut: Number.isFinite(pos.exitSlipPct) ? pos.exitSlipPct : null,
            lag: Number.isFinite(pos.detectLagSec) ? pos.detectLagSec : null,
          }
        : {}),
    });
    if (this.realizedLog.length > 20000) this.realizedLog.splice(0, this.realizedLog.length - 20000);

    // Evaluate streak / daily-loss limits only after this sell is in history,
    // so the closing trade's own loss counts toward the 24h limit.
    if (positionClosed) {
      this.evaluateRiskLimitsOnClose(pos, pnlUsd);
      this.evaluateTraderScore(pos.followId, Boolean(pos.isPaper));
    }

    this.alerts.unshift({
      id: `alt-${randomUUID().slice(0, 8)}`,
      level: pnlUsd >= 0 ? 'success' : 'warning',
      title: `Exit filled · ${chain.name} ($${pos.symbol})`,
      message: `Sold ${(fraction * 100).toFixed(0)}% via ${cause} for $${netProceedsUsd.toFixed(2)} (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} / ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%).`,
      timestamp: Date.now(),
    });

    this.emit('position_sold', { position: pos, receipt });
    return { ok: true, position: pos, receipt };
  }

  async sellInitialsManual(positionId) {
    const pos = this.positions.find((p) => p.id === positionId && p.remainingTokens > 0);
    if (!pos) return { ok: false, error: 'Position not found.' };

    const currentValUsd = pos.remainingTokens * pos.currentPriceUsd;
    if (currentValUsd <= pos.remainingCostUsd) {
      return this.executePositionSell(positionId, { sellPct: 100, cause: 'manual sell (initials underwater → 100%)' });
    }
    const neededPct = Math.min(100, Math.max(1, (pos.remainingCostUsd / currentValUsd) * 100));
    return this.executePositionSell(positionId, { sellPct: neededPct, cause: 'initials taken off' });
  }

  async sellAllPositions({ chainId = null, panic = false } = {}) {
    if (panic) {
      for (const f of this.follows) {
        f.status = 'paused';
        f.pauseReason = 'panic_sell';
      }
    }

    const targets = this.positions.filter(
      (p) => p.remainingTokens > 0 && (!chainId || chainId === 'all' || p.chainId === chainId)
    );

    const results = [];
    for (const pos of targets) {
      const res = await this.executePositionSell(pos.id, {
        sellPct: 100,
        cause: panic ? 'panic sell' : 'sell all',
      });
      results.push(res);
    }

    this.emit('bulk_sell', { panic, chainId, count: results.length });
    return { ok: true, panic, soldCount: results.filter((r) => r.ok).length, results };
  }

  evaluateRiskLimitsOnClose(pos, realizedPnlUsd) {
    const follow = this.follows.find((f) => f.id === pos.followId);
    if (follow) {
      if (realizedPnlUsd < 0) {
        follow.consecutiveLosses = (follow.consecutiveLosses || 0) + 1;
        const streakLimit = Number(follow.streakLimit) >= 2 ? Number(follow.streakLimit) : this.settings.risk.streakLimit;
        if (
          streakLimit !== null &&
          follow.consecutiveLosses >= streakLimit
        ) {
          follow.status = 'paused';
          follow.pauseReason = 'streak';
          follow.streakPausedAt = Date.now();
          this.alerts.unshift({
            id: `alt-${randomUUID().slice(0, 8)}`,
            level: 'danger',
            title: `Losing streak — @${follow.handle}'s buys paused`,
            message: `@${follow.handle} closed ${follow.consecutiveLosses} positions in a row at a loss. Selling and open positions continue normally.`,
            timestamp: Date.now(),
          });
        }
      } else {
        follow.consecutiveLosses = 0;
      }
    }

    if (this.settings.risk.dailyLossLimitUsd !== null) {
      // only this mode's losses (paper losses must not pause real buying, and the reverse)
      const netLoss24h = this.realizedLoss24h(Boolean(pos.isPaper));

      if (netLoss24h >= this.settings.risk.dailyLossLimitUsd && !this.settings.risk.dailyLossTriggered) {
        this.settings.risk.dailyLossTriggered = true;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: 'Daily loss limit hit — buying paused',
          message: `Realized losses over 24h ($${netLoss24h.toFixed(2)}) reached your $${this.settings.risk.dailyLossLimitUsd} limit.`,
          timestamp: Date.now(),
        });
      }
    }
  }

  async evaluatePositionExits(pos, now = Date.now()) {
    if (!pos || pos.remainingTokens <= 0) return null;
    // A real sell can fail (no route, slippage, network). Exit rules mark themselves done
    // before selling, so undo those marks when a real sell did not happen and it is retried.
    const before = { initialsTaken: pos.initialsTaken, timeCapExecuted: pos.timeCapExecuted, armedOrders: Array.isArray(pos.armedOrders) ? pos.armedOrders.slice() : pos.armedOrders };
    // tokens looked gone: keep exits paused, but re-check once a minute (a balance read can fail
    // for a while — the position must not be left without exits for good)
    if (!pos.isPaper && pos.realTokensMissing) {
      if (now - (pos.realMissingAt || 0) < 60_000) return null;
      pos.realMissingAt = now;
    }
    const res = await this.evaluatePositionExitRules(pos, now);
    // Any sell that did not happen (real failure, paper price-impact block, or another sell of
    // this position still in progress) must not leave its rule marked as done.
    if (res && res.ok === false) Object.assign(pos, before);
    return res;
  }

  async evaluatePositionExitRules(pos, now = Date.now()) {
    if (!pos || pos.remainingTokens <= 0) return null;

    const follow = this.follows.find((f) => f.id === pos.followId);
    const gainPct = ((pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const peakGainPct = ((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
    const dropFromPeakPct =
      pos.peakPriceUsd > 0 ? ((pos.peakPriceUsd - pos.currentPriceUsd) / pos.peakPriceUsd) * 100 : 0;
    const ageSec = Math.max(0, (now - pos.openedAt) / 1000);

    // 1. Check Per-Position Armed Limit Orders (up to 5 per position)
    if (Array.isArray(pos.armedOrders) && pos.armedOrders.length > 0) {
      for (let i = 0; i < pos.armedOrders.length; i++) {
        const ord = pos.armedOrders[i];
        let triggered = false;

        if (ord.type === 'sell-initials') {
          if (gainPct >= Number(ord.triggerValue)) {
            pos.armedOrders.splice(i, 1);
            return this.sellInitialsManual(pos.id);
          }
        } else if (ord.type === 'take-profit') {
          if (ord.triggerType === 'pct' && gainPct >= Number(ord.triggerValue)) triggered = true;
          if (ord.triggerType === 'mc' && pos.currentMarketCapUsd >= Number(ord.triggerValue)) triggered = true;
          if (triggered) {
            pos.armedOrders.splice(i, 1);
            // The order was sized on the bag at arm time. If the position has shrunk since
            // (manual sell, initials, another order), scale it down so "50%" stays 50%.
            const armedOn = Number(ord.tokensAtArm || 0);
            const shrink = armedOn > 0 ? Math.min(1, pos.remainingTokens / armedOn) : 1;
            const tokens = ord.tokensToSell ? ord.tokensToSell * shrink : null;
            return this.executePositionSell(pos.id, {
              exactTokens: tokens,
              sellPct: ord.sizePct,
              cause: 'limit take-profit hit',
            });
          }
        } else if (ord.type === 'stop-loss') {
          if (ord.triggerType === 'pct' && gainPct <= -Math.abs(Number(ord.triggerValue))) triggered = true;
          if (ord.triggerType === 'mc' && pos.currentMarketCapUsd <= Number(ord.triggerValue)) triggered = true;
          if (triggered) {
            pos.armedOrders.splice(i, 1);
            return this.executePositionSell(pos.id, {
              sellPct: ord.sizePct,
              cause: 'limit stop-loss hit',
            });
          }
        }
      }
    }

    if (!follow) return null;

    // 2. Check Follow-level Take Profit / Stop Loss (applies in EVERY mode)
    if (follow.tpPct !== null && follow.tpPct !== undefined && gainPct >= Number(follow.tpPct)) {
      return this.executePositionSell(pos.id, { sellPct: 100, cause: 'take-profit hit' });
    }
    if (follow.slPct !== null && follow.slPct !== undefined && gainPct <= -Math.abs(Number(follow.slPct))) {
      return this.executePositionSell(pos.id, { sellPct: 100, cause: 'stop-loss hit' });
    }

    // 3. Check 5-Rule Auto-Exit Engine (ONLY when follow.mode === 'auto-exit')
    if (follow.mode === 'auto-exit' && follow.exitRules) {
      const rules = follow.exitRules;

      if (rules.takeInitials?.enabled && !pos.initialsTaken) {
        if (gainPct >= Number(rules.takeInitials.takeAtPct)) {
          pos.initialsTaken = true;
          return this.executePositionSell(pos.id, {
            sellPct: Number(rules.takeInitials.sellSizePct),
            cause: 'initials taken off',
          });
        }
      }

      if (rules.moonbagTrail?.enabled) {
        if (peakGainPct >= Number(rules.moonbagTrail.armsAtPct)) {
          pos.trailArmed = true;
        }
        if (pos.trailArmed && dropFromPeakPct >= Number(rules.moonbagTrail.trailPct)) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'trailing stop hit',
          });
        }
      }

      if (rules.floor?.enabled) {
        const activeFloorDrop =
          ageSec >= Number(rules.floor.tightensAfterSec)
            ? Math.abs(Number(rules.floor.tightFloorPct))
            : Math.abs(Number(rules.floor.openingFloorPct));
        if (gainPct <= -activeFloorDrop) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'floor hit',
          });
        }
      }

      if (rules.waveCut?.enabled) {
        if (ageSec >= Number(rules.waveCut.afterSec) && peakGainPct < Number(rules.waveCut.needsPeakPct)) {
          return this.executePositionSell(pos.id, {
            sellPct: 100,
            cause: 'no-wave exit',
          });
        }
      }

      if (rules.hardTimeCap?.enabled && ageSec >= Number(rules.hardTimeCap.timeCapSec) && !pos.timeCapExecuted) {
        pos.timeCapExecuted = true;
        if (pos.initialsTaken) {
          // time is up: close whatever is left (the moonbag) instead of holding it forever
          return this.executePositionSell(pos.id, { sellPct: 100, cause: 'time cap reached' });
        }
        const mainSellPct = rules.takeInitials?.enabled ? Number(rules.takeInitials.sellSizePct) : 100;
        pos.initialsTaken = true;
        return this.executePositionSell(pos.id, {
          sellPct: mainSellPct,
          cause: 'time cap reached',
        });
      }
    }

    return null;
  }

  armLimitOrder(positionId, { type, triggerType, triggerValue, sizePct }) {
    const pos = this.positions.find((p) => p.id === positionId && p.remainingTokens > 0);
    if (!pos) return { ok: false, error: 'Open position not found.' };

    pos.armedOrders = pos.armedOrders || [];
    if (pos.armedOrders.length >= 5) {
      return { ok: false, error: 'Maximum of 5 armed limit orders per position reached.' };
    }

    const numericSize = type === 'sell-initials' ? 0 : Math.min(100, Math.max(1, Number(sizePct || 50)));

    if (type === 'take-profit') {
      const existingTpPct = pos.armedOrders
        .filter((o) => o.type === 'take-profit')
        .reduce((sum, o) => sum + Number(o.sizePct || 0), 0);
      if (existingTpPct + numericSize > 100) {
        return {
          ok: false,
          error: `Take-profit orders cannot exceed 100% of the position (${100 - existingTpPct}% remaining free).`,
        };
      }
    }

    const order = {
      id: `ord-${randomUUID().slice(0, 6)}`,
      type,
      triggerType: type === 'sell-initials' ? 'pct' : triggerType,
      triggerValue: Number(triggerValue),
      sizePct: numericSize,
      tokensToSell: pos.remainingTokens * (numericSize / 100),
      tokensAtArm: pos.remainingTokens,
      createdAt: Date.now(),
    };

    pos.armedOrders.push(order);
    this.emit('limit_order_armed', { positionId, order });
    return { ok: true, order, position: pos };
  }

  cancelLimitOrder(positionId, orderId) {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return { ok: false, error: 'Position not found.' };
    pos.armedOrders = (pos.armedOrders || []).filter((o) => o.id !== orderId);
    this.emit('limit_order_cancelled', { positionId, orderId });
    return { ok: true, position: pos };
  }

  /**
   * Fetches real live token prices & market caps from DexScreener for any open positions,
   * and evaluates the Exit Engine.
   */
  /**
   * Real on-chain fills (from watched wallets) are the most trustworthy price. Record one and
   * move every open position in that token to it.
   */
  observeTradePrice(mint, priceUsd, at = Date.now()) {
    const price = Number(priceUsd);
    if (!mint || !(price > 0)) return;
    if (!this.lastTradePrice) this.lastTradePrice = new Map();
    this.lastTradePrice.set(mint, { priceUsd: price, at });
    for (const pos of this.positions) {
      if (pos.tokenAddress !== mint || pos.remainingTokens <= 0) continue;
      const ratio = pos.currentPriceUsd > 0 ? price / pos.currentPriceUsd : 1;
      if (pos.currentMarketCapUsd > 0) pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * ratio);
      pos.currentPriceUsd = price;
      pos.priceUpdatedAt = at;
      pos.priceSource = 'on-chain fill';
      if (price > pos.peakPriceUsd) pos.peakPriceUsd = price;
      if (pos.currentMarketCapUsd > (pos.peakMarketCapUsd || 0)) pos.peakMarketCapUsd = pos.currentMarketCapUsd;
    }
  }

  /**
   * Real on-chain fills beat market-data feeds, which lag fast pump.fun moves by 30-60 s.
   * A feed quote is ignored when a real fill says otherwise:
   *   - fill in the last 60 s: the quote must be within 25% of it
   *   - fill in the last 2 min: within 2x
   * (A lagging quote used to drag positions back to an old price, faking a crash that fired
   * trailing stops and floors.)
   */
  quoteAgreesWithChain(mint, quotePriceUsd, now = Date.now()) {
    const last = this.lastTradePrice?.get(mint);
    if (!last) return true;
    const age = now - last.at;
    if (age > 120_000) return true;
    const r = quotePriceUsd / last.priceUsd;
    if (age <= 60_000) return r <= 1.25 && r >= 0.75;
    return r <= 2 && r >= 0.5;
  }

  /**
   * Batched live quotes from DexScreener. Picks each token's deepest pool where it is the
   * base token, so the price matches what the trader and a copy would actually trade at.
   */
  async fetchLivePrices(allMints) {
    const out = new Map();
    if (!allMints.length || typeof fetch !== 'function') return out;
    const fetchImpl = this.priceFetch || fetch;
    // fast exit checks: a price fetched less than livePriceMinAgeMs ago is reused (the feed
    // itself updates every few seconds, so asking more often only risks its rate limit)
    const minAge = Number(this.livePriceMinAgeMs) || 0;
    if (!this.livePriceCache) this.livePriceCache = new Map();
    const now = Date.now();
    const mints = [];
    for (const m of allMints) {
      const c = minAge > 0 ? this.livePriceCache.get(m) : null;
      if (c && now - c.at < minAge) {
        if (c.value) out.set(m, c.value);
      } else mints.push(m);
    }
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      try {
        const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${chunk.map(encodeURIComponent).join(',')}`);
        if (!res.ok) {
          this.priceFeed = { ...(this.priceFeed || {}), lastError: `Price feed HTTP ${res.status}`, lastErrorAt: Date.now() };
          continue;
        }
        const data = await res.json();
        this.priceFeed = { ...(this.priceFeed || {}), lastOkAt: Date.now() };
        for (const pair of Array.isArray(data?.pairs) ? data.pairs : []) {
          const mint = pair?.baseToken?.address;
          if (!chunk.includes(mint) || !(Number(pair.priceUsd) > 0)) continue;
          const liq = Number(pair.liquidity?.usd || 0);
          const prev = out.get(mint);
          if (!prev || liq > prev.liquidityUsd) {
            out.set(mint, { priceUsd: Number(pair.priceUsd), marketCapUsd: Number(pair.marketCap || pair.fdv || 0), liquidityUsd: liq });
          }
        }
        if (minAge > 0) {
          for (const m of chunk) this.livePriceCache.set(m, { at: now, value: out.get(m) || null });
          if (this.livePriceCache.size > 500) this.livePriceCache = new Map([...this.livePriceCache].slice(-250));
        }
      } catch (err) {
        // network hiccup: positions keep their last live price
        this.priceFeed = { ...(this.priceFeed || {}), lastError: `Price feed unreachable (${err.message})`, lastErrorAt: Date.now() };
      }
    }
    return out;
  }

  async tickMarketPrices(customMultiplierByPosId = null) {
    const now = Date.now();
    const openPositions = this.positions.filter((p) => p.remainingTokens > 0);
    if (openPositions.length === 0) return;

    // Live prices for real token addresses: one batched DexScreener call (≤30 tokens each)
    const realMints = [...new Set(openPositions.filter((p) => p.tokenAddress && p.tokenAddress.length >= 32).map((p) => p.tokenAddress))];
    // pump.fun tokens still on their bonding curve: exact live numbers from the chain (fresher
    // than DexScreener, and the only real liquidity figure for them)
    let curves = new Map();
    let curvesFailed = false;
    if (!customMultiplierByPosId && typeof this.curveSource === 'function') {
      const pumpMints = realMints.filter((m) => /pump$/i.test(m) || openPositions.some((p) => p.tokenAddress === m && (p.venue === 'pumpfun' || p.launchpad === 'pump.fun' || p.stage === 'pre-grad')));
      if (pumpMints.length) {
        try {
          curves = await this.curveSource(pumpMints);
        } catch {
          curves = new Map();
          curvesFailed = true;
        }
      }
    }
    // a pump.fun coin whose curve was read fine but is gone has graduated to PumpSwap
    if (!customMultiplierByPosId && !curvesFailed && typeof this.curveSource === 'function') {
      for (const p of openPositions) if (p.stage === 'pre-grad' && (/pump$/i.test(p.tokenAddress || '') || p.venue === 'pumpfun') && !curves.has(p.tokenAddress)) p.stage = 'graduated';
    }
    const live = customMultiplierByPosId ? new Map() : await this.fetchLivePrices(realMints.filter((m) => !curves.has(m)));

    const exits = [];
    for (const pos of openPositions) {
      const quote = live.get(pos.tokenAddress);
      const curve = curves.get(pos.tokenAddress);
      if (curve) {
        pos.stage = 'pre-grad';
        pos.currentPriceUsd = curve.priceUsd;
        pos.currentMarketCapUsd = Math.round(curve.marketCapUsd);
        pos.liquidityUsd = Math.round(curve.liquidityUsd);
        pos.priceUpdatedAt = now;
        pos.priceSource = 'pump-curve';
      } else if (customMultiplierByPosId && customMultiplierByPosId[pos.id] !== undefined) {
        const mult = customMultiplierByPosId[pos.id];
        pos.currentPriceUsd = Number((pos.currentPriceUsd * mult).toFixed(8));
        pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * mult);
      } else if (curvesFailed && pos.priceSource === 'pump-curve') {
        // curve read failed this tick: keep the last exact curve price rather than a lagging feed
      } else if (quote && this.quoteAgreesWithChain(pos.tokenAddress, quote.priceUsd, now)) {
        pos.currentPriceUsd = quote.priceUsd;
        if (quote.marketCapUsd) pos.currentMarketCapUsd = Math.round(quote.marketCapUsd);
        if (quote.liquidityUsd) pos.liquidityUsd = Math.round(quote.liquidityUsd);
        pos.priceUpdatedAt = now;
        pos.priceSource = 'dexscreener';
      } else if (pos.tokenAddress && pos.tokenAddress.length >= 32) {
        // Real token but no fresh quote this tick: keep the last live price (never invent one)
      } else if (pos.isPaper || this.settings.paperTrading) {
        // Developer test tokens only (no real address): small random drift
        const drift = 1 + (Math.random() * 0.02 - 0.009);
        pos.currentPriceUsd = Number((pos.currentPriceUsd * drift).toFixed(8));
        pos.currentMarketCapUsd = Math.round(pos.currentMarketCapUsd * drift);
      }

      if (pos.currentPriceUsd > pos.peakPriceUsd) {
        pos.peakPriceUsd = pos.currentPriceUsd;
      }
      if (pos.currentMarketCapUsd > pos.peakMarketCapUsd) {
        pos.peakMarketCapUsd = pos.currentMarketCapUsd;
      }

      exits.push(this.evaluatePositionExits(pos, now));
    }
    // Exits run side by side: one slow real sell (up to a minute) used to hold back every other
    // position's stop-loss in the same tick. Each position still sells one at a time.
    const settled = await Promise.allSettled(exits);
    this.emit('market_tick', { timestamp: now });
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /** Clears the History list only (positions, balances and follows are untouched). */
  clearHistory() {
    const removed = this.history.length;
    const closedBefore = this.positions.length;
    this.history = [];
    // Finished (fully sold) trades are dropped too; open positions are kept
    this.positions = this.positions.filter((p) => p.remainingTokens > 0);
    const closedRemoved = closedBefore - this.positions.length;
    this.emit('history_cleared', { removed, closedRemoved });
    return { removed, closedRemoved };
  }

  resetToCleanState() {
    for (const w of this.wallets) {
      w.balances = {
        solana: { native: 0, stable: 0 },
        bsc: { native: 0, stable: 0 },
        robinhood: { native: 0, stable: 0 },
        arc: { native: 0, stable: 0 },
      };
      w.paperLedger = [{ t: Date.now(), type: 'full reset', beforeUsd: Number(w.paperBalanceUsd ?? 10000), afterUsd: 10000, changeUsd: Number((10000 - Number(w.paperBalanceUsd ?? 10000)).toFixed(2)) }];
      w.paperBalanceUsd = 10000.0;
    }
    this.follows = [];
    this.positions = [];
    this.history = [];
    this.alerts = [];
    this.realizedLog = [];
    this.copiedCycles = {};
    this.buyCooldownMap.clear();
    this.emit('state_reset', {});
    return this.getStateSnapshot();
  }

  scorecardSettings() {
    if (!this.settings.scorecard) this.settings.scorecard = createDefaultScorecardSettings();
    return { ...createDefaultScorecardSettings(), ...this.settings.scorecard };
  }

  /**
   * Trader scorecard from the permanent PnL log: real win rate, average hold time and how far the
   * copies slip behind the trader (entry, exit, detection delay). `since` = only trades after
   * that time (set when a trader paused for being too fast is resumed); `from` / `to` filter by
   * date range.
   */
  traderScorecard(followId, { paper = Boolean(this.settings.paperTrading), since = 0, from = 0, to = 0 } = {}) {
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const follow = (this.follows || []).find((f) => f.id === followId);
    const wallet = follow?.traderWallet || null;
    const posById = wallet ? new Map((this.positions || []).map((p) => [p.id, p])) : null;
    const start = Math.max(Number(since) || 0, Number(from) || 0);
    const end = to > 0 ? Number(to) : Infinity;
    const rows = (this.realizedLog || []).filter((r) => {
      const rWallet = r.wallet || (r.pid && posById?.get(r.pid)?.traderWallet) || null;
      return (
        (r.fid === followId || (wallet && rWallet === wallet)) &&
        (r.closes === undefined || r.closes) &&
        Boolean(r.paper) === Boolean(paper) &&
        Number.isFinite(r.t) &&
        r.t >= start &&
        r.t <= end
      );
    });
    const pnls = rows.map((r) => (Number.isFinite(r.posPnl) ? r.posPnl : r.pnl)).filter(Number.isFinite);
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    let losingStreak = 0;
    for (let i = pnls.length - 1; i >= 0; i--) {
      if (pnls[i] < 0) losingStreak += 1;
      else if (pnls[i] > 0) break;
    }
    const held = rows.map((r) => r.held).filter(Number.isFinite);
    const slipIn = rows.map((r) => r.slipIn).filter(Number.isFinite);
    const slipOut = rows.map((r) => r.slipOut).filter(Number.isFinite);
    const lag = rows.map((r) => r.lag).filter(Number.isFinite);
    const aIn = avg(slipIn);
    const aOut = avg(slipOut);
    const r2 = (v) => (v === null ? null : Number(v.toFixed(2)));
    return {
      followId,
      paper: Boolean(paper),
      trades: rows.length,
      wins,
      losses,
      losingStreak,
      winRatePct: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null,
      pnlUsd: Number(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
      avgHoldSec: held.length ? Math.round(avg(held)) : null,
      avgEntrySlipPct: r2(aIn), // + = we bought higher than the trader
      avgExitSlipPct: r2(aOut), // − = we sold lower than the trader (Mirror sells only)
      roundTripSlipPct: aIn === null && aOut === null ? null : r2((aIn || 0) - (aOut || 0)),
      avgLagSec: lag.length ? Number(avg(lag).toFixed(1)) : null,
      measuredSlip: slipIn.length,
      measuredExits: slipOut.length,
    };
  }

  /**
   * Older PnL-log rows have no trader / scorecard fields: fill them in from the closed positions
   * and buy receipts still on record (last 2 days). Safe to run more than once.
   */
  backfillScorecardLog() {
    let filled = 0;
    const byId = new Map(this.positions.map((p) => [p.id, p]));
    for (const r of this.realizedLog || []) {
      if (!r.pid) continue;
      const p = byId.get(r.pid);
      if (!p) continue;
      let touched = false;
      if (!r.wallet && p.traderWallet) {
        r.wallet = p.traderWallet;
        touched = true;
      }
      if (!r.fid && p.followId) {
        r.fid = p.followId;
        touched = true;
      }
      if (r.closes && r.held === undefined) {
        const buy = this.history.find((h) => h.side === 'buy' && h.status === 'filled' && h.tokenAddress === p.tokenAddress && (h.followId === p.followId || (p.traderWallet && h.traderWallet === p.traderWallet)) && Math.abs((h.timestamp || 0) - (p.openedAt || 0)) < 120_000);
        const trader = Number(p.traderEntryPriceUsd || buy?.traderPriceUsd) || 0;
        r.held = p.closedAt && p.openedAt ? Math.max(0, Math.round((p.closedAt - p.openedAt) / 1000)) : null;
        r.slipIn = Number.isFinite(p.entrySlipPct) ? p.entrySlipPct : trader > 0 && p.entryPriceUsd > 0 ? Number(((p.entryPriceUsd / trader - 1) * 100).toFixed(2)) : null;
        r.slipOut = Number.isFinite(p.exitSlipPct) ? p.exitSlipPct : null;
        r.lag = Number.isFinite(p.detectLagSec) ? p.detectLagSec : null;
        touched = true;
      }
      if (touched) filled += 1;
    }
    return filled;
  }

  /** Pause a trader the bot can't keep up with (after enough closed copies). */
  evaluateTraderScore(followId, paper) {
    const cfg = this.scorecardSettings();
    const follow = this.follows.find((f) => f.id === followId);
    if (!cfg.autoPause || !follow || follow.status !== 'copying') return null;
    const sc = this.traderScorecard(followId, { paper, since: Number(follow.scoreSince) || 0 });
    if (sc.trades < cfg.minTrades) return null;
    const why = [];
    if (sc.roundTripSlipPct !== null && sc.roundTripSlipPct > cfg.maxSlipPct) why.push(`copies lose ${sc.roundTripSlipPct.toFixed(1)}% to the trader on average (limit ${cfg.maxSlipPct}%)`);
    if (sc.avgLagSec !== null && sc.avgLagSec > cfg.maxLagSec) why.push(`trades are seen ${sc.avgLagSec.toFixed(1)} s late on average (limit ${cfg.maxLagSec} s)`);
    if (!why.length) return null;
    follow.status = 'paused';
    follow.pauseReason = 'slow';
    follow.pauseDetail = why.join('; ');
    this.alerts.unshift({
      id: `alt-${randomUUID().slice(0, 8)}`,
      level: 'danger',
      title: `@${follow.handle} paused — the bot can't keep up`,
      message: `Over the last ${sc.trades} copies: ${follow.pauseDetail}. Open positions keep being managed; resume the trader to try again.`,
      timestamp: Date.now(),
    });
    this.emit('follows_updated', {});
    return follow.pauseDetail;
  }

  /**
   * PnL totals for any period, from the same log as the calendar, so every card agrees.
   * from/to: ms timestamps (to 0 = now). Trades / wins / losses count whole trades (the sell that
   * closed a position); older log rows without that mark count one sell as one trade.
   */
  pnlSummary({ from = 0, to = 0, paper = true } = {}) {
    const end = to > 0 ? to : Infinity;
    const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
    let realized = 0;
    let realizedSol = 0;
    let solExact = true;
    let cost = 0;
    let sells = 0;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    for (const r of this.realizedLog || []) {
      if (Boolean(r.paper) !== Boolean(paper) || !Number.isFinite(r.pnl) || r.t < from || r.t > end) continue;
      realized += r.pnl;
      sells += 1;
      if (Number.isFinite(r.sol)) realizedSol += r.sol;
      else {
        solExact = false;
        if (px > 0) realizedSol += r.pnl / px;
      }
      if (Number.isFinite(r.cost)) cost += r.cost;
      if (r.closes === undefined) {
        trades += 1;
        if (r.pnl > 0) wins += 1;
        else if (r.pnl < 0) losses += 1;
      } else if (r.closes) {
        trades += 1;
        const p = Number.isFinite(r.posPnl) ? r.posPnl : r.pnl;
        if (p > 0) wins += 1;
        else if (p < 0) losses += 1;
      }
    }
    // copied buys in the period (full history kept on the server, last 2 days)
    const copiedBuys = (this.history || []).filter((h) => h.side === 'buy' && h.status === 'filled' && Boolean(h.isPaper) === Boolean(paper) && h.timestamp >= from && h.timestamp <= end).length;
    const traderScores = Object.fromEntries((this.follows || []).map((f) => [f.id, this.traderScorecard(f.id, { paper, from, to })]));
    return {
      from,
      to: to > 0 ? to : null,
      paper: Boolean(paper),
      copiedBuys,
      realized: Number(realized.toFixed(2)),
      realizedSol: Number(realizedSol.toFixed(4)),
      solExact,
      costSold: Number(cost.toFixed(2)),
      sells,
      trades,
      wins,
      losses,
      traderScores,
    };
  }

  /**
   * Realized PnL per day for one month (PnL calendar). tzOffsetMin = the browser's
   * getTimezoneOffset() (0 for UTC), so days match the user's own calendar.
   */
  pnlCalendar({ year, month, tzOffsetMin = 0, paper = true } = {}) {
    const y = Number(year);
    const m = Number(month); // 1–12
    const shift = -Number(tzOffsetMin || 0) * 60_000; // UTC → local
    const days = {};
    const wins = { count: 0, usd: 0 };
    const losses = { count: 0, usd: 0 };
    let first = null;
    for (const r of this.realizedLog || []) {
      if (Boolean(r.paper) !== Boolean(paper) || !Number.isFinite(r.pnl)) continue;
      const d = new Date(r.t + shift);
      if (first === null || r.t < first) first = r.t;
      if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m) continue;
      const day = d.getUTCDate();
      const cell = days[day] || (days[day] = { pnl: 0, trades: 0, wins: 0, losses: 0 });
      cell.pnl += r.pnl;
      // same trade counting as pnlSummary (win-rate card): one trade = one closed position,
      // won or lost on its whole PnL; older rows without the mark count one sell as one trade
      const closesTrade = r.closes === undefined || r.closes;
      if (!closesTrade) continue;
      const tradePnl = r.closes === undefined ? r.pnl : Number.isFinite(r.posPnl) ? r.posPnl : r.pnl;
      cell.trades += 1;
      if (tradePnl > 0) {
        cell.wins += 1;
        wins.count += 1;
        wins.usd += tradePnl;
      } else if (tradePnl < 0) {
        cell.losses += 1;
        losses.count += 1;
        losses.usd += tradePnl;
      }
    }
    let best = null;
    let worst = null;
    for (const [day, c] of Object.entries(days)) {
      c.pnl = Number(c.pnl.toFixed(2));
      if (!best || c.pnl > best.pnl) best = { day: Number(day), pnl: c.pnl };
      if (!worst || c.pnl < worst.pnl) worst = { day: Number(day), pnl: c.pnl };
    }
    const total = Object.values(days).reduce((a, c) => a + c.pnl, 0);
    return {
      year: y,
      month: m,
      paper: Boolean(paper),
      days,
      total: Number(total.toFixed(2)),
      wins: { count: wins.count, usd: Number(wins.usd.toFixed(2)) },
      losses: { count: losses.count, usd: Number(losses.usd.toFixed(2)) },
      best: best && best.pnl > 0 ? best : null,
      worst: worst && worst.pnl < 0 ? worst : null,
      firstTradeAt: first,
    };
  }

  /**
   * Trader positions we have copied (follow + coin), so top-ups aren't copied as new positions.
   * Ends when the trader sells 100%, or after 2 h (in case their sell was never seen).
   */
  // kind '' = we copied this trader position; 'missed' = their entry came too late to copy
  /**
   * Is this buy a top-up of a position we never entered? Known from the trader's balance before
   * the buy (from the transaction), or — when that is unknown — from our own log of their earlier
   * buys of this coin since they last sold out.
   */
  isTopUpOfMissedEntry(follow, signal) {
    const mint = signal.token?.address;
    if (!mint) return false;
    const haveCopy = this.positions.some((p) => p.followId === follow.id && p.tokenAddress === mint && p.remainingTokens > 0);
    if (haveCopy) return false;
    const before = Number(signal.traderHeldBefore);
    if (signal.traderHeldBefore !== undefined && signal.traderHeldBefore !== null && Number.isFinite(before)) {
      const bought = Number(signal.traderTokens) || 0;
      // leftovers of an earlier round (dust under 5% of this buy) don't count
      return before > 0 && (!bought || before >= bought * 0.05);
    }
    if (!follow.traderWallet || !Array.isArray(this.traderLog)) return false;
    const since = Date.now() - 2 * 3600_000;
    const log = this.traderLog.filter((e) => e.w === follow.traderWallet && e.mint === mint && e.t >= since && e.sig !== signal.signature);
    const lastExit = log.filter((e) => e.side === 'sell' && Number(e.share) >= 99).reduce((m, e) => Math.max(m, e.t), 0);
    return log.some((e) => e.side === 'buy' && e.t > lastExit);
  }

  copiedCycleActive(followId, mint, kind = '') {
    const k = `${followId}:${mint}${kind ? `:${kind}` : ''}`;
    const c = this.copiedCycles?.[k];
    if (!c) return false;
    if (Date.now() - c > 2 * 3600_000) {
      delete this.copiedCycles[k];
      return false;
    }
    return true;
  }

  markCopiedCycle(followId, mint, kind = '') {
    if (!mint) return;
    if (!this.copiedCycles) this.copiedCycles = {};
    const k = `${followId}:${mint}${kind ? `:${kind}` : ''}`;
    if (!this.copiedCycles[k]) this.copiedCycles[k] = Date.now();
  }

  endCopiedCycle(followId, mint) {
    if (!this.copiedCycles) return;
    delete this.copiedCycles[`${followId}:${mint}`];
    delete this.copiedCycles[`${followId}:${mint}:missed`];
  }

  /**
   * Storage: closed positions and history older than `maxAgeMs` (2 days) are removed. Open
   * positions are never touched; the PnL calendar keeps its own small log (realizedLog).
   */
  pruneOldRecords(maxAgeMs = 2 * 86_400_000, now = Date.now()) {
    const cutoff = now - maxAgeMs;
    const beforeP = this.positions.length;
    const beforeH = this.history.length;
    this.positions = this.positions.filter((p) => p.remainingTokens > 0 || (p.closedAt || p.lastSellAt || p.openedAt || now) >= cutoff);
    this.history = this.history.filter((h) => (h.timestamp || now) >= cutoff);
    const removed = { closedPositions: beforeP - this.positions.length, history: beforeH - this.history.length };
    if (removed.closedPositions || removed.history) this.emit('records_pruned', removed);
    return removed;
  }

  /**
   * Ghost positions: a real position whose tokens are gone from the wallet, while the bot's own
   * swap log shows a successful sell of that coin that was never booked (e.g. made by the
   * previous copy during a redeploy). Close it with those exact proceeds.
   */
  reconcileRealTrades(trades = []) {
    const booked = [];
    for (const pos of this.positions) {
      if (pos.isPaper !== false || !(pos.remainingTokens > 0) || !pos.realTokensMissing) continue;
      const t = trades.find((x) => x?.side === 'sell' && x.ok === true && x.mint === pos.tokenAddress && x.t >= (pos.openedAt || 0) && Number(x.usd) >= 0 && !this.history.some((h) => h.txHash && h.txHash === x.signature));
      if (!t) continue;
      this.bookExternalRealSell(pos, { receivedUsd: Number(t.usd), networkFeeUsd: Number(t.networkFeeUsd || 0), txHash: t.signature || null, at: t.t });
      booked.push(pos.id);
    }
    return booked;
  }

  bookExternalRealSell(pos, { receivedUsd, networkFeeUsd = 0, txHash = null, at = Date.now(), cause = 'sold (recovered record)' }) {
    const wallet = this.getWalletById(pos.walletId);
    const netProceedsUsd = Math.max(0, receivedUsd - networkFeeUsd);
    const costBasisSoldUsd = pos.remainingCostUsd;
    const tokensSold = pos.remainingTokens;
    const pnlUsd = netProceedsUsd - costBasisSoldUsd;
    const pnlPct = costBasisSoldUsd > 0 ? (pnlUsd / costBasisSoldUsd) * 100 : 0;
    const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
    pos.realizedPnlUsd = Number(((pos.realizedPnlUsd || 0) + pnlUsd).toFixed(4));
    pos.soldUsd = Number(((pos.soldUsd || 0) + netProceedsUsd).toFixed(4));
    pos.soldTokens = Number(((pos.soldTokens || 0) + tokensSold).toFixed(6));
    if (pos.investedSol != null && px > 0) pos.soldSol = Number(((pos.soldSol || 0) + netProceedsUsd / px).toFixed(6));
    pos.remainingTokens = 0;
    pos.remainingCostUsd = 0;
    pos.armedOrders = [];
    pos.closedAt = at;
    pos.lastSellAt = at;
    pos.closeCause = cause;
    pos.realTokensMissing = false;
    this.creditWalletForSell(wallet, pos.chainId, netProceedsUsd, pos.tradingAssetUsed, false);
    const receipt = {
      id: `hist-${randomUUID().slice(0, 8)}`, status: 'filled', side: 'sell', cause, isPaper: false, chainId: pos.chainId,
      walletId: wallet.id, walletName: wallet.name, traderHandle: pos.traderHandle, followId: pos.followId || null, traderWallet: pos.traderWallet || null,
      symbol: pos.symbol, tokenAddress: pos.tokenAddress, amountUsd: netProceedsUsd, tokens: tokensSold, fillPriceUsd: tokensSold > 0 ? receivedUsd / tokensSold : null,
      traderPriceUsd: null, chaseGapPct: null, platformFeeUsd: 0, networkFeeUsd, gasless: false,
      pnlUsd: Number(pnlUsd.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)), reason: null, txHash, explorerUrl: txHash ? `https://solscan.io/tx/${txHash}` : null, timestamp: at,
    };
    this.history.unshift(receipt);
    this.history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    this.realizedLog.push({
      t: at, pnl: receipt.pnlUsd, paper: false, sym: pos.symbol, cost: Number(costBasisSoldUsd.toFixed(4)), sol: px > 0 ? Number((receipt.pnlUsd / px).toFixed(6)) : null,
      pid: pos.id, closes: true, posPnl: Number(Number(pos.realizedPnlUsd || 0).toFixed(2)), fid: pos.followId || null, wallet: pos.traderWallet || null,
      held: Math.max(0, Math.round((at - pos.openedAt) / 1000)), slipIn: Number.isFinite(pos.entrySlipPct) ? pos.entrySlipPct : null, slipOut: null, lag: Number.isFinite(pos.detectLagSec) ? pos.detectLagSec : null,
    });
    this.realizedLog.sort((a, b) => a.t - b.t);
    this.evaluateRiskLimitsOnClose(pos, pnlUsd);
    this.alerts.unshift({ id: `alt-${randomUUID().slice(0, 8)}`, level: pnlUsd >= 0 ? 'success' : 'warning', title: `Recovered sell · $${pos.symbol}`, message: `This position was already sold on-chain for $${netProceedsUsd.toFixed(2)} (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}). The record is now fixed.`, timestamp: Date.now() });
    this.emit('position_sold', { position: pos, receipt });
    return receipt;
  }

  /**
   * Correct the result of a real position closed by "Close record" (the bookkeeping only — nothing
   * on-chain changes): the position, its history receipt and its PnL-log entry move together.
   */
  reviseRecordedClose(posId, newPnlUsd) {
    const pos = this.positions.find((p) => p.id === posId);
    if (!pos || pos.isPaper !== false || pos.remainingTokens > 0) return null;
    const delta = Number((newPnlUsd - (Number(pos.realizedPnlUsd) || 0)).toFixed(4));
    if (Math.abs(delta) < 0.005) return { delta: 0 };
    const px = Number(CHAINS.solana?.nativePriceUsd) || 0;
    pos.realizedPnlUsd = Number((Number(pos.realizedPnlUsd || 0) + delta).toFixed(4));
    pos.soldUsd = Number(Math.max(0, Number(pos.soldUsd || 0) + delta).toFixed(4));
    if (pos.soldSol != null && px > 0) pos.soldSol = Number(Math.max(0, pos.soldSol + delta / px).toFixed(6));
    const entry = [...this.realizedLog].reverse().find((e) => e.pid === pos.id && e.closes);
    if (entry) {
      entry.pnl = Number((entry.pnl + delta).toFixed(2));
      entry.posPnl = Number(Number(pos.realizedPnlUsd).toFixed(2));
      if (px > 0) entry.sol = Number((entry.pnl / px).toFixed(6));
    }
    const receipt = this.history.find((h) => h.side === 'sell' && h.isPaper === false && h.tokenAddress === pos.tokenAddress && Math.abs((h.timestamp || 0) - (pos.closedAt || 0)) < 2000);
    if (receipt) {
      receipt.amountUsd = Number(Math.max(0, receipt.amountUsd + delta).toFixed(4));
      receipt.pnlUsd = Number((receipt.pnlUsd + delta).toFixed(2));
    }
    this.emit('position_sold', { position: pos, receipt });
    return { delta };
  }

  /** A real sell that did not go through: alert (once a minute per position), nothing booked. */
  realSellFailed(pos, error, execResult = null) {
    const now = Date.now();
    // tokens gone from the bot wallet (sold or moved outside the bot): after 3 checks in a row,
    // stop retrying and tell the user once
    if (execResult?.noTokens) {
      pos.realMissingChecks = (pos.realMissingChecks || 0) + 1;
      if (pos.realMissingChecks >= 3 && !pos.realTokensMissing) {
        pos.realTokensMissing = true;
        pos.realMissingAt = now;
        this.alerts.unshift({
          id: `alt-${randomUUID().slice(0, 8)}`,
          level: 'danger',
          title: `$${pos.symbol}: tokens are no longer in the bot wallet`,
          message: 'They were sold or moved outside Odex Mirror. Automatic exits for this position are paused.',
          timestamp: now,
        });
        this.emit('alerts_updated', {});
      }
      return { ok: false, error, realFailed: true };
    }
    pos.realMissingChecks = 0;
    if (!execResult?.backoff) pos.realSellFails = (pos.realSellFails || 0) + 1;
    if (!execResult?.backoff && (!pos.lastSellBlockedAlertAt || now - pos.lastSellBlockedAlertAt > 60_000 || execResult?.unknown)) {
      pos.lastSellBlockedAlertAt = now;
      this.alerts.unshift({
        id: `alt-${randomUUID().slice(0, 8)}`,
        level: 'danger',
        title: execResult?.unknown ? `REAL sell result unknown — check wallet ($${pos.symbol})` : `Real sell not executed ($${pos.symbol})`,
        message: `${error}. The position stays open and the exit will be retried.`,
        timestamp: now,
      });
      this.emit('alerts_updated', {});
    }
    return { ok: false, error, realFailed: true };
  }

  /**
   * Paper buys only: the price a copy is quoted at is never below the trader's own fill, nor
   * below our own paper buy of the same token in the last 30 s.
   */
  paperBuyPriceFloor(chainId, token) {
    const own = this.recentOwnBuys?.get(`${chainId}:${token.address}`);
    const ownPx = own && Date.now() - own.at < 30_000 ? Number(own.priceUsd) || 0 : 0;
    const floor = Math.max(Number(token.traderFillPriceUsd) || 0, ownPx);
    const market = Number(token.currentPriceUsd) || 0;
    return floor > market ? { ...token, currentPriceUsd: floor } : token;
  }

  /** Fees selling this position now would cost: platform fee (1%, min $0.30) + network fee. */
  estimateExitFeesUsd(p, valueUsd) {
    if (!(valueUsd > 0)) return 0;
    const gasFn = typeof this.adapter.estimateNetworkFeeUsd === 'function' ? (g) => this.adapter.estimateNetworkFeeUsd(p.chainId, this.settings.priorityFee, g) : () => 0;
    if (p.chainId === 'solana') {
      const pct = solanaTradeFeePct({ address: p.tokenAddress, stage: p.stage, launchpad: p.launchpad, marketCapUsd: p.currentMarketCapUsd, createdAt: p.tokenCreatedAt, venue: p.venue }).totalPct;
      return valueUsd * (pct / 100) + gasFn(false);
    }
    const gasless = p.chainId !== 'arc' && p.tradingAssetUsed === 'stable';
    return Math.max(0.3, valueUsd * 0.01) + gasFn(gasless);
  }

  getStateSnapshot() {
    this.getDefaultWallet(); // older saves: mark the first wallet as the default
    const openPositions = this.positions.filter((p) => p.remainingTokens > 0);
    let totalOpenValueUsd = 0;
    let totalOpenCostUsd = 0;
    let totalExitFeesUsd = 0;

    const enrichedPositions = openPositions.map((p) => {
      const valueUsd = p.remainingTokens * p.currentPriceUsd;
      // open PnL = what selling now would return (after the sell fee and gas), minus cost
      const exitFeesUsd = this.estimateExitFeesUsd(p, valueUsd);
      totalExitFeesUsd += exitFeesUsd;
      const unrealizedPnlUsd = valueUsd - exitFeesUsd - p.remainingCostUsd;
      const unrealizedPnlPct = p.remainingCostUsd > 0 ? (unrealizedPnlUsd / p.remainingCostUsd) * 100 : 0;
      totalOpenValueUsd += valueUsd;
      totalOpenCostUsd += p.remainingCostUsd;
      return {
        ...p,
        valueUsd: Number(valueUsd.toFixed(2)),
        exitFeesUsd: Number(exitFeesUsd.toFixed(2)),
        unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
        unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(2)),
        ageSec: Math.max(0, Math.floor((Date.now() - p.openedAt) / 1000)),
      };
    });

    // Closed trades: what was bought, what came back, the result
    const closedPositions = this.positions
      .filter((p) => p.remainingTokens <= 0)
      .map((p) => {
        const boughtUsd = Number(p.initialCostUsd || 0);
        // older records have no soldUsd: proceeds = cost + realized PnL (exact, same maths)
        const soldUsd = p.soldUsd != null ? Number(p.soldUsd) : boughtUsd + Number(p.realizedPnlUsd || 0);
        const pnlUsd = soldUsd - boughtUsd;
        const lastSell = this.history.find((h) => h.side === 'sell' && h.status === 'filled' && h.tokenAddress === p.tokenAddress && h.timestamp >= p.openedAt);
        return {
          id: p.id,
          followId: p.followId,
          traderHandle: p.traderHandle,
          traderWallet: p.traderWallet || null,
          chainId: p.chainId,
          isPaper: p.isPaper,
          tokenAddress: p.tokenAddress,
          symbol: p.symbol,
          name: p.name,
          imageUrl: p.imageUrl || null,
          boughtUsd: Number(boughtUsd.toFixed(2)),
          boughtTokens: Number(p.initialTokens || 0),
          soldUsd: Number(soldUsd.toFixed(2)),
          soldTokens: Number(p.soldTokens != null ? p.soldTokens : p.initialTokens || 0),
          pnlUsd: Number(pnlUsd.toFixed(2)),
          pnlPct: boughtUsd > 0 ? Number(((pnlUsd / boughtUsd) * 100).toFixed(2)) : 0,
          openedAt: p.openedAt,
          closedAt: p.closedAt || p.lastSellAt || lastSell?.timestamp || null,
          closeCause: p.closeCause || lastSell?.cause || null,
          entryMarketCapUsd: p.entryMarketCapUsd,
          ...closedSol(p, boughtUsd, soldUsd),
        };
      })
      .sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt))
      .slice(0, 300);

    const totalUnrealizedPnlUsd = totalOpenValueUsd - totalExitFeesUsd - totalOpenCostUsd;
    const totalUnrealizedPnlPct =
      totalOpenCostUsd > 0 ? (totalUnrealizedPnlUsd / totalOpenCostUsd) * 100 : 0;

    return {
      chains: CHAINS,
      wallets: this.wallets,
      activeWalletId: this.getActiveWallet()?.id,
      // integration secrets (Telegram bot token, Discord webhook) never leave the server
      settings: publicSettings(this.settings),
      follows: this.follows,
      traderScores: Object.fromEntries(this.follows.map((f) => [f.id, { ...this.traderScorecard(f.id), sinceResume: f.scoreSince ? this.traderScorecard(f.id, { since: f.scoreSince }) : null }])),
      positions: enrichedPositions,
      closedPositions,
      positionsSummary: {
        openCount: enrichedPositions.length,
        totalValueUsd: Number(totalOpenValueUsd.toFixed(2)),
        totalCostUsd: Number(totalOpenCostUsd.toFixed(2)),
        unrealizedPnlUsd: Number(totalUnrealizedPnlUsd.toFixed(2)),
        unrealizedPnlPct: Number(totalUnrealizedPnlPct.toFixed(2)),
      },
      history: this.history.slice(0, 100),
      alerts: this.alerts.slice(0, 30),
    };
  }
}
