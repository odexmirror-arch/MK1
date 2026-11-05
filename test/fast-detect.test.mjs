// Fast trade detection: pump.fun trades read from pushed logs, with the fake-trade guards.
// Run: node --test test/fast-detect.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  pumpTradeFromLogs,
  swapFromPumpTrade,
  pumpSwapTradeFromLogs,
  swapFromPumpSwapTrade,
  decodeTradeEvent,
  PUMP_PROGRAM,
  PUMP_AMM_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  PUMP_SWAP_BUY_EVENT,
  PUMP_SWAP_SELL_EVENT,
  PUMP_SWAP_POOL_DISC,
} from '../engine/pumpLogs.mjs';
import { SolanaWalletWatcher } from '../engine/walletWatcher.mjs';
import { base58Encode, base58Decode, findProgramAddress } from '../engine/onchainMeta.mjs';
import { CopyTradingEngine } from '../engine/copyEngine.mjs';

const TRADER = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = base58Encode(crypto.createHash('sha256').update('odex-fast-mint').digest());
const EVIL = 'Evi1111111111111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const u64 = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const pk = (s) => Buffer.from(base58Decode(s));
/** A full current-layout TradeEvent, as pump.fun logs it ("Program data: <base64>"). */
function tradeEvent({ mint = MINT, sol = 500_000_000n, tokens = 5_000_000_000_000n, isBuy = true, user = TRADER, quoteMint = WSOL, fee = 5_000_000n, creatorFee = 1_500_000n } = {}) {
  const name = Buffer.from(isBuy ? 'buy_exact_quote_in_v3' : 'sell_v3');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  return Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
    pk(mint), u64(sol), u64(tokens), Buffer.from([isBuy ? 1 : 0]), pk(user), u64(Math.floor(Date.now() / 1000)),
    u64(31_000_000_000n), u64(1_030_000_000_000_000n), u64(1_000_000_000n), u64(750_000_000_000_000n),
    pk('11111111111111111111111111111111'), u64(95), u64(fee), pk(OTHER), u64(30), u64(creatorFee),
    Buffer.from([1]), u64(0), u64(0), u64(0), u64(0), len, name,
    Buffer.from([0]), u64(0), u64(0), u64(0), u64(0), Buffer.alloc(4), pk(quoteMint), u64(sol),
  ]).toString('base64');
}
/** Logs for a trade going through a router, with pump.fun's event inside pump.fun's own frame. */
function logs(eventB64 = tradeEvent(), { router = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', extra = [] } = {}) {
  return [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    `Program ${router} invoke [1]`,
    `Program ${PUMP_PROGRAM} invoke [2]`,
    'Program log: Instruction: BuyExactQuoteInV3',
    `Program data: ${eventB64}`,
    `Program ${PUMP_PROGRAM} invoke [3]`,
    `Program ${PUMP_PROGRAM} consumed 2000 of 150000 compute units`,
    `Program ${PUMP_PROGRAM} success`,
    `Program ${PUMP_PROGRAM} consumed 40000 of 180000 compute units`,
    `Program ${PUMP_PROGRAM} success`,
    ...extra,
    `Program ${router} success`,
  ];
}

test('FD1 a genuine pump.fun buy is read from the logs: coin, side, SOL to the curve, wallet SOL with fees', () => {
  const r = pumpTradeFromLogs(logs(), TRADER);
  assert.ok(r.trade, r.skip);
  assert.equal(r.trade.mint, MINT);
  assert.equal(r.trade.isBuy, true);
  const s = swapFromPumpTrade(r.trade, { signature: 'sig1' });
  assert.equal(s.side, 'buy');
  assert.equal(s.tokenMint, MINT);
  assert.equal(s.tokenAmount, 5_000_000);
  assert.equal(s.poolQuoteAmount, 0.5);
  assert.ok(Math.abs(s.quoteAmount - 0.5065) < 1e-9, 'fees added for what the trader paid');
  assert.ok(Math.abs(s.priceInQuote - 0.5 / 5_000_000) < 1e-15);
  assert.equal(s.venue, 'pumpfun');
  assert.equal(s.fastDetect, true);
});

test('FD2 FAKE: a trade record written by another program (bait transaction) is ignored', () => {
  const bait = [`Program ${EVIL} invoke [1]`, `Program data: ${tradeEvent()}`, `Program ${EVIL} success`];
  const r = pumpTradeFromLogs(bait, TRADER);
  assert.equal(r.trade, undefined);
  assert.equal(r.forged, true);
  // even with pump.fun called in the same transaction, a record outside pump.fun's frame is fake
  const mixed = [...logs(tradeEvent({ user: OTHER })), `Program ${EVIL} invoke [1]`, `Program data: ${tradeEvent()}`, `Program ${EVIL} success`];
  assert.equal(pumpTradeFromLogs(mixed, TRADER).trade, undefined);
});

test('FD3 FAKE: invoke lines faked as program log text do not fool the stack', () => {
  const fake = [
    `Program ${EVIL} invoke [1]`,
    `Program log: Program ${PUMP_PROGRAM} invoke [2]`,
    `Program data: ${tradeEvent()}`,
    `Program log: Program ${PUMP_PROGRAM} success`,
    `Program ${EVIL} success`,
  ];
  const r = pumpTradeFromLogs(fake, TRADER);
  assert.equal(r.trade, undefined);
  assert.equal(r.forged, true);
});

test('FD4 someone else’s trade, failed / truncated / unfinished logs → not used', () => {
  assert.match(pumpTradeFromLogs(logs(tradeEvent({ user: OTHER })), TRADER).skip, /no pump.fun trade by this wallet/);
  assert.match(pumpTradeFromLogs(logs(), TRADER, { err: { InstructionError: [2, { Custom: 6042 }] } }).skip, /failed/);
  assert.match(pumpTradeFromLogs([...logs().slice(0, 6), 'Log truncated'], TRADER).skip, /truncated/);
  assert.match(pumpTradeFromLogs(logs().slice(0, 9), TRADER).skip, /incomplete/);
  const failed = logs().map((l) => (l === `Program ${PUMP_PROGRAM} success` ? `Program ${PUMP_PROGRAM} failed: custom program error: 0x179a` : l));
  assert.equal(pumpTradeFromLogs(failed, TRADER).trade, undefined);
});

test('FD5 unclear cases use the normal path: two trades, curve completed, coin priced in USDC', () => {
  const two = [...logs(), ...logs(tradeEvent({ isBuy: false }))];
  assert.match(pumpTradeFromLogs(two, TRADER).skip, /several trades/);
  const complete = logs(tradeEvent(), { extra: [`Program ${PUMP_PROGRAM} invoke [2]`, `Program data: ${Buffer.concat([Buffer.from('X3JhnNQumAg=', 'base64'), Buffer.alloc(40)]).toString('base64')}`, `Program ${PUMP_PROGRAM} success`] });
  assert.match(pumpTradeFromLogs(complete, TRADER).skip, /completed/);
  assert.match(pumpTradeFromLogs(logs(tradeEvent({ quoteMint: USDC })), TRADER).skip, /not priced in SOL/);
  // an older, shorter record without the quote mint is still a SOL trade
  const short = Buffer.from(tradeEvent(), 'base64').subarray(0, 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32).toString('base64');
  assert.ok(pumpTradeFromLogs(logs(short), TRADER).trade);
});

test('FD6 sells need the trader’s balance after the trade for the share sold', () => {
  const t = decodeTradeEvent(Buffer.from(tradeEvent({ isBuy: false, tokens: 2_000_000_000_000n }), 'base64').subarray(8));
  assert.equal(swapFromPumpTrade(t, { signature: 's' }), null, 'no balance → normal path');
  const s = swapFromPumpTrade(t, { signature: 's', heldAfterRaw: 6_000_000_000_000n });
  assert.equal(s.side, 'sell');
  assert.equal(s.sellSharePct, 25, 'sold 2M of 8M');
  assert.equal(swapFromPumpTrade(t, { signature: 's', heldAfterRaw: 0n }).sellSharePct, 100);
  assert.ok(s.quoteAmount < s.poolQuoteAmount, 'fees taken off what the trader received');
});

function watcherWorld({ txAppears = true, txFailed = false, heldAfter = null } = {}) {
  const got = [];
  const calls = [];
  const phantoms = [];
  const w = new SolanaWalletWatcher({
    fetchImpl: async () => new Response('{}'),
    tokenInfo: { get: async () => null, solPriceUsd: async () => 200 },
    onSignal: (s) => got.push({ ...s, callsAtSignal: [...calls] }),
  });
  w.onTokenInfoLate = () => {};
  w.running = true;
  w.wallets.set(TRADER, { address: TRADER, label: 'decu', mode: 'full' });
  w.fastDetect = () => true;
  w.confirmDelaysMs = [5, 5];
  w.onPhantomTrade = (p) => phantoms.push(p);
  const ata = findProgramAddress([TRADER, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', MINT].map((x) => Buffer.from(base58Decode(x))), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  w.rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getTransaction') {
      if (!txAppears) return null;
      const tok = { accountIndex: 2, mint: MINT, owner: TRADER, uiTokenAmount: { amount: '5000000000000', decimals: 6 } };
      return {
        slot: 1,
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: txFailed ? { InstructionError: [2, { Custom: 1 }] } : null, fee: 5000, preBalances: [5e9, 0, 0, 1], postBalances: [4.5e9 - 5000, 0, 0, 1], preTokenBalances: [{ ...tok, uiTokenAmount: { amount: '0', decimals: 6 } }], postTokenBalances: [tok] },
        transaction: { signatures: ['x'], message: { accountKeys: [{ pubkey: TRADER }, { pubkey: OTHER }, { pubkey: EVIL }, { pubkey: PUMP_PROGRAM }] } },
      };
    }
    if (method === 'getSignatureStatuses') return { value: [null] };
    if (method === 'getMultipleAccounts') {
      return {
        value: params[0].map((a) => {
          if (a !== ata || heldAfter === null) return null;
          const b = Buffer.alloc(165);
          b.writeBigUInt64LE(BigInt(heldAfter), 64);
          return { data: [b.toString('base64'), 'base64'] };
        }),
      };
    }
    return null;
  };
  return { w, got, calls, phantoms };
}
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('FD7 watcher: buy signal is ready before any getTransaction; confirmed in the background', async () => {
  const { w, got, calls, phantoms } = watcherWorld();
  w.handleStreamLogs(TRADER, { signature: 'fastsig1', err: null, logs: logs(), receivedAt: Date.now() });
  await until(() => got.length === 1);
  assert.equal(got[0].via, 'fast-logs');
  assert.equal(got[0].side, 'buy');
  assert.equal(got[0].tokenMint, MINT);
  assert.ok(!got[0].callsAtSignal.includes('getTransaction'), `no getTransaction before the signal (${got[0].callsAtSignal})`);
  await until(() => w.fastStats.confirmed === 1);
  assert.equal(phantoms.length, 0);
  assert.equal(w.getStatus().stream.fastDetect.hits, 1);
  // the same trade arriving again (poller / second push) is never signalled twice
  w.handleStreamLogs(TRADER, { signature: 'fastsig1', err: null, logs: logs(), receivedAt: Date.now() });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1);
});

