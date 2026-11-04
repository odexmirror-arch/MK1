// Direct pump.fun swaps (bonding curve, v3 instructions) — offline, mock RPC + mock Jupiter.
// Run: node --test test/pump-direct.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as PD from '../engine/pumpDirect.mjs';
import { RealTrader } from '../engine/realTrader.mjs';
import { CopyTradingEngine } from '../engine/copyEngine.mjs';
import { base58Encode, base58Decode } from '../engine/onchainMeta.mjs';

const SOL_PX = 200;

function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: base58Encode(Buffer.concat([seed, pub])), pub: Buffer.from(pub), address: base58Encode(pub) };
}
const rndKey = () => base58Encode(crypto.randomBytes(32));

/** BondingCurve account bytes (full current layout). */
function curveBytes({ vToken = 1_073_000_000_000_000n, vSol = 30_000_000_000n, rToken = 793_100_000_000_000n, complete = false, mayhem = false, cashback = false, quoteMint = PD.WSOL_MINT } = {}) {
  const b = Buffer.alloc(151);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(b, 0);
  b.writeBigUInt64LE(vToken, 8);
  b.writeBigUInt64LE(vSol, 16);
  b.writeBigUInt64LE(rToken, 24);
  b.writeBigUInt64LE(vSol - 30_000_000_000n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = complete ? 1 : 0;
  crypto.randomBytes(32).copy(b, 49);
  b[81] = mayhem ? 1 : 0;
  b[82] = cashback ? 1 : 0;
  Buffer.from(base58Decode(quoteMint)).copy(b, 83);
  return b;
}
/** SPL token account bytes with an amount. */
function tokenAccountBytes(amount) {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(BigInt(amount), 64);
  return b;
}

test('PD1 fixed addresses match pump.fun’s published ones; Token-2022 id is the real one', () => {
  assert.equal(PD.globalPda(), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(PD.eventAuthorityPda(), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(PD.feeConfigPda(), '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
  assert.equal(PD.TOKEN_2022_PROGRAM, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.equal(PD.BUYBACK_FEE_RECIPIENTS.length, 8);
  for (const k of PD.BUYBACK_FEE_RECIPIENTS) assert.equal(base58Decode(k).length, 32);
});

test('PD2 instructions: 17 accounts in IDL order, right flags, discriminator + two u64 args', () => {
  const user = rndKey();
  const mint = rndKey();
  const buy = PD.buyExactQuoteInIx({ user, mint, baseTokenProgram: PD.TOKEN_2022_PROGRAM, lamportsIn: 50_000_000n, minTokensOut: 123n });
  assert.equal(buy.programId, PD.PUMP_PROGRAM);
  assert.equal(buy.keys.length, 17);
  assert.deepEqual([...buy.data.subarray(0, 8)], [225, 247, 80, 30, 213, 179, 132, 136]);
  assert.equal(buy.data.readBigUInt64LE(8), 50_000_000n);
  assert.equal(buy.data.readBigUInt64LE(16), 123n);
  assert.equal(buy.data.length, 24, 'partial_fill left off (optional)');
  const signers = buy.keys.filter((k) => k.isSigner).map((k) => k.pubkey);
  assert.deepEqual(signers, [user], 'only the bot wallet signs');
  assert.equal(buy.keys[0].pubkey, PD.globalPda());
  assert.equal(buy.keys[1].pubkey, mint);
  assert.equal(buy.keys[3].pubkey, PD.TOKEN_2022_PROGRAM);
  assert.equal(buy.keys[5].pubkey, PD.bondingCurveAddress(mint));
  assert.equal(buy.keys[9].pubkey, PD.ataAddress(user, mint, PD.TOKEN_2022_PROGRAM));
  assert.equal(buy.keys[12].pubkey, PD.feeConfigPda());
  assert.equal(buy.keys[16].pubkey, PD.PUMP_PROGRAM);
  const sell = PD.sellIx({ user, mint, baseTokenProgram: PD.TOKEN_PROGRAM, amount: 999n, minSolOutput: 7n });
  assert.deepEqual([...sell.data.subarray(0, 8)], [28, 146, 222, 119, 38, 196, 105, 213]);
  assert.equal(sell.data.readBigUInt64LE(8), 999n);
  assert.equal(sell.data.readBigUInt64LE(16), 7n);
  assert.deepEqual(sell.keys.map((k) => [k.isSigner, k.isWritable]), buy.keys.map((k) => [k.isSigner, k.isWritable]));
});

test('PD3 curve decode + which coins can go direct', () => {
  const c = PD.decodeCurve(curveBytes().toString('base64'));
  assert.equal(c.virtualQuoteReserves, 30_000_000_000n);
  assert.equal(c.solPaired, true);
  assert.equal(PD.directBlocker(c), null);
  assert.match(PD.directBlocker(PD.decodeCurve(curveBytes({ complete: true }))), /graduated/);
  assert.match(PD.directBlocker(PD.decodeCurve(curveBytes({ cashback: true }))), /cashback/);
  assert.match(PD.directBlocker(PD.decodeCurve(curveBytes({ mayhem: true }))), /mayhem/);
  assert.match(PD.directBlocker(PD.decodeCurve(curveBytes({ quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }))), /not priced in SOL/);
  assert.match(PD.directBlocker(PD.decodeCurve(Buffer.alloc(151))), /not a pump/);
  // constant product: 1 SOL into a 30-SOL virtual curve ≈ 1/31 of the virtual tokens (minus fee)
  const out = PD.quoteBuy(c, 1_000_000_000n);
  const ideal = (c.virtualTokenReserves * 1_000_000_000n) / (c.virtualQuoteReserves + 1_000_000_000n);
  assert.ok(out < ideal && out > (ideal * 98n) / 100n);
  assert.ok(PD.quoteSell(c, out) < 1_000_000_000n, 'a round trip never makes money');
});

test('PD4 compiled legacy transaction: payer first, signature valid, fits in a packet', () => {
  const k = newKey();
  const mint = rndKey();
  const ixs = [...PD.computeBudgetIxs({ microLamports: 50_000 }), PD.createAtaIdempotentIx({ payer: k.address, owner: k.address, mint, tokenProgram: PD.TOKEN_PROGRAM }), PD.buyExactQuoteInIx({ user: k.address, mint, baseTokenProgram: PD.TOKEN_PROGRAM, lamportsIn: 1n, minTokensOut: 1n })];
  const { message } = PD.compileMessage({ payer: k.address, instructions: ixs, recentBlockhash: rndKey() });
  assert.equal(message[0], 1, 'one signer');
  assert.ok(message.subarray(4, 36).equals(k.pub), 'payer is account 0');
  const { RealTrader: _ } = { RealTrader };
  const trader = new RealTrader({ env: { ODEX_TRADER_KEY: k.secret }, rpc: async () => null, solPrice: () => SOL_PX });
  const signed = PD.signLegacy(message, trader.keypair);
  const tx = Buffer.from(signed.base64, 'base64');
  assert.ok(tx.length <= 1232, `tx is ${tx.length} bytes`);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), k.pub]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, tx.subarray(65), key, tx.subarray(1, 65)));
  assert.equal(PD.customErrorCode({ InstructionError: [3, { Custom: 6042 }] }), 6042);
});

/**
 * Mock chain for the trader. simMode: 'ok' | 'price' | 'other' | 'fewTokens'; landMode: 'success' | 'failed' | 'unknown'
 */
function world({ simMode = 'ok', landMode = 'success', curve = curveBytes(), heldTokens = 0n, sol = 5 } = {}) {
  const k = newKey();
  const mint = rndKey();
  const w = { sol: BigInt(Math.round(sol * 1e9)), tok: BigInt(heldTokens), sent: [], sims: 0, jupiterOrders: 0, jupiterExecutes: 0 };
  const userAta = PD.ataAddress(k.address, mint, PD.TOKEN_PROGRAM);
  let lastSim = null;
  const rpc = async (method, params) => {
    if (method === 'getMultipleAccounts') {
      return {
        value: params[0].map((a) => {
          if (a === PD.bondingCurveAddress(mint)) return curve ? { owner: PD.PUMP_PROGRAM, lamports: 1, data: [curve.toString('base64'), 'base64'] } : null;
          if (a === mint) return { owner: PD.TOKEN_PROGRAM, lamports: 1, data: ['', 'base64'] };
          if (a === k.address) return { owner: PD.SYSTEM_PROGRAM, lamports: Number(w.sol), data: ['', 'base64'] };
          if (a === userAta) return w.tok > 0n ? { owner: PD.TOKEN_PROGRAM, lamports: 2039280, data: [tokenAccountBytes(w.tok).toString('base64'), 'base64'] } : null;
          return null;
        }),
      };
    }
    if (method === 'getLatestBlockhash') return { value: { blockhash: rndKey() } };
    if (method === 'getBalance') return { value: Number(w.sol) };
    if (method === 'getTokenAccountsByOwner') return { value: w.tok > 0n && (params[1].programId === PD.TOKEN_PROGRAM || params[1].mint === mint) ? [{ pubkey: userAta, account: { data: { parsed: { info: { mint, tokenAmount: { amount: String(w.tok), decimals: 6 } } } } } }] : [] };
    if (method === 'simulateTransaction') {
      w.sims++;
      const tx = Buffer.from(params[0], 'base64');
      const data = parsePumpIx(tx);
      lastSim = data;
      assert.equal(params[1].sigVerify, true, 'simulation checks the signature');
      if (simMode === 'price') return { value: { err: { InstructionError: [3, { Custom: data.buy ? 6042 : 6003 }] } } };
      if (simMode === 'other') return { value: { err: { InstructionError: [3, { Custom: 6094 }] } } };
      const c = PD.decodeCurve(curve);
      let postSol;
      let postTok;
      if (data.buy) {
        const got = simMode === 'fewTokens' ? data.min - 1n : PD.quoteBuy(c, data.a);
        postTok = w.tok + got;
        postSol = w.sol - data.a - 2_039_280n - 5_000n;
      } else {
        postTok = w.tok - data.a;
        postSol = w.sol + PD.quoteSell(c, data.a) - 5_000n;
      }
      data.postSol = postSol;
      data.postTok = postTok;
      return { value: { err: null, accounts: [{ lamports: Number(postSol) }, postTok > 0n ? { data: [tokenAccountBytes(postTok).toString('base64'), 'base64'] } : null] } };
    }
    if (method === 'sendTransaction') {
      w.sent.push(params[0]);
      assert.equal(params[1].skipPreflight, true);
      if (landMode === 'success' && lastSim?.postSol !== undefined) {
        w.sol = lastSim.postSol;
        w.tok = lastSim.postTok;
      }
      return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
    }
    if (method === 'getSignatureStatuses') {
      if (landMode === 'unknown') return { value: [null] };
      if (landMode === 'failed') return { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [3, { Custom: 6042 }] } }] };
      return { value: [{ confirmationStatus: 'confirmed', err: null }] };
    }
    if (method === 'getTransaction') return null;
    return null;
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/order')) w.jupiterOrders++;
    if (u.pathname.endsWith('/execute')) w.jupiterExecutes++;
    return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'jupiter mock offline' }) };
  };
  let t = 1_000_000;
  const trader = new RealTrader({ env: { ODEX_TRADER_KEY: k.secret }, rpc, solPrice: () => SOL_PX, fetchImpl, sleep: async () => { t += 1500; }, now: () => t });
  trader.routeSetting = () => 'direct';
  const token = { address: mint, symbol: 'MEME', decimals: 6, currentPriceUsd: 0.000006, liquidityUsd: 20_000 };
  return { trader, w, token, mint };
}
/** Find the pump.fun instruction in a legacy tx and read its args. */
function parsePumpIx(tx) {
  const n = tx[0];
  const m = tx.subarray(1 + 64 * n);
  const nKeys = m[3];
  const keys = Array.from({ length: nKeys }, (_, i) => base58Encode(m.subarray(4 + 32 * i, 36 + 32 * i)));
  let o = 4 + 32 * nKeys + 32;
  const nIx = m[o++];
  for (let i = 0; i < nIx; i++) {
    const prog = keys[m[o++]];
    const na = m[o++];
    o += na;
    const dl = m[o++];
    const data = m.subarray(o, o + dl);
    o += dl;
    if (prog === PD.PUMP_PROGRAM) return { buy: data[0] === 225, a: data.readBigUInt64LE(8), min: data.readBigUInt64LE(16) };
  }
  throw new Error('no pump.fun instruction');
}

