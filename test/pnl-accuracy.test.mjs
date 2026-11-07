// PnL accuracy: paper copies never fill below the trader, and every fee is counted in PnL.
// Run: node --test test/pnl-accuracy.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';

let seq = 0;
function setup() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  e.settings.cooldown.enabled = false;
  e.settings.tradingAsset.solana = 'native'; // pays SOL gas, like the real setup
  const f = {
    id: `fol-${++seq}`, walletId: e.getActiveWallet().id, name: 't', handle: 't',
    traderWallet: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ', chainId: 'solana', status: 'copying',
    pauseReason: null, mode: 'buy-hold', sizing: { type: 'fixed', amount: 50 }, tpPct: null, slPct: null,
    minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 10000, consecutiveLosses: 0,
    exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);
  return { e, f };
}
const sig = (f, token) => ({
  chainId: 'solana', side: 'buy', traderHandle: f.handle, traderWallet: f.traderWallet, traderBuyUsd: 100,
  token: { symbol: 'X', name: 'X', isLaunchpad: true, stage: 'pre-grad', marketCapUsd: 50_000, safety: { safetyVerified: true }, ...token },
});

test('copy buy never fills below the trader when the market feed lags', async () => {
  const { e, f } = setup();
  // feed says 0.000009, trader really paid 0.000019 (stale cached price)
  await e.processTraderSignal(sig(f, { address: 'lagMint1', traderFillPriceUsd: 0.000019, currentPriceUsd: 0.000009 }));
  const p = e.positions[0];
  assert.ok(p, 'position opened');
  assert.ok(p.entryPriceUsd >= 0.000019, `entry ${p.entryPriceUsd} must be ≥ trader fill`);
  assert.ok(e.history[0].chaseGapPct >= 0);
});

test('a second copy of the same token within 30 s fills no cheaper than our first', async () => {
  const { e, f } = setup();
  e.settings.copyTopUps = true; // two copies of one coin
  await e.processTraderSignal(sig(f, { address: 'stackMint', traderFillPriceUsd: 0.00001, currentPriceUsd: 0.00001 }));
  const first = e.positions[0].entryPriceUsd;
  await e.processTraderSignal(sig(f, { address: 'stackMint', traderFillPriceUsd: 0.00001, currentPriceUsd: 0.00001 }));
  const second = e.positions[0].entryPriceUsd;
  assert.equal(e.positions.length, 2);
  assert.ok(second > first, `second fill ${second} should be above first ${first}`);
});

