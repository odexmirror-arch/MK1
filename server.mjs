import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { CopyTradingEngine, createDefaultExitRules, recommendedExitRules, fastScalpExitRules, followTraderExitRules, activeExitRuleCount, createDefaultUiSettings } from './engine/copyEngine.mjs';
import { CHAINS } from './engine/chainAdapters.mjs';
import { LiveSignalService } from './engine/liveSignals.mjs';
import { isSolanaAddress } from './engine/walletWatcher.mjs';
import { loadEnvFile, redact } from './engine/env.mjs';
import { AlchemyService } from './engine/alchemy.mjs';
import { OnchainMetadata } from './engine/onchainMeta.mjs';
import { fetchPumpCurves } from './engine/pumpCurve.mjs';
import { openDatabase } from './engine/db.mjs';
import { PersistenceManager, serializeEngine, serializeLive } from './engine/persistence.mjs';
import { SupabaseMirror, SUPABASE_TABLE_SQL, isSupabaseUrl } from './engine/supabase.mjs';
import fsSync from 'node:fs';
import zlib from 'node:zlib';
import { RealTrader } from './engine/realTrader.mjs';
import { Notifier } from './engine/notifier.mjs';
import { buildDaxReport } from './engine/dax.mjs';
import { DaxChat, smartDaxAnswer, periodFromQuestion } from './engine/daxChat.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Local secrets (e.g. ALCHEMY_API_KEY) live in .env next to server.mjs — never in public/ files
const envFile = loadEnvFile(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3400);
// Hosting platforms (Railway) must reach the server from outside the container
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_PROJECT_ID);
// Only this computer can open the terminal unless ODEX_HOST says otherwise (Settings → Security)
const HOST = process.env.ODEX_HOST || (ON_RAILWAY ? '0.0.0.0' : '127.0.0.1');
// Optional site password (HTTP Basic auth, any username). Set it on any public deploy.
const SITE_PASSWORD = process.env.ODEX_PASSWORD || '';
function passwordOk(req) {
  if (!SITE_PASSWORD) return true;
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(dec.slice(dec.indexOf(':') + 1));
  const want = Buffer.from(SITE_PASSWORD);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Alchemy: Solana RPC + token metadata/images. The key stays on the server.
export const alchemy = new AlchemyService({ apiKey: process.env.ALCHEMY_API_KEY });

export const engine = new CopyTradingEngine();
// Linked external wallets (public keys only — read-only, never used to sign)
if (!engine.settings.externalWallets) engine.settings.externalWallets = {};

// Connected SSE clients
const sseClients = new Set();

function broadcastRaw(obj) {
  const payload = JSON.stringify(obj);
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Live wallet watching (signals only — reads public chain data, never trades)
export const liveSignals = new LiveSignalService({ engine, broadcast: broadcastRaw, alchemy });
// Live pump.fun curve prices / liquidity for open positions (same RPC, rate-limited)
engine.curveSource = (mints) => fetchPumpCurves((m, p) => liveSignals.watcher.rpc(m, p), mints, CHAINS.solana.nativePriceUsd);
// Logos / wallet pictures straight from chain data when Alchemy DAS is down (same RPC as Live Signals)
alchemy.fallback = new OnchainMetadata({ rpc: (method, params) => liveSignals.watcher.rpc(method, params) });

// Database: SQLite (node:sqlite) or JSON fallback in ./data. Set ODEX_DB=off to run in-memory only.
export const db = process.env.ODEX_DB === 'off' ? null : await openDatabase({ dir: process.env.ODEX_DATA_DIR || path.join(__dirname, 'data') });
// Supabase cloud mirror (optional): SUPABASE_URL + SUPABASE_SERVICE_KEY in .env, server-side only
export const supabase = new SupabaseMirror({
  url: process.env.SUPABASE_URL || '',
  key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '',
  table: process.env.SUPABASE_TABLE || 'odex_kv',
});
export const persistence = db ? new PersistenceManager({ engine, live: liveSignals, store: db, cloud: supabase }) : null;
// Fresh install or newer cloud state (e.g. Railway active while opening localhost): restore from Supabase first
if (persistence && supabase.enabled) {
  try {
    const localEngine = db.get('engine');
    const rows = await supabase.pullAll();
    const remoteEngine = rows.get('engine');
    if (remoteEngine && (!localEngine || (Number(remoteEngine.savedAt) || 0) > (Number(localEngine.savedAt) || 0))) {
      db.setMany([...rows.entries()].filter(([k]) => k === 'engine' || k === 'liveSignals' || k === 'realTrader' || k === 'daxChat'));
      console.log(`Database: restored from Supabase (${localEngine ? 'cloud state was newer than local' : 'local database was empty'})`);
    }
  } catch (err) {
    console.log(`Supabase: could not restore on startup (${err.message})`);
  }
}
if (persistence) {
  persistence.load();
  if (!engine.settings.externalWallets) engine.settings.externalWallets = {};
  persistence.attach();
}

// ---------- Real trading (Paper Trading OFF + ODEX_TRADER_KEY in .env) ----------
// The SOL price must be live before a real order is sized (never the built-in placeholder)
let solPriceLive = false;
const heliusFastRpc = process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${String(process.env.HELIUS_API_KEY).trim()}` : null;
const jitoBlockEngine = process.env.ODEX_JITO_RPC_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
// Sodae (optional): also receives our signed swaps (one credit each) — never used for routine reads,
// so the free tier's 100k monthly credits last
const sodaeRpc = String(process.env.SODAE_RPC_URL || '').trim() || null;
const sodaeKeyOnly = (() => {
  try {
    return sodaeRpc ? new URL(sodaeRpc).searchParams.get('api-key') : null;
  } catch {
    return null;
  }
})();
export const realTrader = new RealTrader({
  env: process.env,
  rpc: (method, params) => liveSignals.watcher.rpc(method, params, { fast: true }),
  fastRpcUrls: [heliusFastRpc, liveSignals.watcher.rpcUrl, jitoBlockEngine, sodaeRpc].filter(Boolean),
  solPrice: () => (solPriceLive ? CHAINS.solana.nativePriceUsd : 0),
  state: db ? db.get('realTrader') : null,
  onChange: () => {
    try {
      db?.set('realTrader', realTrader.exportState());
    } catch {
      // saving the trade log is best-effort
    }
    // also to Supabase: on Railway the local disk is wiped on every deploy, and the 24 h SOL cap
    // must not reset with it
    if (supabase.enabled) supabase.push([['realTrader', realTrader.exportState()]]).catch(() => {});
  },
});// per-buy / daily SOL limits set on the dashboard win over the Railway / .env variables
realTrader.capsOverride = () => engine.settings.realCaps || null;
// Swap route (Settings → Trading & risk): Jupiter (default) or direct pump.fun with Jupiter fallback.
// ODEX_SWAP_ROUTE=jupiter on Railway forces Jupiter whatever the setting says (emergency switch).
realTrader.routeSetting = () => (process.env.ODEX_SWAP_ROUTE === 'jupiter' ? 'jupiter' : engine.settings.swapRoute === 'direct' ? 'direct' : 'jupiter');
// Fast trade detection (Settings → Trading & risk): pump.fun trades read from the pushed logs.
// ODEX_FAST_DETECT=off on Railway turns it off whatever the setting says (emergency switch).
liveSignals.watcher.fastDetect = () => process.env.ODEX_FAST_DETECT !== 'off' && engine.settings.fastDetect === true;
realTrader.priorityMicroLamports = () => Number(process.env.ODEX_DIRECT_PRIORITY_MICROLAMPORTS || 100_000);
realTrader.startBlockhashWarmer();

engine.adapter.liveHooks = realTrader.hooks();
// Paper Mode on Solana: match real-SOL execution time (~700 ms on direct pump.fun curve, ~1,000 ms on Jupiter)
// and re-read the live on-chain curve price when the swap lands so paper fills see the same post-delay price.
engine.adapter.paperDelayMs = ({ chainId, token }) => {
  if (chainId !== 'solana') return 0;
  const isDirectCurve = realTrader.routeSetting() === 'direct' && (token?.stage === 'pre-grad' || token?.venue === 'pumpfun');
  if (isDirectCurve && Number(token?.curve?.virtualSolReserves) > 0) return 250;
  return isDirectCurve ? 700 : 1000;
};
engine.adapter.paperLiveFillPrice = async ({ chainId, side, token, fillPriceUsd }) => {
  if (chainId !== 'solana' || !token?.address || typeof engine.curveSource !== 'function') return fillPriceUsd;
  const curves = await engine.curveSource([token.address]);
  const c = curves?.get?.(token.address);
  if (!(c?.priceUsd > 0)) return fillPriceUsd;
  return side === 'buy' ? Math.max(Number(fillPriceUsd) || 0, c.priceUsd) : Math.min(Number(fillPriceUsd) || c.priceUsd, c.priceUsd);
};

// App integrations (Telegram, Discord): trade alerts pushed to your phone / channel
export const notifier = new Notifier({ engine, redact: (x) => redact(String(x), alchemy.apiKey) });
engine.onUpdate((evt) => notifier.handleEngineEvent(evt));
setInterval(() => notifier.scanAlerts(), 4000).unref?.();
// On a public deploy, real trading needs a site password (otherwise anyone with the link could trade)
const sendLog = []; // Bot Wallet → Send attempts (rate limit)
const grpcKeyOnly = (() => {
  try {
    const u = String(process.env.SODAE_GRPC_URL || process.env.YELLOWSTONE_GRPC_URL || '').trim();
    return u ? new URL(u).searchParams.get('api-key') : null;
  } catch {
    return null;
  }
})();
const hideKeys = (msg) => redact(redact(redact(redact(String(msg), alchemy.apiKey), process.env.HELIUS_API_KEY), sodaeKeyOnly), grpcKeyOnly);
const realBlockedReason = ON_RAILWAY && !SITE_PASSWORD ? 'public deploy without ODEX_PASSWORD: real trading is disabled' : null;
const startedAt = Date.now();
let shuttingDownFlag = false;
// One bot at a time: when another copy of Odex Mirror (PC or Railway) is running on the same
// Supabase account, this one does not trade real SOL (two copies would buy everything twice).
const INSTANCE_ID = `${ON_RAILWAY ? 'railway' : 'pc'}-${Math.random().toString(36).slice(2, 10)}`;
let otherInstance = null; // { id, host, at } of the other running copy, if any
let ownsLock = false; // this copy holds the one-bot lock
let lockUnreachableSince = 0; // Supabase could not be reached for the lock check since then
/** This copy owns the saved data (or there is no cloud lock to respect). */
function holdsData() {
  if (!persistence || !supabase.enabled || ownsLock) return true;
  // Supabase unreachable for a while and no other copy known: work locally rather than freeze
  return !otherInstance && lockUnreachableSince > 0 && Date.now() - lockUnreachableSince > 30_000;
}
// Until the first lock check, don't upload anything: another copy may still own the account
if (persistence && supabase.enabled) persistence.cloudPaused = true;
async function instanceHeartbeat() {
  if (!supabase.enabled) return;
  if (shuttingDownFlag) return;
  try {
    const rows = await supabase.request('GET', '?key=eq.instance_lock&select=value');
    lockUnreachableSince = 0;
    const cur = Array.isArray(rows) ? rows[0]?.value : null;
    const now = Date.now();
    if (cur && cur.id !== INSTANCE_ID && now - Number(cur.at || 0) < 75_000) {
      if (!otherInstance) {
        console.log(`Another Odex Mirror is running on this Supabase account (${cur.host}). Real trading is off here until it stops.`);
        engine.alerts.unshift({ id: `alt-inst-${now}`, level: 'danger', title: `Another copy of Odex Mirror is running (${cur.host})`, message: 'Two copies on one account overwrite each other and would buy everything twice. Real trading is off on this copy until the other one is stopped.', timestamp: now });
        engine.emit('alerts_updated', {});
      }
      otherInstance = cur;
      ownsLock = false;
      if (persistence) persistence.cloudPaused = true; // never overwrite the other copy's data
      return;
    }
    const takingOver = !ownsLock;
    otherInstance = null;
    await supabase.push([['instance_lock', { id: INSTANCE_ID, host: ON_RAILWAY ? 'Railway' : 'your PC', at: now }]]);
    ownsLock = true;
    if (takingOver && persistence) {
      // Taking over: load what the other copy saved last (trades it made while we waited), then
      // resume uploads. Only if the cloud data is newer than what we started with.
      try {
        const rows = await supabase.pullAll();
        const cloudEngine = rows.get('engine');
        if (cloudEngine && Number(cloudEngine.savedAt || 0) > startedAt) {
          persistence.restoreFromRows(rows);
          liveSignals.sync();
          applyDaxAi();
          console.log('One-bot lock: took over and loaded the latest data from Supabase');
        }
        const rt = rows.get('realTrader');
        if (rt && Array.isArray(rt.trades) && rt.trades.length >= realTrader.trades.length) {
          realTrader.trades = rt.trades;
          if (Array.isArray(rt.spendLog)) realTrader.spendLog = rt.spendLog;
        }
      } catch (err) {
        console.log(`One-bot lock: could not load the latest data (${err.message})`);
      }
      persistence.cloudPaused = false;
      try {
        engine.reconcileRealTrades(realTrader.trades);
      } catch {
        // best effort
      }
    }
  } catch {
    if (!lockUnreachableSince) lockUnreachableSince = Date.now();
    // Supabase unreachable: keep the last known state
  }
}
instanceHeartbeat();
setInterval(instanceHeartbeat, 25_000).unref?.();
// while waiting for the lock (a new version starting, the old one stopping), look every 4 s so
// the handover takes seconds, not up to a minute
setInterval(() => {
  if (!ownsLock && !shuttingDownFlag) instanceHeartbeat();
}, 4_000).unref?.();

/** Why changes can't be saved on this copy right now (null = they can). */
function changesBlockedReason() {
  if (shuttingDownFlag) return 'Odex is restarting for an update — try again in a few seconds (nothing was changed).';
  if (holdsData()) return null;
  if (otherInstance && otherInstance.host !== 'stopped') return `Another copy of Odex Mirror is running (${otherInstance.host}) and owns the saved data — make changes there, or stop it (nothing was changed).`;
  return 'Odex is switching to the new version — try again in a few seconds (nothing was changed).';
}
// Ghost positions (sold on-chain but not recorded, e.g. during a redeploy): fix them from the
// bot's own swap log every 30 s
setInterval(() => {
  if (otherInstance || shuttingDownFlag) return;
  try {
    engine.reconcileRealTrades(realTrader.trades);
  } catch {
    // best effort
  }
}, 30_000).unref?.();
// real swaps only on the copy that owns the saved data (a swap made during a handover would be
// overwritten when the data owner's last save is loaded)
engine.adapter.realEnabled = () => realTrader.ready() && !realBlockedReason && !otherInstance && holdsData();
engine.adapter.realBuyRoomUsd = () => realTrader.buyRoomUsd();
engine.realTradingActive = () => !engine.settings.paperTrading && engine.adapter.realEnabled();
// the exact reason real trading is off right now (shown on skipped copies)
engine.realUnavailableReason = () => {
  if (!realTrader.ready()) return realTrader.keyError || 'the bot wallet key ODEX_TRADER_KEY is missing';
  if (realBlockedReason) return 'ODEX_PASSWORD is not set on Railway — add it back in Variables (a public site with the wallet key must have a password)';
  if (otherInstance) return `another copy of Odex Mirror is running (${otherInstance.host}) — stop it`;
  if (!holdsData()) return 'Odex is switching to a new version — copies resume in a few seconds';
  return null;
};

// Real balance of the bot wallet → the engine's wallet balances (used for sizing and spend checks)
async function refreshRealBalance() {
  if (!realTrader.ready()) return null;
  try {
    const bal = await realTrader.refreshBalance();
    for (const w of engine.wallets) {
      if (w.archived) continue;
      if (!w.balances) w.balances = {};
      w.balances.solana = { native: bal.sol, stable: bal.usdc };
    }
    return bal;
  } catch {
    return null;
  }
}
setInterval(() => {
  if (engine.realTradingActive()) refreshRealBalance();
}, 15_000).unref?.();

// Right after a real buy or sell: re-read the bot wallet (the swap's SOL is already there) and
// push the new balance to every open page, so it shows at once instead of on the next 15 s read
engine.onUpdate((evt) => {
  if ((evt.type !== 'position_sold' && evt.type !== 'position_opened') || evt.payload?.position?.isPaper !== false) return;
  for (const delay of [1500, 6000]) {
    setTimeout(async () => {
      const bal = await refreshRealBalance();
      if (bal) broadcastRaw({ event: 'bot_balance', data: bal });
    }, delay).unref?.();
  }
});

engine.onUpdate((evt) => {
  if (!sseClients.size) {
    if (evt.type === 'follows_updated' || evt.type === 'state_reset') liveSignals.sync();
    return; // nobody watching: skip building the snapshot
  }
  const snap = engine.getStateSnapshot();
  // A price tick only changes open positions: send just those (~5 KB) instead of the whole
  // state (~140 KB, every 2 s while a position is open)
  if (evt.type === 'market_tick') {
    broadcastRaw({ event: evt.type, data: evt.payload, patch: { positions: snap.positions, positionsSummary: snap.positionsSummary } });
    return;
  }
  broadcastRaw({
    event: evt.type,
    data: evt.type === 'settings_updated' ? null : evt.payload, // never broadcast raw settings (secrets)
    state: snap,
  });
  if (evt.type === 'follows_updated' || evt.type === 'state_reset') {
    liveSignals.sync();
  }
});

// Live price tick & exit evaluation loop (0.5 s with a real trade open, 2 s otherwise)
// Every manual change to a wallet's paper money is logged (newest 200), so the balance can
// always be reconciled: start + funding changes − buys + sells = balance.
function logPaperFunding(w, type, beforeUsd) {
  const before = Number(beforeUsd ?? 10000);
  const after = Number(w.paperBalanceUsd);
  if (!Array.isArray(w.paperLedger)) w.paperLedger = [];
  w.paperLedger.unshift({ t: Date.now(), type, beforeUsd: before, afterUsd: after, changeUsd: Number((after - before).toFixed(2)) });
  if (w.paperLedger.length > 200) w.paperLedger.length = 200;
}

// ---------------------------------------------------------------------------
// Dax, the report agent
// ---------------------------------------------------------------------------
function daxSettings() {
  const d = engine.settings.dax && typeof engine.settings.dax === 'object' ? engine.settings.dax : {};
  return { daily: Boolean(d.daily), hourUtc: Number.isInteger(d.hourUtc) ? d.hourUtc : 8, lastDailyDay: d.lastDailyDay || null };
}
function daxPublicSettings() {
  const d = daxSettings();
  const c = notifier.cfg();
  return { ...d, telegram: Boolean(c.telegram.enabled), discord: Boolean(c.discord.enabled) };
}
function daxReport(period) {
  return buildDaxReport({ engine, realTrader, live: liveSignals, extra: { region: process.env.RAILWAY_REPLICA_REGION || null, version: process.env.RAILWAY_GIT_COMMIT_SHA || null } }, { period });
}
function daxFilename(rep) {
  return `dax-report-${rep.period.preset}-${new Date(rep.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
}
// ---------------------------------------------------------------------------
// Rent reclaim: close the bot wallet's empty token accounts (≈0.002 SOL each) — after every full
// real sell (30 s later) and every 30 min. Only on the trading copy; open / in-flight coins skipped.
// ---------------------------------------------------------------------------
function reclaimSkipMints() {
  const skip = new Set(engine.positions.filter((p) => p.remainingTokens > 0).map((p) => p.tokenAddress));
  for (const k of engine.buysInFlight || []) skip.add(String(k).split(':').slice(1).join(':'));
  return skip;
}
async function runRentReclaim({ dryRun = false, why = 'auto' } = {}) {
  if (!realTrader.ready()) return { ok: false, error: realTrader.keyError || 'bot wallet key not loaded' };
  if (!dryRun && (realBlockedReason || otherInstance || shuttingDownFlag)) return { ok: false, error: realBlockedReason || (otherInstance ? `another copy of Odex Mirror is running (${otherInstance.host}) — it reclaims rent there` : 'shutting down') };
  const r = await realTrader.reclaimRent({ skipMints: reclaimSkipMints(), dryRun });
  if (r.ok && !dryRun && r.reclaimedSol > 0) {
    // the rent was booked as a cost when each coin was bought: getting it back is real profit
    const px = Number(CHAINS.solana.nativePriceUsd) || 0;
    engine.realizedLog.push({ t: Date.now(), pnl: Number((r.reclaimedSol * px).toFixed(4)), sol: Number(r.reclaimedSol.toFixed(6)), paper: false, sym: 'rent reclaimed', closes: false, kind: 'rent' });
    engine.emit('rent_reclaimed', { closed: r.closed, sol: r.reclaimedSol, why });
    console.log(`Rent reclaim (${why}): closed ${r.closed} empty token account(s), +${r.reclaimedSol.toFixed(5)} SOL`);
  }
  return r;
}
let reclaimTimer = null;
engine.onUpdate((evt) => {
  if (evt.type !== 'position_sold' || evt.payload?.position?.isPaper !== false || evt.payload.position.remainingTokens > 0) return;
  clearTimeout(reclaimTimer);
  reclaimTimer = setTimeout(() => runRentReclaim({ why: 'after sell' }).catch(() => {}), 30_000);
  reclaimTimer.unref?.();
});
setInterval(() => runRentReclaim({ why: 'every 30 min' }).catch(() => {}), 30 * 60_000).unref?.();
setTimeout(() => runRentReclaim({ why: 'start' }).catch(() => {}), 90_000).unref?.();

// Dax chat (text / voice): Gemini / Claude with READ-ONLY tools over the bot's records
const daxAge = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
// Dax agent API key: set in Settings → Integrations (kept in settings on the server), or GEMINI_API_KEY / ANTHROPIC_API_KEY
const DAX_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];
function envDaxKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
}
function applyDaxAi() {
  const s = engine.settings.daxAi || {};
  const key = String(s.apiKey || envDaxKey()).trim();
  daxChat.apiKey = key;
  const wantGemini = key.startsWith('AIza') || (!key.startsWith('sk-ant-') && !String(s.model || '').startsWith('claude-'));
  const defModel = wantGemini ? 'gemini-2.5-flash' : 'claude-sonnet-5-5';
  daxChat.model = s.model || process.env.DAX_MODEL || defModel;
}
function daxAiPublic() {
  const s = engine.settings.daxAi || {};
  const key = String(s.apiKey || '').trim();
  const envKey = envDaxKey();
  const fromEnv = !key && Boolean(envKey);
  const activeKey = key || envKey;
  const isGemini = activeKey ? activeKey.startsWith('AIza') : String(daxChat?.model || s.model || 'gemini-2.5-flash').startsWith('gemini-');
  return {
    configured: Boolean(key) || fromEnv,
    provider: isGemini ? 'gemini' : 'anthropic',
    source: key ? 'dashboard' : fromEnv ? 'railway' : null,
    keyMasked: key ? `${key.startsWith('AIza') ? 'AIza' : 'sk-ant-'}…${key.slice(-4)}` : null,
    model: daxChat?.activeModel || s.model || DAX_MODELS[0],
    models: DAX_MODELS,
    requests: daxChat?.stats?.requests || 0,
    lastError: daxChat?.stats?.lastError ? redact(daxChat.stats.lastError, daxChat.apiKey) : null,
  };
}
// Dax chat history (server side, newest last): local database + Supabase so it survives redeploys
let daxHistory = (() => {
  try {
    const saved = db?.get('daxChat');
    return Array.isArray(saved?.msgs) ? saved.msgs.slice(-100) : [];
  } catch {
    return [];
  }
})();
function saveDaxHistory() {
  daxHistory = daxHistory.slice(-100);
  const value = { msgs: daxHistory, savedAt: Date.now() };
  try {
    db?.set('daxChat', value);
  } catch {
    // best effort
  }
  if (supabase.enabled && holdsData()) supabase.push([['daxChat', value]]).catch(() => {});
}
export const daxChat = new DaxChat({
  tools: {
    get_report: ({ period }) => daxReport(['today', '24h', '7d', 'all'].includes(period) ? period : '24h').markdown,
    get_open_positions: () =>
      engine.positions
        .filter((p) => p.remainingTokens > 0)
        .map((p) => {
          const f = engine.follows.find((x) => x.id === p.followId);
          const value = (Number(p.remainingTokens) || 0) * (Number(p.currentPriceUsd) || 0);
          return {
            coin: p.symbol, mint: p.tokenAddress, kind: p.isPaper === false ? 'real' : 'paper', trader: p.traderHandle,
            costUsd: Number((p.remainingCostUsd ?? p.initialCostUsd ?? 0).toFixed?.(2) ?? 0), valueUsd: Number(value.toFixed(2)),
            pnlPct: p.entryPriceUsd > 0 && p.currentPriceUsd > 0 ? Number(((p.currentPriceUsd / p.entryPriceUsd - 1) * 100).toFixed(1)) : null,
            peakPct: p.entryPriceUsd > 0 && p.peakPriceUsd > 0 ? Number(((p.peakPriceUsd / p.entryPriceUsd - 1) * 100).toFixed(1)) : null,
            entryVsTraderPct: p.entrySlipPct ?? null, heldSec: daxAge(p.openedAt), stage: p.stage || null,
            exitMode: f?.mode || null, sellsWhenTraderSells: Boolean(f?.mirrorSells),
          };
        }),
    get_trader_trades: ({ coin, hours = 24, limit = 60 }) => {
      const since = Date.now() - Math.min(168, Math.max(1, Number(hours) || 24)) * 3600_000;
      const c = String(coin || '').replace(/^\$/, '').toLowerCase();
      const names = Object.fromEntries(engine.follows.map((f) => [f.traderWallet, f.handle]));
      const fname = Object.fromEntries(engine.follows.map((f) => [f.id, f.handle]));
      return (engine.traderLog || [])
        .filter((e) => e.t >= since && (!c || String(e.sym || '').toLowerCase() === c || String(e.mint).toLowerCase() === c))
        .slice(-Math.min(300, Math.max(1, Number(limit) || 60)))
        .reverse()
        .map((e) => ({ at: new Date(e.t).toISOString(), trader: names[e.w] || e.w, coin: e.sym, mint: e.mint, side: e.side, priceUsd: e.px, usd: e.usd, soldPctOfBag: e.share, marketCapUsd: e.mc, seenLateSec: e.lag, copies: (e.copies || []).map((x) => ({ follow: fname[x.fid] || x.fid, copied: x.ok, dryRun: x.dry || undefined, reason: x.reason || undefined })) }));
    },
    get_settings: () => {
      const rt = realTrader.status();
      const todayStart = new Date().setHours(0, 0, 0, 0);
      return {
        mode: engine.settings.paperTrading ? 'paper' : 'real SOL',
        swapRoute: realTrader.routeSetting(),
        fastDetect: Boolean(liveSignals.watcher.fastDetect?.()),
        traders: engine.follows.map((f) => ({
          name: f.handle,
          wallet: f.traderWallet,
          status: f.status,
          pauseReason: f.pauseDetail || null,
          mode: f.mode,
          sellsWhenTraderSells: Boolean(f.mirrorSells),
          size: f.sizing,
          stopLossPct: f.slPct ?? null,
          takeProfitPct: f.tpPct ?? null,
          maxChasePct: f.maxChasePct ?? engine.settings.maxChasePct ?? null,
          copyTopUps: f.copyTopUps ?? null,
          realSolPerDay: f.maxRealSolPerDay ?? null,
          skipReentriesForMin: f.reentryCooldownMin ?? null,
          exitRules: f.exitRules,
          scorecardAllTime: engine.traderScorecard(f.id),
          scorecardToday: engine.traderScorecard(f.id, { from: todayStart }),
        })),
        realTrading: rt.configured ? { wallet: rt.address, balanceSol: rt.balance?.sol ?? null, perBuySol: rt.caps?.maxSolPerTrade, perDaySol: rt.caps?.maxSolPerDay, usedLast24hSol: rt.spent24hSol, keptForFeesSol: rt.caps?.reserveSol } : 'bot wallet not set up',
      };
    },
  },
  // no API key: Dax still answers the question asked (delay, skips, PnL, positions…) from the records
  basicAnswer: (q, opts) =>
    smartDaxAnswer(
      q,
      {
        report: daxReport(periodFromQuestion(q)),
        openPositions: () => daxChat.tools.get_open_positions({}),
        traderTrades: (o) => daxChat.tools.get_trader_trades(o || {}),
        settings: () => daxChat.tools.get_settings({}),
        signals: liveSignals.signals || [],
        realTrades: realTrader.trades || [],
        swapRoute: realTrader.routeSetting(),
        fastDetect: { on: Boolean(liveSignals.watcher.fastDetect?.()), ...(liveSignals.watcher.fastStats || {}) },
        feedRace: liveSignals.watcher.extraStream || liveSignals.watcher.grpcFeed ? liveSignals.watcher.feedRace : null,
      },
      opts
    ),
});
applyDaxAi(); // a key saved in Settings → Integrations wins over ANTHROPIC_API_KEY

// Daily report to Telegram / Discord at the chosen UTC hour (once a day, only on the trading copy)
setInterval(async () => {
  try {
    const d = daxSettings();
    if (!d.daily || shuttingDownFlag || otherInstance) return; // the standby copy never sends
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== d.hourUtc || d.lastDailyDay === day) return;
    engine.settings.dax = { ...d, lastDailyDay: day };
    engine.emit('settings_updated', {});
    const rep = daxReport('24h');
    await notifier.sendReport({ summary: rep.summaryText, markdown: rep.markdown, filename: daxFilename(rep) });
  } catch (err) {
    console.error(`Dax daily report failed: ${redact(err?.message || String(err), alchemy.apiKey)}`);
  }
}, 60_000).unref?.();

