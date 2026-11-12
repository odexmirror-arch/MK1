// Copy speed: pump.fun coins never wait for DexScreener; other coins keep the normal budget.
// Run: node --test test/copy-speed.test.mjs
process.env.ODEX_RPC_MAX_RPS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SolanaWalletWatcher, TokenInfoService, PUMP_CURVE_PROGRAM, PUMP_SUPPLY, isPumpFunCoin } from '../engine/walletWatcher.mjs';
import { RAYDIUM_LAUNCHLAB_PROGRAM } from '../engine/pumpCurve.mjs';
import { WalletStream } from '../engine/walletStream.mjs';
import { TokenAccountStream } from '../engine/tokenStream.mjs';
import { RealTrader, WSOL_MINT, priorityMicroLamportsFor } from '../engine/realTrader.mjs';
import * as PD from '../engine/pumpDirect.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS, paperDelayMsFor } from '../engine/chainAdapters.mjs';

const WALLET = '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ';

function buyTx(mint, venueProgram = PUMP_CURVE_PROGRAM) {
  const tok = { accountIndex: 2, mint, owner: WALLET, uiTokenAmount: { amount: '5000000000000', decimals: 6 } }; // 5M tokens
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, fee: 5000, preBalances: [5e9, 0, 0, 1], postBalances: [4.5e9 - 5000, 0, 0, 1], preTokenBalances: [{ ...tok, uiTokenAmount: { amount: '0', decimals: 6 } }], postTokenBalances: [tok] },
    transaction: { signatures: ['x'], message: { accountKeys: [{ pubkey: WALLET }, { pubkey: 'Pool111111111111111111111111111111111111111' }, { pubkey: 'Acc1111111111111111111111111111111111111111' }, { pubkey: venueProgram }] } },
  };
}

function watcher(slowMs) {
  const got = [];
  const w = new SolanaWalletWatcher({
    fetchImpl: async () => new Response('{}'),
    tokenInfo: { get: () => new Promise((r) => setTimeout(() => r({ symbol: 'LATE', marketCapUsd: 123 }), slowMs)), solPriceUsd: async () => 200 },
    onSignal: (s) => got.push(s),
  });
  w.onTokenInfoLate = () => {};
  return { w, got };
}

test('S1 pump.fun buy: no wait for token details; market cap from the fill price × 1B; authorities known', async () => {
  const mint = 'Fast1111111111111111111111111111111111pump';
  const { w, got } = watcher(2000);
  w.tokenInfoBudgetMs = 1200;
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sigp1', { tx: buyTx(mint) });
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `signal ready in ${ms} ms (pump.fun budget is 150 ms)`);
  const s = got[0];
  assert.ok(s, 'signal emitted');
  assert.equal(s.venue, 'pumpfun');
  // 0.5 SOL × $200 for 5M tokens = $0.00002 per token → $20,000 market cap
  assert.ok(Math.abs(s.marketCapUsd - s.txPriceUsd * PUMP_SUPPLY) < 1e-6);
  assert.ok(s.marketCapUsd > 19_000 && s.marketCapUsd < 21_000, `mcap ${s.marketCapUsd}`);
  assert.equal(s.authorityKnown, true);
  assert.equal(s.mintAuthority, null);
  assert.equal(s.freezeAuthority, null);
});

test('S2 a non-pump.fun coin keeps the normal token-details wait (safety data matters there)', async () => {
  const mint = 'Slow11111111111111111111111111111111111111';
  const { w, got } = watcher(2000);
  w.tokenInfoBudgetMs = 300;
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'x' }, 'sign1', { tx: buyTx(mint, 'OtherDex11111111111111111111111111111111111') });
  const ms = Date.now() - t0;
  assert.ok(ms >= 280, `waited the normal budget (${ms} ms)`);
  assert.equal(got[0]?.marketCapUsd ?? null, null, 'no guessed market cap for unknown coins');
  assert.equal(got[0]?.authorityKnown, false);
});

test('S3 isPumpFunCoin needs both the pump suffix and a pump.fun venue', () => {
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: 'pumpfun' }), true);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: 'pumpswap' }), true);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcpump', venue: null }), false);
  assert.equal(isPumpFunCoin({ tokenMint: 'Abcbonk', venue: 'pumpfun' }), false);
});

test('S4 cached token details still win when they arrive in time', async () => {
  const mint = 'Cach1111111111111111111111111111111111pump';
  const { w, got } = watcher(10);
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sigc1', { tx: buyTx(mint) });
  assert.equal(got[0].symbol, 'LATE');
  assert.equal(got[0].marketCapUsd, 123, 'real feed value used when available');
});

test('S5 streams default to processed commitment for sub-second push detection', () => {
  const ws = new WalletStream({ url: 'wss://x' });
  const ts = new TokenAccountStream({ url: 'wss://x' });
  assert.equal(ws.commitment, 'processed');
  assert.equal(ts.commitment, 'processed');
});

test('S6 multi-RPC race resolves pushed transaction from the fastest provider in milliseconds', async () => {
  const mint = 'Race1111111111111111111111111111111111pump';
  const got = [];
  const w = new SolanaWalletWatcher({
    rpcUrl: 'https://slow-alchemy.example',
    fastRpcUrls: ['https://fast-helius.example'],
    fetchImpl: async (url) => {
      if (String(url).includes('slow-alchemy')) {
        // Primary RPC lags behind the push and returns null first
        await new Promise((r) => setTimeout(r, 400));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
      }
      // Fast Helius RPC already indexed the tx
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: buyTx(mint) }));
    },
    tokenInfo: { get: async () => null, solPriceFast: async () => 200 },
    onSignal: (s) => got.push(s),
  });
  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sig-race', { via: 'stream', waitForTx: true });
  const ms = Date.now() - t0;
  assert.equal(got.length, 1);
  assert.equal(got[0].tokenDecimals, 6, 'decimals extracted directly from trader tx');
  assert.ok(ms < 100, `resolved from fast RPC in ${ms} ms without waiting 400 ms for slow RPC`);
});

