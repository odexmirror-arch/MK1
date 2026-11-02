// Dax report agent: findings and report built from realistic trade data (offline).
// Run: node --test test/dax.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, fastScalpExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';
import { buildDaxReport, daxPeriod } from '../engine/dax.mjs';
import { serializeEngine, restoreEngine } from '../engine/persistence.mjs';

CHAINS.solana.nativePriceUsd = 100;
const DECU = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const NOW = Date.now();
const min = (m) => NOW - m * 60_000;

function world() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  const f = { id: 'fol-decu', handle: 'Decu', traderWallet: DECU, chainId: 'solana', status: 'copying', mode: 'auto-exit', sizing: { type: 'fixed', amount: 10 }, slPct: 30, exitRules: fastScalpExitRules(), maxChasePct: 25, walletId: e.getActiveWallet().id };
  e.follows.push(f);
  // closed real trades: [symbol, mint, pnlUsd, cause, closedMinAgo]
  const trades = [
    ['ROBODICK', 'Robo1111111111111111111111111111111111pump', -5.39, 'stop-loss hit', 50],
    ['Alone', 'Alon1111111111111111111111111111111111pump', -1.48, 'stop-loss hit', 40],
    ['ONE', 'One11111111111111111111111111111111111pump', 6.87, 'initials taken off', 30],
  ];
  for (const [sym, mint, pnl, cause, ago] of trades) {
    e.positions.push({ id: `pos-${sym}`, followId: f.id, traderHandle: 'Decu', traderWallet: DECU, chainId: 'solana', isPaper: false, tokenAddress: mint, symbol: sym, initialCostUsd: 10.15, soldUsd: 10.15 + pnl, realizedPnlUsd: pnl, remainingTokens: 0, initialTokens: 1e6, entryPriceUsd: 0.00001, peakPriceUsd: 0.000011, openedAt: min(ago + 2), closedAt: min(ago), closeCause: cause, entrySlipPct: 4, detectLagSec: 3 });
    e.realizedLog.push({ t: min(ago), pnl, paper: false, sym, closes: true, posPnl: pnl, cost: 10.15, fid: f.id, sol: pnl / 100 });
  }
  // Decu's own trades (the trader log), incl. a winner we skipped
  const log = (mint, sym, side, px, ago, copies) => e.logTraderTrade({ wallet: DECU, tokenMint: mint, symbol: sym, side, txPriceUsd: px, usdValue: 300, sellSharePct: side === 'sell' ? 100 : undefined, detectedAt: min(ago), latencySec: 3 }, copies);
  const ok = [{ followId: f.id, ok: true }];
  log(trades[0][1], 'ROBODICK', 'buy', 1, 53, ok);
  log(trades[0][1], 'ROBODICK', 'sell', 0.25, 49, [{ followId: f.id, ok: false, reason: "Auto-Exit mode manages exits itself, so trader sells aren't copied" }]);
  log(trades[1][1], 'Alone', 'buy', 1, 43, ok);
  log(trades[1][1], 'Alone', 'sell', 1.216, 38, [{ followId: f.id, ok: false, reason: 'x' }]);
  log(trades[2][1], 'ONE', 'buy', 1, 33, ok);
  log(trades[2][1], 'ONE', 'sell', 0.99, 31, [{ followId: f.id, ok: false, reason: 'x' }]);
  const W = 'Wagm1111111111111111111111111111111111pump';
  log(W, 'WAGMI', 'buy', 1, 25, [{ followId: f.id, ok: false, reason: 'price moved too far before we could copy' }]);
  log(W, 'WAGMI', 'sell', 1.68, 20, [{ followId: f.id, ok: false, reason: 'nothing tracked to sell for this holding' }]);
  const realTrader = { status: () => ({ configured: true, address: 'GYCufnfQjneBCx4aHERFCNzdoyiLM7p1NVrK5RLDG2od', balance: { sol: 0.158, usdc: 0 }, caps: { reserveSol: 0.02, maxSolPerTrade: 0.5, maxSolPerDay: 2 }, spent24hSol: 1.95, trades: [{ t: min(10), ok: false, error: 'swap did not go through: Jupiter code -1000' }, { t: min(30), ok: true, timing: { quoteMs: 420, sendMs: 1600 } }] }) };
  return { e, f, realTrader };
}