test('FD8 watcher: a trade that never confirms, or failed, is reported as a phantom', async () => {
  for (const opts of [{ txAppears: false }, { txFailed: true }]) {
    const { w, got, phantoms } = watcherWorld(opts);
    w.handleStreamLogs(TRADER, { signature: `ph-${opts.txAppears}`, err: null, logs: logs(), receivedAt: Date.now() });
    await until(() => phantoms.length === 1);
    assert.equal(got.length, 1);
    assert.equal(phantoms[0].side, 'buy');
    assert.match(phantoms[0].reason, opts.txFailed ? /failed/ : /never confirmed/);
  }
});

test('FD9 watcher: off by default; fake bait trades never become signals; sells get their share', async () => {
  {
    const { w, got } = watcherWorld();
    w.fastDetect = () => false;
    w.processSignature = async () => null; // normal path stubbed out
    w.handleStreamLogs(TRADER, { signature: 'off1', err: null, logs: logs(), receivedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.fastStats.hits, 0);
    assert.equal(got.length, 0);
    assert.equal(new SolanaWalletWatcher({ fetchImpl: async () => new Response('{}') }).fastDetect(), false, 'default off');
  }
  {
    const { w, got } = watcherWorld({ txAppears: false });
    const normal = [];
    const orig = w.processSignature.bind(w);
    w.processSignature = (wl, sig, o) => (o.knownSwap ? orig(wl, sig, o) : (normal.push(sig), Promise.resolve(null)));
    const bait = [`Program ${EVIL} invoke [1]`, `Program ${PUMP_PROGRAM} invoke [2]`, `Program ${PUMP_PROGRAM} success`, `Program data: ${tradeEvent()}`, `Program ${EVIL} success`];
    w.handleStreamLogs(TRADER, { signature: 'bait1', err: null, logs: bait, receivedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 0, 'no signal from the bait');
    assert.equal(w.fastStats.forged, 1);
    assert.deepEqual(normal, ['bait1'], 'checked the normal (confirmed) way instead');
  }
  {
    const { w, got } = watcherWorld({ heldAfter: 6_000_000_000_000n });
    w.handleStreamLogs(TRADER, { signature: 'sell1', err: null, logs: logs(tradeEvent({ isBuy: false, tokens: 2_000_000_000_000n })), receivedAt: Date.now() });
    await until(() => got.length === 1);
    assert.equal(got[0].side, 'sell');
    assert.equal(got[0].sellSharePct, 25);
  }
});

test('FD10 engine: a phantom buy closes the copy it opened; other positions untouched', async () => {
  const engine = new CopyTradingEngine();
  const sold = [];
  engine.positions = [
    { id: 'p1', traderTx: 'ghost', remainingTokens: 100 },
    { id: 'p2', traderTx: 'real', remainingTokens: 100 },
  ];
  engine.executePositionSell = async (id, opts) => {
    sold.push([id, opts.cause]);
    return { ok: true };
  };
  const r = await engine.handlePhantomTrade({ signature: 'ghost', side: 'buy', mint: MINT, reason: 'trader trade never confirmed (dropped)' });
  assert.equal(r.closed, 1);
  assert.deepEqual(sold, [['p1', 'auto-exit: trader trade never confirmed (dropped)']]);
  assert.equal(engine.phantomLog.length, 1);
});

import { sodaeWsFrom } from '../engine/liveSignals.mjs';

test('Sodae: second live feed races Helius — the same trade is handled once, the first feed is counted', async () => {
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: async () => new Response('{}'), tokenInfo: { get: async () => null, solPriceUsd: async () => 200 }, onSignal: (s) => got.push(s), extraStreamUrl: 'ws://example.invalid:8900/?api-key=x', extraStreamName: 'Sodae' });
  w.onTokenInfoLate = () => {};
  w.running = true;
  w.wallets.set(TRADER, { address: TRADER, label: 'decu', mode: 'full' });
  w.fastDetect = () => true;
  w.confirmDelaysMs = [];
  w.rpc = async (m) => (m === 'getSignatureStatuses' ? { value: [{ err: null }] } : null);
  assert.ok(w.extraStream, 'second feed created');
  const ev = { signature: 'race-sig-1', err: null, logs: logs(), receivedAt: Date.now() };
  w.handleStreamLogs(TRADER, ev, 'extra'); // Sodae first
  w.handleStreamLogs(TRADER, ev, 'main'); // Helius a moment later
  await until(() => got.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1, 'one trade, one signal');
  assert.equal(w.feedRace.extra, 1);
  assert.equal(w.feedRace.main, 0);
  assert.equal(w.getStatus().stream.extraFeed.name, 'Sodae');
  // spam-flooded wallets stay off the second feed (they would burn its credits)
  w.wallets.set(OTHER, { address: OTHER, label: 'spam', mode: 'balances' });
  w.streamEnabled = true;
  w.extraStream.start = () => {};
  w.stream.start = () => {};
  w.syncStreams();
  assert.equal(w.extraStream.wanted.has(OTHER), false, 'flooded wallet not on the Sodae feed');
  assert.equal(w.extraStream.wanted.has(TRADER), true, 'normal wallet is');
});