let autoTickEnabled = true;
// Ticks may overlap (a real sell can take seconds) but never pile up; an error in one tick is
// logged and the next tick runs normally (it must never stop exits on open positions)
let ticksRunning = 0;
// Exits are checked every 0.5 s while a REAL trade is open (on a falling pump.fun coin, each
// second of waiting costs several %), every 2 s otherwise. Pump.fun prices come straight from
// the chain each check; DexScreener prices are reused for 1.5 s so it is never flooded.
const FAST_TICK_MS = Number(process.env.ODEX_REAL_EXIT_TICK_MS || 250);
engine.livePriceMinAgeMs = 1500;
let lastTickAt = 0;
setInterval(async () => {
  if (!autoTickEnabled || ticksRunning >= 2 || shuttingDownFlag) return;
  const fastOpen = engine.positions.some((p) => p.remainingTokens > 0 && (p.isPaper === false || p.stage === 'pre-grad' || p.venue === 'pumpfun'));
  if (!fastOpen && Date.now() - lastTickAt < 1950) return;
  lastTickAt = Date.now();
  ticksRunning += 1;
  try {
    await engine.tickMarketPrices();
  } catch (err) {
    console.error(`Price tick failed: ${redact(err?.message || String(err), alchemy.apiKey)}`);
  } finally {
    ticksRunning -= 1;
  }
}, Math.max(250, Math.min(2000, FAST_TICK_MS)));