test('PD5 Direct route: quote is local, buy is simulated then sent, no Jupiter call; fill uses real amounts', async () => {
  const { trader, w, token } = world();
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  assert.equal(q.route, 'direct');
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, true, r.error);
  assert.equal(w.sims, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(w.jupiterOrders + w.jupiterExecutes, 0, 'Jupiter never asked');
  assert.ok(w.tok > 0n);
  assert.equal(trader.directStats.direct, 1);
  // then sell everything direct
  const qs = await trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: 15 });
  assert.equal(qs.route, 'direct');
  const rs = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: qs, slippagePct: 15 });
  assert.equal(rs.ok, true, rs.error);
  assert.equal(w.tok, 0n);
  assert.equal(trader.directStats.direct, 2);
});

test('PD6 price past the limit in simulation → skipped, nothing sent, no Jupiter retry (no chasing)', async () => {
  const { trader, w, token } = world({ simMode: 'price' });
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /price moved/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.jupiterOrders, 0);
  assert.equal(trader.spent24hSol(), 0, 'daily-cap room given back');
});

test('PD7 any other simulation problem → nothing sent, falls back to Jupiter', async () => {
  for (const simMode of ['other', 'fewTokens']) {
    const { trader, w, token } = world({ simMode });
    const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
    const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
    assert.equal(w.sent.length, 0, `${simMode}: nothing direct was sent`);
    assert.ok(w.jupiterOrders >= 1, `${simMode}: Jupiter was asked instead`);
    assert.equal(r.ok, false, 'the mock Jupiter is offline, so the buy fails cleanly');
    assert.equal(trader.directStats.fallbacks, 1);
  }
});