test('S7 RealTrader skips getTokenSupply when token.decimals is known and blasts sendTransaction (skipPreflight) to fastRpcUrls', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const fakeV0Tx = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from([0x80, 1, 0, 1, 2]),
    pub,
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    Buffer.from([0, 0]),
  ]).toString('base64');

  let supplyCalls = 0;
  const blasted = [];
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    fastRpcUrls: ['https://helius.example', 'https://mainnet.block-engine.jito.wtf/api/v1/transactions'],
    rpc: async (method) => {
      if (method === 'getTokenSupply') supplyCalls += 1;
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getTransaction') return null;
      throw new Error(`unexpected ${method}`);
    },
    fetchImpl: async (url, opts = {}) => {
      if (String(url).includes('/order')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: fakeV0Tx, requestId: 'r1', inAmount: '100000000', outAmount: '500000000000', router: 'metis' }) };
      }
      if (String(url).includes('/execute')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, signature: 'sig123', totalInputAmount: '100000000', totalOutputAmount: '500000000000' }) };
      }
      blasted.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'sig123' }) };
    },
  });

  const token = { address: 'MintWithKnownDec11111111111111111111111pump', decimals: 6, symbol: 'FAST', currentPriceUsd: 0.00004 };
  const q = await trader.quote({ side: 'buy', token, amountUsd: 20, slippagePct: 10, assetMode: 'native' });
  const r = await trader.execute({ side: 'buy', token, amountUsd: 20, quote: q, slippagePct: 10, assetMode: 'native' });
  assert.equal(r.ok, true);
  assert.equal(supplyCalls, 0, 'zero getTokenSupply RPC calls when decimals known from trader tx');
  assert.equal(blasted.length, 2, 'signed tx blasted to Helius and Jito in parallel');
  assert.equal(blasted[0].body.method, 'sendTransaction');
  assert.equal(blasted[0].body.params[1].skipPreflight, true);
});

test('S8 single-pass slippage pre-capping avoids double Jupiter quote when post-trader price is already known', async () => {
  CHAINS.solana.nativePriceUsd = 200;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const fakeV0Tx = Buffer.concat([
    Buffer.from([1]),
    Buffer.alloc(64),
    Buffer.from([0x80, 1, 0, 1, 2]),
    pub,
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    Buffer.from([0, 0]),
  ]).toString('base64');

  let orderCalls = 0;
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method) => {
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getTransaction') return null;
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/order')) {
        orderCalls += 1;
        // Price is 0.000022 (+10% above trader's 0.00002)
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: fakeV0Tx, requestId: 'r1', inAmount: '250000000', outAmount: String(Math.floor((50 / 0.000022) * 1e6)), router: 'metis' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, signature: 'sigFast', totalInputAmount: '250000000', totalOutputAmount: String(Math.floor((50 / 0.000022) * 1e6)) }) };
    },
  });

  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  e.settings.cooldown.enabled = false;
  e.settings.tradingAsset.solana = 'native';
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => true;
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-fast', walletId: e.getActiveWallet().id, name: 't', handle: 't', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'auto-exit', sizing: { type: 'fixed', amount: 50 }, maxChasePct: 20,
    minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);

  const [res] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 't', traderWallet: WALLET, traderBuyUsd: 100, signature: 'sig-pre',
    token: {
      address: 'SinglePass11111111111111111111111111111pump', decimals: 6, symbol: 'SP', name: 'SP',
      isLaunchpad: true, stage: 'pre-grad', marketCapUsd: 22000,
      traderFillPriceUsd: 0.00002, currentPriceUsd: 0.000022, safety: { safetyVerified: true },
    },
  });
  assert.equal(res.status, 'filled');
  assert.equal(orderCalls, 1, 'executed in a single Jupiter quote pass');
});

test('S9 RealTrader connection warmer pre-warms Jupiter, Helius Staked, and Jito keep-alive sockets while skipping credit-metered Sodae', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const calls = [];
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async () => null,
    fastRpcUrls: [
      'https://staked.helius-rpc.com?api-key=k1',
      'https://mainnet.helius-rpc.com/?api-key=k1',
      'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions',
      'https://rpc.sodae.xyz/?api-key=s1',
    ],
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method, keepalive: opts.keepalive });
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  const n = await trader.warmConnections();
  assert.equal(n, 4, 'warmed Jupiter + Helius Staked + Helius + Jito');
  assert.ok(calls.every((c) => c.method === 'OPTIONS' && c.keepalive === true));
  assert.ok(!calls.some((c) => c.url.includes('sodae')), 'credit-metered Sodae skipped during keep-alive warming');
  calls.length = 0;
  trader.blastSignedTransaction('AAAA');
  assert.equal(calls.length, 4, 'blastSignedTransaction broadcasts to all 4 fast endpoints including Sodae');
  assert.ok(calls.every((c) => c.method === 'POST' && c.keepalive === true));
});

test('S10 native SOL Jupiter buy skips USDC RPC lookup, caches heldRaw, and fires Jupiter sell /order in parallel with RPC balance check', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const makeTx = () =>
    Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(64),
      Buffer.from([0x80, 1, 0, 1, 2]),
      pub,
      crypto.randomBytes(32),
      crypto.randomBytes(32),
      Buffer.from([0, 0]),
    ]).toString('base64');

  const MINT = 'LaunchLab1111111111111111111111111111111111';
  const events = [];
  let tokenBalanceGate = null;
  let heldTokens = 0n;

  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    routeSetting: () => 'jupiter',
    rpc: async (method) => {
      events.push(`rpc:${method}`);
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') {
        if (tokenBalanceGate) await tokenBalanceGate;
        events.push('rpc:getTokenAccountsByOwner:done');
        if (heldTokens <= 0n) return { value: [] };
        return {
          value: [
            {
              account: {
                data: { parsed: { info: { mint: MINT, tokenAmount: { amount: String(heldTokens), decimals: 6 } } } },
              },
            },
          ],
        };
      }
      if (method === 'getTransaction') return null;
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/order')) {
        events.push('jup:order:start');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ transaction: makeTx(), requestId: 'r-opt', inAmount: '30000000', outAmount: '1500000000', router: 'metis' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'Success', code: 0, signature: `sig-${Math.random()}`, totalInputAmount: '30000000', totalOutputAmount: '1500000000' }),
      };
    },
  });

  const token = { address: MINT, symbol: 'LL', decimals: 6, venue: 'launchlab', currentPriceUsd: 0.004 };
  const buyQuote = await trader.quote({ side: 'buy', token, amountUsd: 6, slippagePct: 10, assetMode: 'native' });
  const usdcLookupsDuringBuyQuote = events.filter((e) => e === 'rpc:getTokenAccountsByOwner');
  assert.equal(usdcLookupsDuringBuyQuote.length, 0, 'native SOL buy quote skipped USDC getTokenAccountsByOwner');

  const buyRes = await trader.execute({ side: 'buy', token, amountUsd: 6, slippagePct: 10, assetMode: 'native', quote: buyQuote });
  assert.equal(buyRes.ok, true);
  assert.equal(trader.mintMetaCache.get(MINT)?.heldRaw, 1500000000n, 'Jupiter buy cached heldRaw in mintMetaCache');

  // Now simulate a slow RPC balance check during sell quote: Jupiter /order must start BEFORE RPC finishes!
  events.length = 0;
  heldTokens = 1500000000n;
  let releaseGate;
  tokenBalanceGate = new Promise((r) => {
    releaseGate = r;
  });

  const sellQuoteP = trader.quote({ side: 'sell', token, tokenAmount: 'all', slippagePct: 12, assetMode: 'native' });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(events.includes('jup:order:start'), 'Jupiter sell /order fired immediately from cached heldRaw before RPC balance finished');
  assert.ok(!events.includes('rpc:getTokenAccountsByOwner:done'), 'RPC balance check is still in flight while /order started');
  releaseGate();
  const sellQuote = await sellQuoteP;
  assert.ok(sellQuote.quotedPriceUsd > 0);
  assert.equal(events.filter((e) => e === 'jup:order:start').length, 1, 'reused optimistic /order with zero duplicate Jupiter calls');
});

