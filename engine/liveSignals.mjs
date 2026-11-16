/**
 * Live Signals service — SIGNALS ONLY by default.
 *
 * Keeps the wallet watcher's watch list in sync with your Solana follows (plus any wallets
 * you add manually), and for every real swap it detects:
 *   1. asks the engine, in dry-run mode, "would my settings copy this?" (nothing executes)
 *   2. stores the signal + decision for the terminal's Live Signals tab
 *   3. optionally (paperCopy ON + Paper Trading ON) feeds it to the PAPER engine,
 *      so paper positions use real tokens and live DexScreener prices.
 * It never sends a real transaction.
 */
import { SolanaWalletWatcher, TokenInfoService, isSolanaAddress, DEFAULT_SOLANA_RPC } from './walletWatcher.mjs';
import { redact } from './env.mjs';

const MAX_SIGNALS = 200;

export function pickCurrentPrice(sig) {
  const fill = Number(sig.txPriceUsd) || null;
  const market = Number(sig.currentPriceUsd) || null;
  if (sig.side === 'sell') return fill || market;
  if (!market) return fill;
  if (!fill) return market;
  const r = market / fill;
  return r <= 3 && r >= 1 / 3 ? market : fill;
}

/** Sodae RPC URL → its WebSocket URL (http→ws, https→wss; port 8899 → 8900, the validator convention). */
export function sodaeWsFrom(httpUrl) {
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (u.port === '8899') u.port = '8900';
    return u.toString();
  } catch {
    return null;
  }
}

export class LiveSignalService {
  constructor({ engine, watcher = null, broadcast = () => {}, env = process.env, alchemy = null } = {}) {
    this.engine = engine;
    this.broadcast = broadcast;
    this.alchemy = alchemy;
    this.signals = [];
    // RPC priority: SOLANA_RPC_URL env → Alchemy (if ALCHEMY_API_KEY set) → public mainnet RPC
    const defaultRpc = env.SOLANA_RPC_URL || alchemy?.solanaRpcUrl() || DEFAULT_SOLANA_RPC;
    this.config = {
      enabled: env.ODEX_LIVE_WATCH !== '0',
      rpcUrl: defaultRpc,
      pollSec: Number(env.ODEX_WATCH_POLL_SEC || 1), // backup check every second (the live stream is instant)
      // Copy followed wallets automatically (paper). Turn off to only watch signals.
      paperCopy: true,
      // Real-time push (WebSocket) on top of polling: trades arrive ~1 s after they land
      realtime: env.ODEX_STREAM !== '0',
      manual: [], // [{ address, label }]
    };
    const heliusKey = String(env.HELIUS_API_KEY || '').trim() || null;
    const sodaeUrl = String(env.SODAE_RPC_URL || '').trim() || null;
    const sodaeKey = sodaeUrl ? new URL(sodaeUrl).searchParams.get('api-key') || null : null;
    // Sodae's WebSocket is not at the validator-convention address (checked: port 8900 does not
    // answer, 8899 refuses WebSockets), so it is only used when SODAE_WS_URL is set explicitly
    const sodaeWs = String(env.SODAE_WS_URL || '').trim() || null;
    const grpcUrl = String(env.SODAE_GRPC_URL || env.YELLOWSTONE_GRPC_URL || '').trim() || null;
    const grpcKey = grpcUrl ? (() => { try { return new URL(grpcUrl).searchParams.get('api-key'); } catch { return null; } })() : null;
    this.watcher =
      watcher ||
      new SolanaWalletWatcher({
        rpcUrl: this.config.rpcUrl,
        pollIntervalMs: this.config.pollSec * 1000,
        tokenInfo: new TokenInfoService({ metadata: alchemy }),
        stream: this.config.realtime,
        // Helius: live push of trades and balances (it supports logsSubscribe and accountSubscribe,
        // so spam-flooded wallets are watched on the same fast connection). Normal requests stay on
        // the RPC above (Alchemy's free tier allows more requests per second).
        ...(heliusKey
          ? {
              streamUrl: `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
              tokenStreamUrl: `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
              balanceWsUrl: env.SOLANA_BALANCE_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
              fastRpcUrls: [`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`],
            }
          : {}),
        // Sodae WebSocket (SODAE_WS_URL): a second live feed racing Helius
        ...(sodaeWs ? { extraStreamUrl: sodaeWs, extraStreamName: 'Sodae' } : {}),
        // Yellowstone gRPC (SODAE_GRPC_URL or YELLOWSTONE_GRPC_URL): the fastest feed
        ...(grpcUrl ? { grpcUrl } : {}),
        redactUrl: (x) => redact(redact(redact(redact(x, alchemy?.apiKey), heliusKey), sodaeKey), grpcKey),
      });
    this.heliusKey = heliusKey;
    this.watcher.onSignal = (s) => this.handleSignal(s);
    this.watcher.onStatus = () => this.pushStatus();
    this.watcher.onTokenInfoLate = (mint, info) => this.applyLateTokenInfo(mint, info);
    // In Auto-Exit mode every trader sell closes 100% of our copy, so skip the getMultipleAccounts sell-share RPC wait
    this.watcher.skipSellShare = (addr) => {
      const fs = this.engine.follows.filter((f) => f.chainId === 'solana' && f.traderWallet === addr && f.status === 'copying');
      return fs.length > 0 && fs.every((f) => f.mode === 'auto-exit');
    };
    // fast trade detection: a copied trade whose trader trade never confirmed is closed
    this.watcher.onPhantomTrade = (p) => {
      const s = this.signals.find((x) => x.signature === p.signature);
      if (s) s.phantom = p.reason;
      return this.engine?.handlePhantomTrade?.(p);
    };
    this.lastStatusPush = 0;
    this.statusTimer = null;
  }

