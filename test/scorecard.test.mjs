// Trader scorecard: win rate, hold time, slip vs the trader, detection delay, auto-pause.
// Run: node --test test/scorecard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';

CHAINS.solana.nativePriceUsd = 200;
const MINT = 'ScoreMint11111111111111111111111111111111';

function setup() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  e.settings.cooldown.enabled = false;
  e.settings.copyTopUps = true;
  e.settings.maxChasePct = 1000;
  const f = {
    id: 'fol-sc', walletId: e.getActiveWallet().id, name: 't', handle: 'trader', traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ', chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'mirror', sizing: { type: 'fixed', amount: 50 }, tpPct: null, slPct: null, minTradeUsd: 1,
    maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);
  return { e, f };
}
const tok = (px, mint) => ({ address: mint, symbol: 'SC', name: 'Score', isLaunchpad: false, stage: 'graduated', marketCapUsd: 5_000_000, liquidityUsd: 2_000_000, traderFillPriceUsd: px, currentPriceUsd: px, safety: { safetyVerified: true } });

/** one copied round trip: trader buys at 1.00, we copy at `ourEntry`; trader sells at `traderExit` */
async function roundTrip(e, f, i, { ourEntry = 1.05, traderExit = 1.2, lag = 2 } = {}) {
  const mint = `${MINT.slice(0, -4)}${String(i).padStart(4, '0')}`;
  const buy = { chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: `b${i}`, ageSec: lag, token: { ...tok(1, mint), currentPriceUsd: ourEntry } };
  const [r] = await e.processTraderSignal(buy);
  assert.equal(r.status, 'filled', JSON.stringify(r));
  const pos = e.positions.find((p) => p.tokenAddress === mint);
  pos.currentPriceUsd = traderExit;
  const sell = { chainId: 'solana', side: 'sell', sellSharePct: 100, traderWallet: f.traderWallet, signature: `s${i}`, token: tok(traderExit, mint) };
  await e.processTraderSignal(sell);
  assert.equal(pos.remainingTokens, 0);
  return pos;
}

test('scorecard: win rate, hold time, entry/exit slip and delay come from the copies', async () => {
  const { e, f } = setup();
  for (let i = 0; i < 4; i++) await roundTrip(e, f, i, { ourEntry: 1.05, traderExit: i < 3 ? 1.3 : 0.8, lag: 3 });
  const sc = e.traderScorecard(f.id);
  assert.equal(sc.trades, 4);
  assert.equal(sc.wins, 3);
  assert.equal(sc.losses, 1);
  assert.equal(sc.winRatePct, 75);
  assert.ok(sc.avgEntrySlipPct > 4 && sc.avgEntrySlipPct < 7, `entry slip ~5% (${sc.avgEntrySlipPct})`);
  assert.ok(sc.avgExitSlipPct <= 0 && sc.measuredExits === 4, `mirror exits measured, never above the trader (${sc.avgExitSlipPct})`);
  assert.equal(sc.avgLagSec, 3);
  assert.ok(Number.isFinite(sc.avgHoldSec));
  assert.ok(e.getStateSnapshot().traderScores[f.id].trades === 4, 'sent to the browser');
});

test('auto-pause: a trader the bot falls far behind is paused after enough copies; resume judges fresh trades', async () => {
  const { e, f } = setup();
  e.settings.scorecard = { autoPause: true, minTrades: 3, maxSlipPct: 20, maxLagSec: 10 };
  for (let i = 0; i < 2; i++) await roundTrip(e, f, i, { ourEntry: 1.4, traderExit: 1.5 });
  assert.equal(f.status, 'copying', 'not judged before 3 copies');
  await roundTrip(e, f, 2, { ourEntry: 1.4, traderExit: 1.5 });
  assert.equal(f.status, 'paused');
  assert.equal(f.pauseReason, 'slow');
  assert.match(f.pauseDetail, /lose/);
  assert.ok(e.alerts.some((a) => /can't keep up/.test(a.title)));
  // a buy while paused is not copied
  const [r] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: 'bx', ageSec: 1, token: tok(1, `${MINT.slice(0, -4)}9999`) });
  assert.equal(r.status, 'skipped');
  // resumed: only trades after the resume count
  f.status = 'copying';
  f.pauseReason = null;
  f.scoreSince = Date.now() + 1;
  await new Promise((res) => setTimeout(res, 5));
  await roundTrip(e, f, 10, { ourEntry: 1.02, traderExit: 1.5 });
  assert.equal(f.status, 'copying', 'old slow trades do not re-pause it');
});

test('auto-pause: slow detection alone also pauses; auto-pause off only reports', async () => {
  const { e, f } = setup();
  e.settings.scorecard = { autoPause: true, minTrades: 2, maxSlipPct: 50, maxLagSec: 10 };
  for (let i = 0; i < 2; i++) await roundTrip(e, f, i, { ourEntry: 1.01, traderExit: 1.2, lag: 25 });
  assert.equal(f.pauseReason, 'slow');
  assert.match(f.pauseDetail, /late/);
  const b = setup();
  b.e.settings.scorecard = { autoPause: false, minTrades: 2, maxSlipPct: 5, maxLagSec: 1 };
  for (let i = 0; i < 3; i++) await roundTrip(b.e, b.f, i, { ourEntry: 1.4, traderExit: 1.5, lag: 30 });
  assert.equal(b.f.status, 'copying');
});