test('buy network fee is part of cost basis; balance and PnL reconcile on a round trip', async () => {
  const { e, f } = setup();
  const w = e.getActiveWallet();
  const start = w.paperBalanceUsd;
  await e.processTraderSignal(sig(f, { address: 'rtMint', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  const p = e.positions[0];
  const buy = e.history[0];
  assert.ok(buy.networkFeeUsd > 0);
  assert.equal(p.initialCostUsd, Number((50 + buy.networkFeeUsd).toFixed(4)));
  const r = await e.executePositionSell(p.id, { sellPct: 100 });
  assert.ok(r.ok !== false);
  const sell = e.history[0];
  // fee = real Jupiter-trade rate on what the sale actually filled at (non-pump pool 0.25% + Jupiter 0.5%)
  assert.ok(Math.abs(sell.platformFeeUsd - sell.tokens * sell.fillPriceUsd * 0.0075) < 1e-9);
  assert.ok(Math.abs(buy.platformFeeUsd - 50 * 0.0075) < 1e-9);
  // first buy of the token pays token-account rent (0.00203928 SOL) on top of gas
  assert.ok(buy.networkFeeUsd > 0.00203928 * 100, `buy network fee ${buy.networkFeeUsd} includes rent`);
  // balance change equals realized PnL (to rounding)
  assert.ok(Math.abs((w.paperBalanceUsd - start) - p.realizedPnlUsd) <= 0.02, `${w.paperBalanceUsd - start} vs ${p.realizedPnlUsd}`);
});

test('open PnL subtracts the fees selling now would cost', async () => {
  const { e, f } = setup();
  await e.processTraderSignal(sig(f, { address: 'openMint', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  const s = e.getStateSnapshot();
  const p = s.positions[0];
  // network part = what a real Jupiter swap pays (~0.00003 SOL), not the Priority Fee preset
  assert.ok(Math.abs(p.exitFeesUsd - (p.valueUsd * 0.0075 + 0.00003 * 185)) < 0.02, `exit fees ${p.exitFeesUsd}`);
  assert.ok(Math.abs(p.unrealizedPnlUsd - (p.valueUsd - p.exitFeesUsd - p.remainingCostUsd)) <= 0.02);
  assert.ok(Math.abs(s.positionsSummary.unrealizedPnlUsd - p.unrealizedPnlUsd) <= 0.02);
});

test('a lagging market feed cannot fake a crash after a real on-chain fill (Larpoors case)', async () => {
  const { e, f } = setup();
  f.mode = 'auto-exit';
  f.exitRules.floor = { enabled: true, openingFloorPct: 30, tightFloorPct: 30, tightensAfterSec: 9999 };
  const mint = 'FpXw6HxyTyW11de5cs76VuSiLdUFVR4fJbW4duDmpump';
  await e.processTraderSignal(sig(f, { address: mint, traderFillPriceUsd: 0.00001015, currentPriceUsd: 0.00001015 }));
  e.observeTradePrice(mint, 0.00001015);
  const p = e.positions[0];
  // DexScreener still shows the old price from a minute ago
  const feed = (px) => async () => ({ ok: true, json: async () => ({ pairs: [{ baseToken: { address: mint }, priceUsd: String(px), liquidity: { usd: 5000 }, marketCap: 3700 }] }) });
  e.priceFetch = feed(0.00000367);
  await e.tickMarketPrices();
  assert.ok(p.remainingTokens > 0, 'no fake floor exit');
  assert.ok(Math.abs(p.currentPriceUsd - 0.00001015) < 1e-12, 'kept the real on-chain price');
  // a feed price close to the real fill is still used
  e.priceFetch = feed(0.0000105);
  await e.tickMarketPrices();
  assert.equal(p.currentPriceUsd, 0.0000105);
});

test('paper fee tiers follow the real venues', async () => {
  const { solanaTradeFeePct } = await import('../engine/chainAdapters.mjs');
  const now = Date.now();
  assert.equal(solanaTradeFeePct({ address: 'xpump', stage: 'pre-grad' }, now).totalPct, 1.75);
  assert.equal(solanaTradeFeePct({ address: 'xpump', stage: 'graduated', marketCapUsd: 50_000, createdAt: now - 2 * 86_400_000 }, now).totalPct, 1.35);
  assert.equal(solanaTradeFeePct({ address: 'xpump', stage: 'graduated', marketCapUsd: 50_000_000, createdAt: now - 2 * 86_400_000 }, now).totalPct, 0.4);
  assert.equal(solanaTradeFeePct({ address: 'RaydiumTokenMint', stage: 'graduated', createdAt: now - 3 * 86_400_000 }, now).totalPct, 0.35);
  // a second buy of a token already held opens no new token account
  const { e, f } = setup();
  await e.processTraderSignal(sig(f, { address: 'rentMint', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  const first = e.history[0].networkFeeUsd;
  await new Promise((r) => setTimeout(r, 5));
  await e.processTraderSignal(sig(f, { address: 'rentMint', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  assert.ok(e.history[0].networkFeeUsd < first);
});

test('pump.fun curve: a copy fills after the trader moved the curve, plus its own move', async () => {
  const { CHAINS } = await import('../engine/chainAdapters.mjs');
  const { pumpCurveCopyFill } = await import('../engine/pumpCurve.mjs');
  const before = CHAINS.solana.nativePriceUsd;
  CHAINS.solana.nativePriceUsd = 108;
  try {
    // José case: trader 0.26 SOL at $0.00001047 → we should land ~1.2% above them, not 0.2%
    const c = pumpCurveCopyFill({ traderPriceUsd: 0.00001047, traderSol: 0.26, ourSol: 0.455, solPriceUsd: 108 });
    const gap = (c.fillPriceUsd / 0.00001047 - 1) * 100;
    assert.ok(gap > 1 && gap < 1.6, `gap ${gap}`);
    // a 5 SOL trader buy moves the curve a lot
    const big = pumpCurveCopyFill({ traderPriceUsd: 0.00003, traderSol: 5, ourSol: 0.455, solPriceUsd: 108 });
    assert.ok((big.fillPriceUsd / 0.00003 - 1) * 100 > 4); // deep pool (~92 SOL): +5.9%
    // prices that don't fit a curve (graduated coins) are left to the normal model
    assert.equal(pumpCurveCopyFill({ traderPriceUsd: 0.01, traderSol: 1, ourSol: 0.5, solPriceUsd: 108 }), null);

    const { e, f } = setup();
    await e.processTraderSignal({ ...sig(f, { address: 'JoseMint1pump', traderFillPriceUsd: 0.00001047, currentPriceUsd: 0.00001047 }), traderBuyNative: 0.26 });
    const entryGap = (e.positions[0].entryPriceUsd / 0.00001047 - 1) * 100;
    assert.ok(entryGap > 1 && entryGap < 1.6, `engine entry gap ${entryGap}`);
  } finally {
    CHAINS.solana.nativePriceUsd = before;
  }
});

test('one copy per trader position: top-ups are not copied until the trader fully sells (ACTX case)', async () => {
  const { e, f } = setup();
  f.mode = 'auto-exit';
  const mint = 'ActxMint11111111111111111111111111111111pump';
  const buy = (sol) => ({ ...sig(f, { address: mint, traderFillPriceUsd: 0.00001, currentPriceUsd: 0.00001 }), traderBuyNative: sol });
  await e.processTraderSignal(buy(2.5)); // real entry → copied
  assert.equal(e.positions.length, 1);
  await e.executePositionSell(e.positions[0].id, { sellPct: 100, cause: 'trailing stop hit' }); // our exit
  await e.processTraderSignal(buy(0.025)); // trader top-up → not a new position
  await e.processTraderSignal(buy(0.035));
  assert.equal(e.positions.length, 1, 'top-ups did not open new positions');
  assert.match(e.history[0].reason, /top-ups not copied/);
  // trader sells everything → next buy is a fresh entry
  await e.processTraderSignal({ chainId: 'solana', side: 'sell', traderHandle: f.handle, traderWallet: f.traderWallet, sellSharePct: 100, token: { address: mint, symbol: 'X' } });
  await e.processTraderSignal(buy(1));
  assert.equal(e.positions.length, 2, 'new trader entry copied after their full exit');
  // switch on to copy every top-up
  e.settings.copyTopUps = true;
  await e.processTraderSignal(buy(0.03));
  assert.equal(e.positions.length, 3);
});

test('storage: closed trades and history older than 2 days are removed; open positions and the PnL calendar log stay', async () => {
  const { e, f } = setup();
  e.settings.copyTopUps = true;
  await e.processTraderSignal(sig(f, { address: 'oldMint', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  await e.executePositionSell(e.positions[0].id, { sellPct: 100 });
  await e.processTraderSignal(sig(f, { address: 'openMint2', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
  const logBefore = e.realizedLog.length;
  const later = Date.now() + 2 * 86_400_000 + 60_000;
  const r = e.pruneOldRecords(2 * 86_400_000, later);
  assert.equal(r.closedPositions, 1);
  assert.ok(r.history >= 2);
  assert.equal(e.positions.length, 1, 'open position kept');
  assert.ok(e.positions[0].remainingTokens > 0);
  assert.equal(e.realizedLog.length, logBefore, 'PnL calendar history kept');
});

test('PnL figures agree: period summary = calendar = sum of closed trades; partial sells count as one trade', async () => {
  const { e, f } = setup();
  e.settings.copyTopUps = true;
  const results = [];
  for (const [i, mult] of [1.4, 0.7, 1.1].entries()) {
    await e.processTraderSignal(sig(f, { address: `syncMint${i}`, traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
    const p = e.positions[0];
    p.currentPriceUsd = p.entryPriceUsd * mult;
    await e.executePositionSell(p.id, { sellPct: 50 }); // partial
    await e.executePositionSell(p.id, { sellPct: 100 }); // rest
    results.push(p);
  }
  const s = e.pnlSummary({ from: 0, to: 0, paper: true });
  const fromPositions = results.reduce((a, p) => a + (p.soldUsd - p.initialCostUsd), 0);
  const now = new Date();
  const cal = e.pnlCalendar({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, tzOffsetMin: 0, paper: true });
  assert.ok(Math.abs(s.realized - fromPositions) <= 0.03, `summary ${s.realized} vs positions ${fromPositions}`);
  assert.ok(Math.abs(s.realized - cal.total) < 0.005, `summary ${s.realized} vs calendar ${cal.total}`);
  assert.equal(s.trades, 3, 'three trades, not six sells');
  assert.equal(s.sells, 6);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.copiedBuys, 3);
});

test('paper mode matches real-SOL execution delay and post-delay curve price on both buy and trader sell', async () => {
  const { e, f } = setup();
  f.mode = 'mirror';
  f.maxChasePct = 35; // allow +28.55% post-delay curve spike in this test
  const mint = 'SnowmeiMint1111111111111111111111111111pump';
  e.adapter.paperDelayMs = () => 60;
  let liveCurvePrice = 0.00000815; // spiked while waiting 60 ms on buy
  e.adapter.paperLiveFillPrice = async ({ side, fillPriceUsd }) =>
    side === 'buy' ? Math.max(fillPriceUsd, liveCurvePrice) : Math.min(fillPriceUsd, liveCurvePrice);

  const t0 = Date.now();
  await e.processTraderSignal({
    ...sig(f, { address: mint, traderFillPriceUsd: 0.00000634, currentPriceUsd: 0.00000634 }),
    traderBuyNative: 3.0,
  });
  const buyElapsed = Date.now() - t0;
  assert.ok(buyElapsed >= 50, `paper buy waited for real-SOL execution delay (${buyElapsed} ms)`);
  const pos = e.positions[0];
  assert.equal(pos.entryPriceUsd, 0.00000815, 'paper buy filled at post-delay spiked curve price');

  // Trader dumps 3 SOL at $0.00000676, crashing post-delay curve price to $0.00000532
  liveCurvePrice = 0.00000532;
  const t1 = Date.now();
  await e.processTraderSignal({
    chainId: 'solana',
    side: 'sell',
    traderHandle: f.handle,
    traderWallet: f.traderWallet,
    sellSharePct: 100,
    traderBuyNative: 3.12,
    token: { address: mint, symbol: 'Snowmei', traderFillPriceUsd: 0.00000676, currentPriceUsd: 0.00000676 },
  });
  const sellElapsed = Date.now() - t1;
  assert.ok(sellElapsed >= 50, `paper sell waited for real-SOL execution delay (${sellElapsed} ms)`);
  assert.equal(e.history[0].fillPriceUsd, 0.00000532, 'paper sell filled at post-dump curve price');
  assert.ok(pos.realizedPnlUsd < 0, 'paper mode records the same loss as real SOL when whale dumps a micro-curve');
});

test('paper mode enforces maxChasePct ceiling when post-delay live curve price spikes past the limit', async () => {
  const { e, f } = setup();
  f.maxChasePct = 20;
  const mint = 'SpikedMint11111111111111111111111111111pump';
  e.adapter.paperDelayMs = () => 10;
  e.adapter.paperLiveFillPrice = async ({ side, fillPriceUsd }) =>
    side === 'buy' ? Math.max(fillPriceUsd, 0.0000095) : fillPriceUsd; // +49.8% above trader's 0.00000634

  const [res] = await e.processTraderSignal({
    ...sig(f, { address: mint, traderFillPriceUsd: 0.00000634, currentPriceUsd: 0.00000634 }),
    traderBuyNative: 1.5,
  });
  assert.equal(res.status, 'skipped', 'paper buy skipped when post-delay curve price exceeds maxChasePct');
  assert.match(res.reason, /price moved too far before we could copy/);
  assert.equal(e.positions.length, 0, 'no paper position opened above maxChasePct ceiling');
});

test('date filter, PnL calendar SOL, PnL summary SOL, and Dax custom filter range stay connected even after SOL price moves', async () => {
  const { buildDaxReport } = await import('../engine/dax.mjs');
  const { CHAINS } = await import('../engine/chainAdapters.mjs');
  const prevPx = CHAINS.solana.nativePriceUsd;
  try {
    const { e, f } = setup();
    e.settings.copyTopUps = true;
    CHAINS.solana.nativePriceUsd = 200; // $200/SOL at trade time
    const tStart = Date.now() - 1000;
    await e.processTraderSignal(sig(f, { address: 'connMint1pump', traderFillPriceUsd: 0.00002, currentPriceUsd: 0.00002 }));
    const p1 = e.positions[0];
    p1.currentPriceUsd = p1.entryPriceUsd * 1.5; // +50% win
    await e.executePositionSell(p1.id, { sellPct: 100 });
    const tEnd = Date.now() + 1000;

    // Later, SOL price halves to $100 — historical trade SOL PnL must remain exact!
    CHAINS.solana.nativePriceUsd = 100;
    const sum = e.pnlSummary({ from: tStart, to: tEnd, paper: true });
    const now = new Date();
    const cal = e.pnlCalendar({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, tzOffsetMin: 0, paper: true });
    const daxRep = buildDaxReport({ engine: e }, { period: 'filter', from: tStart, to: tEnd, label: 'Custom Range' });

    assert.equal(sum.solExact, true);
    assert.equal(cal.solExact, true);
    assert.ok(Math.abs(sum.realizedSol - cal.totalSol) <= 0.0002, `summary SOL ${sum.realizedSol} vs calendar SOL ${cal.totalSol}`);
    assert.ok(Math.abs(sum.realizedSol - cal.winsSol) <= 0.0002, `winsSol ${cal.winsSol} matches exact trade SOL`);
    assert.equal(daxRep.period.preset, 'filter');
    assert.equal(daxRep.period.label, 'Custom Range');
    assert.equal(daxRep.period.from, tStart);
    assert.equal(daxRep.period.to, tEnd);
  } finally {
    CHAINS.solana.nativePriceUsd = prevPx;
  }
});