test('PD8 sent but not confirmed → reported unknown, never retried through Jupiter (no double buy)', async () => {
  const { trader, w, token } = world({ landMode: 'unknown' });
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.unknown, true);
  assert.equal(w.sent.length, 1);
  assert.equal(w.jupiterOrders, 0);
  assert.ok(trader.spent24hSol() > 0, 'kept against the daily cap (it may have landed)');
});

test('PD9 landed but refused on price → skip; graduated / cashback / non-curve coins quote through Jupiter', async () => {
  {
    const { trader, w, token } = world({ landMode: 'failed' });
    const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
    const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
    assert.match(r.error, /price moved/);
    assert.equal(w.jupiterOrders, 0);
  }
  for (const curve of [curveBytes({ complete: true }), curveBytes({ cashback: true }), null]) {
    const { trader, w, token } = world({ curve });
    await assert.rejects(trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 }));
    assert.ok(w.jupiterOrders >= 1, 'went to Jupiter');
    assert.equal(w.sims, 0);
  }
});

test('PD10 Jupiter setting (default) never touches the direct route', async () => {
  const { trader, w, token } = world();
  trader.routeSetting = () => 'jupiter';
  await assert.rejects(trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 }));
  assert.equal(w.sims, 0);
  assert.ok(w.jupiterOrders >= 1);
  const fresh = new RealTrader({ env: {}, rpc: async () => null, solPrice: () => SOL_PX });
  assert.equal(fresh.routeSetting(), 'jupiter', 'default is Jupiter');
});

