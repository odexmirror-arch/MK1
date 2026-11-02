/**
 * Live pump.fun bonding-curve data straight from the chain (no DexScreener delay).
 *
 * Every token still on its pump.fun curve has a "bonding-curve" account holding the pool's
 * reserves. Reading it gives the exact current price, market cap and the SOL really in the
 * pool. Graduated curves (`complete`) have moved to an AMM, where DexScreener is used instead.
 */
import { findProgramAddress, base58Decode } from './onchainMeta.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_DECIMALS = 6;
const curveCache = new Map(); // mint → PDA (derivation is pure; cache it)

export function bondingCurvePda(mint) {
  if (!curveCache.has(mint)) curveCache.set(mint, findProgramAddress([Buffer.from('bonding-curve'), base58Decode(mint)], PUMP_PROGRAM));
  return curveCache.get(mint);
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
export async function fetchPumpCurves(rpc, mints, solPriceUsd) {
  const out = new Map();
  const list = [...new Set(mints)].filter(Boolean).slice(0, 100);
  if (!list.length) return out;
  const pdas = list.map((m) => {
    try {
      return bondingCurvePda(m);
    } catch {
      return null;
    }
  });
  const valid = list.map((m, i) => [m, pdas[i]]).filter(([, p]) => p);
  const res = await rpc('getMultipleAccounts', [valid.map(([, p]) => p), { encoding: 'base64', commitment: 'processed' }]);
  (res?.value || []).forEach((acc, i) => {
    if (!acc || acc.owner !== PUMP_PROGRAM || !acc.data?.[0]) return;
    const m = curveMetrics(parseBondingCurve(acc.data[0]), solPriceUsd);
    if (m && !m.complete) out.set(valid[i][0], m);
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
