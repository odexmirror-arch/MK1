/**
 * Persists the copy engine and Live Signals state to the database so nothing is lost
 * when the server restarts. Saves are debounced: quickly after real changes (trades,
 * follows, settings), less often for routine price ticks, and once more on shutdown.
 * Secrets (API keys inside RPC URLs) are never written.
 */
import { followTraderExitRules } from './copyEngine.mjs';

const HISTORY_CAP = 2000;
const ALERTS_CAP = 200;
const SIGNALS_CAP = 200;
const NESTED_SETTINGS = ['buySlippagePct', 'priorityFee', 'cooldown', 'filters', 'safety', 'risk', 'security', 'tradingAsset', 'externalWallets', 'ui'];

export function serializeEngine(engine) {
  return {
    version: 1,
    savedAt: Date.now(),
    wallets: engine.wallets,
    follows: engine.follows,
    positions: engine.positions,
    history: engine.history.slice(0, HISTORY_CAP),
    realizedLog: (engine.realizedLog || []).slice(-20000),
    alerts: engine.alerts.slice(0, ALERTS_CAP),
    settings: engine.settings,
    buyCooldown: [...engine.buyCooldownMap.entries()],
    copiedCycles: engine.copiedCycles || {},
    traderLog: (engine.traderLog || []).slice(-6000), // Dax: trader buys/sells + copy outcome (7 days)
  };
}

export function restoreEngine(engine, data) {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.wallets) && data.wallets.length) engine.wallets = data.wallets;
  if (Array.isArray(data.follows)) {
    engine.follows = data.follows;
    for (const f of engine.follows) {
      if ((f.id === 'fol-03782071' || f.traderWallet === '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9') && !f.decuV3Migrated) {
        f.mode = 'auto-exit';
        f.mirrorSells = true;
        f.exitRules = followTraderExitRules();
        f.copyTopUps = false;
        f.reentryCooldownMin = 10;
        f.maxChasePct = 45;
        f.filtersOverride = { ...(f.filtersOverride || {}), minTraderBuyNative: 0.5 };
        f.decuV2Migrated = true;
        f.decuV3Migrated = true;
      }
      if ((f.id === 'fol-03782071' || f.traderWallet === '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9') && !f.decuV4Migrated) {
        f.mode = 'auto-exit';
        f.mirrorSells = true;
        const baseRules = followTraderExitRules();
        f.exitRules = {
          ...baseRules,
          takeInitials: { ...baseRules.takeInitials, enabled: true, takeAtPct: 10, sellSizePct: 100 },
          floor: { ...baseRules.floor, enabled: true, openingFloorPct: 20, tightensAfterSec: 3600, tightFloorPct: 20 },
        };
        f.copyTopUps = false;
        f.reentryCooldownMin = 10;
        f.maxChasePct = 20;
        f.filtersOverride = { ...(f.filtersOverride || {}), minTraderBuyNative: 0.5 };
        f.decuV4Migrated = true;
      }
    }
  }
  if (Array.isArray(data.positions)) engine.positions = data.positions;
  if (Array.isArray(data.history)) engine.history = data.history;
  if (Array.isArray(data.realizedLog)) engine.realizedLog = data.realizedLog;
  else if (Array.isArray(data.history)) {
    // older saves: build the PnL calendar from the sells still in History
    engine.realizedLog = data.history
      .filter((h) => h.side === 'sell' && h.status === 'filled' && Number.isFinite(h.pnlUsd))
      .map((h) => ({ t: h.timestamp, pnl: h.pnlUsd, paper: Boolean(h.isPaper), sym: h.symbol }))
      .sort((a, b) => a.t - b.t);
  }
  if (Array.isArray(data.alerts)) engine.alerts = data.alerts;
  if (data.copiedCycles && typeof data.copiedCycles === 'object') engine.copiedCycles = { ...data.copiedCycles };
  if (Array.isArray(data.traderLog)) engine.traderLog = data.traderLog;
  if (data.settings && typeof data.settings === 'object') {
    // Merge so settings added in newer versions keep their defaults
    const merged = { ...engine.settings, ...data.settings };
    for (const k of NESTED_SETTINGS) {
      if (engine.settings[k] && typeof engine.settings[k] === 'object' && data.settings[k] && typeof data.settings[k] === 'object') {
        merged[k] = { ...engine.settings[k], ...data.settings[k] };
      }
    }
    // real-copy age limit: the first version saved 20 s as its default; the limit is now 10 s
    if (merged.maxRealSignalAgeSec === 20) merged.maxRealSignalAgeSec = 10;
    const hasDecu = engine.follows.some((f) => f.id === 'fol-03782071' || f.traderWallet === '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9');
    if (hasDecu && !merged.decuV4SettingsMigrated) {
      merged.maxChasePct = 20;
      merged.risk = { ...(merged.risk || {}), streakLimit: 3 };
      const mainWallet = engine.wallets.find((w) => w.id === 'w-main') || engine.wallets[0];
      if (mainWallet && Number(mainWallet.paperBalanceUsd) < 30) {
        mainWallet.paperBalanceUsd = 400;
      }
      merged.decuV4SettingsMigrated = true;
    }
    engine.settings = merged;
  }
  if (Array.isArray(data.buyCooldown)) engine.buyCooldownMap = new Map(data.buyCooldown);
  engine.backfillScorecardLog?.();
  return {
    follows: engine.follows.length,
    openPositions: engine.positions.filter((p) => p.remainingTokens > 0).length,
    history: engine.history.length,
    savedAt: data.savedAt || null,
  };
}