test('PD11 a Direct SELL refused on price is never dropped: Jupiter takes it (live slippage)', async () => {
  const { trader, w, token } = world({ simMode: 'price', heldTokens: 5_000_000_000n });
  const q = await trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: null });
  assert.equal(q.route, 'direct');
  const r = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: q, slippagePct: null });
  assert.equal(w.sent.length, 0, 'nothing direct was sent');
  assert.ok(w.jupiterOrders >= 1, `handed to Jupiter (${JSON.stringify(r)})`);
  assert.doesNotMatch(String(r.error || ''), /price moved too far before we could copy/);
  assert.equal(trader.directStats.priceSkips, 0);
});

test('PD12 a sell you press yourself skips the retry wait left by a failed sell', async () => {
  const { trader, w, token, mint } = world({ heldTokens: 5_000_000_000n });
  trader.sellBlockedUntil.set(mint, Date.now() + 10 ** 9);
  const blocked = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: null, slippagePct: null });
  assert.match(blocked.error, /before retrying this sell/);
  const q = await trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: null, urgent: true });
  const r = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: q, slippagePct: null, urgent: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(w.tok, 0n);
});

test('PD13 two same-size Direct buys at the same moment are two different transactions (EARNY bug)', async () => {
  const { trader, w, token } = world();
  const [qa, qb] = await Promise.all([trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 }), trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 })]);
  const [a, b] = await Promise.all([trader.execute({ side: 'buy', token, amountUsd: 10, quote: qa, slippagePct: 10 }), trader.execute({ side: 'buy', token, amountUsd: 10, quote: qb, slippagePct: 10 })]);
  assert.equal(a.ok, true, a.error);
  assert.equal(b.ok, true, b.error);
  const sigs = w.sent.map((tx) => base58Encode(Buffer.from(tx, 'base64').subarray(1, 65)));
  assert.equal(sigs.length, 2);
  assert.notEqual(sigs[0], sigs[1], 'different signatures → two real swaps, not one swap booked twice');
});