test('DX1 Dax finds the exit overshoot, the shake-out, the skipped winner, low wallet and the daily limit', () => {
  const { e, realTrader } = world();
  const r = buildDaxReport({ engine: e, realTrader, live: { signals: [] } }, { period: '24h', now: NOW });
  const all = r.findings.map((f) => f.text).join('\n');
  assert.match(all, /Real SOL: 3 trades, 1 won \/ 2 lost \(33% win rate\), −\$0\.00|Real SOL: 3 trades, 1 won \/ 2 lost/);
  // ROBODICK: −53.1% on a 30% stop = 23 points past the limit
  assert.equal(r.data.overshoots.length, 1);
  assert.equal(r.data.overshoots[0].sym, 'ROBODICK');
  assert.ok(Math.abs(r.data.overshoots[0].overPct - 23.1) < 0.2, String(r.data.overshoots[0].overPct));
  assert.match(all, /sold well past the limit/);
  // Alone: we lost 14.6%, Decu made +21.6% → shaken out
  assert.match(all, /\$Alone ours −15% vs theirs \+22%/);
  // WAGMI: skipped (price moved too far) while Decu made +68%
  assert.match(all, /\$WAGMI \+68%/);
  assert.match(all, /raise "Max chase"/);
  // wallet: 0.158 SOL, typical buy 0.1015 SOL, 0.02 kept → 1 buy left
  assert.equal(r.data.wallet.buysLeft, 1);
  assert.match(all, /enough for about 1 more real buy/);
  assert.match(all, /Daily real-SOL limit nearly or fully used/);
  assert.match(all, /1 real order failed/);
  // markdown sections and the per-trade data block for analysis
  for (const h of ["## Dax's findings", '## Results', '## Bot wallet', '## Traders', '## Exits past their limit', '## By exit', '## Speed', '## All closed trades (for analysis)']) assert.ok(r.markdown.includes(h), h);
  assert.match(r.markdown, /\| \$Alone \| real \| −14\.6% .* \| \+21\.6% \|/);
  assert.ok(r.markdown.split('\n').some((l) => l.includes(',real,Decu,ROBODICK,')), 'csv row');
  assert.ok(r.summaryText.length < 3500, 'fits a Telegram / Discord message with room to spare');
  // nothing secret in the report
  assert.ok(!/api-key|ODEX_TRADER_KEY|webhooks\//i.test(r.markdown));
});

test('DX2 period presets and an empty period', () => {
  const fixedNow = Date.UTC(2026, 9, 26, 20, 0, 0);
  assert.equal(daxPeriod('7d', fixedNow).from, fixedNow - 7 * 86400000);
  assert.equal(daxPeriod('today', fixedNow).from, Date.UTC(2026, 9, 26));
  assert.equal(daxPeriod('nonsense', fixedNow).preset, '24h');
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  const r = buildDaxReport({ engine: e }, { period: '24h', now: fixedNow });
  assert.match(r.findings[0].text, /No trades closed/);
  assert.ok(r.markdown.startsWith('# Dax report — Last 24 hours'));
});

test('DX3 the trader log is saved and restored with the engine, and trimmed to 7 days', () => {
  const { e } = world();
  e.logTraderTrade({ wallet: DECU, tokenMint: 'Old11111111111111111111111111111111111pump', side: 'buy', txPriceUsd: 1, usdValue: 5, detectedAt: Date.now() - 8 * 86400000 }, []);
  e.logTraderTrade({ wallet: DECU, tokenMint: 'New11111111111111111111111111111111111pump', side: 'buy', txPriceUsd: 1, usdValue: 5, detectedAt: Date.now() }, []);
  assert.ok(!e.traderLog.some((x) => x.mint.startsWith('Old')), 'older than 7 days dropped');
  const saved = JSON.parse(JSON.stringify(serializeEngine(e)));
  const e2 = new CopyTradingEngine();
  e2.resetToCleanState();
  restoreEngine(e2, saved);
  assert.equal(e2.traderLog.length, e.traderLog.length);
  // backfill signals are never logged
  const n = e2.traderLog.length;
  e2.logTraderTrade({ wallet: DECU, tokenMint: 'X', side: 'buy', backfill: true }, []);
  assert.equal(e2.traderLog.length, n);
});

test('DX4 Dax numbers first entries and re-entries and compares them', () => {
  const { e, f } = world();
  const mint = 'Goon1111111111111111111111111111111111pump';
  const mk = (id, openedAgo, pnl) => {
    e.positions.push({ id, followId: f.id, traderHandle: 'Decu', traderWallet: f.traderWallet, chainId: 'solana', isPaper: false, tokenAddress: mint, symbol: 'gooning', initialCostUsd: 10, soldUsd: 10 + pnl, remainingTokens: 0, initialTokens: 1e6, entryPriceUsd: 1e-5, peakPriceUsd: 1e-5, openedAt: min(openedAgo), closedAt: min(openedAgo - 1), closeCause: pnl > 0 ? 'initials taken off' : 'floor hit' });
  };
  mk('g1', 49, -2.89);
  mk('g2', 48, 0.91);
  mk('g3', 46, -3.63);
  const r = buildDaxReport({ engine: e, live: { signals: [] } }, { period: '24h', now: NOW });
  const g = r.data.closed.filter((c) => c.sym === 'gooning').sort((a, b) => a.openedAt - b.openedAt);
  assert.deepEqual(g.map((c) => c.entryNo), [1, 2, 3]);
  assert.equal(r.data.entries.real.re.n, 2);
  assert.ok(Math.abs(r.data.entries.real.re.pnl - (0.91 - 3.63)) < 1e-9);
  assert.match(r.markdown, /## First entries vs re-entries/);
  assert.match(r.findings.map((x) => x.text).join('\n'), /Real re-entries .*2 trades, 50% won/);
  assert.ok(r.markdown.includes(',real,Decu,gooning,' + mint + ',2,'), 'entry number in the CSV');
});
