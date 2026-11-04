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
import { RealTrader, WSOL_MINT } from '../engine/realTrader.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { CHAINS } from '../engine/chainAdapters.mjs';

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