test('Sodae WebSocket address: http → ws, port 8899 → 8900, key kept', () => {
  assert.equal(sodaeWsFrom('http://ams.rpc.sodae.io:8899?api-key=abc'), 'ws://ams.rpc.sodae.io:8900/?api-key=abc');
  assert.equal(sodaeWsFrom('https://x.example/rpc?api-key=k'), 'wss://x.example/rpc?api-key=k');
  assert.equal(sodaeWsFrom('not a url'), null);
});

test('Yellowstone gRPC feed plugs into fast detection; the first feed to hear a trade wins', async () => {
  const got = [];
  const w = new SolanaWalletWatcher({ fetchImpl: async () => new Response('{}'), tokenInfo: { get: async () => null, solPriceUsd: async () => 200 }, onSignal: (s) => got.push(s), grpcUrl: 'http://example.invalid:10201?api-key=k' });
  w.onTokenInfoLate = () => {};
  w.running = true;
  w.wallets.set(TRADER, { address: TRADER, label: 'decu', mode: 'full' });
  w.fastDetect = () => true;
  w.confirmDelaysMs = [];
  w.rpc = async (m) => (m === 'getSignatureStatuses' ? { value: [{ err: null }] } : null);
  assert.ok(w.grpcFeed);
  assert.equal(w.grpcFeed.token, 'k');
  const ev = { signature: 'grpc-sig-1', err: null, logs: logs(), slot: 1, receivedAt: Date.now() };
  w.grpcFeed.onTx(TRADER, ev); // gRPC first
  w.handleStreamLogs(TRADER, ev, 'main'); // Helius later
  await until(() => got.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1);
  assert.equal(got[0].via, 'fast-logs');
  assert.equal(w.feedRace.grpc, 1);
  assert.equal(w.feedRace.main, 0);
  assert.equal(w.getStatus().stream.grpcFeed.kind, 'yellowstone-grpc');
  assert.doesNotMatch(JSON.stringify(w.getStatus().stream.grpcFeed), /api-key=k/, 'key not shown in status');
});

