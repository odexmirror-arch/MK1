/**
 * Live pump.fun bonding-curve data straight from the chain (no DexScreener delay).
 *
 * Every token still on its pump.fun curve has a "bonding-curve" account holding the pool's
 * reserves. Reading it gives the exact current price, market cap and the SOL really in the
 * pool. Graduated curves (`complete`) have moved to an AMM, where DexScreener is used instead.
 */
import { findProgramAddress, base58Decode } from './onchainMeta.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_DECIMALS = 6;
const curveCache = new Map(); // mint → PDA (derivation is pure; cache it)
const launchLabCache = new Map(); // mint → Raydium LaunchLab PoolState PDA

export function bondingCurvePda(mint) {
  if (!curveCache.has(mint)) curveCache.set(mint, findProgramAddress([Buffer.from('bonding-curve'), base58Decode(mint)], PUMP_PROGRAM));
  return curveCache.get(mint);
}

export function launchLabPoolPda(mint) {
  if (!launchLabCache.has(mint)) {
    launchLabCache.set(mint, findProgramAddress([Buffer.from('pool'), base58Decode(mint), base58Decode(WSOL_MINT)], RAYDIUM_LAUNCHLAB_PROGRAM));
  }
  return launchLabCache.get(mint);
}

/** Decode Raydium LaunchLab PoolState (429 bytes): status (u8 @ 17), decimals (18, 19), supply (21), virtualBase (37), virtualQuote (45), realBase (53), realQuote (61). */
export function parseLaunchLabPool(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  if (b.length < 69) return null;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  const status = b[17];
  const baseDecimals = b[18] || 6;
  const quoteDecimals = b[19] || 9;
  const supply = u64(21);
  const totalBaseSell = u64(29);
  const virtualBase = u64(37);
  const virtualQuote = u64(45);
  const realBase = u64(53);
  const realQuote = u64(61);
  if (!(virtualBase > realBase) || !(virtualQuote > 0) || !(supply > 0)) return null;
  return {
    status,
    complete: status !== 0,
    baseDecimals,
    quoteDecimals,
    supply,
    totalBaseSell,
    virtualBase,
    virtualQuote,
    realBase,
    realQuote,
  };
}

export function launchLabMetrics(pool, solPriceUsd) {
  if (!pool || !(solPriceUsd > 0) || !(pool.virtualBase > pool.realBase)) return null;
  const effTokens = (pool.virtualBase - pool.realBase) / 10 ** pool.baseDecimals;
  const effSol = (pool.virtualQuote + pool.realQuote) / 10 ** pool.quoteDecimals;
  if (!(effTokens > 0) || !(effSol > 0)) return null;
  const priceSol = effSol / effTokens;
  const priceUsd = priceSol * solPriceUsd;
  const supply = pool.supply / 10 ** pool.baseDecimals;
  return {
    priceUsd,
    marketCapUsd: priceUsd * supply,
    liquidityUsd: (pool.realQuote / 10 ** pool.quoteDecimals) * solPriceUsd * 2,
    complete: pool.complete,
    source: 'pump-curve',
    curve: {
      virtualTokenReserves: pool.virtualBase - pool.realBase,
      virtualSolReserves: pool.virtualQuote + pool.realQuote,
      realTokenReserves: Math.max(0, (pool.totalBaseSell || pool.virtualBase) - pool.realBase),
      realSolReserves: pool.realQuote,
      launchlab: true,
      at: Date.now(),
    },
  };
}

/** Decode the BondingCurve account: 8-byte discriminator, five u64 fields, `complete` flag. */
export function parseBondingCurve(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  if (b.length < 8 + 8 * 5 + 1) return null;
  const u64 = (o) => Number(b.readBigUInt64LE(o));
  return {
    virtualTokenReserves: u64(8),
    virtualSolReserves: u64(16),
    realTokenReserves: u64(24),
    realSolReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: b[48] === 1,
    mayhem: b.length > 81 ? b[81] === 1 : false,
    cashback: b.length > 82 ? b[82] === 1 : false,
  };
}

/** Price / market cap / liquidity in USD from curve reserves. */
export function curveMetrics(curve, solPriceUsd) {
  if (!curve || !(curve.virtualTokenReserves > 0) || !(solPriceUsd > 0)) return null;
  // A standard pump.fun curve always carries its 30 SOL of virtual reserves on top of the real
  // SOL. Curves that don't (other configs / migrated states) are not trusted: DexScreener is used.
  const virtualOnly = (curve.virtualSolReserves - curve.realSolReserves) / 1e9;
  if (virtualOnly < 25 || virtualOnly > 35) return null;
  const priceSol = curve.virtualSolReserves / 1e9 / (curve.virtualTokenReserves / 10 ** TOKEN_DECIMALS);
  const priceUsd = priceSol * solPriceUsd;
  const supply = curve.tokenTotalSupply / 10 ** TOKEN_DECIMALS;
  return {
    priceUsd,
    marketCapUsd: priceUsd * supply,
    // the SOL really deposited in the curve, counted on both sides of the pool (as DEX sites show it)
    liquidityUsd: (curve.realSolReserves / 1e9) * solPriceUsd * 2,
    complete: curve.complete,
    source: 'pump-curve',
    curve: {
      virtualTokenReserves: curve.virtualTokenReserves,
      virtualSolReserves: curve.virtualSolReserves,
      realTokenReserves: curve.realTokenReserves,
      realSolReserves: curve.realSolReserves,
      mayhem: Boolean(curve.mayhem),
      cashback: Boolean(curve.cashback),
      at: Date.now(),
    },
  };
}