test('S11 LaunchLab stream trade skips 150ms DexScreener wait (0ms fast-info path) and waitForSignature micro-polls 35→65→100ms', async () => {
  const mint = 'BillyLaunchLab11111111111111111111111111bonk';
  // Build a valid 147-byte Raydium LaunchLab TradeEvent log payload
  const evBuf = Buffer.alloc(147);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(evBuf, 0); // TRADE_EVENT discriminator
  evBuf.writeBigUInt64LE(800_000_000_000_000n, 8 + 32); // totalBaseSell
  evBuf.writeBigUInt64LE(1_073_000_000_000_000n, 8 + 40); // virtualBase
  evBuf.writeBigUInt64LE(30_000_000_000n, 8 + 48); // virtualQuote
  evBuf.writeBigUInt64LE(0n, 8 + 56); // realBaseBefore
  evBuf.writeBigUInt64LE(0n, 8 + 64); // realQuoteBefore
  evBuf.writeBigUInt64LE(5_000_000_000_000n, 8 + 72); // realBaseAfter
  evBuf.writeBigUInt64LE(500_000_000n, 8 + 80); // realQuoteAfter
  evBuf.writeBigUInt64LE(500_000_000n, 8 + 88); // amountIn
  evBuf.writeBigUInt64LE(5_000_000_000_000n, 8 + 96); // amountOut
  evBuf[8 + 136] = 0; // Buy
  evBuf[8 + 137] = 0; // Active pool
  evBuf[8 + 138] = 1; // exactIn

  const tx = buyTx(mint, RAYDIUM_LAUNCHLAB_PROGRAM);
  tx.meta.logMessages = [
    `Program ${RAYDIUM_LAUNCHLAB_PROGRAM} invoke [1]`,
    `Program data: ${evBuf.toString('base64')}`,
    `Program ${RAYDIUM_LAUNCHLAB_PROGRAM} success`,
  ];

  const got = [];
  const lateUpdates = [];
  const tokenInfo = new TokenInfoService({
    fetchImpl: async () => {
      await new Promise((r) => setTimeout(r, 400).unref?.());
      return {
        ok: true,
        json: async () => ({
          pairs: [{ chainId: 'solana', baseToken: { address: mint, symbol: 'BILLY', name: 'Billy' }, priceUsd: '0.00002', marketCap: 20000, liquidity: { usd: 12000 }, dexId: 'launchlab' }],
        }),
      };
    },
  });
  tokenInfo.cache.set(WSOL_MINT, { at: Date.now(), info: { priceUsd: 200 } });

  const w = new SolanaWalletWatcher({
    fetchImpl: async () => new Response('{}'),
    tokenInfo,
    onSignal: (s) => got.push(s),
  });
  w.onTokenInfoLate = (m, info) => lateUpdates.push({ m, info });

  const t0 = Date.now();
  await w.processSignature({ address: WALLET, label: 'decu' }, 'sig-ll-fast', { via: 'stream', tx });
  const elapsed = Date.now() - t0;
  assert.equal(got.length, 1);
  assert.equal(got[0].venue, 'launchlab');
  assert.equal(got[0].curve?.launchlab, true);
  assert.ok(elapsed < 60, `LaunchLab stream trade emitted in ${elapsed} ms without waiting 150ms+ on DexScreener`);

  // Verify RealTrader.waitForSignature stepped micro-polling (35 → 65 → 100 ms)
  const sleeps = [];
  let checks = 0;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const secret = base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]));
  let nowT = 1000;
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    now: () => nowT,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowT += ms;
    },
    rpc: async () => {
      checks += 1;
      if (checks >= 6) return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      return { value: [null] };
    },
  });
  const st = await trader.waitForSignature('sig-step', 5000);
  assert.equal(st, 'success');
  assert.deepEqual(sleeps, [35, 35, 35, 35, 65], 'stepped micro-polling 35ms × 4 then 65ms');
});

test('S12 PumpSwap/LaunchLab sells skip wasted pump.fun getMultipleAccounts under direct route, and sellAllPositions exits distinct tokens in parallel', async () => {
  CHAINS.solana.nativePriceUsd = 200;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const makeTx = () =>
    Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(64),
      Buffer.from([0x80, 1, 0, 1, 2]),
      pub,
      crypto.randomBytes(32),
      crypto.randomBytes(32),
      Buffer.from([0, 0]),
    ]).toString('base64');

  const MINT_A = 'AscendPumpSwap11111111111111111111111111pump';
  const MINT_B = 'BillyLaunchLab11111111111111111111111111bonk';
  const rpcCalls = [];
  let inFlightExecutes = 0;
  let maxConcurrentExecutes = 0;

  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method, params) => {
      rpcCalls.push(method);
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getTokenAccountsByOwner') {
        const m = params?.[1]?.mint;
        if (m === MINT_A || m === MINT_B) {
          return { value: [{ account: { data: { parsed: { info: { mint: m, tokenAmount: { amount: '1000000000', decimals: 6 } } } } } }] };
        }
        return { value: [] };
      }
      if (method === 'getTransaction') return null;
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/order')) {
        const isBuy = String(url).includes(`inputMint=${WSOL_MINT}`);
        const inAmt = isBuy ? '30000000' : '1000000000';
        const outAmt = isBuy ? '1000000000' : '30000000';
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: makeTx(), requestId: `${isBuy ? 'buy' : 'sell'}-${Math.random()}`, inAmount: inAmt, outAmount: outAmt, router: 'metis' }) };
      }
      inFlightExecutes += 1;
      maxConcurrentExecutes = Math.max(maxConcurrentExecutes, inFlightExecutes);
      await new Promise((r) => setTimeout(r, 40));
      inFlightExecutes -= 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, signature: `sig-${Math.random()}`, totalInputAmount: '1000000000', totalOutputAmount: '30000000' }) };
    },
  });
  trader.routeSetting = () => 'direct';

  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  e.settings.cooldown.enabled = false;
  e.settings.tradingAsset.solana = 'native';
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => true;
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-par', walletId: e.getActiveWallet().id, name: 't', handle: 't', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'buy-hold', sizing: { type: 'fixed', amount: 6 }, maxChasePct: 20,
    minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);

  await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 't', traderWallet: WALLET, traderBuyUsd: 50, signature: 'sig-buy-a',
    token: { address: MINT_A, decimals: 6, symbol: 'ASCEND', name: 'Ascend', isLaunchpad: true, venue: 'pumpswap', stage: 'graduated', marketCapUsd: 90000, traderFillPriceUsd: 0.006, currentPriceUsd: 0.006, safety: { safetyVerified: true } },
  });
  await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 't', traderWallet: WALLET, traderBuyUsd: 50, signature: 'sig-buy-b',
    token: { address: MINT_B, decimals: 6, symbol: 'BILLY', name: 'Billy', isLaunchpad: true, venue: 'launchlab', stage: 'pre-grad', marketCapUsd: 25000, traderFillPriceUsd: 0.006, currentPriceUsd: 0.006, safety: { safetyVerified: true } },
  });
  assert.equal(e.positions.filter((p) => p.remainingTokens > 0).length, 2);

  rpcCalls.length = 0;
  inFlightExecutes = 0;
  maxConcurrentExecutes = 0;
  trader.buyMintsInFlight = new Map();

  const bulk = await e.sellAllPositions({ panic: true });
  assert.equal(bulk.soldCount, 2);
  assert.equal(rpcCalls.filter((m) => m === 'getMultipleAccounts').length, 0, 'zero wasted pump.fun getMultipleAccounts calls when selling PumpSwap + LaunchLab');
  assert.equal(rpcCalls.filter((m) => m === 'getTokenSupply').length, 0, 'zero getTokenSupply calls because pos.decimals was preserved');
  assert.equal(trader.directStats.fallbacks, 0, 'zero unnecessary direct fallbacks');
  assert.equal(maxConcurrentExecutes, 2, 'both positions exited simultaneously in parallel');
});