export function serializeLive(live) {
  const rpcProvider = live.rpcProvider();
  return {
    version: 1,
    savedAt: Date.now(),
    signals: live.signals.slice(0, SIGNALS_CAP),
    config: {
      enabled: live.config.enabled,
      pollSec: live.config.pollSec,
      pollV: 2, // pollSec saved after the 1-second default existed
      paperCopy: live.config.paperCopy,
      paperCopyChosen: Boolean(live.config.paperCopyChosen),
      realtime: live.config.realtime !== false,
      manual: live.config.manual,
      rpcProvider,
      // Only a custom RPC URL is stored; Alchemy's URL contains the key and is rebuilt from .env
      rpcUrl: rpcProvider === 'custom' ? live.config.rpcUrl : null,
    },
  };
}

export function restoreLive(live, data) {
  if (!data || typeof data !== 'object') return null;
  // drop fake signals saved by older versions: $0 dust and unverified balance guesses
  if (Array.isArray(data.signals)) live.signals = data.signals.filter((x) => Number(x?.usdValue) >= 1 && !(x.source === 'balances' && String(x.signature || '').startsWith('bal-')));
  const c = data.config || {};
  if (typeof c.enabled === 'boolean') live.config.enabled = c.enabled;
  // Older saves defaulted copying to OFF; only keep a value the user actually chose
  if (typeof c.paperCopy === 'boolean' && c.paperCopyChosen) {
    live.config.paperCopy = c.paperCopy;
    live.config.paperCopyChosen = true;
  }
  if (typeof c.realtime === 'boolean') {
    live.config.realtime = c.realtime;
    live.watcher.setStreamEnabled?.(c.realtime);
  }
  // saves from before the 1-second check: move them to 1 s; choices made since then are kept
  if (Number(c.pollSec) && c.pollV === 2) {
    live.config.pollSec = Math.max(1, Number(c.pollSec));
    live.watcher.setPollInterval(live.config.pollSec * 1000);
  }
  if (Array.isArray(c.manual)) live.config.manual = c.manual.filter((m) => m && typeof m.address === 'string');
  if (c.rpcProvider === 'custom' && typeof c.rpcUrl === 'string' && /^https?:\/\//.test(c.rpcUrl)) {
    live.config.rpcUrl = c.rpcUrl;
    live.watcher.setRpcUrl(c.rpcUrl);
  } else if (c.rpcProvider === 'public') {
    live.config.rpcUrl = 'https://api.mainnet-beta.solana.com';
    live.watcher.setRpcUrl(live.config.rpcUrl);
  }
  return { signals: live.signals.length, manualWatches: live.config.manual.length };
}

export class PersistenceManager {
  constructor({ engine, live = null, store, cloud = null, fastMs = 1000, slowMs = 10_000 }) {
    this.engine = engine;
    this.cloud = cloud; // optional SupabaseMirror: every save is also pushed to the cloud (coalesced)
    this.live = live;
    this.store = store;
    this.fastMs = fastMs;
    this.slowMs = slowMs;
    this.timer = null;
    this.timerDue = 0;
    this.lastSavedAt = null;
    this.lastLoadedAt = null;
    this.lastError = null;
    this.restored = null;
    this.saves = 0;
  }