test('PD14 the same signed transaction is never sent or booked twice', async () => {
  const { trader, w, token } = world();
  const realRandom = Math.random;
  Math.random = () => 0; // same fee recipient both times, so only the guard can tell them apart
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  trader.directNonce = 0;
  const first = await trader.executeDirect({ side: 'buy', token, quote: q, slippagePct: 10 });
  assert.equal(first.ok, true, first.error);
  trader.directNonce = 0; // force the identical transaction again (same size, same cached blockhash)
  const q2 = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const again = await trader.executeDirect({ side: 'buy', token, quote: q2, slippagePct: 10 });
  assert.equal(again.ok, undefined);
  Math.random = realRandom;
  assert.match(again.error, /already sent/);
  assert.equal(w.sent.length, 1);
});

test('PD15 "sell everything" while a buy of the same coin is in progress sells only this position (EARNY race)', async () => {
  const { trader, w, token, mint } = world({ heldTokens: 5_000_000_000n }); // 5,000 tokens in the wallet
  trader.buyMintsInFlight = new Map([[mint, 1]]); // another copy's buy of this coin is landing
  const q = await trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: null, positionTokens: 2000 });
  const r = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: q, slippagePct: null, positionTokens: 2000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(w.tok, 3_000_000_000n, 'the other position’s 3,000 tokens stay in the wallet');
  // no buy in progress: everything goes (no dust left behind)
  trader.buyMintsInFlight = new Map();
  const q2 = await trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: null, positionTokens: 1000 });
  const r2 = await trader.execute({ side: 'sell', token, tokenAmount: 'all', quote: q2, slippagePct: null, positionTokens: 1000 });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(w.tok, 0n);
});

test('PD16 a buy marks its coin as in progress until shortly after it returns', async () => {
  const { trader, token, mint } = world();
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const p = trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(trader.buyInProgress(mint), true);
  await p;
  assert.equal(trader.buyInProgress(mint), true, 'still marked right after (the engine books it next)');
});

test('PD17 direct buy reads curve, mint, user SOL, and both token accounts in one getMultipleAccounts call (no separate getBalance)', async () => {
  const { trader, token } = world();
  const calls = [];
  const origRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    calls.push(method);
    return origRpc(method, params);
  };
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, true, r.error);
  const preSendCalls = calls.slice(0, calls.indexOf('sendTransaction'));
  assert.equal(preSendCalls.filter((m) => m === 'getMultipleAccounts').length, 1, `single 5-account read before send: ${preSendCalls.join(', ')}`);
  assert.equal(preSendCalls.filter((m) => m === 'getBalance').length, 0, `no redundant getBalance before send: ${preSendCalls.join(', ')}`);
});