test('S13 fast RPC race ignores faster null/unindexed responses when another RPC already has confirmed status or tx, and sets keepalive on RPC fetch', async () => {
  const seenKeepalive = [];
  const w = new SolanaWalletWatcher({
    rpcUrl: 'https://closer-lagging-alchemy.example',
    fastRpcUrls: ['https://helius-indexed.example'],
    fetchImpl: async (url, opts = {}) => {
      seenKeepalive.push(opts.keepalive);
      const body = JSON.parse(opts.body);
      if (String(url).includes('closer-lagging')) {
        // Responds 5 ms faster, but hasn't indexed the block yet!
        if (body.method === 'getSignatureStatuses') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [null] } }));
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
      }
      // Helius responds 25 ms later with the confirmed status / indexed tx
      await new Promise((r) => setTimeout(r, 25));
      if (body.method === 'getSignatureStatuses') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', err: null }] } }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { slot: 999, meta: { err: null } } }));
    },
    tokenInfo: { get: async () => null, solPriceFast: async () => 200 },
  });

  const st = await w.rpc('getSignatureStatuses', [['sig-1'], { searchTransactionHistory: true }], { fast: true });
  assert.equal(st?.value?.[0]?.confirmationStatus, 'confirmed', 'waited 25ms for Helius confirmed instead of returning Alchemy [null]');

  const tx = await w.rpc('getTransaction', ['sig-1', { encoding: 'jsonParsed' }], { fast: true });
  assert.equal(tx?.slot, 999, 'waited 25ms for Helius indexed tx instead of returning Alchemy null');
  assert.ok(seenKeepalive.every((k) => k === true), 'all JSON-RPC fetches reuse keep-alive sockets');
});

test('S14 priorityMicroLamportsFor wires dashboard priorityFee presets and executeDirect right-sizes CU limits (~95k buy / ~65k sell)', async () => {
  // 0.0002 SOL across 100k CU = 2,000,000 microLamports/CU
  assert.equal(priorityMicroLamportsFor({ mode: 'normal' }, 100_000), 2_000_000);
  // 0.001 SOL across 100k CU = 10,000,000 microLamports/CU
  assert.equal(priorityMicroLamportsFor({ mode: 'fast' }, 100_000), 10_000_000);
  // 0.005 SOL across 100k CU = 50,000,000 microLamports/CU
  assert.equal(priorityMicroLamportsFor({ mode: 'turbo' }, 100_000), 50_000_000);
  // custom clamped safely at <= 0.01 SOL even if someone enters 5 SOL
  assert.equal(priorityMicroLamportsFor({ mode: 'custom', customSol: 5 }, 100_000), 100_000_000);
  // explicit env override wins
  assert.equal(priorityMicroLamportsFor({ mode: 'turbo' }, 100_000, '750000'), 750_000);

  // Inspect compiled SetComputeUnitLimit instruction on Direct buy & sell
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const secret = base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]));
  const mint = base58Encode(crypto.randomBytes(32));
  const sentTxs = [];
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method, params) => {
      if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
      if (method === 'simulateTransaction') return { value: { err: null, accounts: [{ lamports: 4_900_000_000 }, { data: [Buffer.alloc(165).toString('base64'), 'base64'] }] } };
      if (method === 'sendTransaction') {
        sentTxs.push(Buffer.from(params[0], 'base64'));
        return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
      }
      if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      return null;
    },
  });
  trader.routeSetting = () => 'direct';
  trader.balance = { sol: 5, usdc: 0 };
  trader.priorityMicroLamports = (u) => priorityMicroLamportsFor({ mode: 'fast' }, u);
  await trader.refreshBlockhash();

  const fastTok = {
    address: mint,
    symbol: 'FAST',
    decimals: 6,
    curve: { virtualSolReserves: 30_000_000_000, virtualTokenReserves: 1_073_000_000_000_000, realTokenReserves: 790_000_000_000_000, mayhem: false, cashback: false, tokenProgram: PD.TOKEN_2022_PROGRAM },
  };
  const readCuLimit = (tx) => {
    const n = tx[0];
    const m = tx.subarray(1 + 64 * n);
    const nKeys = m[3];
    let o = 4 + 32 * nKeys + 32 + 1;
    o += 1; // prog idx
    const na = m[o++];
    o += na;
    const dl = m[o++];
    const data = m.subarray(o, o + dl);
    assert.equal(data[0], 2, 'SetComputeUnitLimit instruction tag = 2');
    return data.readUInt32LE(1);
  };

  const qb = await trader.quote({ side: 'buy', token: fastTok, amountUsd: 8, slippagePct: 10 });
  const rb = await trader.execute({ side: 'buy', token: fastTok, amountUsd: 8, quote: qb, slippagePct: 10 });
  assert.equal(rb.ok, true);
  const buyCu = readCuLimit(sentTxs[0]);
  assert.ok(buyCu >= 95_000 && buyCu < 105_000, `Direct buy CU limit right-sized (~95k..105k), got ${buyCu}`);

  const qs = await trader.quote({ side: 'sell', token: fastTok, tokenAmount: 'all', slippagePct: 15 });
  const rs = await trader.execute({ side: 'sell', token: fastTok, tokenAmount: 'all', quote: qs, slippagePct: 15 });
  assert.equal(rs.ok, true);
  const sellCu = readCuLimit(sentTxs[1]);
  assert.ok(sellCu >= 65_000 && sellCu < 75_000, `Direct sell CU limit right-sized (~65k..75k), got ${sellCu}`);
});