test('FD14 a trade through Raydium LaunchLab (PumpSwap) is decoded via fast-logs with venue pumpswap', () => {
  const eventB64 = tradeEvent();
  const launchlabLogs = [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    'Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 invoke [1]',
    `Program ${RAYDIUM_LAUNCHLAB_PROGRAM} invoke [2]`,
    'Program log: Instruction: BuyExactIn',
    `Program data: ${eventB64}`,
    `Program ${RAYDIUM_LAUNCHLAB_PROGRAM} consumed 25000 of 150000 compute units`,
    `Program ${RAYDIUM_LAUNCHLAB_PROGRAM} success`,
    'Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 success',
  ];
  const r = pumpTradeFromLogs(launchlabLogs, TRADER);
  assert.ok(r.trade, r.skip);
  const s = swapFromPumpTrade(r.trade);
  assert.equal(s.venue, 'pumpswap');
  assert.equal(s.side, 'buy');
});

function pumpSwapEventB64({
  isBuy = true,
  baseAmount = 3_964_618_653n,
  userBaseBefore = isBuy ? 0n : 3_964_618_653n,
  quoteAmount = isBuy ? 83_840_884n : 100_506_713n,
  userQuoteAmount = isBuy ? 84_553_533n : 99_702_658n,
  pool = OTHER,
  user = TRADER,
} = {}) {
  return Buffer.concat([
    isBuy ? PUMP_SWAP_BUY_EVENT : PUMP_SWAP_SELL_EVENT,
    u64(1_793_828_142n), // timestamp
    u64(baseAmount),
    u64(userQuoteAmount), // max_quote_in / min_quote_out
    u64(userBaseBefore),
    u64(isBuy ? userQuoteAmount : 0n),
    u64(31_455_230_775_549n), // pool_base_token_reserves
    u64(655_270_467_691n), // pool_quote_token_reserves
    u64(quoteAmount),
    u64(20n),
    u64(167_682n),
    u64(5n),
    u64(41_921n),
    u64(quoteAmount),
    u64(userQuoteAmount),
    pk(pool),
    pk(user),
    pk(OTHER),
    pk(OTHER),
  ]).toString('base64');
}