test('PD18 direct buy near maxChasePct ceiling tightens slippage locally without a second getSwapQuote RPC read', async () => {
  const { trader, token, mint } = world();
  const calls = [];
  const origRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    calls.push(method);
    return origRpc(method, params);
  };
  const e = new CopyTradingEngine();
  e.settings.paperTrading = false;
  e.settings.tradingAsset.solana = 'native';
  e.settings.buySlippagePct.solana = 15;
  e.wallets[0].balances.solana.native = 5;
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => trader.ready();
  const f = {
    id: 'fol-direct',
    walletId: e.getActiveWallet().id,
    name: 'Decu',
    handle: 'Decu',
    traderWallet: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
    chainId: 'solana',
    status: 'copying',
    pauseReason: null,
    mode: 'buy-hold',
    sizing: { type: 'fixed', amount: 10 },
    tpPct: null,
    slPct: null,
    minTradeUsd: 1,
    maxOpenPositions: 100,
    maxAtRiskUsd: 100000,
    consecutiveLosses: 0,
    maxChasePct: 20,
    filtersOverride: {},
    createdAt: Date.now(),
  };
  e.follows.unshift(f);
  // Direct quote for $10 on default curve is ~$0.000005668/token; set traderFillPriceUsd so quote is ~+13% above trader (room ~5.8% < 15% slippage)
  const q0 = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 15 });
  calls.length = 0;
  const traderPx = q0.quotedPriceUsd / 1.13;
  const [res] = await e.processTraderSignal({
    chainId: 'solana',
    side: 'buy',
    traderHandle: f.handle,
    traderWallet: f.traderWallet,
    signature: 'sig-direct-near-ceiling',
    ageSec: 1,
    traderBuyUsd: 200,
    token: { ...token, address: mint, traderFillPriceUsd: traderPx, currentPriceUsd: traderPx },
  });
  assert.equal(res.status, 'filled', res.reason);
  const preSendCalls = calls.slice(0, calls.indexOf('sendTransaction'));
  assert.equal(preSendCalls.filter((m) => m === 'getMultipleAccounts').length, 1, `no second directQuote RPC call when tightening slippage: ${preSendCalls.join(', ')}`);
});

test('PD19 direct buy blasts fastRpcUrls before awaiting primary sendTransaction, keeps blockhash warm, and polls status at 100 ms', async () => {
  const { trader, token } = world();
  const order = [];
  const sleepIntervals = [];
  const origSleep = trader.sleep;
  trader.sleep = async (ms) => {
    sleepIntervals.push(ms);
    return origSleep(ms);
  };
  const origBlast = trader.blastSignedTransaction.bind(trader);
  trader.blastSignedTransaction = (b64) => {
    order.push('blast');
    return origBlast(b64);
  };
  let statusCalls = 0;
  const origRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    if (method === 'sendTransaction') {
      order.push('primary-send-start');
      await Promise.resolve();
      order.push('primary-send-end');
    }
    if (method === 'getSignatureStatuses') {
      statusCalls += 1;
      if (statusCalls === 1) return { value: [null] };
    }
    return origRpc(method, params);
  };
  trader.startBlockhashWarmer(60_000);
  await trader.blockhashInFlight;
  trader.stopBlockhashWarmer();
  assert.ok(trader.blockhashCache?.hash, 'warmer pre-populated blockhashCache');
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(order.slice(0, 3), ['blast', 'primary-send-start', 'primary-send-end']);
  assert.ok(sleepIntervals.some((ms) => ms > 0 && ms <= 100), `expected stepped <=100ms status poll interval, got ${sleepIntervals.join(', ')}`);
});

test('PD20 non-SOL-paired pump.fun curve skips BUY immediately without falling back to Jupiter, while SELL still falls back to Jupiter', async () => {
  const otherMint = 'MsGDybWRSNdNXkdDZhEksgzugT5CbVWUG2wkhwgpump';
  const { trader, w, token } = world({ curve: curveBytes({ quoteMint: otherMint }), heldTokens: 5_000_000_000n });
  await assert.rejects(
    trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 }),
    (err) => err?.skipBuy === true && /curve is not priced in SOL/i.test(err.message),
  );
  assert.equal(w.jupiterOrders, 0, 'buy never falls back to 2-hop Jupiter quote');
  assert.equal(w.sent.length, 0);

  // Sells on non-SOL-paired curves still fall back to Jupiter so existing holdings can always exit
  await assert.rejects(trader.quote({ side: 'sell', token, amountUsd: 10, tokenAmount: 'all', slippagePct: 15 }));
  assert.ok(w.jupiterOrders >= 1, 'sell falls back to Jupiter');
});