test('S15 immediate <3s direct sell uses pos.lastCurve for 0-RPC quote and overlaps waitForSignature in parallel with simulateTransaction', async () => {
  CHAINS.solana.nativePriceUsd = 200;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const secret = base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]));
  const mint = `${base58Encode(crypto.randomBytes(29)).slice(0, 40)}pump`;
  const events = [];
  let simGate = null;

  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method, params) => {
      events.push(method);
      if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
      if (method === 'simulateTransaction') {
        if (simGate) await simGate;
        return { value: { err: null, accounts: [{ lamports: 4_950_000_000 }, { data: [Buffer.alloc(165).toString('base64'), 'base64'] }] } };
      }
      if (method === 'sendTransaction') return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
      if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      return null;
    },
  });
  trader.routeSetting = () => 'direct';
  trader.balance = { sol: 5, usdc: 0 };
  await trader.refreshBlockhash();

  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  e.settings.tradingAsset.solana = 'native';
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => true;
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-fast-sell', walletId: e.getActiveWallet().id, name: 'Decu', handle: 'Decu', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'auto-exit', mirrorSells: true, sizing: { type: 'fixed', amount: 8 }, maxChasePct: 25,
    minTradeUsd: 1, maxOpenPositions: 100, maxAtRiskUsd: 100000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);

  const curve = { virtualSolReserves: 32_000_000_000, virtualTokenReserves: 1_006_000_000_000_000, realTokenReserves: 726_000_000_000_000, mayhem: false, cashback: false, tokenProgram: PD.TOKEN_2022_PROGRAM };
  const [buyRes] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 'Decu', traderWallet: WALLET, traderBuyUsd: 100, signature: 'sig-fast-b',
    token: { address: mint, decimals: 6, symbol: 'QUICK', name: 'Quick', isLaunchpad: true, venue: 'pumpfun', stage: 'pre-grad', marketCapUsd: 6360, traderFillPriceUsd: 0.00000636, currentPriceUsd: 0.00000636, curve, safety: { safetyVerified: true } },
  });
  assert.equal(buyRes.status, 'filled');
  assert.ok(e.positions[0].lastCurve, 'position initialized lastCurve from buy signal');
  assert.equal(trader.buyInProgress(mint), true, 'still inside 3s post-buy grace window');

  // Hold simulateTransaction open for 50ms: getSignatureStatuses MUST still fire in parallel before simulateTransaction resolves!
  events.length = 0;
  let releaseSim;
  simGate = new Promise((r) => { releaseSim = r; });

  const sellP = e.executePositionSell(e.positions[0].id, { sellPct: 100, cause: 'Take Initials' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.filter((m) => m === 'getMultipleAccounts').length, 0, '0-RPC fastCurve direct sell quote even <3s after buy');
  assert.ok(events.includes('getSignatureStatuses'), 'waitForSignature started polling in parallel before simulateTransaction finished');
  releaseSim();
  const sellRes = await sellP;
  assert.equal(sellRes.ok, true);
});

test('S16 Jupiter swap races /execute against on-chain getSignatureStatuses when fastRpcUrls are active', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const makeTx = () =>
    Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(64),
      Buffer.from([0x80, 1, 0, 1, 2]),
      pub,
      crypto.randomBytes(32),
      crypto.randomBytes(32),
      Buffer.from([0, 0]),
    ]).toString('base64');

  const MINT = 'PumpSwapGrad1111111111111111111111111111pump';
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    fastRpcUrls: ['https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions'],
    rpc: async (method) => {
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      if (method === 'getTransaction') return null;
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('block-engine.jito.wtf')) {
        return { ok: true, status: 200, text: async () => '{}' };
      }
      if (String(url).includes('/order')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: makeTx(), requestId: 'r-race', inAmount: '40000000', outAmount: '2000000000', router: 'metis' }) };
      }
      // Simulate slow 600ms Jupiter /execute HTTP wrapper while Jito already confirmed in 35ms!
      await new Promise((r) => setTimeout(r, 600).unref?.());
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, totalInputAmount: '40000000', totalOutputAmount: '2000000000' }) };
    },
  });

  const tok = { address: MINT, symbol: 'GRAD', decimals: 6, venue: 'pumpswap', stage: 'graduated', currentPriceUsd: 0.004 };
  const q = await trader.quote({ side: 'buy', token: tok, amountUsd: 8, slippagePct: 10 });
  const t0 = Date.now();
  const r = await trader.execute({ side: 'buy', token: tok, amountUsd: 8, quote: q, slippagePct: 10 });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 250, `completed in ${elapsed} ms via on-chain confirmation race without waiting 600 ms for Jupiter /execute`);
});

test('S17 WebSocket signatureSubscribe + ownTxCache confirms swaps in 0 ms at confirmed commitment (never processed) with 0-RPC readFill', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const MINT = 'WsConfirm111111111111111111111111111111pump';

  const sentWsMsgs = [];
  class MockWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      setImmediate(() => this.onopen?.());
    }
    send(raw) {
      const msg = JSON.parse(raw);
      sentWsMsgs.push(msg);
      if (msg.method === 'signatureSubscribe') {
        const sig = msg.params[0];
        // Subscribed strictly at 'confirmed' commitment
        assert.equal(msg.params[1]?.commitment, 'confirmed');
        setImmediate(() => {
          this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 777 }) });
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: '2.0',
              method: 'signatureNotification',
              params: { subscription: 777, result: { context: { slot: 123 }, value: { err: null } } },
            }),
          });
        });
      }
    }
    close() {
      this.readyState = 3;
    }
  }

  let getTxCalls = 0;
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    confirmWsUrl: 'wss://mainnet.helius-rpc.example/?api-key=test',
    WebSocketImpl: MockWS,
    rpc: async (method) => {
      if (method === 'getBalance') return { value: 5e9 };
      if (method === 'getSignatureStatuses') {
        // Simulate slow HTTP status polling (400 ms) so WS signatureSubscribe wins!
        await new Promise((r) => setTimeout(r, 400).unref?.());
        return { value: [null] };
      }
      if (method === 'getTransaction') {
        getTxCalls += 1;
        return null;
      }
      return { value: { decimals: 6 } };
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/order')) {
        const tx = Buffer.concat([
          Buffer.from([1]),
          Buffer.alloc(64),
          Buffer.from([0x80, 1, 0, 1, 2]),
          pub,
          crypto.randomBytes(32),
          crypto.randomBytes(32),
          Buffer.from([0, 0]),
        ]).toString('base64');
        return { ok: true, status: 200, text: async () => JSON.stringify({ transaction: tx, requestId: 'r-ws', inAmount: '40000000', outAmount: '2500000000', router: 'metis' }) };
      }
      // Slow 800 ms Jupiter /execute HTTP wrapper
      await new Promise((r) => setTimeout(r, 800).unref?.());
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'Success', code: 0, totalInputAmount: '40000000', totalOutputAmount: '2500000000' }) };
    },
  });

  // Safety guard: 'processed' must NEVER mark a signature succeeded
  assert.equal(trader.notifySignature('unconfirmed-sig', { err: null, confirmationStatus: 'processed' }), false);
  assert.equal(trader.resolvedSigs.has('unconfirmed-sig'), false);

  const tok = { address: MINT, symbol: 'WSFAST', decimals: 6, venue: 'pumpswap', stage: 'graduated', currentPriceUsd: 0.0032 };
  const q = await trader.quote({ side: 'buy', token: tok, amountUsd: 8, slippagePct: 10 });
  // Pre-cache own-wallet transaction (as Yellowstone gRPC onWalletTx does) before/during confirmation
  const { signature } = (await import('../engine/realTrader.mjs')).signTransactionBase64(q._order.transaction, trader.keypair);
  trader.cacheOwnTransaction(signature, {
    slot: 123,
    meta: {
      err: null,
      fee: 35_000,
      preBalances: [5_000_000_000],
      postBalances: [5_000_000_000 - 40_000_000 - 35_000],
      preTokenBalances: [],
      postTokenBalances: [{ mint: MINT, owner: trader.address, uiTokenAmount: { amount: '2512345678', decimals: 6 } }],
    },
    transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: trader.address }] } },
  });

  const t0 = Date.now();
  const r = await trader.execute({ side: 'buy', token: tok, amountUsd: 8, quote: q, slippagePct: 10 });
  const elapsed = Date.now() - t0;
  trader.stopConnectionWarmer();

  assert.equal(r.ok, true);
  assert.ok(elapsed < 100, `confirmed via WebSocket signatureSubscribe in ${elapsed} ms without waiting 400–800 ms on HTTP polling`);
  assert.equal(getTxCalls, 0, '0 getTransaction RPC calls because ownTxCache supplied exact tx.meta');
  assert.ok(Math.abs(r.tokensReceived - 2512.345678) < 1e-6, 'used exact on-chain tokens from ownTxCache');
  assert.ok(sentWsMsgs.some((m) => m.method === 'signatureSubscribe'), 'sent WebSocket signatureSubscribe');
});