function pumpSwapLogs(eventB64, prog = PUMP_AMM_PROGRAM) {
  return [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    `Program ${prog} invoke [1]`,
    'Program log: Instruction: Buy',
    `Program data: ${eventB64}`,
    `Program ${prog} success`,
  ];
}

test('FD15 PumpSwap BuyEvent & SellEvent decode from processed logs with exact heldBefore / sellSharePct and reject forged events', () => {
  const buyRes = pumpSwapTradeFromLogs(pumpSwapLogs(pumpSwapEventB64({ isBuy: true, userBaseBefore: 0n })), TRADER);
  assert.ok(buyRes.trade, buyRes.skip);
  const buySwap = swapFromPumpSwapTrade(buyRes.trade, { baseMint: MINT, quoteMint: WSOL, decimals: 6 }, { signature: 'ps-b1' });
  assert.equal(buySwap.side, 'buy');
  assert.equal(buySwap.venue, 'pumpswap');
  assert.equal(buySwap.tokenMint, MINT);
  assert.equal(buySwap.heldBefore, 0);
  assert.ok(Math.abs(buySwap.tokenAmount - 3964.618653) < 1e-6);
  assert.ok(Math.abs(buySwap.poolQuoteAmount - 0.083840884) < 1e-9);
  assert.ok(Math.abs(buySwap.quoteAmount - 0.084553533) < 1e-9);

  // Partial sell (sold 1,000 of 4,000 tokens = 25% share, no ATA balance RPC needed!)
  const sellRes = pumpSwapTradeFromLogs(
    pumpSwapLogs(pumpSwapEventB64({ isBuy: false, baseAmount: 1_000_000_000n, userBaseBefore: 4_000_000_000n })),
    TRADER
  );
  assert.ok(sellRes.trade, sellRes.skip);
  const sellSwap = swapFromPumpSwapTrade(sellRes.trade, { baseMint: MINT, quoteMint: WSOL, decimals: 6 }, { signature: 'ps-s1' });
  assert.equal(sellSwap.side, 'sell');
  assert.equal(sellSwap.sellSharePct, 25);

  // Forged event written outside PUMP_AMM_PROGRAM invoke frame is rejected
  const forged = pumpSwapTradeFromLogs(pumpSwapLogs(pumpSwapEventB64(), EVIL), TRADER);
  assert.equal(forged.trade, undefined);
  assert.equal(forged.forged, true);
});