// Storage: closed trades + history older than 2 days are cleared (at start, then every 30 min)
function pruneOld() {
  try {
    const r = engine.pruneOldRecords(Number(process.env.ODEX_KEEP_CLOSED_HOURS || 48) * 3600_000);
    if (r.closedPositions || r.history) console.log(`Storage: removed ${r.closedPositions} closed trade(s) and ${r.history} history row(s) older than 2 days`);
  } catch (err) {
    console.error(`Storage cleanup failed: ${err.message}`);
  }
}
// trader scorecard: give older PnL-log rows their trader + hold time (before old trades are cleared)
try {
  const n = engine.backfillScorecardLog();
  if (n) console.log(`Scorecard: filled in ${n} older trades`);
} catch {
  // never block startup
}
pruneOld();
setInterval(pruneOld, 30 * 60_000).unref?.();

// Safety net: a stray async error is logged instead of stopping the whole server
process.on('unhandledRejection', (err) => {
  console.error(`Unhandled error (server kept running): ${redact(err?.stack || err?.message || String(err), alchemy.apiKey)}`);
});

// Copies come only from real wallet swaps detected by the Live Signals watcher.

// Live SOL price (replaces the built-in placeholder price) — refreshed every minute
async function refreshSolPrice() {
  try {
    const px = await liveSignals.watcher.tokenInfo.solPriceUsd();
    if (Number(px) > 0 && px !== liveSignals.watcher.tokenInfo.fallbackSolPriceUsd) {
      CHAINS.solana.nativePriceUsd = Number(Number(px).toFixed(2));
      solPriceLive = true;
    }
  } catch {
    // keep the last known price
  }
}
refreshSolPrice();
setInterval(refreshSolPrice, 60_000).unref?.();

// Event-loop lag sampler for the health check
{
  let expected = Date.now() + 1000;
  setInterval(() => {
    const now = Date.now();
    globalThis.__odexLagMs = Math.max(0, now - expected);
    expected = now + 1000;
  }, 1000).unref?.();
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Update KEY=value lines in the .env file (null removes the key); other lines are kept. */
function setEnvValues(values) {
  const file = path.join(__dirname, '.env');
  let lines = [];
  try {
    lines = fsSync.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  for (const [k, v] of Object.entries(values)) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    if (v === null || v === undefined || v === '') {
      if (idx >= 0) lines.splice(idx, 1);
      delete process.env[k];
    } else {
      const line = `${k}=${v}`;
      if (idx >= 0) lines[idx] = line;
      else lines.push(line);
      process.env[k] = v;
    }
  }
  fsSync.writeFileSync(file, `${lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n').trim()}\n`);
}

function isAllowedHost(hostHeader) {
  const host = String(hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true; // non-browser clients
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  const extra = String(process.env.ODEX_ALLOWED_HOSTS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) extra.push(String(process.env.RAILWAY_PUBLIC_DOMAIN).toLowerCase());
  return extra.includes(host);
}
function requestBlockedReason(req) {
  if (!isAllowedHost(req.headers.host)) return 'Blocked: unknown host name (set ODEX_ALLOWED_HOSTS to allow it).';
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'Blocked: requests from other websites are not allowed.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) return 'Blocked: requests from other websites are not allowed.';
    } catch {
      return 'Blocked: bad origin.';
    }
  } else if (origin === 'null') return 'Blocked: requests from other websites are not allowed.';
  return null;
}

async function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        err.statusCode = 400;
        err.message = `Invalid JSON body: ${err.message}`;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const acceptsGzip = (req) => /\bgzip\b/.test(String(req?.headers?.['accept-encoding'] || ''));

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  // big answers (state, signals: 100–250 KB) shrink ~85% gzipped — matters on a hosted deploy
  if (body.length > 2048 && acceptsGzip(res.req)) {
    res.writeHead(statusCode, { ...headers, 'Content-Encoding': 'gzip' });
    return res.end(zlib.gzipSync(body, { level: 6 }));
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

// Static files: gzip once per version, ETag so an unchanged file is a 304 (no re-download)
const staticCache = new Map(); // path → { mtimeMs, size, etag, raw, gz }
async function readStatic(filePath) {
  const st = await fs.stat(filePath);
  const hit = staticCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = await fs.readFile(filePath);
  const compressible = /\.(html|css|js|json|svg|txt|map)$/i.test(filePath) && raw.length > 1024;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, etag: `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`, raw, gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null };
  staticCache.set(filePath, entry);
  return entry;
}