test('S18 size-calibrated priorityMicroLamportsFor protects $8 (~0.083 SOL) trades from fee bleed while boosting CU priority 35x+', () => {
  // $8 trade at ~$96/SOL = 0.0833 SOL across 95,000 CU:
  // Uncapped 'turbo' would charge 0.005 SOL (~$0.48/leg = 60% of a +$0.80 +10% TP!).
  // Size-calibrated 'turbo' caps at 0.00035 SOL (~$0.033/leg) = ~3,684,211 microLamports/CU (36.8x old 100k default!)
  const turboSmall = priorityMicroLamportsFor({ mode: 'turbo' }, 95_000, null, { tradeSol: 0.0833 });
  const turboSmallSol = (turboSmall * 95_000) / 1e15;
  assert.ok(turboSmall > 3_500_000, `35x+ higher priority than old 100k default (${turboSmall})`);
  assert.ok(Math.abs(turboSmallSol - 0.00035) < 0.00001, `capped at ~0.00035 SOL on $8 trade, got ${turboSmallSol}`);

  const fastSmall = priorityMicroLamportsFor({ mode: 'fast' }, 95_000, null, { tradeSol: 0.0833 });
  const fastSmallSol = (fastSmall * 95_000) / 1e15;
  assert.ok(Math.abs(fastSmallSol - 0.00025) < 0.00001, `fast capped at ~0.00025 SOL on $8 trade, got ${fastSmallSol}`);

  // Larger 1.5 SOL trade automatically scales up to the full 0.005 SOL turbo preset
  const turboLarge = priorityMicroLamportsFor({ mode: 'turbo' }, 100_000, null, { tradeSol: 1.5 });
  assert.equal(turboLarge, 50_000_000);

  // Explicit custom mode always honors customSol without size-capping
  const customExplicit = priorityMicroLamportsFor({ mode: 'custom', customSol: 0.002 }, 100_000, null, { tradeSol: 0.0833 });
  assert.equal(customExplicit, 20_000_000);
});

test('S19 paperDelayMsFor models realistic >=650 ms Solana confirmed latency instead of 250 ms sub-slot phantom scalps', () => {
  assert.equal(paperDelayMsFor({ chainId: 'bsc', side: 'buy', swapRoute: 'direct' }), 0);
  const directTok = { venue: 'pumpfun', stage: 'pre-grad', curve: { virtualSolReserves: 32e9 } };
  assert.equal(paperDelayMsFor({ chainId: 'solana', side: 'buy', token: directTok, swapRoute: 'direct' }), 650);
  assert.equal(paperDelayMsFor({ chainId: 'solana', side: 'sell', token: directTok, swapRoute: 'direct' }), 750);

  // LaunchLab pre-grad tokens route via Jupiter, NOT direct pump.fun curve
  const launchLabTok = { venue: 'launchlab', stage: 'pre-grad', curve: { virtualSolReserves: 32e9, launchlab: true } };
  assert.equal(paperDelayMsFor({ chainId: 'solana', side: 'buy', token: launchLabTok, swapRoute: 'direct' }), 950);
  assert.equal(paperDelayMsFor({ chainId: 'solana', side: 'sell', token: launchLabTok, swapRoute: 'direct' }), 1000);
});