  load() {
    try {
      const engineData = this.store.get('engine');
      const liveData = this.live ? this.store.get('liveSignals') : null;
      const e = restoreEngine(this.engine, engineData);
      const l = this.live ? restoreLive(this.live, liveData) : null;
      this.lastLoadedAt = Date.now();
      this.restored = e || l ? { ...(e || {}), ...(l || {}) } : null;
      return this.restored;
    } catch (err) {
      this.lastError = `Load failed: ${err.message}`;
      return null;
    }
  }

  /** Hook engine + live events so changes are saved automatically. */
  attach() {
    this.unsubscribe = this.engine.onUpdate((evt) => {
      if (evt.type !== 'market_tick') this.cloudDirty = true; // a real change (not just prices)
      this.schedule(evt.type === 'market_tick' ? this.slowMs : this.fastMs);
    });
    if (this.live) {
      const original = this.live.broadcast;
      this.live.broadcast = (msg) => {
        if (msg?.event === 'live_signal') this.cloudDirty = true;
        if (msg?.event === 'live_signal' || msg?.event === 'watcher_status') this.schedule(msg.event === 'live_signal' ? this.fastMs : this.slowMs);
        return original(msg);
      };
    }
    return this;
  }

  schedule(ms) {
    const due = Date.now() + ms;
    if (this.timer && this.timerDue <= due) return; // an earlier save is already queued
    if (this.timer) clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, ms);
    this.timer.unref?.();
  }

  saveNow() {
    try {
      const entries = [['engine', serializeEngine(this.engine)]];
      if (this.live) entries.push(['liveSignals', serializeLive(this.live)]);
      this.store.setMany(entries);
      this.lastSavedAt = Date.now();
      this.lastError = null;
      this.saves += 1;
      // Cloud backup: real changes go up within seconds; price-only updates at most once a minute
      // (each upload is the whole ~0.5 MB state)
      // cloudPaused: another copy of the bot owns the account right now — never overwrite its data
      if (this.cloud?.enabled && !this.cloudPaused && (this.cloudDirty !== false || Date.now() - (this.lastCloudAt || 0) > 60_000)) {
        this.cloud.schedule(entries);
        this.lastCloudAt = Date.now();
        this.cloudDirty = false;
      }
      // keep the SQLite journal small (every ~5 minutes)
      if (typeof this.store.checkpoint === 'function' && Date.now() - (this.lastCheckpointAt || 0) > 300_000) {
        this.lastCheckpointAt = Date.now();
        this.store.checkpoint();
      }
      return true;
    } catch (err) {
      this.lastError = `Save failed: ${err.message}`;
      return false;
    }
  }

  /** Apply rows pulled from the cloud (same shape as the local store). */
  restoreFromRows(rows) {
    const engineData = rows.get('engine');
    if (!engineData) throw new Error('No Odex Mirror data found in Supabase yet.');
    return this.importBackup({ app: 'odex-mirror', engine: engineData, liveSignals: rows.get('liveSignals') || null });
  }

  exportBackup() {
    return {
      app: 'odex-mirror',
      exportedAt: new Date().toISOString(),
      engine: serializeEngine(this.engine),
      liveSignals: this.live ? serializeLive(this.live) : null,
    };
  }

  importBackup(backup) {
    if (!backup || backup.app !== 'odex-mirror' || !backup.engine) throw new Error('Not an Odex Mirror backup file.');
    const e = restoreEngine(this.engine, backup.engine);
    const l = this.live && backup.liveSignals ? restoreLive(this.live, backup.liveSignals) : null;
    this.saveNow();
    return { ...(e || {}), ...(l || {}) };
  }

  info() {
    return {
      engine: this.store.kind,
      file: this.store.file,
      sizeBytes: this.store.sizeBytes(),
      lastSavedAt: this.lastSavedAt,
      lastLoadedAt: this.lastLoadedAt,
      restored: this.restored,
      saves: this.saves,
      lastError: this.lastError,
      keys: this.store.keys(),
      cloud: this.cloud ? this.cloud.status() : null,
      counts: {
        follows: this.engine.follows.length,
        openPositions: this.engine.positions.filter((p) => p.remainingTokens > 0).length,
        history: this.engine.history.length,
        signals: this.live ? this.live.signals.length : 0,
      },
    };
  }

  async closeAsync() {
    this.close({ keepStore: true });
    if (this.cloud?.enabled && !this.cloudPaused) await this.cloud.flush();
    this.store.close();
  }

  close({ keepStore = false } = {}) {
    if (this.timer) clearTimeout(this.timer);
    this.saveNow();
    if (keepStore) {
      this.unsubscribe?.();
      return;
    }
    this.unsubscribe?.();
    this.store.close();
  }
}
