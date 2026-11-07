/**
 * Dax — the bot's report agent.
 *
 * Reads the bot's own records (closed trades, the PnL log, the trader trade log, live signals,
 * real orders, settings) and writes one report for a period: results real vs paper, per trader,
 * every closed trade next to the trader's own result on that coin, exits that went past their
 * limit, missed trades and why, speed, wallet runway and errors — ending with Dax's findings:
 * plain conclusions with numbers and what to change.
 *
 * Pure analysis, no network and no outside AI service: the same data always gives the same
 * report, and nothing secret (keys, wallet key) is ever put in it.
 */
import { CHAINS } from './chainAdapters.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Report period from a preset: 'today' (UTC day so far), '24h', '7d', 'all', or custom { from, to, label }. */
export function daxPeriod(preset = '24h', now = Date.now(), custom = null) {
  if ((preset === 'custom' || preset === 'filter') && custom && (Number(custom.from) > 0 || Number(custom.to) > 0)) {
    const f = Math.max(0, Number(custom.from) || 0);
    const t = Number(custom.to) > 0 ? Number(custom.to) : now;
    const lbl = String(custom.label || '').trim().slice(0, 64) || `${f ? new Date(f).toISOString().slice(0, 10) : 'Start'} – ${new Date(t).toISOString().slice(0, 10)}`;
    return { preset: 'filter', label: lbl, from: f, to: Math.max(f, t) };
  }
  if (preset === 'today') {
    const d = new Date(now);
    return { preset, label: 'Today (UTC)', from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), to: now };
  }
  if (preset === '7d') return { preset, label: 'Last 7 days', from: now - 7 * DAY, to: now };
  if (preset === 'all') return { preset, label: 'Everything on record', from: 0, to: now };
  return { preset: '24h', label: 'Last 24 hours', from: now - DAY, to: now };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const usd = (n) => (n == null ? '—' : `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`);
const usdPlain = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const pct = (n, d = 1) => (n == null ? '—' : `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toFixed(d)}%`);
const sol = (n, d = 3) => (n == null ? '—' : `${Number(n).toFixed(d)} SOL`);
const short = (a) => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '—');
const secs = (n) => (n == null ? '—' : n >= 120 ? `${(n / 60).toFixed(1)} min` : `${Math.round(n)} s`);

/** Trader's own result per coin from their logged buys and sells (USD-weighted average prices). */
function traderCoinResults(log, wallet, from, to) {
  const by = new Map();
  for (const e of log) {
    if (e.w !== wallet || e.t < from - 6 * HOUR || e.t > to || !(e.px > 0)) continue;
    const c = by.get(e.mint) || { mint: e.mint, sym: e.sym, buyUsd: 0, buyW: 0, sellUsd: 0, sellW: 0, buys: 0, sells: 0, soldShare: 0, firstBuyAt: null, lastSellAt: null };
    const w = Math.max(0.01, Number(e.usd) || 0);
    if (e.side === 'buy') {
      c.buys += 1;
      c.buyUsd += w;
      c.buyW += w / e.px; // tokens
      if (!c.firstBuyAt) c.firstBuyAt = e.t;
    } else {
      c.sells += 1;
      c.sellUsd += w;
      c.sellW += w / e.px;
      c.soldShare += Number(e.share) || 0;
      c.lastSellAt = e.t;
    }
    if (e.sym) c.sym = e.sym;
    by.set(e.mint, c);
  }
  for (const c of by.values()) {
    c.avgBuy = c.buyW > 0 ? c.buyUsd / c.buyW : null;
    c.avgSell = c.sellW > 0 ? c.sellUsd / c.sellW : null;
    c.resultPct = c.avgBuy && c.avgSell ? (c.avgSell / c.avgBuy - 1) * 100 : null;
    c.holdSec = c.firstBuyAt && c.lastSellAt && c.lastSellAt > c.firstBuyAt ? (c.lastSellAt - c.firstBuyAt) / 1000 : null;
  }
  return by;
}