test('S20 fastCurve direct buy reads actual post-land tokens (not pre-trade simulated d.tokensOut) so trailing stop never false-arms and direct sell never fails with 6023', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = base58Encode(Buffer.concat([seed, pub]));
  const MINT = base58Encode(crypto.randomBytes(32));

  const actualOnChainTokensRaw = 1_124_765_256_268n;
  let walletHeldRaw = 0n;

  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 200,
    rpc: async (method, params) => {
      if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
      if (method === 'getBalance') return { value: 5_000_000_000 };
      if (method === 'simulateTransaction') {
        return { value: { err: null, accounts: [{ lamports: 4_950_000_000 }, { data: [Buffer.alloc(165).toString('base64'), 'base64'] }] } };
      }
      if (method === 'sendTransaction') {
        if (walletHeldRaw === 0n) walletHeldRaw = actualOnChainTokensRaw;
        else walletHeldRaw = 0n;
        return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
      }
      if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      if (method === 'getTransaction') return null;
      if (method === 'getTokenAccountsByOwner') {
        return {
          value: walletHeldRaw > 0n
            ? [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: String(walletHeldRaw), decimals: 6 } } } } } }]
            : [],
        };
      }
      return { value: null };
    },
  });
  trader.routeSetting = () => 'direct';
  trader.balance = { sol: 5, usdc: 0, at: Date.now() };
  await trader.refreshBlockhash();

  const tok = {
    address: MINT,
    symbol: 'MOOHAN',
    decimals: 6,
    venue: 'pumpfun',
    stage: 'pre-grad',
    currentPriceUsd: 0.000006,
    curve: {
      virtualSolReserves: 30_000_000_000,
      virtualTokenReserves: 1_073_000_000_000_000,
      realTokenReserves: 790_000_000_000_000,
      mayhem: false,
      cashback: false,
      tokenProgram: PD.TOKEN_2022_PROGRAM,
      at: Date.now(),
    },
  };

  const qBuy = await trader.quote({ side: 'buy', token: tok, amountUsd: 8, slippagePct: 25 });
  assert.ok(qBuy._direct.tokensOut > 1_400_000_000_000n, 'pre-trade quote estimates >1.4M tokens');

  const buyRes = await trader.execute({ side: 'buy', token: tok, amountUsd: 8, quote: qBuy, slippagePct: 25 });
  assert.equal(buyRes.ok, true);
  assert.ok(Math.abs(buyRes.tokensReceived - 1_124_765.256268) < 1e-4, `booked actual on-chain tokens (1,124,765.26), got ${buyRes.tokensReceived}`);
  assert.equal(trader.mintMetaCache.get(MINT).heldRaw, actualOnChainTokensRaw, 'mintMetaCache heldRaw matches exact on-chain balance');
  assert.ok(Math.abs(buyRes.fillPriceUsd - buyRes.spentUsd / 1_124_765.256268) < 1e-9, 'fillPriceUsd reflects true on-chain entry price');

  const qSell = await trader.quote({ side: 'sell', token: tok, amountUsd: 8, slippagePct: 15, tokenAmount: 'all' });
  assert.equal(qSell.route, 'direct');
  assert.equal(qSell._direct.amount, actualOnChainTokensRaw, 'direct sell uses exact on-chain token count');
});

test('S21 Edit A + Edit B + Items #1–#4: parseSwapFromTransaction curve extraction, 0ms fastCurve mirror sell, 0.4s sellRetrySec, and full Turbo CU priority on $25 buys & sells', async () => {
  const { parseSwapFromTransaction } = await import('../engine/walletWatcher.mjs');
  const { base58Decode } = await import('../engine/onchainMeta.mjs');
  const MINT = '82ysZZ4WrTkeo8Tz6o5QiVtJYqs6FCu6WX73GCEJpump';
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const pk = (s) => Buffer.from(base58Decode(s));
  const name = Buffer.from('buy_exact_quote_in_v3');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  const evB64 = Buffer.concat([
    Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
    pk(MINT), u64(250_000_000n), u64(30_000_000_000_000n), Buffer.from([1]), pk(WALLET), u64(Math.floor(Date.now() / 1000)),
    u64(32_500_000_000n), u64(990_000_000_000_000n), u64(2_500_000_000n), u64(710_000_000_000_000n),
    pk('11111111111111111111111111111111'), u64(95), u64(2_500_000n), pk(WALLET), u64(30), u64(750_000n),
    Buffer.from([1]), u64(0), u64(0), u64(0), u64(0), len, name,
    Buffer.from([0]), u64(0), u64(0), u64(0), u64(0), Buffer.alloc(4), pk(WSOL_MINT), u64(250_000_000n),
  ]).toString('base64');

  // 1. Edit A + Item #2: parseSwapFromTransaction extracts curve + Token-2022 + .at timestamp
  const tx = {
    slot: 100,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [5e9, 0, 0, 1],
      postBalances: [4.75e9 - 5000, 0, 0, 1],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 2, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '30000000000000', decimals: 6 } }],
      logMessages: [`Program ${PUMP_CURVE_PROGRAM} invoke [1]`, `Program data: ${evB64}`, `Program ${PUMP_CURVE_PROGRAM} success`],
    },
    transaction: {
      signatures: ['sig-edit-a'],
      message: { accountKeys: [{ pubkey: WALLET }, { pubkey: PUMP_CURVE_PROGRAM }, { pubkey: PD.TOKEN_2022_PROGRAM }] },
    },
  };
  const parsed = parseSwapFromTransaction(tx, WALLET);
  assert.ok(parsed.curve, 'Edit A: curve extracted from parseSwapFromTransaction');
  assert.equal(parsed.curve.virtualSolReserves, 32_500_000_000);
  assert.equal(parsed.curve.tokenProgram, PD.TOKEN_2022_PROGRAM, 'Edit A: Token-2022 extracted from tx keys');
  assert.ok(Date.now() - parsed.curve.at < 1000, 'Item #2: curve.at timestamp stamped');

  // 2. Item #1 & #4: $25 (~0.30 SOL) Turbo buy & sell get full 0.0025 SOL CU priority
  const buyMicro = priorityMicroLamportsFor({ mode: 'turbo' }, 95_000, null, { tradeSol: 0.30 });
  const sellMicro = priorityMicroLamportsFor({ mode: 'turbo' }, 65_000, null, { tradeSol: 0.30 });
  assert.equal(buyMicro, 26_315_789, 'Item #4: $25 buy gets 26.3M microLamports/CU');
  assert.equal(sellMicro, 38_461_538, 'Item #1: $25 sell gets 38.5M microLamports/CU');
  const sellPol = PD.resolveDirectPriority({ priorityFee: { mode: 'turbo' }, side: 'sell', units: 65_000 });
  assert.equal(sellPol.microLamports, 15_000_000, 'Item #1: resolveDirectPriority gives sell full 15M microLamports on turbo');

  // 3. Item #3 + Edit B + Item #2: sellRetrySec = 0.4s & traderSellCurve without .at stamps .at for 0-RPC fastCurve sell
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const secret = base58Encode(Buffer.concat([privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]));
  const rpcCalls = [];
  const trader = new RealTrader({
    env: { ODEX_TRADER_KEY: secret },
    solPrice: () => 85,
    rpc: async (method, params) => {
      rpcCalls.push(method);
      if (method === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
      if (method === 'simulateTransaction') return { value: { err: null, accounts: [{ lamports: 4_700_000_000 }, { data: [Buffer.alloc(165).toString('base64'), 'base64'] }] } };
      if (method === 'sendTransaction') return base58Encode(Buffer.from(params[0], 'base64').subarray(1, 65));
      if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      if (method === 'getTransaction') return null;
      if (method === 'getTokenAccountsByOwner') {
        return { value: [{ account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: '3500000000000', decimals: 6 } } } } } }] };
      }
      return { value: null };
    },
  });
  assert.equal(trader.caps.sellRetrySec, 0.4, 'Item #3: sellRetrySec defaults to 0.4s');
  trader.routeSetting = () => 'direct';
  trader.balance = { sol: 5, usdc: 0, at: Date.now() };
  await trader.refreshBlockhash();

  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = false;
  e.settings.tradingAsset.solana = 'native';
  e.adapter.liveHooks = trader.hooks();
  e.adapter.realEnabled = () => true;
  e.getActiveWallet().balances.solana = { native: 5, stable: 0 };
  const f = {
    id: 'fol-s21', walletId: e.getActiveWallet().id, name: '4vw5…9Ud9', handle: '4vw5…9Ud9', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', pauseReason: null, mode: 'auto-exit', mirrorSells: true, sizing: { type: 'fixed', amount: 25 }, maxChasePct: 30,
    minTradeUsd: 1, maxOpenPositions: 10, maxAtRiskUsd: 1000, consecutiveLosses: 0, exitRules: createDefaultExitRules(), filtersOverride: {}, createdAt: Date.now(),
  };
  e.follows.unshift(f);

  rpcCalls.length = 0;
  const [buyRes] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: f.handle, traderWallet: WALLET, traderBuyUsd: 165, signature: 'sig-s21-buy',
    token: { address: MINT, decimals: 6, symbol: 'DEGEN', name: 'Degen', isLaunchpad: true, venue: 'pumpfun', stage: 'pre-grad', marketCapUsd: 6000, traderFillPriceUsd: 0.000006, currentPriceUsd: 0.000006, curve: parsed.curve, safety: { safetyVerified: true } },
  });
  assert.equal(buyRes.status, 'filled');
  assert.equal(rpcCalls.filter((m) => m === 'getMultipleAccounts').length, 0, '0 getMultipleAccounts RPC calls on buy thanks to Edit A curve + Token-2022');

  // Expire pos.lastCurve.at so only traderSellCurve (passed WITHOUT .at) can save the mirror sell from getMultipleAccounts
  e.positions[0].lastCurve.at = Date.now() - 10_000;
  rpcCalls.length = 0;
  const [sellRes] = await e.processTraderSignal({
    chainId: 'solana', side: 'sell', sellSharePct: 100, traderHandle: f.handle, traderWallet: WALLET, signature: 'sig-s21-sell',
    token: {
      address: MINT, decimals: 6, symbol: 'DEGEN', venue: 'pumpfun', stage: 'pre-grad',
      traderFillPriceUsd: 0.000008, currentPriceUsd: 0.000008,
      curve: { virtualSolReserves: 35_000_000_000, virtualTokenReserves: 920_000_000_000_000, realTokenReserves: 640_000_000_000_000, mayhem: false, cashback: false },
    },
  });
  assert.equal(sellRes.ok, true);
  assert.equal(rpcCalls.filter((m) => m === 'getMultipleAccounts').length, 0, 'Item #2: 0 getMultipleAccounts RPC calls on mirror sell when traderSellCurve is stamped with .at');
});