test('PD21 Yellowstone gRPC TradeEvent curve reserves skip getMultipleAccounts RPC call on direct buy', async () => {
  const { trader, token } = world();
  trader.balance = { sol: 5, usdc: 0 };
  await trader.refreshBlockhash();
  const calls = [];
  const origRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    calls.push(method);
    return origRpc(method, params);
  };
  const fastToken = {
    ...token,
    curve: {
      virtualSolReserves: 30_000_000_000,
      virtualTokenReserves: 1_073_000_000_000_000,
      realTokenReserves: 793_100_000_000_000,
      mayhem: false,
      cashback: false,
      tokenProgram: PD.TOKEN_PROGRAM,
    },
  };
  const q = await trader.quote({ side: 'buy', token: fastToken, amountUsd: 10, slippagePct: 10 });
  assert.equal(q.route, 'direct');
  assert.equal(calls.length, 0, `zero RPC calls during directQuote when Yellowstone curve + cached blockhash are warm: ${calls.join(', ')}`);
  const r = await trader.execute({ side: 'buy', token: fastToken, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, true, r.error);

  // Now sell using Yellowstone TradeEvent curve reserves + cached mintMetaCache -> zero RPC calls during sell quote
  await new Promise((res) => setImmediate(res));
  trader.buyMintsInFlight = new Map();
  calls.length = 0;
  const qs = await trader.quote({ side: 'sell', token: fastToken, tokenAmount: 'all', slippagePct: 15 });
  assert.equal(qs.route, 'direct');
  assert.equal(calls.length, 0, `zero RPC calls during direct SELL quote when Yellowstone curve + mintMetaCache are warm: ${calls.join(', ')}`);
  const rs = await trader.execute({ side: 'sell', token: fastToken, tokenAmount: 'all', quote: qs, slippagePct: 15 });
  assert.equal(rs.ok, true, rs.error);
});

test('PD22 direct buy 6042 is preserved from waitForSignature even if second RPC returns [null], and Jupiter fallback enforces entryCeilingUsd', async () => {
  // Part A: waitForSignature sees 6042 on poll #1, and any subsequent getSignatureStatuses returns [null]
  const { trader, w, token } = world({ landMode: 'failed' });
  let statusCalls = 0;
  const origRpc = trader.rpc;
  trader.rpc = async (method, params) => {
    if (method === 'getSignatureStatuses') {
      statusCalls += 1;
      if (statusCalls === 1) return { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [3, { Custom: 6042 }] } }] };
      return { value: [null] };
    }
    return origRpc(method, params);
  };
  const q = await trader.quote({ side: 'buy', token, amountUsd: 10, slippagePct: 10 });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 10, quote: q, slippagePct: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.priceMoved, true, 'cached 6042 error treated as priceMoved skip, never Jupiter fallback');
  assert.equal(w.jupiterOrders, 0, 'zero Jupiter fallback calls when pump.fun rejected on 6042');

  // Part B: If direct simulation genuinely falls back to Jupiter, entryCeilingUsd blocks an over-pumped Jupiter quote (+50% above trader)
  const w2 = world({ simMode: 'other' });
  let jupExecs = 0;
  w2.trader.fetch = async (url) => {
    if (String(url).includes('/order')) {
      // $10 buy returning only 1,000,000_000 raw (1,000 tokens = $0.01/token, +66% above $0.006 ceiling)
      return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: Buffer.alloc(100).toString('base64'), requestId: 'r-high', inAmount: '50000000', outAmount: '1000000000', router: 'metis' }) };
    }
    jupExecs += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success' }) };
  };
  const q2 = await w2.trader.quote({ side: 'buy', token: w2.token, amountUsd: 10, slippagePct: 10 });
  const r2 = await w2.trader.execute({ side: 'buy', token: w2.token, amountUsd: 10, quote: q2, slippagePct: 10, entryCeilingUsd: 0.0075 });
  assert.equal(r2.ok, false);
  assert.equal(r2.priceMoved, true, 'Jupiter fallback blocked when quote exceeds entryCeilingUsd');
  assert.equal(jupExecs, 0, 'over-ceiling Jupiter fallback never signed or executed');
});