/**
 * Read many curves in one RPC call. Returns Map mint → metrics (only tokens still on a curve).
 * @param rpc async (method, params) => result
 */
export async function fetchPumpCurves(rpc, mints, solPriceUsd, launchLabMints = null) {
  const out = new Map();
  const list = [...new Set(mints)].filter(Boolean).slice(0, 100);
  if (!list.length) return out;
  const valid = [];
  for (const m of list) {
    try {
      const pda = bondingCurvePda(m);
      if (pda) valid.push([m, pda, 'pump']);
    } catch {
      // ignore invalid base58
    }
    if (!/pump$/i.test(m) || launchLabMints?.has?.(m)) {
      try {
        const llPda = launchLabPoolPda(m);
        if (llPda) valid.push([m, llPda, 'launchlab']);
      } catch {
        // ignore invalid base58
      }
    }
  }
  if (!valid.length) return out;
  const res = await rpc('getMultipleAccounts', [valid.map(([, p]) => p), { encoding: 'base64', commitment: 'processed' }]);
  (res?.value || []).forEach((acc, i) => {
    if (!acc || !acc.data?.[0]) return;
    const [mint] = valid[i];
    if (acc.owner === PUMP_PROGRAM) {
      const m = curveMetrics(parseBondingCurve(acc.data[0]), solPriceUsd);
      if (m && !m.complete) out.set(mint, m);
    } else if (acc.owner === RAYDIUM_LAUNCHLAB_PROGRAM && !out.has(mint)) {
      const m = launchLabMetrics(parseLaunchLabPool(acc.data[0]), solPriceUsd);
      if (m && !m.complete) out.set(mint, m);
    }
  });
  return out;
}

/**
 * Where a copy really fills on a pump.fun bonding curve (constant product x·y = k, starting at
 * 30 virtual SOL × 1,073,000,000 tokens). The trader's buy moves the curve first; the copy then
 * buys on top of it:
 *   trader: avg price p = V0·(V0+s)/k  →  pool before them V0 = (−s + √(s² + 4kp)) / 2
 *   after the trader: V1 = V0 + s, marginal price V1²/k
 *   our buy of x SOL: avg price V1·(V1+x)/k
 * Returns null when the numbers don't describe a curve (e.g. graduated / other pool).
 * Prices are in USD per token; s, x in SOL (what enters the curve, after fees).
 */
export const PUMP_CURVE_K = 30 * 1_073_000_000; // SOL × tokens
export function pumpCurveCopyFill({ traderPriceUsd, traderSol, ourSol, solPriceUsd, startSol = 0 }) {
  const px = Number(solPriceUsd);
  const p = Number(traderPriceUsd) / px; // SOL per token
  const s = Number(traderSol);
  const x = Number(ourSol);
  if (!(px > 0) || !(p > 0) || !(s > 0) || !(x > 0)) return null;
  const k = PUMP_CURVE_K;
  const v0 = (-s + Math.sqrt(s * s + 4 * k * p)) / 2;
  // a live curve holds 30 virtual SOL + up to ~85 real SOL
  if (!(v0 >= 29.5 && v0 <= 116)) return null;
  const v1 = v0 + s + Math.max(0, Number(startSol) || 0); // + our own earlier copies, if any
  return {
    poolSolBefore: v0,
    postTraderPriceUsd: ((v1 * v1) / k) * px,
    fillPriceUsd: ((v1 * (v1 + x)) / k) * px,
  };
}

/**
 * Where a copy SELL really fills on a pump.fun bonding curve after the trader's own sell drained
 * `traderSol` SOL from the pool:
 *   trader: avg sell price p = V0·V1/k where V0 = V1 + s  →  pool after them V1 = (−s + √(s² + 4kp)) / 2
 *   after the trader: marginal price V1²/k
 *   our sell of ~x SOL: avg price V1·max(30, V1−x)/k
 */
export function pumpCurveSellFill({ traderPriceUsd, traderSol, ourSol = 0, solPriceUsd }) {
  const px = Number(solPriceUsd);
  const p = Number(traderPriceUsd) / px;
  const s = Number(traderSol);
  const x = Math.max(0, Number(ourSol) || 0);
  if (!(px > 0) || !(p > 0) || !(s > 0)) return null;
  const k = PUMP_CURVE_K;
  const v1 = (-s + Math.sqrt(s * s + 4 * k * p)) / 2;
  if (!(v1 >= 29.5 && v1 <= 116)) return null;
  const v2 = Math.max(30, v1 - x);
  return {
    poolSolAfterTrader: v1,
    postTraderPriceUsd: ((v1 * v1) / k) * px,
    fillPriceUsd: ((v1 * v2) / k) * px,
  };
}