test('S22 Nov 11 4-edit calibration: smart maxChase (30% <=$12k MC, 26.5% >$12k MC), 4s floor grace, 22% trail arm, and $100k maxMarketCapUsd', async () => {
  const { restoreEngine } = await import('../engine/persistence.mjs');
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  restoreEngine(e, {
    follows: [{
      id: 'fol-03782071',
      walletId: e.getActiveWallet().id,
      name: '4vw5…9Ud9',
      handle: '4vw5…9Ud9',
      traderWallet: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
      chainId: 'solana',
      status: 'copying',
      mode: 'auto-exit',
      mirrorSells: true,
      sizing: { type: 'fixed', amount: 25 },
      minTradeUsd: 1,
      maxOpenPositions: 10,
      maxAtRiskUsd: 1000,
      exitRules: {
        takeInitials: { enabled: true, takeAtPct: 35, sellSizePct: 100 },
        moonbagTrail: { enabled: true, trailPct: 10, armsAtPct: 12 },
        floor: { enabled: true, openingFloorPct: 25, tightensAfterSec: 45, tightFloorPct: 15 },
        waveCut: { enabled: true, afterSec: 25, needsPeakPct: 8 },
        hardTimeCap: { enabled: true, timeCapSec: 180 },
      },
      filtersOverride: { minTraderBuyNative: 0.5 },
      decuV3Migrated: true,
      decuV5Migrated: true,
    }],
  });

  const f = e.follows[0];
  assert.equal(f.maxChasePct, 30);
  assert.equal(f.matureMaxChasePct, 26.5);
  assert.equal(f.exitRules.moonbagTrail.armsAtPct, 22);
  assert.equal(f.exitRules.floor.graceSec, 4);
  assert.equal(f.filtersOverride.maxMarketCapUsd, 100000);

  // Edit #1: Qi ($9.1k MC <= $12k) allows 27.56% chase (<= 30%), while GIF ($13.9k MC > $12k) caps at 26.5%
  assert.equal(e.maxChaseFor(f, { marketCapUsd: 9100 }), 30);
  assert.equal(e.maxChaseFor(f, { marketCapUsd: 13900 }), 26.5);

  // Edit #4: updog ($780.3k MC > $100k limit) is skipped by market cap filter
  const [updogRes] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: f.handle, traderWallet: f.traderWallet, traderBuyUsd: 200, traderBuyNative: 1.5,
    token: { address: 'updogMint111111111111111111111111111111111', symbol: 'updog', isLaunchpad: true, marketCapUsd: 780_300, traderFillPriceUsd: 0.00078, currentPriceUsd: 0.00080, safety: { safetyVerified: true } },
  });
  assert.equal(updogRes.status, 'skipped');
  assert.equal(updogRes.reason, 'market cap outside your filter');

  // Edit #2 & #3: BERNIE #2 (-26% dip at 2.0s holds during 4s grace) & DANIELA (+13.7% peak does not arm 22% trail)
  const [danRes] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: f.handle, traderWallet: f.traderWallet, traderBuyUsd: 200, traderBuyNative: 1.5,
    token: { address: 'danMint11111111111111111111111111111111111', symbol: 'DANIELA', isLaunchpad: true, marketCapUsd: 27_500, traderFillPriceUsd: 0.000025, currentPriceUsd: 0.000027, safety: { safetyVerified: true } },
  });
  assert.equal(danRes.status, 'filled');
  const pos = danRes.position;
  // +13.7% peak then 11% pullback at 1.2s does NOT arm or trigger moonbagTrail (needs +22%)
  pos.peakPriceUsd = pos.entryPriceUsd * 1.137;
  pos.currentPriceUsd = pos.peakPriceUsd * 0.88;
  await e.evaluatePositionExits(pos, pos.openedAt + 1200);
  assert.equal(pos.trailArmed, false);
  assert.ok(pos.remainingTokens > 0, 'DANIELA holds past 1.2s shakeout');

  // -26% wick at 2.0s is ignored during 4s opening floor grace period (BERNIE #2)
  pos.currentPriceUsd = pos.entryPriceUsd * 0.74;
  await e.evaluatePositionExits(pos, pos.openedAt + 2000);
  assert.ok(pos.remainingTokens > 0, 'BERNIE #2 holds during 4s opening floor grace period');

  // After 4.5s, if still at -26%, the -25% opening floor triggers normally
  await e.evaluatePositionExits(pos, pos.openedAt + 4500);
  assert.equal(pos.remainingTokens, 0, 'opening floor triggers normally once 4s grace period has elapsed');
});