// Secret Dax report link (read-only, no password): /dax-report/<token>?period=24h|today|7d|all
// Only this one report opens with it — trading, settings and everything else stay password
// protected. Created / turned off on the Dax page; DAX_REPORT_TOKEN (Railway) also works.
function daxShareToken() {
  const env = String(process.env.DAX_REPORT_TOKEN || '').trim();
  if (env.length >= 24) return env;
  const t = engine.settings.daxShare?.token;
  return typeof t === 'string' && t.length >= 24 ? t : null;
}
function daxShareMatches(given) {
  const want = daxShareToken();
  if (!want || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
const daxShareHits = [];
function daxShareRoute(req, res) {
  const url = new URL(req.url || '/', 'http://x');
  const m = url.pathname.match(/^\/dax-report\/([A-Za-z0-9_-]{24,128})\/?$/);
  if (!m) return false;
  const now = Date.now();
  while (daxShareHits.length && now - daxShareHits[0] > 60_000) daxShareHits.shift();
  if (req.method !== 'GET' || !daxShareMatches(m[1])) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }
  if (daxShareHits.length >= 30) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    res.end('Too many requests — try again in a minute');
    return true;
  }
  daxShareHits.push(now);
  const period = ['today', '24h', '7d', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '24h';
  const rep = daxReport(period);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.end(rep.markdown);
  return true;
}

export const server = http.createServer(async (req, res) => {
  if (String(req.url || '').startsWith('/dax-report/') && daxShareRoute(req, res)) return;
  if (!passwordOk(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Odex Mirror", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Password required');
  }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Request guard: this server can spend real SOL, so only this app may drive it.
    //  - Host must be this machine / an IP (blocks DNS-rebinding sites)
    //  - changes (non-GET) must come from this app's own page, never from another website
    if (pathname.startsWith('/api/')) {
      const blocked = requestBlockedReason(req);
      if (blocked) return sendJson(res, 403, { ok: false, error: blocked });
    }

    // Handover guard: while this copy does not own the saved data (a new version waiting for the
    // old one to stop, another copy running, or shutting down), a change made here would be
    // overwritten when the data owner's save is loaded. Refuse changes instead of losing them.
    if (pathname.startsWith('/api/') && req.method !== 'GET' && pathname !== '/api/dax/chat') {
      const why = changesBlockedReason();
      if (why) return sendJson(res, 503, { ok: false, error: why, retry: true });
    }

    // 1. Server-Sent Events stream for real-time terminal updates
    if (req.method === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // proxies must pass events through immediately
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ event: 'connected', state: engine.getStateSnapshot() })}\n\n`);
      sseClients.add(res);
      // heartbeat: hosting proxies (Railway) close connections that stay silent ~60 s
      const beat = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          clearInterval(beat);
        }
      }, 20_000);
      beat.unref?.();
      req.on('close', () => {
        clearInterval(beat);
        sseClients.delete(res);
      });
      return;
    }

    // 2. Full Engine State Snapshot
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, {
        ok: true,
        autoTickEnabled,
        state: engine.getStateSnapshot(),
      });
    }

    // Website health check (bug checker): every server subsystem reports ok / problem
    // Copy speed check: round trips from this server to every service a copy depends on, the
    // server's region, and the measured timings of recent real trades and signals
    if (req.method === 'GET' && pathname === '/api/latency') {
      const median = (xs) => {
        const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : null;
      };
      const timeIt = async (fn, n = 3) => {
        const ms = [];
        let error = null;
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          try {
            await fn();
            ms.push(Date.now() - t0);
          } catch (err) {
            error = redact(redact(String(err.message || err), alchemy.apiKey), liveSignals.heliusKey).slice(0, 120);
          }
        }
        return { medianMs: median(ms), samples: ms, error: ms.length ? null : error };
      };
      const getJson = async (url, init = {}) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          const r = await fetch(url, { ...init, signal: ctrl.signal });
          await r.text();
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } finally {
          clearTimeout(t);
        }
      };
      const SOL = 'So11111111111111111111111111111111111111112';
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const probes = {
        solanaRpc: () => liveSignals.watcher.rpc('getSlot', [{ commitment: 'processed' }]),
        jupiterQuote: () => getJson(`${realTrader.jupBase}/order?inputMint=${SOL}&outputMint=${USDC}&amount=10000000`, { headers: realTrader.jupKey ? { 'x-api-key': realTrader.jupKey } : {} }),
        dexscreener: () => getJson(`https://api.dexscreener.com/latest/dex/tokens/${SOL}`),
      };
      if (liveSignals.heliusKey) probes.helius = () => getJson(`https://mainnet.helius-rpc.com/?api-key=${liveSignals.heliusKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }) });
      const entries = await Promise.all(Object.entries(probes).map(async ([k, fn]) => [k, await timeIt(fn)]));
      const realTrades = (realTrader.trades || []).filter((t) => t.ok && t.timing).slice(0, 20);
      const sigs = (liveSignals.signals || []).filter((s) => !s.backfill).slice(0, 40);
      const handled = sigs.flatMap((s) => (s.copies || []).map((c) => c.handledMs));
      return sendJson(res, 200, {
        ok: true,
        region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || null,
        onRailway: ON_RAILWAY,
        roundTrips: Object.fromEntries(entries),
        recent: {
          realTrades: realTrades.length,
          quoteMs: median(realTrades.map((t) => t.timing.quoteMs)),
          sendMs: median(realTrades.map((t) => t.timing.sendMs)),
          signals: sigs.length,
          // trader's block time → signal ready (1 s resolution: block times are whole seconds)
          detectSec: median(sigs.map((s) => s.latencySec)),
          // push received → signal ready
          streamMs: median(sigs.map((s) => s.streamMs)),
          // signal ready → copy finished
          copyMs: median(handled),
        },
      });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      const now = Date.now();
      const checks = [];
      const add = (id, name, ok, detail, severity = 'error') => checks.push({ id, name, ok: Boolean(ok), detail: ok ? null : detail, severity });

      // Database
      if (persistence) {
        const pi = persistence.info();
        add('db', 'Database saving', !pi.lastError, pi.lastError || '');
      } else add('db', 'Database saving', true, '');

      // Solana RPC
      try {
        const t0 = Date.now();
        await liveSignals.watcher.rpc('getSlot', [{ commitment: 'processed' }]);
        const ms = Date.now() - t0;
        add('rpc', 'Solana connection', ms < 5000, `Solana RPC is very slow (${ms} ms)`, 'warning');
      } catch (err) {
        add('rpc', 'Solana connection', false, redact(`Solana RPC not reachable: ${err.message}`, alchemy.apiKey));
      }

      // Wallet watcher
      const ws = liveSignals.watcher.getStatus();
      const watchList = liveSignals.watchList();
      const enabled = liveSignals.config.enabled;
      const intervalMs = liveSignals.config.pollSec * 1000;
      if (enabled && watchList.length) {
        add('watcher-running', 'Wallet watcher running', ws.running, 'Watching is on but the watcher is not running');
        const stalled = ws.running && ws.lastSuccessAt && now - ws.lastSuccessAt > Math.max(90_000, intervalMs * 6);
        add('watcher-stalled', 'Wallet watcher up to date', !stalled, `No successful check for ${Math.round((now - (ws.lastSuccessAt || now)) / 1000)} s`);
        add('watcher-errors', 'Wallet watcher errors', !ws.lastError, redact(ws.lastError || '', alchemy.apiKey));
        const sm = ws.stream || {};
        if (sm.enabled && ws.running) {
          // Down for over a minute = slower copies (backup checks still find every trade)
          const down = !sm.connected && sm.downSince && now - sm.downSince > 60_000;
          add('stream', 'Real-time stream', !down, `Real-time stream not connected${sm.lastError ? `: ${redact(sm.lastError, alchemy.apiKey)}` : ''}. Trades are still found by the ${liveSignals.config.pollSec}s backup check.`, 'warning');
        }
        for (const w of ws.wallets || []) {
          if (w.error) add(`wallet-${w.address}`, `Reading wallet ${w.label || w.address.slice(0, 6)}`, false, redact(w.error, alchemy.apiKey), 'warning');
          // a slow backup check is fine; one stuck for minutes is not
          else if (w.slowSince && now - w.slowSince > 120_000) add(`wallet-${w.address}`, `Reading wallet ${w.label || w.address.slice(0, 6)}`, false, `Backup check still running after ${Math.round((now - w.slowSince) / 1000)} s (wallet is flooded with spam). Real-time copies are not affected.`, 'warning');
        }
      } else {
        add('watcher-off', 'Wallet watching', !(liveSignals.config.paperCopy && engine.follows.some((f) => f.status === 'copying') && !enabled), 'Watching is switched off, so followed wallets are not being copied', 'warning');
      }

      // Alchemy + price feed
      if (alchemy.enabled) {
        const a = alchemy.status();
        // One-off busy errors (429/503) are retried and normal; flag only repeated failures with no success since
        const dasBad = a.lastErrorAt && (!a.lastOkAt || a.lastErrorAt > a.lastOkAt) && now - a.lastErrorAt < 300_000 && (a.consecutiveFailures || 0) >= 3;
        const fb = a.fallback;
        const fallbackOk = fb && (!fb.lastErrorAt || (fb.lastOkAt && fb.lastOkAt >= fb.lastErrorAt));
        if (a.das?.down || dasBad) {
          // Alchemy's DAS API is down: fine as long as the on-chain fallback is delivering logos
          add('alchemy', 'Token logos & metadata', Boolean(fallbackOk), fallbackOk ? '' : `Alchemy DAS unavailable (${a.das?.lastError || a.lastError}) and the on-chain fallback is failing too: ${fb?.lastError || 'unknown error'}`, 'warning');
        } else {
          add('alchemy', 'Token logos & metadata', true, '', 'warning');
        }
      }
      const pf = engine.priceFeed || {};
      const priceBad = pf.lastError && (!pf.lastOkAt || pf.lastErrorAt > pf.lastOkAt) && now - pf.lastErrorAt < 120_000;
      add('prices', 'Live price feed', !priceBad, pf.lastError || '', 'warning');

      // Supabase cloud backup
      if (supabase.enabled) {
        const sb = supabase.status();
        const bad = sb.lastError && (!sb.lastSyncAt || sb.lastErrorAt > sb.lastSyncAt);
        add('supabase', 'Supabase cloud backup', !bad, sb.lastError || '', 'warning');
      }

      // Server load (event-loop lag)
      const lag = globalThis.__odexLagMs || 0;
      add('lag', 'Server responsiveness', lag < 1000, `Server is overloaded (event loop ${lag} ms behind)`, 'warning');

      // Data sanity
      const badPos = engine.positions.filter((p) => p.remainingTokens > 0 && !(Number(p.currentPriceUsd) > 0 && Number.isFinite(Number(p.currentPriceUsd))));
      add('positions', 'Position prices', !badPos.length, `${badPos.length} open position(s) without a valid price: ${badPos.map((p) => p.symbol).slice(0, 4).join(', ')}`, 'warning');
      // Real trading
      if (!engine.settings.paperTrading) {
        const rs = realTrader.status();
        add('real-key', 'Real trading wallet', rs.ready, rs.keyError || 'Paper Trading is OFF but no bot wallet key is set (ODEX_TRADER_KEY in .env), so nothing is copied');
        add('real-price', 'Live SOL price for real orders', solPriceLive, 'SOL price not loaded yet — real orders wait for it', 'warning');
        const recentErr = rs.lastError && now - rs.lastError.at < 600_000 && !/price moved (too far|past the limit)/i.test(rs.lastError.error || '');
        add('real-errors', 'Real orders', !recentErr, recentErr ? redact(rs.lastError.error, alchemy.apiKey) : '', 'warning');
        if (rs.ready && rs.balance) add('real-gas', 'Bot wallet SOL for fees', rs.balance.sol >= rs.caps.reserveSol, `Only ${rs.balance.sol.toFixed(4)} SOL in the bot wallet — keep at least ${rs.caps.reserveSol} SOL for fees`, 'warning');
      }
      const badWallet = engine.wallets.find((w) => !Number.isFinite(Number(w.paperBalanceUsd ?? 0)) || Number(w.paperBalanceUsd ?? 0) < 0);
      add('balances', 'Wallet balances', !badWallet, `Invalid paper balance on wallet ${badWallet?.name}`);

      return sendJson(res, 200, { ok: checks.every((c) => c.ok), checkedAt: now, checks });
    }

    // Phantom deposits: the browser builds a plain SOL transfer and Phantom signs + sends it.
    // The server only hands out a recent blockhash and reports a signature's status (read-only).
    if (req.method === 'GET' && pathname === '/api/solana/blockhash') {
      try {
        const r = await liveSignals.watcher.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const v = r?.value || r;
        if (!v?.blockhash) throw new Error('no blockhash');
        return sendJson(res, 200, { ok: true, blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight ?? null });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: alchemy.maskUrl(err.message) });
      }
    }
    if (req.method === 'GET' && pathname === '/api/solana/tx-status') {
      const sig = url.searchParams.get('sig') || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(sig)) return sendJson(res, 400, { ok: false, error: 'Invalid signature.' });
      try {
        const r = await liveSignals.watcher.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const st = r?.value?.[0] || null;
        return sendJson(res, 200, { ok: true, status: !st ? 'pending' : st.err ? 'failed' : st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : 'pending' });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: alchemy.maskUrl(err.message) });
      }
    }

    // App integrations: Telegram + Discord trade alerts (secrets stay on the server)
    if (pathname === '/api/integrations' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...notifier.publicConfig(), dax: daxAiPublic() });
    }
    // Dax agent API (Settings → Integrations): the Claude API key that makes Dax a full AI
    if (pathname.startsWith('/api/integrations/dax') && req.method === 'POST') {
      const sub = pathname.split('/')[4] || '';
      const body = await readJsonBody(req);
      const cur = { ...(engine.settings.daxAi || {}) };
      try {
        if (sub === 'disconnect') {
          delete cur.apiKey;
          engine.settings.daxAi = cur;
        } else if (sub === 'test') {
          if (!daxChat.aiEnabled) throw new Error('add an API key first');
          const r = await daxChat.call({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], voice: true, allowTools: false });
          const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          return sendJson(res, 200, { ok: true, reply: text.slice(0, 80), dax: daxAiPublic() });
        } else if (!sub) {
          if (body.apiKey !== undefined && String(body.apiKey).trim()) {
            const k = String(body.apiKey).trim();
            const isGeminiKey = /^AIza[A-Za-z0-9_-]{20,}$/.test(k);
            const isClaudeKey = /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);
            if (!isGeminiKey && !isClaudeKey) {
              throw new Error('that does not look like a Gemini API key (starts with AIza) or Claude API key (starts with sk-ant-)');
            }
            cur.apiKey = k;
            if (isGeminiKey && (!cur.model || String(cur.model).startsWith('claude-'))) cur.model = 'gemini-2.5-flash';
            if (isClaudeKey && (!cur.model || String(cur.model).startsWith('gemini-'))) cur.model = 'claude-sonnet-5-5';
            cur.savedAt = Date.now();
          }
          if (body.model !== undefined) cur.model = DAX_MODELS.includes(body.model) ? body.model : DAX_MODELS[0];
          engine.settings.daxAi = cur;
        } else return sendJson(res, 404, { ok: false, error: 'Unknown action.' });
        applyDaxAi();
        engine.emit('settings_updated', {}); // saves (database + Supabase)
        return sendJson(res, 200, { ok: true, dax: daxAiPublic() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: redact(String(err.message || err), daxChat.apiKey), dax: daxAiPublic() });
      }
    }
    if (pathname.startsWith('/api/integrations/') && req.method === 'POST') {
      const [, , , app, sub] = pathname.split('/');
      if (!['telegram', 'discord'].includes(app)) return sendJson(res, 404, { ok: false, error: 'Unknown app.' });
      const body = await readJsonBody(req);
      try {
        let extra = {};
        if (sub === 'test') await notifier.test(app);
        else if (sub === 'disconnect') notifier.disconnect(app);
        else if (sub === 'find-chat' && app === 'telegram') {
          if (body.botToken) notifier.updateTelegram({ botToken: body.botToken });
          extra = await notifier.findTelegramChat();
          notifier.updateTelegram({ chatId: extra.chatId });
        } else if (!sub) {
          if (app === 'telegram') notifier.updateTelegram(body);
          else notifier.updateDiscord(body);
        } else return sendJson(res, 404, { ok: false, error: 'Unknown action.' });
        engine.emit('settings_updated', {}); // saves (database + Supabase)
        return sendJson(res, 200, { ok: true, ...extra, ...notifier.publicConfig() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message, ...notifier.publicConfig() });
      }
    }

    // Real trading: status (never includes the key) and a safe self-test that sends nothing
    if (req.method === 'GET' && pathname === '/api/real/status') {
      if (engine.realTradingActive()) await refreshRealBalance();
      return sendJson(res, 200, { ok: true, active: engine.realTradingActive(), paperTrading: engine.settings.paperTrading, solPriceLive, blocked: realBlockedReason || (otherInstance ? `another copy of Odex Mirror is running (${otherInstance.host}) — stop it to trade here` : null), onRailway: ON_RAILWAY, sendNeedsPassword: Boolean(SITE_PASSWORD), ...realTrader.status() });
    }
    // Real-trading SOL limits from the dashboard (empty = use the Railway / .env variable)
    if (req.method === 'POST' && pathname === '/api/real/caps') {
      const body = await readJsonBody(req);
      const next = { ...(engine.settings.realCaps || {}) };
      const field = (k, max, label) => {
        if (body[k] === undefined) return null;
        if (body[k] === null || body[k] === '') {
          delete next[k];
          return null;
        }
        const v = Number(body[k]);
        if (!Number.isFinite(v) || v < 0 || v > max) return `${label} must be between 0 and ${max} SOL.`;
        next[k] = v;
        return null;
      };
      const err = field('maxSolPerDay', 1000, 'Daily limit') || field('maxSolPerTrade', 100, 'Per-buy limit');
      if (err) return sendJson(res, 400, { ok: false, error: err });
      if (next.maxSolPerTrade === 0) return sendJson(res, 400, { ok: false, error: 'Per-buy limit must be above 0 SOL.' });
      engine.settings.realCaps = Object.keys(next).length ? next : null;
      engine.emit('settings_updated', {}); // saves (database + Supabase)
      return sendJson(res, 200, { ok: true, ...realTrader.status(), state: engine.getStateSnapshot() });
    }
    // Dax, the report agent: one report of every trade section for a period (password protected)
    if (req.method === 'GET' && pathname === '/api/dax/report') {
      const period = ['today', '24h', '7d', 'all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '24h';
      const rep = daxReport(period);
      if (url.searchParams.get('format') === 'md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `inline; filename="${daxFilename(rep)}"`, 'Cache-Control': 'no-store' });
        return res.end(rep.markdown);
      }
      return sendJson(res, 200, { ok: true, period: rep.period, generatedAt: rep.generatedAt, findings: rep.findings, markdown: rep.markdown, summaryText: rep.summaryText, dax: daxPublicSettings() });
    }
    // Dax chat: the conversation is kept on the server (database + Supabase), not in the browser
    if (req.method === 'GET' && pathname === '/api/dax/history') {
      return sendJson(res, 200, { ok: true, msgs: daxHistory.slice(-60) });
    }
    if (req.method === 'DELETE' && pathname === '/api/dax/history') {
      daxHistory = [];
      saveDaxHistory();
      return sendJson(res, 200, { ok: true, msgs: [] });
    }
    if (req.method === 'POST' && pathname === '/api/dax/chat') {
      const body = await readJsonBody(req);
      const voice = Boolean(body.voice);
      // new clients send only the question; older ones the whole conversation (its last user message is the question)
      const fromList = Array.isArray(body.messages) ? [...body.messages].reverse().find((m) => m && m.role === 'user')?.text : '';
      const text = String(body.text || fromList || '').trim().slice(0, 4000);
      if (!text) return sendJson(res, 400, { ok: false, error: 'Ask Dax something first.' });
      daxHistory.push({ role: 'user', text, voice, t: Date.now() });
      const convo = daxHistory.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, text: m.text }));
      const r = await daxChat.reply(convo, { voice });
      const error = r.error ? redact(r.error, process.env.ANTHROPIC_API_KEY) : null;
      if (r.ok) daxHistory.push({ role: 'assistant', text: r.text, mode: r.mode, t: Date.now() });
      else daxHistory.push({ role: 'error', text: error || 'Dax could not answer.', t: Date.now() });
      saveDaxHistory();
      return sendJson(res, r.ok ? 200 : 400, { ...r, ...(error ? { error } : {}) });
    }
    if (req.method === 'GET' && pathname === '/api/dax/chat/status') {
      return sendJson(res, 200, { ok: true, ...daxChat.status(), lastError: daxChat.status().lastError ? redact(daxChat.status().lastError, process.env.ANTHROPIC_API_KEY) : null });
    }
    if (req.method === 'POST' && pathname === '/api/dax/send') {
      const body = await readJsonBody(req);
      const period = ['today', '24h', '7d', 'all'].includes(body.period) ? body.period : '24h';
      const rep = daxReport(period);
      const sent = await notifier.sendReport({ summary: rep.summaryText, markdown: rep.markdown, filename: daxFilename(rep) }, body.to || null);
      const anyApp = sent.telegram !== null || sent.discord !== null;
      if (!anyApp) return sendJson(res, 400, { ok: false, error: 'Connect Telegram or Discord first (Settings → Integrations).' });
      return sendJson(res, 200, { ok: Boolean(sent.telegram || sent.discord), sent });
    }
    // Secret report link: create (or replace) / turn off. The full link is shown once, to you.
    if (req.method === 'POST' && pathname === '/api/dax/share') {
      const body = await readJsonBody(req);
      if (body.enabled === false) {
        engine.settings.daxShare = null;
        engine.emit('settings_updated', {});
        return sendJson(res, 200, { ok: true, enabled: Boolean(process.env.DAX_REPORT_TOKEN), envToken: Boolean(process.env.DAX_REPORT_TOKEN) });
      }
      const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8);
      engine.settings.daxShare = { token, createdAt: Date.now() };
      engine.emit('settings_updated', {});
      const host = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://${req.headers.host || `localhost:${PORT}`}`;
      return sendJson(res, 200, { ok: true, enabled: true, url: `${host}/dax-report/${token}?period=24h` });
    }
    if (req.method === 'POST' && pathname === '/api/dax/settings') {
      const body = await readJsonBody(req);
      const cur = daxSettings();
      if (body.daily !== undefined) cur.daily = Boolean(body.daily);
      if (body.hourUtc !== undefined) {
        const h = Number(body.hourUtc);
        if (!(Number.isInteger(h) && h >= 0 && h <= 23)) return sendJson(res, 400, { ok: false, error: 'Hour must be 0–23 (UTC).' });
        cur.hourUtc = h;
      }
      engine.settings.dax = cur;
      engine.emit('settings_updated', {});
      return sendJson(res, 200, { ok: true, dax: daxPublicSettings() });
    }
    // Rent reclaim: { dryRun: true } only counts what can be reclaimed
    if (req.method === 'POST' && pathname === '/api/real/reclaim-rent') {
      const body = await readJsonBody(req);
      const r = await runRentReclaim({ dryRun: Boolean(body.dryRun), why: 'by hand' });
      return sendJson(res, r.ok ? 200 : 400, { ...r, error: r.error ? redact(r.error, alchemy.apiKey) : undefined, errors: (r.errors || []).map((e) => redact(e, alchemy.apiKey)), balance: realTrader.balance || null });
    }
    // Bot Wallet → Send: SOL to another wallet. The site password is asked again for every send
    // (an open browser tab alone can't empty the wallet); without a site password, typing SEND.
    if (req.method === 'POST' && pathname === '/api/real/send') {
      const body = await readJsonBody(req);
      if (realBlockedReason) return sendJson(res, 403, { ok: false, error: realBlockedReason });
      if (otherInstance) return sendJson(res, 409, { ok: false, error: `another copy of Odex Mirror is running (${otherInstance.host}) — send from there or stop it` });
      const hourAgo = Date.now() - 3600_000;
      while (sendLog.length && sendLog[0].t < hourAgo) sendLog.shift();
      if (sendLog.filter((x) => x.bad).length >= 5) return sendJson(res, 429, { ok: false, error: 'too many wrong passwords — sending is locked for an hour' });
      if (SITE_PASSWORD) {
        const given = Buffer.from(String(body.password || ''));
        const want = Buffer.from(SITE_PASSWORD);
        if (!(given.length === want.length && timingSafeEqual(given, want))) {
          sendLog.push({ t: Date.now(), bad: true });
          return sendJson(res, 403, { ok: false, error: 'wrong site password — nothing was sent' });
        }
      } else if (String(body.confirm || '').trim().toUpperCase() !== 'SEND') {
        return sendJson(res, 400, { ok: false, error: 'type SEND to confirm' });
      }
      if (!body.dryRun && sendLog.filter((x) => !x.bad).length >= 10) return sendJson(res, 429, { ok: false, error: 'at most 10 sends an hour' });
      const openReal = engine.positions.some((p) => p.isPaper === false && p.remainingTokens > 0);
      const r = await realTrader.sendSol({ to: body.to, amountSol: body.max ? 'max' : body.amountSol, keepReserve: openReal, dryRun: Boolean(body.dryRun) });
      if (!body.dryRun && (r.ok || r.unknown)) {
        sendLog.push({ t: Date.now() });
        console.log(`Bot wallet send: ${r.sentSol ?? '?'} SOL → ${String(body.to).slice(0, 6)}… ${r.ok ? 'confirmed' : 'unconfirmed'} ${r.signature || ''}`);
      }
      return sendJson(res, r.ok ? 200 : 400, { ...r, error: r.error ? redact(r.error, alchemy.apiKey) : undefined, keptReserve: openReal });
    }
    if (req.method === 'POST' && pathname === '/api/real/test') {
      const r = await realTrader.selfTest();
      return sendJson(res, 200, { ...r, steps: (r.steps || []).map((s) => redact(s, alchemy.apiKey)), error: r.error ? redact(r.error, alchemy.apiKey) : null });
    }

    // Live ping: round-trip time to the Solana RPC (cached a few seconds)
    if (req.method === 'GET' && pathname === '/api/ping') {
      const now = Date.now();
      if (!globalThis.__odexPing || now - globalThis.__odexPing.at > 4000) {
        const t0 = Date.now();
        try {
          await liveSignals.watcher.rpc('getSlot', [{ commitment: 'processed' }]);
          globalThis.__odexPing = { at: now, rpcMs: Date.now() - t0, ok: true };
        } catch (err) {
          globalThis.__odexPing = { at: now, rpcMs: null, ok: false, error: redact(err.message, alchemy.apiKey) };
        }
      }
      return sendJson(res, 200, { ok: true, provider: liveSignals.rpcProvider(), ...globalThis.__odexPing });
    }

    // 3. Trader wallet check: is this wallet actually swapping on-chain? (read-only)
    if (req.method === 'GET' && pathname === '/api/traders/check') {
      const address = String(url.searchParams.get('address') || '').trim();
      if (!isSolanaAddress(address)) return sendJson(res, 400, { ok: false, error: 'Enter a valid Solana wallet address.' });
      try {
        const report = await liveSignals.watcher.checkWallet(address, { limit: Number(url.searchParams.get('limit')) || 25 });
        return sendJson(res, 200, { ok: true, ...report });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: redact(`Could not read this wallet: ${err.message}`, alchemy.apiKey) });
      }
    }

    // 5. Copy a trader by wallet address (Solana — the chain the live watcher reads)
    if (req.method === 'POST' && pathname === '/api/follows') {
      const body = await readJsonBody(req);
      const activeWallet = engine.getActiveWallet();
      const traderWallet = String(body.traderWallet || body.solanaWallet || '').trim();
      if (!isSolanaAddress(traderWallet)) {
        return sendJson(res, 400, { ok: false, error: 'Paste the trader\'s Solana wallet address.' });
      }
      const nameRaw = String(body.name || '').trim();
      if (nameRaw.length > 32) return sendJson(res, 400, { ok: false, error: 'Name cannot exceed 32 characters.' });
      if (engine.follows.some((f) => f.walletId === activeWallet.id && f.chainId === 'solana' && f.traderWallet === traderWallet)) {
        return sendJson(res, 409, { ok: false, error: 'You are already copying this wallet.' });
      }
      const MODES = ['auto-exit', 'buy-and-hold', 'mirror'];
      const SIZING = ['fixed', 'percent', 'proportional'];
      const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      const sizingType = SIZING.includes(body.sizing?.type) ? body.sizing.type : 'fixed';
      const sizingAmount = num(body.sizing?.amount) ?? 50;
      if (sizingAmount <= 0) return sendJson(res, 400, { ok: false, error: 'Size must be greater than zero.' });
      if (sizingType === 'percent' && sizingAmount > 100) return sendJson(res, 400, { ok: false, error: '% of balance cannot exceed 100.' });
      const tpPct = num(body.tpPct);
      const slPct = num(body.slPct);
      if (tpPct !== null && tpPct <= 0) return sendJson(res, 400, { ok: false, error: 'Take profit must be above 0%.' });
      if (slPct !== null && (slPct <= 0 || slPct >= 100)) return sendJson(res, 400, { ok: false, error: 'Stop loss must be between 0% and 100%.' });
      const short = `${traderWallet.slice(0, 4)}…${traderWallet.slice(-4)}`;
      const follow = {
        id: `fol-${randomUUID().slice(0, 8)}`,
        walletId: activeWallet.id,
        name: nameRaw || short,
        handle: (nameRaw || short).replace(/^@/, ''),
        traderWallet,
        chainId: 'solana',
        status: 'copying',
        pauseReason: null,
        mode: MODES.includes(body.mode) ? body.mode : 'auto-exit',
        sizing: { type: sizingType, amount: Math.min(sizingType === 'percent' ? 100 : 100000, sizingAmount) },
        tpPct,
        slPct,
        minTradeUsd: num(body.minTradeUsd) ?? 1,
        maxOpenPositions: num(body.maxOpenPositions) ?? 10,
        maxAtRiskUsd: num(body.maxAtRiskUsd) ?? 1000,
        consecutiveLosses: 0,
        // Auto-Exit with zero rules would never sell on its own → start with the recommended five
        exitRules:
          body.exitRules
            ? createDefaultExitRules(body.exitRules)
            : (MODES.includes(body.mode) ? body.mode : 'auto-exit') === 'auto-exit'
              ? recommendedExitRules()
              : createDefaultExitRules(),
        filtersOverride: { pumpOnly: null, minMarketCapUsd: null, maxMarketCapUsd: null, minTraderBuyNative: null, maxTraderBuyNative: null, stage: null },
        createdAt: Date.now(),
      };
      engine.follows.unshift(follow);
      engine.emit('follows_updated', { created: [follow] });
      return sendJson(res, 200, { ok: true, created: [follow], state: engine.getStateSnapshot() });
    }

    // 6. Update / Pause / Resume / Edit / Delete a Follow
    if (pathname.startsWith('/api/follows/')) {
      const followId = pathname.split('/')[3];
      const action = pathname.split('/')[4];

      if (req.method === 'POST' && followId === 'pause-all') {
        for (const f of engine.follows) {
          f.status = 'paused';
          f.pauseReason = 'manual';
        }
        engine.emit('follows_updated', {});
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && followId === 'resume-all') {
        for (const f of engine.follows) {
          if (f.pauseReason === 'slow') f.scoreSince = Date.now(); // judge it again on fresh trades
          f.status = 'copying';
          f.pauseReason = null;
          f.pauseDetail = null;
          f.consecutiveLosses = 0;
        }
        engine.emit('follows_updated', {});
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      const follow = engine.follows.find((f) => f.id === followId);
      if (!follow) return sendJson(res, 404, { ok: false, error: 'Follow not found.' });

      if (req.method === 'DELETE') {
        engine.follows = engine.follows.filter((f) => f.id !== followId);
        engine.emit('follows_updated', { removedId: followId });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }

      if (req.method === 'PATCH' || (req.method === 'POST' && action === 'update')) {
        const body = await readJsonBody(req);
        const FOLLOW_MODES = ['auto-exit', 'buy-and-hold', 'mirror'];
        const SIZING_TYPES = ['fixed', 'percent', 'proportional'];
        if (body.status !== undefined && !['copying', 'paused'].includes(body.status)) return sendJson(res, 400, { ok: false, error: 'Status must be copying or paused.' });
        if (body.mode !== undefined && !FOLLOW_MODES.includes(body.mode)) return sendJson(res, 400, { ok: false, error: 'Unknown copy mode.' });
        if (body.sizing) {
          const t = body.sizing.type ?? follow.sizing.type;
          const a = Number(body.sizing.amount ?? follow.sizing.amount);
          if (!SIZING_TYPES.includes(t)) return sendJson(res, 400, { ok: false, error: 'Unknown sizing type.' });
          if (!(a > 0) || (t === 'percent' && a > 100)) return sendJson(res, 400, { ok: false, error: t === 'percent' ? '% of balance must be between 0 and 100.' : 'Size must be greater than zero.' });
        }
        for (const [k, lo, hi] of [['tpPct', 0, 100000], ['slPct', 0, 100], ['minTradeUsd', -1, 1e9], ['maxOpenPositions', 0, 10000], ['maxAtRiskUsd', 0, 1e9]]) {
          const v = body[k];
          if (v === undefined || v === null || v === '') continue;
          if (!Number.isFinite(Number(v)) || Number(v) <= lo || Number(v) > hi) return sendJson(res, 400, { ok: false, error: `Invalid value for ${k}.` });
        }
        if (body.status) {
          follow.status = body.status;
          if (body.status === 'copying') {
            if (follow.pauseReason === 'slow') follow.scoreSince = Date.now(); // judge it again on fresh trades
            follow.pauseReason = null;
            follow.pauseDetail = null;
            follow.consecutiveLosses = 0;
          }
        }
        if (body.name !== undefined) {
          const clean = String(body.name).trim();
          if (clean.length > 32) {
            return sendJson(res, 400, { ok: false, error: 'Name must be 32 characters or fewer.' });
          }
          follow.name = clean === '-' || !clean ? follow.handle : clean;
        }
        if (body.mode) {
          follow.mode = body.mode;
          if (body.mode === 'auto-exit' && !body.exitRules && activeExitRuleCount(follow.exitRules) === 0) follow.exitRules = recommendedExitRules();
        }
        if (body.useRecommendedExits) follow.exitRules = recommendedExitRules();
        if (body.useFastScalp) {
          follow.exitRules = fastScalpExitRules();
          follow.mode = 'auto-exit';
        }
        // "Follow the trader": sell when they sell, +12% take profit, −40% floor, 5 min cap
        if (body.useFollowTrader) {
          follow.exitRules = followTraderExitRules();
          follow.mode = 'auto-exit';
          follow.mirrorSells = true;
        }
        if (body.mirrorSells !== undefined) follow.mirrorSells = Boolean(body.mirrorSells);
        if (body.sizing) {
          follow.sizing = {
            type: body.sizing.type || follow.sizing.type,
            amount: Number(body.sizing.amount ?? follow.sizing.amount),
          };
        }
        if (body.tpPct !== undefined) follow.tpPct = body.tpPct === null || body.tpPct === '' ? null : Number(body.tpPct);
        if (body.slPct !== undefined) follow.slPct = body.slPct === null || body.slPct === '' ? null : Number(body.slPct);
        for (const k of ['minTradeUsd', 'maxOpenPositions', 'maxAtRiskUsd']) {
          if (body[k] !== undefined) follow[k] = body[k] === null || body[k] === '' ? null : Number(body[k]);
        }
        if (body.exitRules) {
          follow.exitRules = createDefaultExitRules({
            takeInitials: { ...follow.exitRules.takeInitials, ...(body.exitRules.takeInitials || {}) },
            moonbagTrail: { ...follow.exitRules.moonbagTrail, ...(body.exitRules.moonbagTrail || {}) },
            floor: { ...follow.exitRules.floor, ...(body.exitRules.floor || {}) },
            waveCut: { ...follow.exitRules.waveCut, ...(body.exitRules.waveCut || {}) },
            hardTimeCap: { ...follow.exitRules.hardTimeCap, ...(body.exitRules.hardTimeCap || {}) },
          });
        }
        // per-trader overrides: max chase (null = account setting) and copying top-ups
        if (body.maxChasePct !== undefined) {
          const v = body.maxChasePct === null || body.maxChasePct === '' ? null : Number(body.maxChasePct);
          if (v !== null && !(Number.isFinite(v) && v >= 1 && v <= 100000)) return sendJson(res, 400, { ok: false, error: 'Max chase must be between 1% and 100000%.' });
          follow.maxChasePct = v;
        }
        if (body.copyTopUps !== undefined) follow.copyTopUps = body.copyTopUps === null || body.copyTopUps === '' ? null : Boolean(body.copyTopUps);
        // re-entry rule: minutes after our copy of a coin closed during which the trader's new buys of
        // that same coin are not copied (empty / 0 = off)
        if (body.reentryCooldownMin !== undefined) {
          const v = body.reentryCooldownMin === null || body.reentryCooldownMin === '' ? null : Number(body.reentryCooldownMin);
          if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 1440)) return sendJson(res, 400, { ok: false, error: 'The re-entry rule must be 0–1440 minutes (empty = off).' });
          follow.reentryCooldownMin = v || null;
        }
        // this trader's own daily real-SOL limit (empty = none; the overall daily limit still applies)
        if (body.maxRealSolPerDay !== undefined) {
          const v = body.maxRealSolPerDay === null || body.maxRealSolPerDay === '' ? null : Number(body.maxRealSolPerDay);
          if (v !== null && !(Number.isFinite(v) && v > 0 && v <= 1000)) return sendJson(res, 400, { ok: false, error: "The trader's daily SOL limit must be above 0 and at most 1000 SOL (leave it empty for no limit)." });
          follow.maxRealSolPerDay = v;
        }
        if (body.filtersOverride) {
          follow.filtersOverride = {
            ...follow.filtersOverride,
            ...body.filtersOverride,
          };
        }
        engine.emit('follows_updated', { follow });
        return sendJson(res, 200, { ok: true, follow, state: engine.getStateSnapshot() });
      }
    }

    // 7. Positions: Sell, Sell Initials, Sell All, Panic Sell, Arm/Cancel Limit Orders, Price Override
    if (pathname === '/api/positions/sell-all' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await engine.sellAllPositions({
        chainId: body.chainId || 'all',
        panic: Boolean(body.panic),
      });
      // only what the page needs per sell; errors without API keys
      const results = (result.results || []).map((r) => ({ ok: Boolean(r?.ok), error: r?.error ? hideKeys(r.error) : undefined }));
      return sendJson(res, 200, { ...result, results, state: engine.getStateSnapshot() });
    }

    if (pathname.startsWith('/api/positions/')) {
      const parts = pathname.split('/');
      const posId = parts[3];
      const subAction = parts[4];
      const body = req.method !== 'GET' ? await readJsonBody(req) : {};

      if (req.method === 'POST' && subAction === 'sell') {
        if (body.mode === 'initials') {
          const resSell = await engine.sellInitialsManual(posId);
          return sendJson(res, resSell.ok ? 200 : 400, { ...resSell, state: engine.getStateSnapshot() });
        }
        const resSell = await engine.executePositionSell(posId, {
          sellPct: Number(body.sellPct || 100),
          cause: 'manual sell',
        });
        return sendJson(res, resSell.ok ? 200 : 400, { ...resSell, error: resSell.error ? hideKeys(resSell.error) : resSell.error, state: engine.getStateSnapshot() });
      }

      // Real position whose coins are no longer in the bot wallet: close the record. Checked
      // on-chain first; the transaction that took the coins out (if found) sets the result.
      if (req.method === 'POST' && subAction === 'close-record') {
        const pos = engine.positions.find((p) => p.id === posId);
        // an already-fixed record can be checked again (its result is recomputed)
        const refix = pos && !(pos.remainingTokens > 0) && pos.closeCause === 'record fixed to the on-chain result';
        if (!pos || (!(pos.remainingTokens > 0) && !refix)) return sendJson(res, 404, { ok: false, error: 'Position not found or already closed.' });
        if (pos.isPaper !== false) return sendJson(res, 400, { ok: false, error: 'Only real positions need this — sell paper positions normally.' });
        // other real positions in the same coin around the same time share its on-chain history
        const t0 = pos.openedAt || 0;
        const siblings = engine.positions.filter((p) => p.id !== pos.id && p.isPaper === false && p.tokenAddress === pos.tokenAddress && Math.abs((p.openedAt || 0) - t0) < 6 * 3600_000);
        if (siblings.some((p) => p.remainingTokens > 0)) return sendJson(res, 409, { ok: false, error: 'Another open position holds this coin — sell or close that one first.' });
        const since = Math.min(t0, ...siblings.map((p) => p.openedAt || t0));
        let found;
        try {
          const booked = new Set((engine.history || []).map((h) => h.txHash).filter(Boolean));
          found = await realTrader.findTokenExit(pos.tokenAddress, { skip: booked, since });
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: `could not read the bot wallet: ${hideKeys(err.message)}` });
        }
        if (found.held > 0n) return sendJson(res, 409, { ok: false, error: 'The bot wallet still holds this coin — use Sell instead.' });
        const px = Number(CHAINS.solana.nativePriceUsd) || 0;
        const sale = found.sale;
        // The coin's real result is what its on-chain transactions moved (buys, sells, rent refund).
        // Positions of the same coin that already booked their part keep it; this one gets the rest.
        const othersPnl = siblings.reduce((sum, p) => sum + (Number(p.realizedPnlUsd) || 0), 0);
        const target = found.onchain && px > 0 ? found.onchain.netSol * px - othersPnl : null;
        if (refix) {
          if (target === null) return sendJson(res, 409, { ok: false, error: 'could not read this coin\'s on-chain history' });
          const r = engine.reviseRecordedClose(pos.id, target);
          return sendJson(res, 200, { ok: true, revised: true, delta: r?.delta ?? 0, onchain: found.onchain, totalPnlUsd: Number(pos.realizedPnlUsd) || 0, othersPnlUsd: othersPnl, state: engine.getStateSnapshot() });
        }
        let receivedUsd;
        let cause;
        if (target !== null) {
          receivedUsd = Math.max(0, target - (Number(pos.realizedPnlUsd) || 0) + (Number(pos.remainingCostUsd) || 0));
          cause = 'record fixed to the on-chain result';
        } else {
          receivedUsd = sale ? sale.receivedSol * px : 0;
          cause = sale ? 'sold outside the bot (record fixed)' : 'coins gone from the bot wallet (no sale found)';
        }
        const receipt = engine.bookExternalRealSell(pos, { receivedUsd, txHash: sale?.signature || null, at: sale?.t || Date.now(), cause });
        return sendJson(res, 200, { ok: true, onchain: found.onchain || null, othersPnlUsd: othersPnl, totalPnlUsd: Number(pos.realizedPnlUsd) || 0, sale: sale ? { signature: sale.signature, signatures: sale.signatures, receivedSol: sale.receivedSol } : null, receipt: receipt ? { pnlUsd: receipt.pnlUsd ?? null } : null, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && subAction === 'limit-orders') {
        const resOrd = engine.armLimitOrder(posId, body);
        return sendJson(res, resOrd.ok ? 200 : 400, { ...resOrd, state: engine.getStateSnapshot() });
      }

      if (req.method === 'DELETE' && subAction === 'limit-orders') {
        const orderId = parts[5] || body.orderId;
        const resCancel = engine.cancelLimitOrder(posId, orderId);
        return sendJson(res, resCancel.ok ? 200 : 400, { ...resCancel, state: engine.getStateSnapshot() });
      }

      if (req.method === 'POST' && subAction === 'nudge-price') {
        const pos = engine.positions.find((p) => p.id === posId && p.remainingTokens > 0);
        if (!pos) return sendJson(res, 404, { ok: false, error: 'Position not found' });
        const mult = Number(body.multiplier || 1.25);
        await engine.tickMarketPrices({ [posId]: mult });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }
    }

    // 8. Account Settings, Filters, Safety & Risk Limits
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.ui && typeof body.ui === 'object') {
        // Profile / security / notification preferences: validated field by field
        const u = { ...createDefaultUiSettings(), ...(engine.settings.ui || {}) };
        const b = body.ui;
        if (b.displayName !== undefined) u.displayName = String(b.displayName || '').replace(/[<>]/g, '').trim().slice(0, 32);
        if (['local', 'utc'].includes(b.timeZone)) u.timeZone = b.timeZone;
        if (['positions', 'closed', 'signals'].includes(b.landingTab)) u.landingTab = b.landingTab;
        if (typeof b.confirmSells === 'boolean') u.confirmSells = b.confirmSells;
        if (typeof b.hideBalances === 'boolean') u.hideBalances = b.hideBalances;
        if (b.notify && typeof b.notify === 'object') {
          u.notify = { ...u.notify };
          for (const k of ['copies', 'sells', 'skips', 'problems', 'sound']) if (typeof b.notify[k] === 'boolean') u.notify[k] = b.notify[k];
        }
        engine.settings.ui = u;
        engine.emit('settings_updated', { ui: true });
        return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
      }
      if (body.reset) {
        const keepTradingAsset = { ...engine.settings.tradingAsset };
        engine.settings.buySlippagePct = { solana: 15, evm: null };
        engine.settings.sellSlippagePct = null;
        engine.settings.priorityFee = { mode: 'normal', customSol: 0.002 };
        engine.settings.cooldown = { enabled: true, mode: 'duration', durationSec: 600 };
        engine.settings.retryBuys = true;
        engine.settings.maxChasePct = 25;
        engine.settings.filters = {
          pumpOnly: body.keepPumpOnly ? engine.settings.filters.pumpOnly : false,
          minMarketCapUsd: null,
          maxMarketCapUsd: null,
          minTraderBuyNative: null,
          maxTraderBuyNative: null,
          stage: 'any',
        };
        engine.settings.safety = {
          blockRiskyCoins: true,
          blockMintableSupply: false,
          strictNonPump: false,
        };
        engine.settings.risk = {
          dailyLossLimitUsd: null,
          dailyLossTriggered: false,
          streakLimit: null,
          exposureLimitUsd: null,
        };
        engine.settings.tradingAsset = keepTradingAsset;
        engine.settings.paperTrading = true;
      } else {
        if (body.paperTrading !== undefined) {
          engine.settings.paperTrading = Boolean(body.paperTrading);
          // real trading just switched on: load the bot wallet's balance before the next copy
          if (!engine.settings.paperTrading) await refreshRealBalance();
        }
        const clampPct = (v, lo, hi) => (v === null || v === '' || v === undefined || !Number.isFinite(Number(v)) ? null : Math.min(hi, Math.max(lo, Number(v))));
        if (body.buySlippagePct) {
          const next = { ...engine.settings.buySlippagePct };
          for (const k of ['solana', 'evm']) if (k in body.buySlippagePct) next[k] = clampPct(body.buySlippagePct[k], 0.1, 50);
          if (next.solana === null) next.solana = 15;
          engine.settings.buySlippagePct = next;
        }
        if (body.sellSlippagePct !== undefined) {
          engine.settings.sellSlippagePct = clampPct(body.sellSlippagePct, 0.1, 50);
        }
        if (body.maxChasePct !== undefined) {
          engine.settings.maxChasePct = Math.min(1000, Math.max(1, Number(body.maxChasePct)));
        }
        if (body.priorityFee) {
          engine.settings.priorityFee = { ...engine.settings.priorityFee, ...body.priorityFee };
        }
        if (body.tradingAsset) {
          engine.settings.tradingAsset = { ...engine.settings.tradingAsset, ...body.tradingAsset };
        }
        if (body.cooldown) {
          engine.settings.cooldown = { ...engine.settings.cooldown, ...body.cooldown };
        }
        if (body.copyTopUps !== undefined) engine.settings.copyTopUps = Boolean(body.copyTopUps);
        if (body.swapRoute !== undefined) engine.settings.swapRoute = body.swapRoute === 'direct' ? 'direct' : 'jupiter';
        if (body.fastDetect !== undefined) engine.settings.fastDetect = body.fastDetect === true || body.fastDetect === 'true';
        if (body.scorecard && typeof body.scorecard === 'object') {
          const sc = { ...engine.scorecardSettings() };
          if (body.scorecard.autoPause !== undefined) sc.autoPause = Boolean(body.scorecard.autoPause);
          for (const [k, lo, hi] of [['minTrades', 3, 1000], ['maxSlipPct', 1, 500], ['maxLagSec', 1, 600]]) {
            const v = Number(body.scorecard[k]);
            if (body.scorecard[k] !== undefined && body.scorecard[k] !== '' && Number.isFinite(v)) sc[k] = Math.min(hi, Math.max(lo, v));
          }
          engine.settings.scorecard = sc;
        }
        if (body.retryBuys !== undefined) {
          engine.settings.retryBuys = Boolean(body.retryBuys);
        }
        if (body.muteWarnings !== undefined) {
          engine.settings.muteWarnings = Boolean(body.muteWarnings);
        }
        if (body.filters) {
          engine.settings.filters = { ...engine.settings.filters, ...body.filters };
        }
        if (body.safety) {
          engine.settings.safety = { ...engine.settings.safety, ...body.safety };
        }
        if (body.risk) {
          engine.settings.risk = { ...engine.settings.risk, ...body.risk };
        }
      }
      engine.emit('settings_updated', {});
      return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
    }

    // 9. Wallets, Deposit, Withdraw, Bridge, Security
    if (pathname === '/api/wallets' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = body.action;

      if (action === 'create') {
        const activeWallets = engine.wallets.filter((w) => !w.archived);
        if (activeWallets.length >= 5) {
          return sendJson(res, 400, { ok: false, error: 'Maximum of 5 active wallets reached.' });
        }
        const idx = engine.wallets.length + 1;
        const newWallet = {
          id: `w-${randomUUID().slice(0, 6)}`,
          index: idx,
          name: body.name || `Wallet ${idx}`,
          active: false,
          archived: false,
          // No made-up addresses: a wallet only gets a deposit address that its owner provides
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
          paperBalanceUsd: 10000,
        };
        engine.wallets.push(newWallet);
      } else if (action === 'switch') {
        for (const w of engine.wallets) {
          w.active = w.id === body.walletId;
        }
      } else if (action === 'rename') {
        const w = engine.getWalletById(body.walletId);
        if (w && body.name) w.name = String(body.name).trim().slice(0, 24);
      } else if (action === 'delete') {
        // Remove a wallet. The default wallet stays; a wallet with open positions must sell first.
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived);
        if (!w) return sendJson(res, 404, { ok: false, error: 'Wallet not found.' });
        const def = engine.getDefaultWallet();
        if (w.id === def?.id) return sendJson(res, 400, { ok: false, error: "The default wallet can't be deleted. Make another wallet the default first." });
        const open = engine.positions.filter((p) => p.walletId === w.id && p.remainingTokens > 0).length;
        if (open) return sendJson(res, 400, { ok: false, error: `This wallet still has ${open} open position${open === 1 ? '' : 's'}. Sell ${open === 1 ? 'it' : 'them'} first.` });
        for (const f of engine.follows) if (f.walletId === w.id) f.walletId = def.id; // its copytrades move to the default wallet
        if (w.active) for (const x of engine.wallets) x.active = x.id === def.id;
        engine.wallets = engine.wallets.filter((x) => x.id !== w.id); // trade history keeps the wallet's name
      } else if (action === 'set-default') {
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived);
        if (!w) return sendJson(res, 404, { ok: false, error: 'Wallet not found.' });
        for (const x of engine.wallets) x.isDefault = x.id === w.id;
      } else if (action === 'set-paper-balance') {
        // Set a wallet's paper money to an exact amount, in USD or SOL (at the live SOL price)
        const w = engine.wallets.find((x) => x.id === body.walletId && !x.archived) || engine.getActiveWallet();
        const unit = body.unit === 'sol' ? 'sol' : 'usd';
        const amount = Number(body.amount);
        const px = Number(CHAINS.solana.nativePriceUsd) || 0;
        if (unit === 'sol' && !(px > 0)) return sendJson(res, 400, { ok: false, error: 'SOL price not known yet. Try again in a moment or enter USD.' });
        const usd = unit === 'sol' ? amount * px : amount;
        if (!(Number.isFinite(usd) && usd >= 0 && usd <= 1_000_000)) return sendJson(res, 400, { ok: false, error: 'Enter an amount between $0 and $1,000,000.' });
        const before = w.paperBalanceUsd;
        w.paperBalanceUsd = Number(usd.toFixed(2));
        logPaperFunding(w, 'set', before);
      } else if (action === 'archive') {
        const w = engine.getWalletById(body.walletId);
        if (w && !w.active) w.archived = true;
      } else if (['deposit', 'bridge', 'withdraw', 'set-withdrawal-address', 'toggle-address-cooldown'].includes(action)) {
        // Odex Mirror never moves real money; these simulated money actions were removed
        return sendJson(res, 410, { ok: false, error: 'Moving funds is not supported. Deposit with Phantom or the QR code; paper money uses "paper-funds".' });
      } else if (action === 'link-external') {
        const provider = String(body.provider || 'phantom');
        const address = String(body.address || '').trim();
        const names = { phantom: 'Phantom', metamask: 'MetaMask' };
        if (!names[provider]) return sendJson(res, 400, { ok: false, error: 'Only Phantom and MetaMask linking are supported.' });
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
          return sendJson(res, 400, { ok: false, error: `${names[provider]} returned an invalid Solana address.` });
        }
        // one linked wallet at a time (it is the deposit address and the balance shown)
        engine.settings.externalWallets = {};
        engine.settings.externalWallets[provider] = { address, linkedAt: Date.now() };
      } else if (action === 'paper-funds') {
        // Paper trading money (USD) — what paper copies spend; never real funds
        const w = engine.getWalletById(body.walletId) || engine.getActiveWallet();
        const amount = Number(body.amountUsd);
        const before = w.paperBalanceUsd;
        if (body.reset) w.paperBalanceUsd = 10000;
        else {
          if (!(amount > 0 && amount <= 1_000_000)) return sendJson(res, 400, { ok: false, error: 'Enter an amount between $1 and $1,000,000.' });
          w.paperBalanceUsd = Number(((w.paperBalanceUsd ?? 10000) + amount).toFixed(2));
        }
        logPaperFunding(w, body.reset ? 'reset' : 'top-up', before);
      } else if (action === 'set-solana-address') {
        const w = engine.getWalletById(body.walletId) || engine.getActiveWallet();
        const address = String(body.address || '').trim();
        if (address && !isSolanaAddress(address)) return sendJson(res, 400, { ok: false, error: 'That is not a valid Solana address.' });
        w.solanaAddress = address;
      } else if (action === 'unlink-external') {
        if (engine.settings.externalWallets) {
          const provider = String(body.provider || '');
          if (provider) delete engine.settings.externalWallets[provider];
          else engine.settings.externalWallets = {};
        }
      }

      engine.emit('wallets_updated', {});
      return sendJson(res, 200, { ok: true, state: engine.getStateSnapshot() });
    }

    // 9.3 Database status, manual save, backup export / import
    if (pathname === '/api/db' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, enabled: Boolean(persistence), ...(persistence ? persistence.info() : {}) });
    }
    if (pathname === '/api/db/save' && req.method === 'POST') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off (ODEX_DB=off).' });
      const ok = persistence.saveNow();
      return sendJson(res, ok ? 200 : 500, { ok, ...persistence.info() });
    }
    if (pathname === '/api/db/export' && req.method === 'GET') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="odex-mirror-backup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(persistence.exportBackup(), null, 2));
    }
    if (pathname === '/api/db/import' && req.method === 'POST') {
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      try {
        const backup = await readJsonBody(req, 25_000_000);
        const restored = persistence.importBackup(backup);
        liveSignals.sync();
        engine.emit('state_restored', restored);
        return sendJson(res, 200, { ok: true, restored, state: engine.getStateSnapshot() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    // PnL totals for a period (Period PnL card, win rate, Closed totals) — same log as the calendar
    if (pathname === '/api/pnl/summary' && req.method === 'GET') {
      const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
      const to = Math.max(0, Number(url.searchParams.get('to')) || 0);
      return sendJson(res, 200, { ok: true, ...engine.pnlSummary({ from, to, paper: url.searchParams.get('mode') !== 'real' }) });
    }

    // 9.33 PnL calendar: realized PnL per day for a month
    if (pathname === '/api/pnl/calendar' && req.method === 'GET') {
      const now = new Date();
      const year = Number(url.searchParams.get('year')) || now.getUTCFullYear();
      const month = Number(url.searchParams.get('month')) || now.getUTCMonth() + 1;
      const tz = Number(url.searchParams.get('tz')) || 0;
      if (month < 1 || month > 12 || year < 2000 || year > 2100 || Math.abs(tz) > 900) return sendJson(res, 400, { ok: false, error: 'Bad month or time zone.' });
      return sendJson(res, 200, { ok: true, ...engine.pnlCalendar({ year, month, tzOffsetMin: tz, paper: url.searchParams.get('mode') !== 'real' }) });
    }

    // 9.34 Security: who can reach this server, where keys live
    if (pathname === '/api/security' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        host: HOST,
        lanAccess: HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1',
        pendingLanAccess: process.env.ODEX_HOST ? !['127.0.0.1', 'localhost', '::1'].includes(process.env.ODEX_HOST) : false,
        port: PORT,
        alchemy: { configured: alchemy.enabled, keyMasked: alchemy.enabled ? alchemy.status().keyMasked : null },
        supabase: { configured: supabase.enabled, keyMasked: supabase.enabled ? supabase.status().keyMasked : null, host: supabase.status().host },
        phantom: engine.settings.externalWallets?.phantom?.address || null,
        devTools: process.env.ODEX_DEV_TOOLS === '1',
      });
    }
    if (pathname === '/api/security' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.lanAccess !== 'boolean') return sendJson(res, 400, { ok: false, error: 'lanAccess must be true or false.' });
      try {
        setEnvValues({ ODEX_HOST: body.lanAccess ? '0.0.0.0' : null });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `Could not save .env: ${err.message}` });
      }
      return sendJson(res, 200, { ok: true, restartNeeded: true, pendingLanAccess: body.lanAccess });
    }

    // 9.35 Supabase cloud backup (keys stay in .env on this server; only a masked key is ever returned)
    if (pathname === '/api/db/supabase' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...supabase.status(), sql: SUPABASE_TABLE_SQL });
    }
    if (pathname === '/api/db/supabase' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const sbUrl = String(body.url || '').trim().replace(/\/+$/, '');
      const sbKey = String(body.key || '').trim();
      const table = String(body.table || 'odex_kv').trim();
      if (!isSupabaseUrl(sbUrl)) return sendJson(res, 400, { ok: false, error: 'Enter your Supabase project URL (https://xxxx.supabase.co).' });
      if (sbKey.length < 20) return sendJson(res, 400, { ok: false, error: 'Paste the service role key from Supabase → Project settings → API.' });
      const trial = new SupabaseMirror({ url: sbUrl, key: sbKey, table });
      const t = await trial.test();
      if (!t.ok) return sendJson(res, 400, { ok: false, error: t.error, tableMissing: Boolean(t.tableMissing), sql: SUPABASE_TABLE_SQL });
      try {
        setEnvValues({ SUPABASE_URL: sbUrl, SUPABASE_SERVICE_KEY: sbKey, SUPABASE_TABLE: trial.table === 'odex_kv' ? null : trial.table });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: `Connected, but could not save .env: ${err.message}` });
      }
      supabase.configure({ url: sbUrl, key: sbKey, table: trial.table });
      let pushed = false;
      if (persistence) {
        try {
          const entries = [['engine', serializeEngine(engine)], ['liveSignals', serializeLive(liveSignals)]];
          pushed = await supabase.push(entries);
        } catch {
          pushed = false;
        }
      }
      return sendJson(res, 200, { ok: true, pushed, ...supabase.status() });
    }
    if (pathname === '/api/db/supabase/sync' && req.method === 'POST') {
      if (!supabase.enabled) return sendJson(res, 400, { ok: false, error: 'Supabase is not connected.', ...supabase.status() });
      try {
        await supabase.push([['engine', serializeEngine(engine)], ['liveSignals', serializeLive(liveSignals)]]);
        return sendJson(res, 200, { ok: true, ...supabase.status() });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, ...supabase.status() });
      }
    }
    if (pathname === '/api/db/supabase/restore' && req.method === 'POST') {
      if (!supabase.enabled) return sendJson(res, 400, { ok: false, error: 'Supabase is not connected.' });
      if (!persistence) return sendJson(res, 400, { ok: false, error: 'Database is turned off.' });
      try {
        const restored = persistence.restoreFromRows(await supabase.pullAll());
        liveSignals.sync();
        engine.emit('state_restored', restored);
        return sendJson(res, 200, { ok: true, restored, state: engine.getStateSnapshot() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (pathname === '/api/db/supabase/disconnect' && req.method === 'POST') {
      await supabase.flush().catch(() => {});
      try {
        setEnvValues({ SUPABASE_URL: null, SUPABASE_SERVICE_KEY: null, SUPABASE_KEY: null, SUPABASE_TABLE: null });
      } catch {
        // .env not writable; still disconnect for this run
      }
      supabase.configure({ url: '', key: '' });
      return sendJson(res, 200, { ok: true, ...supabase.status() });
    }

    // 9.4 Clear History list (keeps positions, balances, follows)
    if (pathname === '/api/history/clear' && req.method === 'POST') {
      const result = engine.clearHistory();
      return sendJson(res, 200, { ok: true, ...result, state: engine.getStateSnapshot() });
    }

    // 9.5 Reset Engine State to Clean Baseline (Clears all fake/test data)
    if (pathname === '/api/engine/reset' && req.method === 'POST') {
      const state = engine.resetToCleanState();
      return sendJson(res, 200, { ok: true, state });
    }

    // 9.55 Token metadata & images (Alchemy, proxied so the API key never reaches the browser)
    if (pathname === '/api/tokens/meta' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const items = (body?.items || [{ chain: url.searchParams.get('chain') || 'solana', address: url.searchParams.get('address') }])
        .filter((it) => it && typeof it.address === 'string' && it.address.length >= 32 && it.address.length <= 64)
        .slice(0, 40);
      if (!alchemy.canFetchTokens) {
        return sendJson(res, 200, { ok: true, configured: false, tokens: {} });
      }
      const tokens = {};
      await Promise.all(
        items.map(async (it) => {
          const meta = await alchemy.getToken(it.chain || 'solana', it.address);
          if (meta) tokens[it.address] = meta;
        })
      );
      // Remember logos on open positions so they show after a restart too
      let touched = false;
      for (const p of engine.positions) {
        const img = tokens[p.tokenAddress]?.imageUrl;
        if (!p.imageUrl && img) {
          p.imageUrl = img;
          touched = true;
        }
      }
      if (touched) engine.emit('positions_updated', {});
      return sendJson(res, 200, { ok: true, configured: true, tokens });
    }

    // Trader wallet pictures: an NFT each wallet holds (Alchemy DAS), never a made-up image
    if (pathname === '/api/wallets/avatars' && (req.method === 'GET' || req.method === 'POST')) {
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const list = (body?.addresses || String(url.searchParams.get('addresses') || '').split(','))
        .map((a) => String(a || '').trim())
        .filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
      const addresses = [...new Set(list)].slice(0, 25);
      if (!alchemy.canFetchTokens) return sendJson(res, 200, { ok: true, configured: false, avatars: {} });
      const avatars = {};
      await Promise.all(
        addresses.map(async (a) => {
          avatars[a] = await alchemy.getWalletAvatar(a).catch(() => null);
        })
      );
      return sendJson(res, 200, { ok: true, configured: true, avatars });
    }

    // Real on-chain balance (SOL + USDC) of a Solana address, read through the same RPC as Live Signals
    if (pathname === '/api/external-wallet/balance' && req.method === 'GET') {
      const address = url.searchParams.get('address') || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return sendJson(res, 400, { ok: false, error: 'Invalid Solana address.' });
      try {
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const [r, t] = await Promise.all([
          liveSignals.watcher.rpc('getBalance', [address, { commitment: 'confirmed' }]),
          liveSignals.watcher.rpc('getTokenAccountsByOwner', [address, { mint: USDC }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => ({ value: [] })),
        ]);
        const lamports = Number(r?.value ?? r ?? 0);
        const usdc = (t?.value || []).reduce((sum, a) => sum + Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
        const solPrice = CHAINS.solana.nativePriceUsd;
        return sendJson(res, 200, { ok: true, address, sol: lamports / 1e9, usdc, solPriceUsd: solPrice, usd: usdc + (lamports / 1e9) * solPrice });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: alchemy.maskUrl(err.message) });
      }
    }

    // 9.6 Live wallet signals (signals only)
    if (pathname === '/api/signals' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(true) });
    }
    if (pathname === '/api/signals/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        liveSignals.updateConfig(body);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(false) });
    }
    if (pathname === '/api/signals/watch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        if (body.action === 'remove') liveSignals.removeManual(body.address);
        else liveSignals.addManual(body.address, body.label);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(false) });
    }
    // Missed-trade audit: the trader's real buys/sells (on-chain) vs what the bot detected.
    // Also saved to data/missed-trades.json. ?minutes=60&wallet=<address>
    if (pathname === '/api/signals/missed' && req.method === 'GET') {
      const minutes = Math.min(360, Math.max(5, Number(url.searchParams.get('minutes')) || 60));
      const only = url.searchParams.get('wallet');
      const wallets = liveSignals.watchList().map((w) => w.address).filter((a) => !only || a === only);
      const bySig = new Map(liveSignals.signals.map((s) => [s.signature, s]));
      const reports = [];
      for (const address of wallets) {
        try {
          const a = await liveSignals.watcher.auditWallet(address, { minutes });
          const trades = a.swaps
            .sort((x, y) => x.blockTime - y.blockTime)
            .map((s) => {
              const sig = bySig.get(s.signature);
              let status;
              if (sig) status = sig.backfill ? 'detected (history catch-up, not copied)' : 'detected';
              else if (liveSignals.dustSigs?.has(s.signature)) status = 'seen, ignored as dust (< $1)';
              else if (a.seenByWatcher[s.signature]) status = 'seen, but not turned into a signal';
              else status = 'MISSED (never seen by the bot)';
              const copy = sig?.copies?.map((c) => c.status + (c.reason ? `: ${c.reason}` : '')).join('; ') || null;
              return {
                time: new Date(s.blockTime * 1000).toISOString(),
                side: s.side,
                token: sig?.symbol || s.tokenMint,
                mint: s.tokenMint,
                amount: `${Number(s.quoteAmount).toFixed(4)} ${s.quoteSymbol}`,
                status,
                delaySec: sig ? sig.latencySec : null,
                via: sig?.via || null,
                copy,
                signature: s.signature,
              };
            });
          const count = (f) => trades.filter(f).length;
          reports.push({
            wallet: address,
            minutes,
            watchMode: a.watch,
            onChain: { historyEntries: a.historyEntries, failedSpam: a.failedEntries, read: a.read, truncated: a.truncated, unreadable: a.unreadable, notSwaps: a.notSwap },
            summary: {
              traderSwaps: trades.length,
              detected: count((t) => t.status.startsWith('detected')),
              missed: count((t) => t.status.startsWith('MISSED')),
              seenNotSignal: count((t) => t.status.startsWith('seen, but')),
              dust: count((t) => t.status.includes('dust')),
            },
            trades,
          });
        } catch (err) {
          reports.push({ wallet: address, error: redact(err.message, alchemy.apiKey) });
        }
      }
      const out = { ok: true, checkedAt: new Date().toISOString(), reports };
      try {
        const dir = process.env.ODEX_DATA_DIR || path.join(__dirname, 'data');
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(path.join(dir, 'missed-trades.json'), JSON.stringify(out, null, 2));
      } catch {
        // report is still returned
      }
      return sendJson(res, 200, out);
    }

    if (pathname === '/api/signals/poll' && req.method === 'POST') {
      const found = await liveSignals.watcher.pollOnce();
      return sendJson(res, 200, { ok: true, found: found.length, ...liveSignals.snapshot(true) });
    }
    if (pathname === '/api/signals/clear' && req.method === 'POST') {
      liveSignals.clear();
      return sendJson(res, 200, { ok: true, ...liveSignals.snapshot(true) });
    }

    // 10. Simulate Trader Signal Scenarios (Interactive Testing of Copy Pipeline & Exits)
    if (pathname === '/api/simulate-signal' && req.method === 'POST') {
      // Developer test harness only — made-up trades are never part of normal use
      if (process.env.ODEX_DEV_TOOLS !== '1') {
        return sendJson(res, 404, { ok: false, error: 'Simulated trades are disabled. Copies come only from real wallet swaps.' });
      }
      const body = await readJsonBody(req);
      const scenario = body.scenario || 'normal_buy';
      let activeFollow =
        engine.follows.find((f) => f.id === body.followId) ||
        engine.follows.find((f) => f.status === 'copying') ||
        engine.follows[0];

      if (!activeFollow) {
        if (engine.settings.paperTrading) {
          const autoFollow = {
            id: `fol-${randomUUID().slice(0, 8)}`,
            walletId: engine.getActiveWallet()?.id || 'w-main',
            handle: 'test-trader',
            name: 'Test trader',
            traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ',
            chainId: 'solana',
            status: 'copying',
            pauseReason: null,
            mode: 'auto-exit',
            sizing: { type: 'fixed', amount: 75 },
            minTradeUsd: 1,
            maxAtRiskUsd: 500,
            maxOpenPositions: 3,
            tpPct: 50,
            slPct: 25,
            // Take Initials on so the "Price Pump (+35%)" test actually exercises the +25% rule
            exitRules: createDefaultExitRules({ takeInitials: { enabled: true } }),
            filtersOverride: {
              pumpOnly: null,
              minMarketCapUsd: null,
              maxMarketCapUsd: null,
              minTraderBuyNative: null,
              maxTraderBuyNative: null,
              stage: null,
            },
            consecutiveLosses: 0,
            createdAt: Date.now(),
          };
          engine.follows.unshift(autoFollow);
          activeFollow = autoFollow;
          engine.emit('follows_updated', { created: [autoFollow] });
        } else {
          return sendJson(res, 400, { ok: false, error: 'Add or resume at least one trader follow first.' });
        }
      }

      const SAMPLE_COINS = [
        { symbol: 'MARS', name: 'Mars Cat', mc: 280_000, price: 0.00028 },
        { symbol: 'GIGA', name: 'Giga Chad Sol', mc: 640_000, price: 0.00064 },
        { symbol: 'PEPEAI', name: 'Pepe Neural', mc: 190_000, price: 0.00019 },
        { symbol: 'BONK2', name: 'Bonk Reloaded', mc: 510_000, price: 0.00051 },
        { symbol: 'WIFHAT', name: 'Dog Wif Neon', mc: 820_000, price: 0.00082 },
      ];
      const pick = SAMPLE_COINS[Math.floor(Math.random() * SAMPLE_COINS.length)];

      let signal;
      if (scenario === 'normal_buy') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 120,
          token: {
            address: `${pick.symbol.toLowerCase()}${randomUUID().slice(0, 8)}Mint`,
            symbol: pick.symbol,
            name: pick.name,
            isLaunchpad: true,
            stage: 'pre-grad',
            marketCapUsd: pick.mc,
            traderFillPriceUsd: pick.price,
            currentPriceUsd: Number((pick.price * 1.04).toFixed(8)), // +4% chase (well below 25% Max Chase)
            safety: { safetyVerified: true },
          },
        };
      } else if (scenario === 'high_chase_skip') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 200,
          token: {
            address: `chase${randomUUID().slice(0, 8)}Mint`,
            symbol: 'RUNNER',
            name: 'Runner Test',
            isLaunchpad: true,
            stage: 'graduated',
            marketCapUsd: 950_000,
            traderFillPriceUsd: 0.0005,
            currentPriceUsd: 0.00074, // +48% above trader fill -> triggers Max Chase skip (>25%)
            safety: { safetyVerified: true },
          },
        };
      } else if (scenario === 'honeypot_skip') {
        signal = {
          chainId: activeFollow.chainId,
          side: 'buy',
          traderHandle: activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          traderBuyUsd: 90,
          token: {
            address: `rug${randomUUID().slice(0, 8)}Mint`,
            symbol: 'SQUID2',
            name: 'Squid Honeypot',
            isLaunchpad: false,
            stage: 'graduated',
            marketCapUsd: 310_000,
            traderFillPriceUsd: 0.00031,
            currentPriceUsd: 0.00032,
            safety: {
              freezeAuthority: true,
              honeypot: true,
              practiceSellFailed: true,
            },
          },
        };
      } else if (scenario === 'leader_sell') {
        const openForFollow =
          engine.positions.find((p) => p.followId === activeFollow.id && p.remainingTokens > 0) ||
          engine.positions.find((p) => p.remainingTokens > 0);
        signal = {
          chainId: openForFollow ? openForFollow.chainId : activeFollow.chainId,
          side: 'sell',
          sellSharePct: 100,
          traderHandle: openForFollow ? openForFollow.traderHandle : activeFollow.handle,
          traderWallet: activeFollow.traderWallet,
          token: {
            address: openForFollow ? openForFollow.tokenAddress : 'unknown',
            symbol: openForFollow ? openForFollow.symbol : 'MANLET',
          },
        };
      } else if (scenario === 'pump_open_positions') {
        const map = {};
        for (const p of engine.positions) {
          if (p.remainingTokens > 0) map[p.id] = 1.35; // +35% jump -> triggers Take Initials (+25%) or TP
        }
        await engine.tickMarketPrices(map);
        return sendJson(res, 200, { ok: true, scenario, state: engine.getStateSnapshot() });
      }

      const results = await engine.processTraderSignal(signal);
      return sendJson(res, 200, { ok: true, scenario, results, state: engine.getStateSnapshot() });
    }

    // 11. Static file serving from public/
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    // Page addresses (/login, /settings, /settings/profile, /positions, /signals, …) are all the
    // one-page app; the browser picks the page from the address. Files keep their extension.
    if (!path.extname(pathname) && !pathname.startsWith('/api/')) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // never serve anything outside public/
    const resolved = path.resolve(filePath);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    try {
      const f = await readStatic(resolved);
      // pages, styles and scripts are revalidated on every load (an update shows after a normal
      // refresh) but an unchanged file answers 304 instead of being downloaded again
      const headers = { 'Content-Type': contentType, ETag: f.etag, Vary: 'Accept-Encoding', ...(/\.(html|css|js)$/.test(resolved) ? { 'Cache-Control': 'no-cache' } : { 'Cache-Control': 'public, max-age=86400' }) };
      if (req.headers['if-none-match'] === f.etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      if (f.gz && acceptsGzip(req)) {
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
        return res.end(f.gz);
      }
      res.writeHead(200, headers);
      res.end(f.raw);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  } catch (err) {
    sendJson(res, err?.statusCode || 500, { ok: false, error: err?.message || 'Internal Server Error' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  server.listen(PORT, HOST, () => {
    if (ON_RAILWAY) console.log(`Railway: listening on ${HOST}:${PORT}${process.env.RAILWAY_PUBLIC_DOMAIN ? ` (https://${process.env.RAILWAY_PUBLIC_DOMAIN})` : ''}; site password ${SITE_PASSWORD ? 'ON' : 'OFF — set ODEX_PASSWORD'}`);
    if (realBlockedReason && realTrader.ready()) console.log(`Real trading: ${realBlockedReason}`);
    if (realTrader.keyError) console.log(`Real trading: ${realTrader.keyError}`);
    else if (realTrader.ready()) {
      const c = realTrader.caps;
      console.log(`Real trading: bot wallet ${realTrader.address} loaded (max ${c.maxSolPerTrade} SOL per buy, ${c.maxSolPerDay || 'no'} SOL per 24 h)`);
      if (!engine.settings.paperTrading) console.log('*** REAL TRADING IS ACTIVE (Paper Trading is OFF) — copies spend real SOL ***');
      refreshRealBalance();
    }
    console.log(`Odex Mirror Web Terminal running at http://localhost:${PORT}${HOST === '127.0.0.1' ? ' (this computer only)' : ` (open to your network on ${HOST})`}`);
    console.log(
      alchemy.enabled
        ? `Alchemy: connected (key ${alchemy.status().keyMasked}${envFile.keys.includes('ALCHEMY_API_KEY') ? ', from .env' : ''})`
        : 'Alchemy: not configured — add ALCHEMY_API_KEY to .env for token images and a faster Solana RPC'
    );
    if (persistence) {
      const r = persistence.restored;
      console.log(
        `Database: ${db.kind === 'sqlite' ? 'SQLite' : 'JSON file'} · ${path.relative(__dirname, db.file)}${
          r ? ` · restored ${r.follows ?? 0} follows, ${r.openPositions ?? 0} open positions, ${r.history ?? 0} history entries` : ' · new database'
        }`
      );
    } else {
      console.log('Database: off (ODEX_DB=off) — data is lost on restart');
    }
    console.log(supabase.enabled ? `Supabase: cloud backup ON · ${supabase.status().host} · table ${supabase.table}` : 'Supabase: not connected (optional cloud backup — connect in Settings → Data & storage)');
    liveSignals.sync();
    console.log(
      `Live wallet watching: ${liveSignals.config.enabled ? 'ON' : 'OFF'} · copying followed wallets ${liveSignals.config.paperCopy ? 'ON (paper)' : 'OFF (signals only)'} · RPC ${liveSignals.maskedRpcUrl()}`
    );
  });
}

// Save everything before the process exits (Ctrl+C, terminal closed, service stop)
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shuttingDownFlag = true; // stop exits and lock refreshes right away
  liveSignals.watcher.stop();
  realTrader.stopBlockhashWarmer();
  // free the one-bot-at-a-time lock so another copy can take over right away
  if (supabase.enabled && !otherInstance) supabase.push([['instance_lock', { id: INSTANCE_ID, host: 'stopped', at: 0 }]]).catch(() => {});
  const done = () => process.exit(0);
  setTimeout(done, 4000).unref?.(); // never hang on exit
  if (!persistence) return done();
  persistence
    .closeAsync()
    .then(() => console.log(`\n${signal}: data saved to ${db.kind === 'sqlite' ? 'SQLite' : 'JSON'} database${supabase.enabled ? ' and Supabase' : ''}. Bye.`))
    .catch(() => {})
    .finally(done);
}
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows console close / Ctrl+Break
}