test('missed entry: when the trader’s first buy ran too far to copy, their top-ups are not bought late either', async () => {
  const { e, f } = setup();
  e.settings.copyTopUps = false;
  e.settings.maxChasePct = 25;
  const mint = `${MINT.slice(0, -4)}7777`;
  // trader bought at 1.00, market already at 1.40 when we see it → chased, skipped
  const [a] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 300, signature: 'm1', ageSec: 3, token: { ...tok(1, mint), currentPriceUsd: 1.4 } });
  assert.equal(a.status, 'skipped');
  assert.match(a.reason, /price moved too far/);
  // 2 min later a small top-up at the pumped price must NOT be copied as a fresh entry
  const [b] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 4, signature: 'm2', ageSec: 1, token: tok(1.45, mint) });
  assert.equal(b.status, 'skipped');
  assert.match(b.reason, /too late to copy/);
  assert.equal(e.positions.filter((p) => p.tokenAddress === mint).length, 0);
  // the trader fully exits → their next buy is a fresh entry and is copied
  await e.processTraderSignal({ chainId: 'solana', side: 'sell', sellSharePct: 100, traderWallet: f.traderWallet, signature: 'm3', token: tok(1.2, mint) });
  const [c] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 100, signature: 'm4', ageSec: 1, token: tok(1, mint) });
  assert.equal(c.status, 'filled', JSON.stringify(c));
});

test('per-trader "copy every trade": no chase limit and top-ups copied, other traders keep the account rules', async () => {
  const { e, f } = setup();
  e.settings.copyTopUps = false;
  e.settings.maxChasePct = 25;
  f.maxChasePct = 100000;
  f.copyTopUps = true;
  const mint = `${MINT.slice(0, -4)}8888`;
  // price already ran 60% past the trader → still copied for this trader
  const [a] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 300, signature: 'c1', ageSec: 2, token: { ...tok(1, mint), currentPriceUsd: 1.6 } });
  assert.equal(a.status, 'filled', JSON.stringify(a));
  // top-up copied too
  const [b] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: f.traderWallet, traderBuyUsd: 26, signature: 'c2', ageSec: 1, token: tok(1.7, mint) });
  assert.equal(b.status, 'filled', JSON.stringify(b));
  assert.equal(e.positions.filter((p) => p.tokenAddress === mint).length, 2);
  // a second trader without overrides still uses the 25% account limit
  const g = { ...f, id: 'fol-other', traderWallet: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', maxChasePct: null, copyTopUps: null };
  e.follows.push(g);
  const [c] = await e.processTraderSignal({ chainId: 'solana', side: 'buy', traderWallet: g.traderWallet, traderBuyUsd: 300, signature: 'c3', ageSec: 2, token: { ...tok(1, `${MINT.slice(0, -4)}9998`), currentPriceUsd: 1.6 } });
  assert.equal(c.status, 'skipped');
  assert.match(c.reason, /price moved too far/);
});

test('date filter: traderScorecard and pnlSummary filter performance per trader wallet by date range', async () => {
  const { e, f } = setup();
  const f2 = {
    ...f,
    id: 'fol-sc-2',
    name: 't2',
    handle: 'trader2',
    traderWallet: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  };
  e.follows.push(f2);

  await roundTrip(e, f, 101, { ourEntry: 1.02, traderExit: 1.5, lag: 1 });
  await roundTrip(e, f2, 102, { ourEntry: 1.1, traderExit: 0.7, lag: 4 });
  const day1 = new Date('2026-10-25T12:00:00Z').getTime();
  const day2 = new Date('2026-11-01T12:00:00Z').getTime();
  e.realizedLog[0].t = day1;
  e.realizedLog[1].t = day1 + 5000;

  await roundTrip(e, f, 103, { ourEntry: 1.08, traderExit: 0.6, lag: 2 });
  await roundTrip(e, f2, 104, { ourEntry: 1.01, traderExit: 1.8, lag: 1 });
  e.realizedLog[2].t = day2;
  e.realizedLog[3].t = day2 + 5000;

  const day1Summary = e.pnlSummary({ from: day1 - 1000, to: day1 + 60_000, paper: true });
  assert.equal(day1Summary.traderScores[f.id].trades, 1);
  assert.equal(day1Summary.traderScores[f.id].wins, 1);
  assert.equal(day1Summary.traderScores[f.id].losses, 0);
  assert.equal(day1Summary.traderScores[f.id].losingStreak, 0);
  assert.ok(day1Summary.traderScores[f.id].pnlUsd > 0);

  assert.equal(day1Summary.traderScores[f2.id].trades, 1);
  assert.equal(day1Summary.traderScores[f2.id].wins, 0);
  assert.equal(day1Summary.traderScores[f2.id].losses, 1);
  assert.equal(day1Summary.traderScores[f2.id].losingStreak, 1);
  assert.ok(day1Summary.traderScores[f2.id].pnlUsd < 0);

  const day2Summary = e.pnlSummary({ from: day2 - 1000, to: day2 + 60_000, paper: true });
  assert.equal(day2Summary.traderScores[f.id].trades, 1);
  assert.equal(day2Summary.traderScores[f.id].wins, 0);
  assert.equal(day2Summary.traderScores[f.id].losses, 1);
  assert.equal(day2Summary.traderScores[f.id].losingStreak, 1);
  assert.ok(day2Summary.traderScores[f.id].pnlUsd < 0);

  assert.equal(day2Summary.traderScores[f2.id].trades, 1);
  assert.equal(day2Summary.traderScores[f2.id].wins, 1);
  assert.equal(day2Summary.traderScores[f2.id].losses, 0);
  assert.equal(day2Summary.traderScores[f2.id].losingStreak, 0);
  assert.ok(day2Summary.traderScores[f2.id].pnlUsd > 0);
});