/** Exit limit (as a positive loss %) that a floor / stop-loss exit was supposed to sell at. */
function exitLimitPct(cause, follow) {
  const c = String(cause || '').toLowerCase();
  if (c.includes('floor')) {
    const f = follow?.exitRules?.floor;
    return f?.enabled ? Number(f.openingFloorPct) || null : null;
  }
  if (c.includes('stop')) return Number(follow?.slPct) > 0 ? Number(follow.slPct) : null;
  return null;
}

/** Plain advice for a skip reason (missed trades). */
function adviceForSkip(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('price moved too far') || r.includes('max chase')) return 'the price ran past your max chase before the copy — raise "Max chase" for this trader, or accept missing late entries';
  if (r.includes('daily real-sol limit') || r.includes('sol limit')) return 'a daily SOL limit was used up — raise it in the trader Settings if you want more copies per day';
  if (r.includes('top-up') || r.includes('already copied') || r.includes('first buy was too late')) return 'repeat buys of a coin already copied are skipped — turn on "Copy every trade" / top-ups if the trader often re-enters';
  if (r.includes('not enough sol') || r.includes('not enough balance')) return 'the wallet ran low — top up the bot wallet';
  if (r.includes('position limit') || r.includes('exposure')) return 'an open-position / exposure limit was reached — raise it in the trader Settings';
  if (r.includes('cooldown')) return 'the buy cooldown blocked it';
  if (r.includes('quote failed') || r.includes('buy failed')) return 'the real swap could not be made (no route / failed) — usually a coin too new or too thin';
  if (r.includes('filter') || r.includes('pump-only') || r.includes('market cap')) return 'your filters excluded it';
  if (r.includes('below your minimum')) return "the trader's buy was below your minimum size";
  return null;
}

/**
 * Build the report.
 * @param ctx { engine, realTrader?, live?, extra?: { region, version, latency } }
 * @param opts { period: 'today'|'24h'|'7d'|'all', now }
 * @returns { period, data, findings, markdown, summaryText }
 */