test('FD16 watcher: PumpSwap WS logs emit fast-logs signal without getTransaction and cache pool for 0-RPC subsequent buys/sells', async () => {
  const poolAddr = OTHER;
  const pumpMint = `${MINT.slice(0, 40)}pump`;
  const poolBuf = Buffer.alloc(301);
  PUMP_SWAP_POOL_DISC.copy(poolBuf, 0);
  pk(pumpMint).copy(poolBuf, 43);
  pk(WSOL).copy(poolBuf, 75);

  const got = [];
  const rpcCalls = [];
  const w = new SolanaWalletWatcher({
    fetchImpl: async () => new Response('{}'),
    tokenInfo: { cache: new Map(), get: async () => null, solPriceFast: async () => 200, solPriceUsd: async () => 200 },
    onSignal: (s) => got.push({ ...s, callsAtSignal: [...rpcCalls] }),
  });
  w.onTokenInfoLate = () => {};
  w.running = true;
  w.wallets.set(TRADER, { address: TRADER, label: 'decu', mode: 'full' });
  w.fastDetect = () => true;
  w.confirmDelaysMs = [];
  w.rpc = async (method, params) => {
    rpcCalls.push(method);
    if (method === 'getAccountInfo' && params[0] === poolAddr) {
      return { value: { owner: PUMP_AMM_PROGRAM, data: [poolBuf.toString('base64'), 'base64'] } };
    }
    if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
    return null;
  };

  // First swap on pool: 1 processed getAccountInfo, 0 getTransaction
  w.handleStreamLogs(TRADER, {
    signature: 'ps-ws-buy',
    err: null,
    logs: pumpSwapLogs(pumpSwapEventB64({ isBuy: true, pool: poolAddr })),
    receivedAt: Date.now(),
  });
  await until(() => got.length === 1);
  assert.equal(got[0].via, 'fast-logs');
  assert.equal(got[0].venue, 'pumpswap');
  assert.equal(got[0].side, 'buy');
  assert.equal(got[0].tokenMint, pumpMint);
  assert.deepEqual(got[0].callsAtSignal, ['getAccountInfo'], 'only 1 pool lookup on first swap, zero getTransaction');
  assert.equal(w.fastStats.misses, 0, 'zero false fast-detect misses on PumpSwap');

  // Second swap (sell!) on same pool: 0 RPC calls before signal!
  rpcCalls.length = 0;
  w.handleStreamLogs(TRADER, {
    signature: 'ps-ws-sell',
    err: null,
    logs: pumpSwapLogs(pumpSwapEventB64({ isBuy: false, pool: poolAddr })),
    receivedAt: Date.now(),
  });
  await until(() => got.length === 2);
  assert.equal(got[1].side, 'sell');
  assert.equal(got[1].sellSharePct, 100);
  assert.deepEqual(got[1].callsAtSignal, [], '0 RPC calls on cached PumpSwap pool sell');
});