  /**
   * Token details that arrived after a trade was already copied (see tokenInfoBudgetMs): fill in
   * the name, symbol, logo and market data on the signal, positions and history.
   */
  applyLateTokenInfo(mint, info) {
    const placeholder = `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    for (const s of this.signals) {
      if (s.tokenMint !== mint) continue;
      if (info.symbol && s.symbol === placeholder) s.symbol = info.symbol;
      if (info.name && !s.name) s.name = info.name;
      if (info.imageUrl && !s.imageUrl) s.imageUrl = info.imageUrl;
      for (const k of ['marketCapUsd', 'liquidityUsd', 'dexId', 'pairCreatedAt', 'pairUrl']) if (info[k] != null && s[k] == null) s[k] = info[k];
      if (info.authorityKnown && !s.authorityKnown) Object.assign(s, { authorityKnown: true, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null });
    }
    let changed = false;
    for (const p of this.engine.positions || []) {
      if (p.tokenAddress !== mint) continue;
      if (info.symbol && p.symbol === placeholder) (p.symbol = info.symbol), (changed = true);
      if (info.name && (!p.name || p.name === placeholder)) (p.name = info.name), (changed = true);
      if (info.imageUrl && !p.imageUrl) (p.imageUrl = info.imageUrl), (changed = true);
      if (info.pairCreatedAt && !p.tokenCreatedAt) (p.tokenCreatedAt = info.pairCreatedAt), (changed = true);
    }
    for (const h of this.engine.history || []) if (h.tokenAddress === mint && info.symbol && h.symbol === placeholder) (h.symbol = info.symbol), (changed = true);
    if (changed) this.engine.emit?.('token_info', { mint });
    this.pushStatus(true);
  }

  /** Wallets to watch: Solana follows + manual entries, de-duplicated. */
  watchList() {
    const map = new Map();
    for (const f of this.engine.follows) {
      if (f.chainId !== 'solana' || !isSolanaAddress(f.traderWallet)) continue;
      if (!map.has(f.traderWallet)) map.set(f.traderWallet, { address: f.traderWallet, label: `@${f.handle}`, source: 'follow' });
    }
    for (const m of this.config.manual) {
      if (!map.has(m.address)) map.set(m.address, { address: m.address, label: m.label || null, source: 'manual' });
    }
    return [...map.values()];
  }

  sync() {
    this.watcher.setWallets(this.watchList());
    const shouldRun = this.config.enabled && this.watcher.wallets.size > 0;
    if (shouldRun && !this.watcher.running) this.watcher.start();
    if (!shouldRun && this.watcher.running) this.watcher.stop();
    this.pushStatus(true);
  }

  isActive() {
    return this.config.enabled && this.watcher.running && this.watcher.wallets.size > 0;
  }

  updateConfig(patch = {}) {
    if (patch.enabled !== undefined) this.config.enabled = Boolean(patch.enabled);
    if (patch.paperCopy !== undefined) {
      this.config.paperCopy = Boolean(patch.paperCopy);
      this.config.paperCopyChosen = true;
    }
    if (patch.realtime !== undefined) {
      this.config.realtime = Boolean(patch.realtime);
      this.watcher.setStreamEnabled(this.config.realtime);
    }
    if (patch.pollSec !== undefined) {
      this.config.pollSec = Math.min(300, Math.max(1, Number(patch.pollSec) || 1));
      this.watcher.setPollInterval(this.config.pollSec * 1000);
    }
    if (patch.rpcUrl !== undefined) {
      let url = String(patch.rpcUrl || '').trim();
      // The browser only ever sees a masked URL; saving it unchanged keeps the current one
      if (url.includes('…') || url === this.maskedRpcUrl()) return this.sync();
      if (!url || url.toLowerCase() === 'alchemy') url = this.alchemy?.solanaRpcUrl() || DEFAULT_SOLANA_RPC;
      if (!/^https?:\/\//i.test(url)) throw new Error('RPC URL must start with http:// or https://');
      this.config.rpcUrl = url;
      this.watcher.setRpcUrl(url);
    }
    this.sync();
  }

  addManual(address, label) {
    const addr = String(address || '').trim();
    if (!isSolanaAddress(addr)) throw new Error('Enter a valid Solana wallet address (32–44 base58 characters).');
    if (!this.config.manual.some((m) => m.address === addr)) {
      this.config.manual.push({ address: addr, label: String(label || '').trim().slice(0, 32) || null });
    }
    this.sync();
  }

  removeManual(address) {
    this.config.manual = this.config.manual.filter((m) => m.address !== address);
    this.sync();
  }

  purgeFake() {
    const before = this.signals.length;
    this.signals = this.signals.filter((x) => Number(x?.usdValue) >= 1 && !(x.source === 'balances' && String(x.signature || '').startsWith('bal-')));
    this.pushStatus(true);
    return before - this.signals.length;
  }

  clear() {
    this.signals = [];
    this.pushStatus(true);
  }

  /** Map a watcher signal to the engine's signal shape for one follow. */
  toEngineSignal(sig, follow) {
    // pump.fun / PumpSwap: read from the trader's own transaction first (works for brand-new coins
    // DexScreener doesn't list yet, and for pump.fun coins whose address doesn't end in "pump")
    const isLaunchpad = sig.venue === 'pumpfun' || sig.venue === 'pumpswap' || sig.venue === 'launchlab' || sig.dexId === 'pumpfun' || sig.dexId === 'pumpswap' || sig.dexId === 'launchlab' || /pump$/i.test(sig.tokenMint);
    return {
      chainId: 'solana',
      side: sig.side,
      sellSharePct: sig.side === 'sell' ? (Number(sig.sellSharePct) > 0 ? Number(sig.sellSharePct) : 100) : undefined,
      // a buy: how much of this coin the trader already held (> 0 = a top-up of an earlier buy)
      traderHeldBefore: sig.side === 'buy' && Number.isFinite(Number(sig.heldBefore)) && sig.heldBefore !== null ? Number(sig.heldBefore) : undefined,
      traderTokens: Number(sig.tokenAmount) || undefined,
      traderHandle: follow ? follow.handle : sig.label || sig.wallet,
      traderWallet: sig.wallet,
      signature: sig.signature,
      ageSec: sig.blockTime ? Math.max(0, (Date.now() - sig.blockTime) / 1000) : undefined,
      traderBuyUsd: sig.usdValue,
      traderBuyNative: sig.quoteSymbol === 'SOL' ? sig.quoteAmount : undefined,
      // SOL that really reached the pool (no fees/tips): used for the curve maths
      traderPoolSol: sig.quoteSymbol === 'SOL' && sig.poolQuoteAmount > 0 ? sig.poolQuoteAmount : undefined,
      live: true,
      token: {
        address: sig.tokenMint,
        decimals: Number.isInteger(sig.tokenDecimals) ? sig.tokenDecimals : undefined,
        symbol: sig.symbol,
        name: sig.name || sig.symbol,
        isLaunchpad,
        // a pump.fun coin DexScreener doesn't list yet is still on its bonding curve
        stage: sig.venue === 'pumpfun' || sig.venue === 'launchlab' ? 'pre-grad' : sig.venue === 'pumpswap' ? 'graduated' : sig.dexId === 'pumpfun' || sig.dexId === 'launchlab' || (!sig.dexId && /pump$/i.test(sig.tokenMint)) ? 'pre-grad' : 'graduated',
        marketCapUsd: sig.marketCapUsd,
        liquidityUsd: sig.liquidityUsd,
        traderFillPriceUsd: sig.txPriceUsd,
        // Market price for the chase check, unless it disagrees wildly with the trader's real
        // fill (data feeds misprice some new launches). Sells fill at the trader's own price.
        currentPriceUsd: pickCurrentPrice(sig),
        imageUrl: sig.imageUrl || null,
        createdAt: sig.pairCreatedAt || null,
        venue: sig.venue || null,
        curve: sig.curve || null,
        // Freeze / mint authority come from Alchemy token metadata when available
        safety: sig.authorityKnown
          ? { safetyVerified: true, freezeAuthority: Boolean(sig.freezeAuthority), mintAuthority: Boolean(sig.mintAuthority) }
          : { safetyVerified: true },
      },
    };
  }

  async decide(sig) {
    const follows = this.engine.follows.filter((f) => f.chainId === 'solana' && f.traderWallet === sig.wallet);
    if (!follows.length) return [{ followId: null, handle: sig.label, status: 'watch_only', reason: 'watched manually, not followed' }];
    const out = [];
    for (const f of follows) {
      const es = this.toEngineSignal(sig, f);
      try {
        const r =
          sig.side === 'buy'
            ? await this.engine.handleLeaderBuySignal(f, es, { dryRun: true })
            : await this.engine.handleLeaderSellSignal(f, es, { dryRun: true });
        out.push({
          followId: f.id,
          handle: f.handle,
          followStatus: f.status,
          status: r.status,
          reason: r.reason || null,
          sizeUsd: r.sizeUsd ?? null,
          chaseGapPct: r.chaseGapPct ?? null,
        });
      } catch (err) {
        out.push({ followId: f.id, handle: f.handle, status: 'error', reason: err.message });
      }
    }
    return out;
  }

  async handleSignal(sig) {
    // a signal is only added to the list after it has been copied (seconds later), so also
    // remember the ones being handled right now: the same trade must never be copied twice
    if (!this.handling) this.handling = new Set();
    if (this.handling.has(sig.signature) || this.signals.some((s) => s.signature === sig.signature)) return;
    this.handling.add(sig.signature);
    try {
      return await this.handleSignalNow(sig);
    } finally {
      this.handling.delete(sig.signature);
    }
  }

  async handleSignalNow(sig) {
    // dust (under $1) is never a real copy-worthy trade; keep it out of the feed
    if (!(Number(sig.usdValue) >= 1)) {
      (this.dustSigs || (this.dustSigs = new Set())).add(sig.signature); // remembered for the missed-trade audit
      return;
    }
    // a coin bought before its name/logo were known shows as "B1Y2…pump": fill those in as soon as
    // any later trade of it carries the details
    const placeholder = sig.tokenMint ? `${sig.tokenMint.slice(0, 4)}…${sig.tokenMint.slice(-4)}` : null;
    if (placeholder && sig.symbol && sig.symbol !== placeholder) {
      try {
        this.applyLateTokenInfo(sig.tokenMint, { symbol: sig.symbol, name: sig.name, imageUrl: sig.imageUrl, pairCreatedAt: sig.pairCreatedAt });
      } catch {
        // cosmetic only
      }
    }
    // Copies run on paper (Paper Trading ON) or for real (Paper Trading OFF + bot wallet key set)
    const copying = this.engine.settings.paperTrading || (typeof this.engine.realTradingActive === 'function' && this.engine.realTradingActive());
    const follows = this.engine.follows.filter((f) => f.chainId === 'solana' && f.traderWallet === sig.wallet);
    const willCopy = Boolean(this.config.paperCopy && copying && !sig.backfill && follows.length);
    // Copy speed: the dry-run "would copy / skip" preview is only shown when nothing is copied.
    // When a copy runs it would cost a whole extra Jupiter quote BEFORE the real buy, so it is
    // skipped and the feed shows the real copy result instead.
    const record = { ...sig, decisions: willCopy ? [] : await this.decide(sig), paperCopied: false };

    // Every live fill from a watched wallet is a real price for that token
    if (!sig.backfill && typeof this.engine.observeTradePrice === 'function') {
      this.engine.observeTradePrice(sig.tokenMint, sig.txPriceUsd, sig.blockTime || Date.now(), sig.curve || null);
    }
    // Log the trader's trade before running the swap so any 2nd buy arriving while the 1st swap is
    // still in flight already knows the trader entered this coin earlier.
    if (!sig.backfill && typeof this.engine.logTraderTrade === 'function') {
      try {
        this.engine.logTraderTrade(sig, []);
      } catch {
        // reporting only
      }
    }

    if (willCopy) {
      // Each follow is matched by WALLET only and copies with its own settings
      record.copies = [];
      for (const f of follows) {
        const es = this.toEngineSignal(sig, f);
        let r;
        try {
          r = sig.side === 'buy' ? await this.engine.handleLeaderBuySignal(f, es) : await this.engine.handleLeaderSellSignal(f, es);
        } catch (err) {
          r = { status: 'error', reason: err.message };
        }
        const ok = r?.status === 'filled' || r?.ok === true;
        // copy speed, measured: signal ready → copy finished (includes the swap for real copies)
        const handledMs = sig.detectedAt ? Date.now() - sig.detectedAt : null;
        record.copies.push({ followId: f.id, handle: f.handle, ok, status: r?.status || null, reason: r?.reason || null, handledMs });
        record.decisions.push({ followId: f.id, handle: f.handle, followStatus: f.status, status: ok ? 'copied' : r?.status || null, reason: r?.reason || null, sizeUsd: null, chaseGapPct: r?.chaseGapPct ?? null });
      }
      record.paperCopied = record.copies.some((c) => c.ok);
    }

    // Event-driven 0ms auto-exit check: if any existing open position in this token crossed TP/SL/Trail on this live trade, evaluate immediately
    if (!sig.backfill && sig.tokenMint && typeof this.engine.evaluatePositionExits === 'function') {
      const now = Date.now();
      for (const pos of this.engine.positions || []) {
        if (pos.tokenAddress === sig.tokenMint && pos.remainingTokens > 0 && now - (pos.openedAt || 0) >= 500) {
          await this.engine.evaluatePositionExits(pos, now).catch(() => {});
        }
      }
    }

    // Dax's trader log: what the trader did and what each follow did about it
    if (!sig.backfill && typeof this.engine.logTraderTrade === 'function') {
      try {
        const outcomes = record.copies
          ? record.copies.map((c) => ({ followId: c.followId, ok: c.ok, reason: c.reason || (c.ok ? null : c.status) }))
          : (record.decisions || []).filter((d) => d.followId).map((d) => ({ followId: d.followId, ok: d.status === 'would_copy', dry: true, reason: d.reason || null }));
        this.engine.logTraderTrade(sig, outcomes);
      } catch {
        // reporting only: never disturb copying
      }
    }

    this.signals.unshift(record);
    if (this.signals.length > MAX_SIGNALS) this.signals.length = MAX_SIGNALS;
    this.broadcast({ event: 'live_signal', data: record, liveWatch: this.snapshot(false) });
  }

  pushStatus(force = false) {
    const now = Date.now();
    if (!force && now - this.lastStatusPush < 1000) {
      if (!this.statusTimer) {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          this.pushStatus(true);
        }, 1000);
      }
      return;
    }
    this.lastStatusPush = now;
    this.broadcast({ event: 'watcher_status', liveWatch: this.snapshot(false) });
  }

  maskedRpcUrl() {
    return this.alchemy ? this.alchemy.maskUrl(this.config.rpcUrl) : this.config.rpcUrl;
  }

  rpcProvider() {
    const u = this.config.rpcUrl || '';
    if (this.alchemy?.enabled && u.includes(this.alchemy.apiKey)) return 'alchemy';
    if (u === DEFAULT_SOLANA_RPC) return 'public';
    return 'custom';
  }

  snapshot(includeSignals = true) {
    const status = this.watcher.getStatus();
    const key = this.alchemy?.apiKey;
    return {
      mode: 'signals-only',
      config: { ...this.config, rpcUrl: this.maskedRpcUrl(), rpcProvider: this.rpcProvider(), manual: [...this.config.manual] },
      status: { ...status, rpcUrl: redact(redact(status.rpcUrl, key), this.heliusKey), lastError: status.lastError ? redact(redact(status.lastError, key), this.heliusKey) : null },
      helius: { configured: Boolean(this.heliusKey) },
      alchemy: this.alchemy ? this.alchemy.status() : { configured: false },
      watchList: this.watchList(),
      ...(includeSignals ? { signals: this.signals } : {}),
    };
  }
}