export function buildDaxReport(ctx, { period = '24h', from = 0, to = 0, label = '', now = Date.now() } = {}) {
  const { engine, realTrader = null, live = null, extra = {} } = ctx;
  const P = daxPeriod(period, now, { from, to, label });
  const inP = (t) => Number.isFinite(t) && t >= P.from && t <= P.to;
  const follows = engine.follows || [];
  const followById = new Map(follows.map((f) => [f.id, f]));
  const traderLog = engine.traderLog || [];

  // ---------- results (from the PnL log: the same numbers as the cards and the calendar) ----------
  const real = engine.pnlSummary({ from: P.from, to: P.to, paper: false });
  const paper = engine.pnlSummary({ from: P.from, to: P.to, paper: true });

  // ---------- closed trades in the period (kept 2 days on the server) ----------
  // entry number per copy: 1 = our first copy of this coin from this trader, 2+ = a re-entry after
  // an earlier copy of the same coin (within 6 h) — numbered over every position on record
  const entryNo = new Map();
  {
    const groups = new Map();
    for (const p of engine.positions || []) {
      const k = `${p.followId}|${p.tokenAddress}|${p.isPaper === false ? 'r' : 'p'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
      let n = 0;
      let prevAt = 0;
      for (const p of list) {
        n = prevAt && (p.openedAt || 0) - prevAt <= 6 * HOUR ? n + 1 : 1;
        prevAt = p.openedAt || 0;
        entryNo.set(p.id, n);
      }
    }
  }
  const closed = (engine.positions || [])
    .filter((p) => p.remainingTokens <= 0 && inP(p.closedAt || p.lastSellAt))
    .map((p) => {
      const cost = Number(p.initialCostUsd) || 0;
      const sold = p.soldUsd != null ? Number(p.soldUsd) : cost + Number(p.realizedPnlUsd || 0);
      const pnl = sold - cost;
      const peakPct = p.entryPriceUsd > 0 && p.peakPriceUsd > 0 ? (p.peakPriceUsd / p.entryPriceUsd - 1) * 100 : null;
      return {
        id: p.id, fid: p.followId, trader: p.traderHandle, wallet: p.traderWallet, mint: p.tokenAddress, sym: p.symbol,
        real: p.isPaper === false, cost, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
        cause: p.closeCause || null, openedAt: p.openedAt, closedAt: p.closedAt || p.lastSellAt,
        heldSec: p.closedAt && p.openedAt ? (p.closedAt - p.openedAt) / 1000 : null,
        entrySlipPct: num(p.entrySlipPct), exitSlipPct: num(p.exitSlipPct), lagSec: num(p.detectLagSec), peakPct,
        entryNo: entryNo.get(p.id) || 1,
      };
    })
    .sort((a, b) => a.closedAt - b.closedAt);

  // ---------- per trader ----------
  const traders = follows.map((f) => {
    const mine = closed.filter((c) => c.fid === f.id);
    const coins = traderCoinResults(traderLog, f.traderWallet, P.from, P.to);
    const logged = traderLog.filter((e) => e.w === f.traderWallet && inP(e.t));
    const buys = logged.filter((e) => e.side === 'buy');
    const outcome = (e) => (e.copies || []).find((c) => c.fid === f.id);
    const copiedBuys = buys.filter((e) => outcome(e)?.ok);
    const missedBuys = buys.filter((e) => outcome(e) && !outcome(e).ok);
    const reasons = new Map();
    for (const e of missedBuys) {
      const r = String(outcome(e).reason || 'not copied').replace(/\s*\(.*?\)\s*/g, ' ').trim();
      reasons.set(r, (reasons.get(r) || 0) + 1);
    }
    // missed coins the trader won on (their own result known)
    const copiedMints = new Set(mine.map((c) => c.mint).concat(copiedBuys.map((e) => e.mint)));
    const missedCoins = [...new Set(missedBuys.map((e) => e.mint))]
      .filter((m) => !copiedMints.has(m))
      .map((m) => ({ mint: m, sym: coins.get(m)?.sym || missedBuys.find((e) => e.mint === m)?.sym, traderPct: coins.get(m)?.resultPct ?? null, reason: outcome(missedBuys.find((e) => e.mint === m))?.reason || null }));
    // our result vs theirs, coin by coin
    const vs = [];
    const byMint = new Map();
    for (const c of mine) {
      const g = byMint.get(c.mint) || { mint: c.mint, sym: c.sym, cost: 0, pnl: 0, n: 0, real: c.real, causes: [] };
      g.cost += c.cost;
      g.pnl += c.pnl;
      g.n += 1;
      if (c.cause) g.causes.push(c.cause);
      byMint.set(c.mint, g);
    }
    for (const g of byMint.values()) {
      const t = coins.get(g.mint);
      const ours = g.cost > 0 ? (g.pnl / g.cost) * 100 : null;
      vs.push({ ...g, oursPct: ours, traderPct: t?.resultPct ?? null, traderBuys: t?.buys || 0, traderSells: t?.sells || 0, traderHoldSec: t?.holdSec ?? null });
    }
    const sc = engine.traderScorecard ? engine.traderScorecard(f.id, { paper: Boolean(engine.settings?.paperTrading), since: P.from }) : null;
    return { follow: f, closed: mine, coins, buysSeen: buys.length, copiedBuys: copiedBuys.length, missedBuys: missedBuys.length, reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]), missedCoins, vs, scorecard: sc };
  });

  // ---------- exits that went past their limit ----------
  const overshoots = closed
    .map((c) => {
      const lim = exitLimitPct(c.cause, followById.get(c.fid));
      if (lim == null || c.pnlPct >= 0) return null;
      const over = -c.pnlPct - lim;
      return over > 3 ? { ...c, limitPct: lim, overPct: over, overUsd: (c.cost * over) / 100 } : null;
    })
    .filter(Boolean);

  // ---------- by exit cause ----------
  const causes = new Map();
  for (const c of closed) {
    const k = `${c.real ? 'real' : 'paper'}|${c.cause || 'unknown'}`;
    const g = causes.get(k) || { real: c.real, cause: c.cause || 'unknown', n: 0, pnl: 0, pcts: [] };
    g.n += 1;
    g.pnl += c.pnl;
    g.pcts.push(c.pnlPct);
    causes.set(k, g);
  }

  // ---------- first entries vs re-entries ----------
  const entryStats = (list) => {
    const wins = list.filter((c) => c.pnl > 0).length;
    return { n: list.length, wins, winRate: list.length ? (wins / list.length) * 100 : null, pnl: sum(list.map((c) => c.pnl)), avgPct: list.length ? sum(list.map((c) => c.pnlPct)) / list.length : null };
  };
  const entries = {};
  for (const kind of ['real', 'paper']) {
    const mine = closed.filter((c) => c.real === (kind === 'real'));
    entries[kind] = { first: entryStats(mine.filter((c) => c.entryNo === 1)), re: entryStats(mine.filter((c) => c.entryNo > 1)) };
  }

  // ---------- speed ----------
  const sigs = (live?.signals || []).filter((s) => !s.backfill && inP(s.detectedAt));
  const rt = realTrader?.status ? realTrader.status() : null;
  const realOrders = (rt?.trades || []).filter((t) => inP(t.t));
  const speed = {
    detectSec: median(sigs.map((s) => num(s.latencySec))),
    copyMs: median(sigs.flatMap((s) => (s.copies || []).filter((c) => c.ok).map((c) => num(c.handledMs)))),
    quoteMs: median(realOrders.filter((t) => t.ok && t.timing).map((t) => num(t.timing.quoteMs))),
    sendMs: median(realOrders.filter((t) => t.ok && t.timing).map((t) => num(t.timing.sendMs))),
    lagSec: median(closed.map((c) => c.lagSec)),
    signals: sigs.length,
  };

  // ---------- real wallet + orders ----------
  const failedOrders = realOrders.filter((t) => t.ok === false);
  const unknownOrders = realOrders.filter((t) => t.ok === null);
  const errCounts = new Map();
  for (const t of failedOrders) {
    const k = String(t.error || 'failed').replace(/[1-9A-HJ-NP-Za-km-z]{40,}/g, '…').slice(0, 90);
    errCounts.set(k, (errCounts.get(k) || 0) + 1);
  }
  const realBuys = closed.filter((c) => c.real);
  const typicalBuySol = realBuys.length ? median(realBuys.map((c) => (c.cost > 0 && engineSolPx(engine) > 0 ? c.cost / engineSolPx(engine) : null))) : null;
  const wallet = rt?.configured
    ? {
        address: rt.address,
        sol: num(rt.balance?.sol),
        reserve: num(rt.caps?.reserveSol),
        perBuy: num(rt.caps?.maxSolPerTrade),
        perDay: num(rt.caps?.maxSolPerDay),
        spent24h: num(rt.spent24hSol),
        typicalBuySol,
        buysLeft: rt.balance && typicalBuySol > 0 ? Math.max(0, Math.floor((rt.balance.sol - (rt.caps?.reserveSol || 0)) / typicalBuySol)) : null,
      }
    : null;

  // ---------- findings ----------
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const modeLive = engine.settings?.paperTrading === false ? 'real' : 'paper';
  const res = (s) => (s.trades ? `${s.trades} trade${s.trades === 1 ? '' : 's'}, ${s.wins} won / ${s.losses} lost (${Math.round((s.wins / Math.max(1, s.wins + s.losses)) * 100)}% win rate), ${usd(s.realized)}` : 'no closed trades');
  if (real.trades || paper.trades) {
    add(real.realized < 0 ? 'bad' : real.realized > 0 ? 'good' : 'info', `Real SOL: ${res(real)}. Paper: ${res(paper)}.`);
  } else add('info', 'No trades closed in this period.');
  if (overshoots.length) {
    const lost = sum(overshoots.map((o) => o.overUsd));
    const avgOver = sum(overshoots.map((o) => o.overPct)) / overshoots.length;
    const realOnes = overshoots.filter((o) => o.real).length;
    add('bad', `${overshoots.length} stop/floor exit${overshoots.length === 1 ? '' : 's'} sold well past the limit (avg ${avgOver.toFixed(0)} points too low${realOnes ? `, ${realOnes} of them real` : ''}), costing about ${usdPlain(lost)} beyond what the limits allowed. On a falling coin every second of exit delay costs — "Sell when the trader sells" and the 0.5 s exit checks target exactly this.`);
  }
  for (const t of traders) {
    const h = `@${t.follow.handle || short(t.follow.traderWallet)}`;
    const known = t.vs.filter((v) => v.traderPct != null && v.oursPct != null);
    if (known.length) {
      const shaken = known.filter((v) => v.oursPct < -3 && v.traderPct > 3);
      const beat = known.filter((v) => v.oursPct > v.traderPct + 3);
      const behind = known.filter((v) => v.oursPct < v.traderPct - 3);
      add(beat.length >= behind.length ? 'good' : 'warn', `${h}: on ${known.length} coin${known.length === 1 ? '' : 's'} both traded, we did better on ${beat.length} and worse on ${behind.length}${shaken.length ? `; ${shaken.length} time${shaken.length === 1 ? '' : 's'} we sold at a loss while the trader still won (${shaken.map((v) => `$${v.sym} ours ${pct(v.oursPct, 0)} vs theirs ${pct(v.traderPct, 0)}`).join(', ')}) — exits too tight for this trader${t.follow.mirrorSells ? '' : '; try "Follow the trader"'}` : ''}.`);
    }
    const winnersMissed = t.missedCoins.filter((m) => m.traderPct != null && m.traderPct > 5);
    if (t.missedBuys) {
      const top = t.reasons[0];
      const adv = top ? adviceForSkip(top[0]) : null;
      add(winnersMissed.length ? 'warn' : 'info', `${h}: ${t.copiedBuys} of ${t.buysSeen} buys copied, ${t.missedBuys} skipped${top ? ` — mostly "${top[0]}" (${top[1]}×)` : ''}${adv ? `: ${adv}` : ''}.${winnersMissed.length ? ` Skipped coins the trader won on: ${winnersMissed.slice(0, 6).map((m) => `$${m.sym || short(m.mint)} ${pct(m.traderPct, 0)}`).join(', ')}.` : ''}`);
    }
    if (t.follow.status !== 'copying') add('warn', `${h} is ${t.follow.status}${t.follow.pauseDetail ? ` (${t.follow.pauseDetail})` : ''} — nothing new is copied from this trader.`);
  }
  for (const kind of ['real', 'paper']) {
    const e = entries[kind];
    if (e.re.n >= 2) {
      const worse = e.re.avgPct < e.first.avgPct - 5;
      add(worse && e.re.pnl < 0 ? 'warn' : 'info', `${kind === 'real' ? 'Real' : 'Paper'} re-entries (the trader sold out and bought the same coin again): ${e.re.n} trades, ${Math.round(e.re.winRate)}% won, ${usd(e.re.pnl)} (avg ${pct(e.re.avgPct, 0)}) vs first entries ${e.first.n} trades, ${e.first.winRate == null ? '—' : Math.round(e.first.winRate) + '%'} won, ${usd(e.first.pnl)} (avg ${pct(e.first.avgPct, 0)}).${worse && e.re.pnl < 0 ? ' Re-entries lose more — consider "Skip re-entries for" ~10 min in the trader Settings.' : ''}`);
    }
  }
  const lostCauses = [...causes.values()].filter((g) => g.real && g.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  if (lostCauses.length) add('info', `Real losses by exit: ${lostCauses.map((g) => `${g.cause} ${usd(g.pnl)} over ${g.n}`).join('; ')}.`);
  if (speed.detectSec != null && speed.detectSec >= 4) add('warn', `Trades are spotted ~${speed.detectSec} s after the trader on average — slow for fast coins. A paid Helius plan switches on the faster token feed (~1 s).`);
  if (wallet) {
    if (wallet.buysLeft != null && wallet.buysLeft <= 2) add('bad', `Bot wallet has ${sol(wallet.sol)} — enough for about ${wallet.buysLeft} more real buy${wallet.buysLeft === 1 ? '' : 's'} (${sol(wallet.reserve, 2)} is kept for fees). Top it up or real copies will be skipped.`);
    if (wallet.perDay > 0 && wallet.spent24h != null && wallet.spent24h >= wallet.perDay * 0.9) add('warn', `Daily real-SOL limit nearly or fully used (${sol(wallet.spent24h)} of ${sol(wallet.perDay, 2)}) — new buys are skipped until older ones drop out of the 24 h window.`);
  }
  if (failedOrders.length) add('warn', `${failedOrders.length} real order${failedOrders.length === 1 ? '' : 's'} failed${unknownOrders.length ? ` and ${unknownOrders.length} had an unknown result` : ''}; most common: ${[...errCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]}.`);
  if (modeLive === 'paper' && paper.realized > 0 && real.trades === 0) add('info', 'Only paper trades this period. Paper fills the moment a trade is spotted and sells instantly, so expect real results a few % worse per trade.');

  // ---------- markdown ----------
  const L = [];
  const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  L.push(`# Dax report — ${P.label}`);
  L.push(`${iso(P.from || (closed[0]?.openedAt ?? now))} → ${iso(P.to)} UTC · mode now: **${modeLive === 'real' ? 'REAL SOL' : 'paper'}**${extra.region ? ` · server ${extra.region}` : ''}${extra.version ? ` · version ${String(extra.version).slice(0, 7)}` : ''}`);
  L.push('');
  L.push('## Dax\'s findings');
  for (const f of findings) L.push(`- ${f.level === 'bad' ? '🔴' : f.level === 'warn' ? '🟠' : f.level === 'good' ? '🟢' : '•'} ${f.text}`);
  L.push('');
  L.push('## Results');
  L.push('| | Trades | Won / lost | Win rate | Realized | SOL | Copied buys |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [name, s] of [['Real SOL', real], ['Paper', paper]]) L.push(`| ${name} | ${s.trades} | ${s.wins} / ${s.losses} | ${s.wins + s.losses ? Math.round((s.wins / (s.wins + s.losses)) * 100) + '%' : '—'} | ${usd(s.realized)} | ${s.realizedSol ? `${s.solExact ? '' : '≈'}${s.realizedSol >= 0 ? '+' : '−'}${Math.abs(s.realizedSol).toFixed(3)}` : '—'} | ${s.copiedBuys} |`);
  L.push('');
  if (wallet) {
    L.push('## Bot wallet');
    L.push(`- Balance ${sol(wallet.sol)} · kept for fees ${sol(wallet.reserve, 2)} · typical buy ${wallet.typicalBuySol ? sol(wallet.typicalBuySol) : '—'} · buys left ≈ ${wallet.buysLeft ?? '—'}`);
    L.push(`- Limits: ${sol(wallet.perBuy, 2)} per buy · ${wallet.perDay > 0 ? `${sol(wallet.perDay, 2)} per day (used ${sol(wallet.spent24h)} in 24 h)` : 'no daily limit'}`);
    L.push('');
  }
  L.push('## Traders');
  for (const t of traders) {
    const f = t.follow;
    const r = f.exitRules || {};
    const rules = [
      r.takeInitials?.enabled ? `TP +${r.takeInitials.takeAtPct}% (sell ${r.takeInitials.sellSizePct}%)` : null,
      r.moonbagTrail?.enabled ? `trail ${r.moonbagTrail.trailPct}% from +${r.moonbagTrail.armsAtPct}%` : null,
      r.floor?.enabled ? `floor −${r.floor.openingFloorPct}%` : null,
      r.waveCut?.enabled ? 'wave cut' : null,
      r.hardTimeCap?.enabled ? `cap ${secs(r.hardTimeCap.timeCapSec)}` : null,
    ].filter(Boolean);
    L.push(`### @${f.handle || short(f.traderWallet)} (${short(f.traderWallet)}) — ${f.status}`);
    L.push(`- Setup: ${f.mode}${f.mode === 'auto-exit' ? ` [${rules.join(', ') || 'no rules'}]${f.mirrorSells ? ' + sells when trader sells' : ''}` : ''} · ${f.sizing?.type === 'fixed' ? `$${f.sizing.amount} per copy` : `${f.sizing?.type} ${f.sizing?.amount}`}${f.slPct ? ` · SL ${f.slPct}%` : ''}${f.maxChasePct ? ` · max chase ${f.maxChasePct}%` : ''}${f.copyTopUps != null ? ` · top-ups ${f.copyTopUps ? 'on' : 'off'}` : ''}${f.maxRealSolPerDay ? ` · ${f.maxRealSolPerDay} SOL/day` : ''}${f.reentryCooldownMin ? ` · re-entries skipped for ${f.reentryCooldownMin} min` : ''}`);
    L.push(`- Trader buys seen ${t.buysSeen} · copied ${t.copiedBuys} · skipped ${t.missedBuys}`);
    if (t.reasons.length) L.push(`- Skip reasons: ${t.reasons.slice(0, 6).map(([k, n]) => `${k} ×${n}`).join(' · ')}`);
    const sc = t.scorecard;
    if (sc && sc.trades) L.push(`- Scorecard (${sc.paper ? 'paper' : 'real'}): entry slip ${pct(sc.avgEntrySlipPct)} · exit slip ${pct(sc.avgExitSlipPct)} · seen ${sc.avgLagSec ?? '—'} s late · avg hold ${secs(sc.avgHoldSec)}`);
    if (t.vs.length) {
      L.push('');
      L.push('| Coin | Kind | Ours | Trader | Exit | Trader buys/sells |');
      L.push('|---|---|---|---|---|---|');
      for (const v of t.vs) L.push(`| $${v.sym} | ${v.real ? 'real' : 'paper'} | ${pct(v.oursPct, 1)} (${usd(v.pnl)}) | ${v.traderPct == null ? '—' : pct(v.traderPct, 1)} | ${[...new Set(v.causes)].join(', ') || '—'} | ${v.traderBuys}/${v.traderSells} |`);
    }
    const winnersMissed = t.missedCoins.filter((m) => m.traderPct != null);
    if (winnersMissed.length) {
      L.push('');
      L.push(`Skipped coins with the trader's result: ${winnersMissed.slice(0, 12).map((m) => `$${m.sym || short(m.mint)} ${pct(m.traderPct, 0)}`).join(' · ')}`);
    }
    L.push('');
  }
  if (overshoots.length) {
    L.push('## Exits past their limit');
    L.push('| Coin | Kind | Exit | Limit | Sold at | Past limit |');
    L.push('|---|---|---|---|---|---|');
    for (const o of overshoots) L.push(`| $${o.sym} | ${o.real ? 'real' : 'paper'} | ${o.cause} | −${o.limitPct}% | ${pct(o.pnlPct, 1)} | ${o.overPct.toFixed(1)} pts (${usdPlain(o.overUsd)}) |`);
    L.push('');
  }
  if (entries.real.re.n || entries.paper.re.n) {
    L.push('## First entries vs re-entries');
    L.push('| Kind | Entry | Trades | Won | Result | Avg |');
    L.push('|---|---|---|---|---|---|');
    for (const kind of ['real', 'paper']) {
      for (const [label, st] of [['first', entries[kind].first], ['re-entry', entries[kind].re]]) {
        if (st.n) L.push(`| ${kind} | ${label} | ${st.n} | ${Math.round(st.winRate)}% | ${usd(st.pnl)} | ${pct(st.avgPct, 1)} |`);
      }
    }
    L.push('');
  }
  if (causes.size) {
    L.push('## By exit');
    L.push('| Kind | Exit | Trades | Result | Avg |');
    L.push('|---|---|---|---|---|');
    for (const g of [...causes.values()].sort((a, b) => a.pnl - b.pnl)) L.push(`| ${g.real ? 'real' : 'paper'} | ${g.cause} | ${g.n} | ${usd(g.pnl)} | ${pct(sum(g.pcts) / g.pcts.length, 1)} |`);
    L.push('');
  }
  L.push('## Speed');
  L.push(`- Trade spotted after the trader: ${speed.detectSec != null ? `~${speed.detectSec} s` : '—'} (median of ${speed.signals} live signals)`);
  L.push(`- Signal → copy done: ${speed.copyMs != null ? `${(speed.copyMs / 1000).toFixed(2)} s` : '—'} · real quote ${speed.quoteMs != null ? `${speed.quoteMs} ms` : '—'} · real send→landed ${speed.sendMs != null ? `${(speed.sendMs / 1000).toFixed(2)} s` : '—'}`);
  if (extra.latency?.roundTrips) L.push(`- Server round trips: ${Object.entries(extra.latency.roundTrips).map(([k, v]) => `${k} ${v.medianMs != null ? `${v.medianMs} ms` : 'unreachable'}`).join(' · ')}`);
  L.push('');
  if (failedOrders.length || unknownOrders.length) {
    L.push('## Real order problems');
    for (const [k, n] of [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) L.push(`- ${n}× ${k}`);
    if (unknownOrders.length) L.push(`- ${unknownOrders.length}× result unknown (check the wallet)`);
    L.push('');
  }
  if (closed.length) {
    L.push('## All closed trades (for analysis)');
    L.push('```');
    L.push('closed_utc,kind,trader,coin,mint,entry_no,cost_usd,pnl_usd,pnl_pct,exit,held_s,peak_pct,entry_slip_pct,exit_slip_pct,seen_late_s');
    for (const c of closed) L.push([iso(c.closedAt), c.real ? 'real' : 'paper', c.trader || '', c.sym, c.mint, c.entryNo, c.cost.toFixed(2), c.pnl.toFixed(2), c.pnlPct.toFixed(1), (c.cause || '').replace(/,/g, ' '), c.heldSec != null ? Math.round(c.heldSec) : '', c.peakPct != null ? c.peakPct.toFixed(1) : '', c.entrySlipPct ?? '', c.exitSlipPct ?? '', c.lagSec ?? ''].join(','));
    L.push('```');
  }
  L.push('');
  L.push('_Report by Dax · Odex Mirror. Closed trades are kept 2 days on the server; totals come from the full PnL log._');
  const markdown = L.join('\n');

  // short version for Telegram / Discord messages
  const S = [`Dax report — ${P.label}`, `Real: ${res(real)}`, `Paper: ${res(paper)}`];
  if (wallet) S.push(`Bot wallet: ${sol(wallet.sol)}${wallet.buysLeft != null ? ` (~${wallet.buysLeft} buys left)` : ''}`);
  S.push('');
  for (const f of findings.slice(1, 7)) S.push(`${f.level === 'bad' ? '🔴' : f.level === 'warn' ? '🟠' : f.level === 'good' ? '🟢' : '•'} ${f.text}`);
  const summaryText = S.join('\n');

  return {
    period: P,
    generatedAt: now,
    data: { real, paper, closed, overshoots, speed, wallet, entries, traders: traders.map((t) => ({ followId: t.follow.id, handle: t.follow.handle, buysSeen: t.buysSeen, copiedBuys: t.copiedBuys, missedBuys: t.missedBuys, reasons: t.reasons, vs: t.vs, missedCoins: t.missedCoins })) },
    findings,
    markdown,
    summaryText,
  };
}

function engineSolPx() {
  return Number(CHAINS.solana?.nativePriceUsd) || 0;
}
