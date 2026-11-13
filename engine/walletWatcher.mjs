/**
 * Live Wallet Watcher — SIGNALS ONLY
 *
 * Watches real trader wallets on Solana and turns their on-chain swaps into buy/sell
 * signals. It only READS public chain data (JSON-RPC) and token info (DexScreener).
 * It never signs, never sends a transaction, and never touches a private key.
 *
 *   getSignaturesForAddress  →  getTransaction (jsonParsed)  →  parseSwapFromTransaction
 *   →  enrich with DexScreener token info  →  onSignal(signal)
 */

import { WalletStream, looksLikeSwap, toWsUrl } from './walletStream.mjs';
import { TokenAccountStream } from './tokenStream.mjs';

/** Every pump.fun coin has exactly 1 billion tokens. */
export const PUMP_SUPPLY = 1_000_000_000;
/** A pump.fun coin traded on pump.fun's own curve or its PumpSwap pool. */
export function isPumpFunCoin(swap) {
  return Boolean(swap && /pump$/.test(String(swap.tokenMint || '')) && (swap.venue === 'pumpfun' || swap.venue === 'pumpswap'));
}
import { bondingCurvePda, RAYDIUM_LAUNCHLAB_PROGRAM } from './pumpCurve.mjs';
import { pumpTradeFromLogs, swapFromPumpTrade, pumpSwapTradeFromLogs, swapFromPumpSwapTrade, decodePumpSwapPool, launchLabTradeFromLogs } from './pumpLogs.mjs';
import { YellowstoneFeed } from './yellowstone.mjs';
import { findProgramAddress, base58Decode as b58d } from './onchainMeta.mjs';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const QUOTE_MINTS = {
  [WSOL_MINT]: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280; // rent for a new SPL token account (refundable)
const SOL_DUST = 0.0005; // ignore SOL moves smaller than fees/tips noise

export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// A wallet whose newest 100 history entries span less than this is "flooded": other
// people's bot transactions mention it so often that its own trades are buried.
const FLOOD_WINDOW_SEC = 180;

// Programs that tell us where a swap really happened (read from the trader's own transaction)
export const PUMP_CURVE_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'; // pump.fun bonding curve
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'; // PumpSwap (graduated pump.fun)

/**
 * SOL that really went into (buy) or came out of (sell) the pool in this transaction, so the
 * trader's price isn't inflated by what never reached the pool: priority fees, tips, trading-bot
 * fees, account deposits. On a 0.03 SOL buy those can be half of the SOL spent.
 *   pump.fun curve: the coin's bonding-curve account's SOL change
 *   PumpSwap / other pools: the largest wrapped-SOL vault change (not owned by the trader)
 * Returns null when no pool leg can be identified (the wallet's SOL change is used instead).
 */
export function poolSolLeg(tx, wallet, { side, mint, venue, walletSol }) {
  const meta = tx.meta;
  const keys = (tx.transaction.message?.accountKeys || []).map(keyOf);
  const sign = side === 'buy' ? 1 : -1;
  const sane = (sol) => sol > 0 && sol <= walletSol * 1.05 + 1e-9;
  if (venue === 'pumpfun') {
    try {
      const i = keys.indexOf(bondingCurvePda(mint));
      if (i >= 0) {
        const d = (Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0)) / LAMPORTS_PER_SOL;
        if (sane(sign * d)) return sign * d;
      }
    } catch {
      // not derivable: fall through
    }
  }
  // wrapped-SOL vaults (AMMs)
  const pre = new Map();
  for (const tb of meta.preTokenBalances || []) if (tb.mint === WSOL_MINT && tb.owner !== wallet) pre.set(tb.accountIndex, uiAmount(tb));
  let best = 0;
  for (const tb of meta.postTokenBalances || []) {
    if (tb.mint !== WSOL_MINT || tb.owner === wallet) continue;
    const d = sign * (uiAmount(tb) - (pre.get(tb.accountIndex) || 0));
    if (d > best) best = d;
  }
  return sane(best) ? best : null;
}

export function isSolanaAddress(addr) {
  return typeof addr === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function keyOf(k) {
  return typeof k === 'string' ? k : k?.pubkey;
}

function uiAmount(tb) {
  const t = tb?.uiTokenAmount;
  if (!t) return 0;
  if (t.amount !== undefined && t.decimals !== undefined) {
    return Number(t.amount) / 10 ** Number(t.decimals);
  }
  return Number(t.uiAmountString ?? t.uiAmount ?? 0);
}

/**
 * Exact detection delay in milliseconds/seconds:
 * - When blockTimeMs is present (Yellowstone gRPC created_at with ms/ns precision),
 *   measures detectedAt - blockTimeMs (falling back to streamMs only if clock skew > 500 ms).
 * - Otherwise blockTime is only integer-second precision (floored to .000), so we use the
 *   unbiased bucket midpoint (blockTime + 500) to eliminate the artificial +500 ms rounding floor.
 */
export function computeDetectLatency({ detectedAt, receivedAt = null, blockTimeMs = null, blockTime = null } = {}) {
  const now = Number(detectedAt) || Date.now();
  const streamMs = receivedAt ? Math.max(0, now - Number(receivedAt)) : null;
  let latencyMs = null;
  if (Number.isFinite(blockTimeMs)) {
    const rawMs = now - blockTimeMs;
    latencyMs = rawMs >= -500 ? Math.max(streamMs ?? 0, Math.round(rawMs)) : streamMs;
  } else if (Number.isFinite(blockTime) && blockTime > 0) {
    const midMs = now - (blockTime + 500);
    latencyMs = Math.max(streamMs ?? 0, Math.round(midMs));
  } else {
    latencyMs = streamMs;
  }
  return {
    streamMs,
    latencyMs,
    latencySec: latencyMs !== null ? Number((latencyMs / 1000).toFixed(3)) : null,
  };
}

/**
 * Pure function: given a `getTransaction` result (encoding jsonParsed) and the watched
 * wallet, return the swap the wallet made, or `{ skip: reason }` if it wasn't a simple
 * buy or sell against SOL / USDC / USDT.
 */
/**
 * Drop "dust" token moves that ride along with a real trade: a move under 1 token when another
 * token moved at least 1,000 the same way. Some traders add a tiny transfer of a second token to
 * every buy so copy bots see "multiple tokens moved" and skip it; pump.fun coins (1B supply) never
 * trade in amounts under 1 token. delta(m): signed UI amount (+ in, − out).
 */
export function dropDustMoves(moves, delta) {
  if (!Array.isArray(moves) || moves.length < 2) return moves;
  return moves.filter((m) => {
    const d = delta(m);
    if (Math.abs(d) >= 1) return true;
    return !moves.some((o) => o !== m && Math.sign(delta(o)) === Math.sign(d) && Math.abs(delta(o)) >= 1000);
  });
}

export function parseSwapFromTransaction(tx, wallet) {
  if (!tx || !tx.meta || !tx.transaction) return { skip: 'no transaction data' };
  if (tx.meta.err) return { skip: 'failed transaction' };

  const keys = (tx.transaction.message?.accountKeys || []).map(keyOf);
  const meta = tx.meta;

  // --- Native SOL change for the wallet (fee added back if the wallet paid it)
  let solDelta = 0;
  const idx = keys.indexOf(wallet);
  if (idx >= 0) {
    const pre = Number(meta.preBalances?.[idx] ?? 0);
    const post = Number(meta.postBalances?.[idx] ?? 0);
    let lamports = post - pre;
    if (idx === 0) lamports += Number(meta.fee || 0);
    solDelta = lamports / LAMPORTS_PER_SOL;
  }

  // --- Token changes for accounts owned by the wallet, summed per mint
  const deltas = new Map();
  const decimalsByMint = new Map();
  const preByIndex = new Map();
  const preTotals = new Map(); // mint → wallet's balance before this tx (for partial sells)
  for (const tb of meta.preTokenBalances || []) {
    if (Number.isInteger(tb?.uiTokenAmount?.decimals)) decimalsByMint.set(tb.mint, tb.uiTokenAmount.decimals);
    if (tb.owner === wallet) {
      preByIndex.set(tb.accountIndex, tb);
      preTotals.set(tb.mint, (preTotals.get(tb.mint) || 0) + uiAmount(tb));
    }
  }
  let newTokenAccounts = 0;
  const seen = new Set();
  for (const tb of meta.postTokenBalances || []) {
    if (Number.isInteger(tb?.uiTokenAmount?.decimals)) decimalsByMint.set(tb.mint, tb.uiTokenAmount.decimals);
    if (tb.owner !== wallet) continue;
    seen.add(tb.accountIndex);
    const pre = preByIndex.get(tb.accountIndex);
    if (!pre) newTokenAccounts += 1;
    const d = uiAmount(tb) - (pre ? uiAmount(pre) : 0);
    deltas.set(tb.mint, (deltas.get(tb.mint) || 0) + d);
  }
  for (const [accIdx, tb] of preByIndex) {
    if (seen.has(accIdx)) continue; // account closed in this tx
    deltas.set(tb.mint, (deltas.get(tb.mint) || 0) - uiAmount(tb));
  }

  // Wrapped SOL held in a token account counts as SOL
  if (deltas.has(WSOL_MINT)) {
    solDelta += deltas.get(WSOL_MINT);
    deltas.delete(WSOL_MINT);
  }

  // balance before this tx per mint, to tell real moves from dust (some trading programs nudge
  // a held token by a few billionths as a side effect)
  const heldBefore = new Map();
  for (const tb of preByIndex.values()) heldBefore.set(tb.mint, (heldBefore.get(tb.mint) || 0) + uiAmount(tb));
  const stableMoves = [];
  let tokenMoves = [];
  for (const [mint, d] of deltas) {
    if (Math.abs(d) < 1e-12) continue;
    if (QUOTE_MINTS[mint]) stableMoves.push({ mint, symbol: QUOTE_MINTS[mint], delta: d });
    else tokenMoves.push({ mint, delta: d, rel: Math.abs(d) / Math.max(Math.abs(d), heldBefore.get(mint) || 0) });
  }
  if (tokenMoves.length > 1) {
    // ignore dust: under 0.01% of what was held, while another token really moved
    const real = tokenMoves.filter((t) => t.rel >= 1e-4);
    if (real.length >= 1) tokenMoves = real;
  }
  // ignore dust sent along with a real trade (copy-bot bait: e.g. +0.04 of another token in every buy)
  tokenMoves = dropDustMoves(tokenMoves, (t) => t.delta);

  if (tokenMoves.length === 0) return { skip: 'no token bought or sold (transfer, stake or SOL/stable only)' };
  if (tokenMoves.length > 1) {
    const plus = tokenMoves.filter((t) => t.delta > 0).length;
    const minus = tokenMoves.filter((t) => t.delta < 0).length;
    return { skip: plus && minus ? 'token-to-token swap (not copied)' : 'multiple tokens moved' };
  }

  const tok = tokenMoves[0];
  const side = tok.delta > 0 ? 'buy' : 'sell';

  // Quote leg: a stablecoin moving the opposite way wins, otherwise SOL
  let quote = null;
  const stable = stableMoves.find((s) => (side === 'buy' ? s.delta < 0 : s.delta > 0));
  if (stable) {
    quote = { symbol: stable.symbol, mint: stable.mint, amount: Math.abs(stable.delta) };
  } else {
    let sol = solDelta;
    // A buy that opened a brand-new token account also paid refundable rent; don't count it as spend
    if (side === 'buy' && newTokenAccounts > 0) {
      sol += (newTokenAccounts * TOKEN_ACCOUNT_RENT_LAMPORTS) / LAMPORTS_PER_SOL;
    }
    if ((side === 'buy' && sol < -SOL_DUST) || (side === 'sell' && sol > SOL_DUST)) {
      quote = { symbol: 'SOL', mint: WSOL_MINT, amount: Math.abs(sol) };
    }
  }

  if (!quote) {
    return { skip: side === 'buy' ? 'tokens received without paying (airdrop or transfer in)' : 'tokens sent without receiving SOL/USDC (transfer out)' };
  }

  // price from the pool leg (excludes fees, tips and deposits); SOL-quoted trades only
  const swapVenue = keys.includes(PUMP_CURVE_PROGRAM) ? 'pumpfun' : keys.includes(PUMP_AMM_PROGRAM) ? 'pumpswap' : keys.includes(RAYDIUM_LAUNCHLAB_PROGRAM) ? 'launchlab' : null;
  const llEv = swapVenue === 'launchlab' && Array.isArray(meta.logMessages) ? launchLabTradeFromLogs(meta.logMessages) : null;
  const pumpLogRes = swapVenue === 'pumpfun' && Array.isArray(meta.logMessages) ? pumpTradeFromLogs(meta.logMessages, wallet) : null;
  const pumpEv = pumpLogRes?.trade && pumpLogRes.trade.mint === tok.mint ? pumpLogRes.trade : null;
  const txTokenProg = keys.includes(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : keys.includes(TOKEN_PROGRAM) ? TOKEN_PROGRAM : null;
  const llSol = llEv && llEv.poolSolLamports > 0 ? llEv.poolSolLamports / LAMPORTS_PER_SOL : null;
  const poolQuote =
    quote.symbol === 'SOL'
      ? llSol > 0 && llSol <= quote.amount * 1.05 + 1e-9
        ? llSol
        : poolSolLeg(tx, wallet, { side, mint: tok.mint, venue: swapVenue, walletSol: quote.amount })
      : null;

  const before = preTotals.get(tok.mint) || 0;
  const sellSharePct = side === 'sell' && before > 0 ? Math.min(100, (Math.abs(tok.delta) / before) * 100) : side === 'sell' ? 100 : null;

  return {
    side,
    sellSharePct: sellSharePct === null ? null : Number(sellSharePct.toFixed(2)),
    heldBefore: before, // the wallet's balance of this coin before the trade (> 0 on a buy = a top-up)
    tokenMint: tok.mint,
    tokenDecimals: decimalsByMint.get(tok.mint) ?? (/pump$/i.test(tok.mint) ? 6 : null),
    tokenAmount: Math.abs(tok.delta),
    quoteSymbol: quote.symbol,
    quoteMint: quote.mint,
    quoteAmount: quote.amount,
    priceInQuote: (poolQuote > 0 ? poolQuote : quote.amount) / Math.abs(tok.delta),
    poolQuoteAmount: poolQuote > 0 ? poolQuote : null, // SOL that really reached the pool
    signature: tx.transaction.signatures?.[0] || null,
    slot: tx.slot ?? null,
    blockTime: tx.blockTime ? tx.blockTime * 1000 : null,
    blockTimeMs: Number.isFinite(tx.blockTimeMs) ? tx.blockTimeMs : null,
    // where it traded: decided from the programs in the transaction, not from a data feed
    venue: swapVenue,
    curve:
      llEv && llEv.virtualSolReserves > 0 && llEv.virtualTokenReserves > 0
        ? {
            virtualSolReserves: llEv.virtualSolReserves,
            virtualTokenReserves: llEv.virtualTokenReserves,
            realSolReserves: llEv.realSolReserves,
            realTokenReserves: llEv.realTokenReserves,
            launchlab: true,
          }
        : pumpEv && pumpEv.virtualSolReserves > 0n && pumpEv.virtualTokenReserves > 0n
          ? {
              virtualSolReserves: Number(pumpEv.virtualSolReserves),
              virtualTokenReserves: Number(pumpEv.virtualTokenReserves),
              realSolReserves: Number(pumpEv.realSolReserves || 0n),
              realTokenReserves: Number(pumpEv.realTokenReserves || 0n),
              mayhem: Boolean(pumpEv.mayhem),
              cashback: Boolean(pumpEv.cashback),
              tokenProgram: pumpEv.tokenProgram || txTokenProg,
              at: Date.now(),
            }
          : undefined,
  };
}

/**
 * Token info (symbol, price, market cap, liquidity) from DexScreener, cached.
 */
export class TokenInfoService {
  /**
   * @param metadata optional AlchemyService: adds token image, name/symbol fallback and
   *                 mint/freeze authority (when the provider returns them)
   */
  constructor({ fetchImpl = (...a) => fetch(...a), ttlMs = 60_000, fallbackSolPriceUsd = 150, metadata = null } = {}) {
    this.fetch = fetchImpl;
    this.metadata = metadata;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.fallbackSolPriceUsd = fallbackSolPriceUsd;
  }

  async get(mint) {
    const hit = this.cache.get(mint);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.info;
    const metaPromise =
      (this.metadata?.canFetchTokens ?? this.metadata?.enabled) && mint !== WSOL_MINT ? this.metadata.getSolanaToken(mint).catch(() => null) : Promise.resolve(null);
    let info = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await this.fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        const pairs = (Array.isArray(data?.pairs) ? data.pairs : []).filter(
          (p) => p.chainId === 'solana' && p.baseToken?.address === mint
        );
        pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
        const p = pairs[0];
        if (p) {
          info = {
            symbol: p.baseToken.symbol,
            name: p.baseToken.name,
            priceUsd: Number(p.priceUsd || 0) || null,
            marketCapUsd: Number(p.marketCap || p.fdv || 0) || null,
            liquidityUsd: Number(p.liquidity?.usd || 0) || null,
            dexId: p.dexId || null,
            pairUrl: p.url || null,
            pairCreatedAt: p.pairCreatedAt || null,
            imageUrl: typeof p.info?.imageUrl === 'string' && /^https:\/\//.test(p.info.imageUrl) ? p.info.imageUrl : null,
          };
        }
      }
    } catch {
      // network error — fall through with null info
    }
    const meta = await metaPromise;
    if (meta) {
      info = {
        ...(info || { priceUsd: null, marketCapUsd: null, liquidityUsd: null, dexId: null, pairUrl: null, pairCreatedAt: null }),
        symbol: info?.symbol || meta.symbol || null,
        name: info?.name || meta.name || null,
        imageUrl: meta.imageUrl || info?.imageUrl || null,
        authorityKnown: Boolean(meta.authorityKnown),
        mintAuthority: meta.mintAuthority ?? null,
        freezeAuthority: meta.freezeAuthority ?? null,
        metadataSource: 'alchemy',
      };
    }
    this.cache.set(mint, { at: Date.now(), info });
    return info;
  }

  async solPriceUsd() {
    const info = await this.get(WSOL_MINT);
    return info?.priceUsd || this.fallbackSolPriceUsd;
  }

  /** SOL price without waiting: the last known price (refreshed in the background when old). */
  async solPriceFast() {
    const hit = this.cache.get(WSOL_MINT);
    if (hit?.info?.priceUsd) {
      if (Date.now() - hit.at >= this.ttlMs) this.get(WSOL_MINT).catch(() => {});
      return hit.info.priceUsd;
    }
    return this.solPriceUsd();
  }
}

class RpcError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

/**
 * Polls watched wallets for new signatures and emits parsed swap signals.
 */
const MIN_BALANCE_SIGNAL_USD = 1; // balance-mode moves worth less than this are dust / spam
const MAX_BALANCE_MOVES_PER_POLL = 8;

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => {
        const err = new Error(message);
        err.budget = true; // still running in the background, not a failure
        reject(err);
      }, ms);
      t.unref?.();
    }),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

export function isFlooded(sigs, limit) {
  if (!Array.isArray(sigs) || sigs.length < limit || limit < 25) return false;
  const newest = sigs[0]?.blockTime;
  const oldest = sigs[sigs.length - 1]?.blockTime;
  if (!newest || !oldest) return false;
  const span = newest - oldest;
  if (span >= FLOOD_WINDOW_SEC) return false;
  // A fast trader's own swaps mostly succeed; a flood is other bots' (mostly failed) spam,
  // or volume no single trader produces (100 entries in under 20 seconds).
  const failShare = sigs.filter((x) => x.err).length / sigs.length;
  return failShare >= 0.5 || span < 20;
}

/**
 * Pure: holdings snapshots → buys/sells. SOL and stablecoin changes are the payment leg;
 * when several tokens moved in one interval the payment is split by their estimated value.
 */
export function diffHoldings(prev, now) {
  const minRel = 0.001; // ignore <0.1% wiggles (rebases, dust)
  const moves = [];
  const mints = new Set([...prev.tokens.keys(), ...now.tokens.keys()]);
  let solDelta = now.sol - prev.sol;
  // Token accounts closed in this interval refunded their rent (~0.002 SOL each) and new ones
  // cost it; neither is a trade payment.
  const RENT = TOKEN_ACCOUNT_RENT_LAMPORTS / LAMPORTS_PER_SOL;
  let closed = 0;
  let opened = 0;
  for (const m of prev.tokens.keys()) if (!now.tokens.has(m)) closed += 1;
  for (const m of now.tokens.keys()) if (!prev.tokens.has(m)) opened += 1;
  solDelta = solDelta - closed * RENT + opened * RENT;
  const stable = {};
  for (const mint of mints) {
    const before = prev.tokens.get(mint) || 0;
    const after = now.tokens.get(mint) || 0;
    const d = after - before;
    if (Math.abs(d) <= Math.max(before, after) * minRel || Math.abs(d) < 1e-12) continue;
    if (mint === WSOL_MINT) {
      solDelta += d;
      continue;
    }
    if (QUOTE_MINTS[mint]) {
      stable[QUOTE_MINTS[mint]] = (stable[QUOTE_MINTS[mint]] || 0) + d;
      continue;
    }
    moves.push({
      mint,
      side: d > 0 ? 'buy' : 'sell',
      tokenAmount: Math.abs(d),
      sellSharePct: d < 0 ? Math.min(100, Number(((Math.abs(d) / before) * 100).toFixed(2))) : null,
      before,
    });
  }
  const kept = dropDustMoves(moves, (m) => (m.side === 'buy' ? m.tokenAmount : -m.tokenAmount));
  if (kept !== moves) moves.splice(0, moves.length, ...kept);
  const buys = moves.filter((m) => m.side === 'buy');
  const sells = moves.filter((m) => m.side === 'sell');
  const stableOut = Object.entries(stable).find(([, v]) => v < 0);
  const stableIn = Object.entries(stable).find(([, v]) => v > 0);
  // Payment legs (only attributed when exactly one token moved that way; otherwise unknown)
  if (buys.length === 1) {
    if (stableOut) Object.assign(buys[0], { quoteSymbol: stableOut[0], quoteAmount: -stableOut[1] });
    else if (solDelta < -SOL_DUST) Object.assign(buys[0], { quoteSymbol: 'SOL', quoteAmount: -solDelta + (sells.length ? 0 : 0) });
  }
  if (sells.length === 1) {
    if (stableIn) Object.assign(sells[0], { quoteSymbol: stableIn[0], quoteAmount: stableIn[1] });
    else if (solDelta > SOL_DUST) Object.assign(sells[0], { quoteSymbol: 'SOL', quoteAmount: solDelta });
  }
  if (buys.length > 1 && solDelta < -SOL_DUST) {
    // several buys in one interval: mark them as paid (split later by token value)
    for (const m of buys) Object.assign(m, { quoteSymbol: null, paidShare: true });
  }
  return moves;
}

export class SolanaWalletWatcher {
  constructor({
    rpcUrl = DEFAULT_SOLANA_RPC,
    fetchImpl = (...a) => fetch(...a),
    tokenInfo = null,
    onSignal = () => {},
    onStatus = () => {},
    pollIntervalMs = 15_000,
    backfillCount = 3,
    maxTxPerWalletPerPoll = 60,
    walletBudgetMs = 25_000,
    stream = true,
    WebSocketImpl = globalThis.WebSocket,
    balanceWsUrl = process.env.SOLANA_BALANCE_WS_URL || 'wss://api.mainnet-beta.solana.com',
    streamUrl = null, // live push connection; default: the RPC URL as wss
    tokenStreamUrl = null, // token-account push (Helius): spam-proof, fastest buy/sell detection
    fastRpcUrls = [], // extra low-latency HTTP RPCs raced in parallel on live stream events
    extraStreamUrl = null, // a second live push feed (e.g. Sodae) racing the main one; first to see a trade wins
    extraStreamName = 'extra',
    grpcUrl = null, // Yellowstone gRPC feed (e.g. Sodae): fastest way to hear the followed wallets' trades
    redactUrl = (x) => x,
  } = {}) {
    this.rpcUrl = rpcUrl;
    this.fastRpcUrls = Array.isArray(fastRpcUrls) ? fastRpcUrls.filter(Boolean) : [];
    this.fixedStreamUrl = streamUrl || null;
    this.fetch = fetchImpl;
    this.tokenInfo = tokenInfo || new TokenInfoService({ fetchImpl });
    this.onSignal = onSignal;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.backfillCount = backfillCount;
    this.maxTx = maxTxPerWalletPerPoll;
    this.walletBudgetMs = walletBudgetMs;
    this.wallets = new Map(); // address -> { address, label, lastSig, initialized, lastPollAt, error }
    this.seenSigs = new Set();
    this.spamSigs = new Set(); // opened transactions that were not signed by the watched wallet
    this.maxRps = Number(process.env.ODEX_RPC_MAX_RPS || 15);
    // Token details (name, logo, market data) may wait this long before a trade is passed on
    // for copying; whatever arrives later is filled in afterwards (onTokenInfoLate)
    this.tokenInfoBudgetMs = Number(process.env.ODEX_TOKEN_INFO_BUDGET_MS ?? 50);
    this.pumpInfoBudgetMs = Number(process.env.ODEX_PUMP_INFO_BUDGET_MS ?? 25);
    this.onTokenInfoLate = null;
    this.rpcTimes = [];
    this.emittedSigs = new Map(); // signature → token mint, for trades that became signals
    this.timer = null;
    // Real-time path: pushed logs for every watched wallet (polling stays on as the safety net)
    this.streamEnabled = Boolean(stream);
    this.streamQueue = [];
    this.streamActive = 0;
    this.streamMaxConcurrent = 16;
    this.streamStats = { swapsSeen: 0, notSwap: 0, failedTx: 0, signals: 0, lagMs: [] };
    // Fast trade detection (Settings): read pump.fun trades from the pushed logs, confirm later
    this.fastDetect = () => false;
    this.onPhantomTrade = null; // ({ signature, wallet, side, mint, reason }) → close the copy
    this.onWalletTx = null; // optional hook (address, ev) when a full pushed tx arrives
    this.pumpSwapPoolCache = new Map(); // pool pubkey -> { baseMint, quoteMint, decimals }
    this.fastStats = { hits: 0, misses: 0, forged: 0, confirmed: 0, phantoms: 0, missReasons: {}, lagMs: [], lastPhantom: null };
    this.confirmDelaysMs = [1500, 2500, 4000, 6000, 10_000, 15_000, 20_000];
    this.stream = new WalletStream({
      url: streamUrl || toWsUrl(rpcUrl),
      WebSocketImpl,
      redactUrl,
      onLogs: (address, ev) => this.handleStreamLogs(address, ev),
      onAccount: (address, ev) => this.handleStreamAccount(address, ev),
      onAccountUnsupported: (address) => {
        this.useBalanceStream = true;
        const w = this.wallets.get(address);
        if (w && w.mode !== 'balances') {
          w.mode = 'balances'; // it flooded the stream, so treat it as a flooded wallet
          w.floodedAt = Date.now();
        }
        this.syncStreams();
      },
      onChange: () => this.emitStatus(),
    });
    this.stream.keepLogsOnFlood = () => Boolean(this.fastDetect?.());
    // Optional second live feed (Sodae): the same transaction pushes from another provider. Both
    // feeds share the "seen signature" set, so each trade is handled once — by whichever arrived
    // first. Spam-flooded wallets are left out (their pushes would only burn the feed's credits).
    this.feedRace = { main: 0, extra: 0, grpc: 0, extraName: extraStreamName };
    this.grpcFeed = grpcUrl ? new YellowstoneFeed({ url: grpcUrl, redactUrl, onTx: (address, ev) => this.handleStreamLogs(address, ev, 'grpc'), onChange: () => this.emitStatus() }) : null;
    this.firstSeenBy = new Map();
    this.extraStream = extraStreamUrl
      ? new WalletStream({
          url: extraStreamUrl,
          WebSocketImpl,
          redactUrl,
          onLogs: (address, ev) => this.handleStreamLogs(address, ev, 'extra'),
          onChange: () => this.emitStatus(),
        })
      : null;
    // Second connection only for balance watching of spam-flooded wallets, used when the main
    // provider has no accountSubscribe (Alchemy). It only triggers checks; trades are still
    // read through the main RPC.
    this.useBalanceStream = false;
    this.balanceStream = new WalletStream({
      url: balanceWsUrl,
      WebSocketImpl,
      redactUrl,
      onAccount: (address, ev) => this.handleStreamAccount(address, ev),
      onChange: () => this.emitStatus(),
    });
    // Fastest path: the wallets' token accounts (spam never touches them). Runs next to the
    // other feeds; every path shares one "seen signature" set, so a trade is handled once.
    this.tokenStats = { events: 0, signals: 0, lagMs: [] };
    this.tokenStream = tokenStreamUrl
      ? new TokenAccountStream({ url: tokenStreamUrl, WebSocketImpl, redactUrl, onChange: (ev) => this.handleTokenChange(ev), onStatus: () => this.emitStatus() })
      : null;
    this.running = false;
    this.polling = false;
    this.backoffMs = 0;
    this.status = {
      running: false,
      rpcUrl: rpcUrl,
      lastPollAt: null,
      lastSuccessAt: null,
      lastError: null,
      rateLimited: false,
      rpcCalls: 0,
      txParsed: 0,
      signalsEmitted: 0,
      txSkipped: 0,
      rpcMs: null,
      skipReasons: {},
      recentSkips: [],
      nextPollInMs: null,
    };
  }

  setRpcUrl(url) {
    this.rpcUrl = url || DEFAULT_SOLANA_RPC;
    this.status.rpcUrl = this.rpcUrl;
    if (!this.fixedStreamUrl) this.stream.setUrl(toWsUrl(this.rpcUrl)); // a dedicated stream (Helius) stays
    this.emitStatus();
  }

  setPollInterval(ms) {
    this.pollIntervalMs = Math.max(1_000, Number(ms) || 1_000);
  }

  /** Replace the watch list. Keeps progress for wallets already being watched. */
  setWallets(list) {
    const next = new Map();
    for (const w of list) {
      if (!isSolanaAddress(w.address)) continue;
      const prev = this.wallets.get(w.address);
      next.set(w.address, prev ? { ...prev, label: w.label || prev.label } : {
        address: w.address,
        label: w.label || null,
        lastSig: null,
        initialized: false,
        lastPollAt: null,
        error: null,
        mode: 'history', // 'history' (parse its transactions) | 'balances' (diff its holdings)
        holdings: null,
      });
    }
    this.wallets = next;
    this.syncStreams();
    this.emitStatus();
  }

  /** Route each wallet to the right live feed: transactions (normal) or balance (flooded). */
  syncStreams() {
    const all = [...this.wallets.keys()];
    const flooded = all.filter((a) => this.wallets.get(a)?.mode === 'balances');
    const on = this.running && this.streamEnabled;
    const keepFastLogs = Boolean(this.fastDetect?.());
    if (this.useBalanceStream) {
      const normal = all.filter((a) => !flooded.includes(a));
      for (const a of flooded) this.stream.accountMode.delete(a);
      this.stream.setWallets(keepFastLogs ? all : normal);
      for (const a of flooded) this.balanceStream.accountMode.add(a);
      for (const a of [...this.balanceStream.accountMode]) if (!flooded.includes(a)) this.balanceStream.accountMode.delete(a);
      this.balanceStream.setWallets(flooded);
      if (on && flooded.length) this.balanceStream.start();
      else this.balanceStream.stop();
    } else {
      this.stream.setWallets(all);
      // switch already-open subscriptions between transaction and balance watching
      if (keepFastLogs) {
        for (const a of [...this.stream.accountMode]) this.stream.setBalanceWatch(a, false);
      } else {
        for (const a of flooded) this.stream.setBalanceWatch(a, true);
        for (const a of [...this.stream.accountMode]) if (!flooded.includes(a)) this.stream.setBalanceWatch(a, false);
      }
      this.balanceStream.stop();
    }
    if (on) this.stream.start();
    else this.stream.stop();
    if (this.grpcFeed) {
      // failed transactions are filtered out at the source, so even flooded wallets are cheap here
      this.grpcFeed.setWallets(all);
      if (on && all.length) this.grpcFeed.start();
      else this.grpcFeed.stop();
    }
    if (this.extraStream) {
      const normal = all.filter((a) => !flooded.includes(a));
      this.extraStream.setWallets(normal);
      if (on && normal.length) this.extraStream.start();
      else this.extraStream.stop();
    }
    if (this.tokenStream) {
      this.tokenStream.setWallets(all);
      if (on && all.length) this.tokenStream.start();
      else this.tokenStream.stop();
    }
  }

  /**
   * A watched wallet's token account changed (a real buy or sell — spam can't do this): read that
   * account's newest transaction (it has very few) and handle it at once.
   */
  async handleTokenChange(ev) {
    const w = this.wallets.get(ev.wallet);
    if (!w) return;
    this.tokenStats.events += 1;
    const since = Date.now() - 120_000; // only fresh trades (never replay old history)
    for (let attempt = 0; attempt < 14; attempt++) {
      let list = [];
      try {
        list = (await this.rpcRace('getSignaturesForAddress', [ev.tokenAccount, { limit: 5, commitment: 'confirmed' }], (r) => Array.isArray(r) && r.length > 0)) || [];
      } catch {
        list = [];
      }
      const fresh = list.filter((x) => !x.err && (!x.blockTime || x.blockTime * 1000 >= since) && !this.seenSigs.has(x.signature));
      if (fresh.length) {
        // oldest first, so a buy and an immediate sell keep their order
        for (const x of fresh.reverse()) {
          try {
            const sig = await this.processSignature(w, x.signature, { backfill: false, via: 'token-stream', receivedAt: ev.receivedAt, waitForTx: true });
            if (sig) {
              this.tokenStats.signals += 1;
              if (ev.receivedAt) {
                this.tokenStats.lagMs.push(Date.now() - ev.receivedAt);
                if (this.tokenStats.lagMs.length > 50) this.tokenStats.lagMs.shift();
              }
            }
          } catch {
            this.seenSigs.delete(x.signature); // let another path pick it up
          }
        }
        return;
      }
      // If the newest signature on this token account is already in seenSigs, logsSubscribe already caught it
      if (list.length > 0 && !list[0].err && this.seenSigs.has(list[0].signature)) return;
      // the account's history can trail the push by a few ms: micro-retry instead of 250ms+ sleeps
      await new Promise((r) => setTimeout(r, 35 + attempt * 20));
    }
  }

  setStreamEnabled(on) {
    this.streamEnabled = Boolean(on);
    this.syncStreams();
    this.emitStatus();
  }

  /** A pushed transaction that mentions a watched wallet. */
  handleStreamLogs(address, ev, feed = 'main') {
    const w = this.wallets.get(address);
    if (!w || !ev?.signature) return;
    // which live feed heard this transaction first (main = Helius, extra = Sodae)
    if ((this.extraStream || this.grpcFeed) && !this.firstSeenBy.has(ev.signature)) {
      this.firstSeenBy.set(ev.signature, feed);
      if (!ev.err) this.feedRace[feed] = (this.feedRace[feed] || 0) + 1;
      if (this.firstSeenBy.size > 3000) this.firstSeenBy = new Map([...this.firstSeenBy].slice(-1500));
    }
    if (!ev.err && ev.tx && typeof this.onWalletTx === 'function') {
      try {
        this.onWalletTx(address, ev);
      } catch {
        // ignore listener errors
      }
    }
    if (ev.err) {
      this.streamStats.failedTx += 1; // failed transaction (spam floods are mostly these)
      return;
    }
    if (this.seenSigs.has(ev.signature)) return;
    if (!looksLikeSwap(ev.logs)) {
      this.streamStats.notSwap += 1;
      return;
    }
    this.streamStats.swapsSeen += 1;
    const hasPumpCurveLog = Array.isArray(ev.logs) && ev.logs.some((l) => String(l).includes(PUMP_CURVE_PROGRAM));
    const hasPumpSwapLog = Array.isArray(ev.logs) && ev.logs.some((l) => String(l).includes(PUMP_AMM_PROGRAM));
    if (this.fastDetect() && hasPumpCurveLog) {
      const r = pumpTradeFromLogs(ev.logs, address, { err: ev.err });
      if (r.trade) {
        this.fastTrade(w, ev, r.trade);
        return;
      }
      if (r.forged) this.fastStats.forged += 1;
      this.fastStats.misses += 1;
      this.fastStats.missReasons[r.skip] = (this.fastStats.missReasons[r.skip] || 0) + 1;
      if (r.nonSolBuy) {
        this.seenSigs.add(ev.signature);
        return;
      }
    }
    if (this.fastDetect() && ev.tx) {
      const keys = ev.tx.transaction?.message?.accountKeys || [];
      const signedByWallet = keys.some((k) => k && typeof k === 'object' && k.pubkey === address && k.signer);
      if (!signedByWallet) {
        this.spamSigs.add(ev.signature);
        return;
      }
      const swap = parseSwapFromTransaction(ev.tx, address);
      if (!swap || swap.skip) {
        this.seenSigs.add(ev.signature);
        return;
      }
      this.fastTxTrade(w, ev, swap);
      return;
    }
    if (this.fastDetect() && hasPumpSwapLog) {
      const ps = pumpSwapTradeFromLogs(ev.logs, address, { err: ev.err });
      if (ps.trade) {
        this.fastPumpSwapTrade(w, ev, ps.trade);
        return;
      }
      if (ps.forged) this.fastStats.forged += 1;
      this.fastStats.misses += 1;
      this.fastStats.missReasons[ps.skip] = (this.fastStats.missReasons[ps.skip] || 0) + 1;
    }
    if (w.mode === 'balances' && this.fastDetect()) return;
    this.streamQueue.push({ w, ev });
    if (this.streamQueue.length > 200) this.streamQueue.splice(0, this.streamQueue.length - 200);
    this.drainStream();
  }

  /** Resolve and cache { baseMint, quoteMint, decimals } for a PumpSwap pool account. */
  async resolvePumpSwapPool(pool) {
    const hit = this.pumpSwapPoolCache.get(pool);
    if (hit) return hit;
    const acc = await this.rpc('getAccountInfo', [pool, { encoding: 'base64', commitment: 'processed' }], { fast: true });
    const val = acc?.value;
    if (!val || val.owner !== PUMP_AMM_PROGRAM) return null;
    const decoded = decodePumpSwapPool(val.data?.[0]);
    if (!decoded) return null;
    const mint = decoded.quoteMint === WSOL_MINT ? decoded.baseMint : decoded.baseMint === WSOL_MINT ? decoded.quoteMint : null;
    let decimals = 6;
    if (mint && !/pump$/i.test(mint)) {
      try {
        const mAcc = await this.rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'processed' }], { fast: true });
        const mb = mAcc?.value?.data?.[0] ? Buffer.from(mAcc.value.data[0], 'base64') : null;
        if (mb && mb.length >= 45 && mb[44] <= 18) decimals = mb[44];
      } catch {
        // default 6
      }
    }
    const info = { ...decoded, decimals };
    if (this.pumpSwapPoolCache.size > 2000) {
      this.pumpSwapPoolCache = new Map([...this.pumpSwapPoolCache].slice(-1000));
    }
    this.pumpSwapPoolCache.set(pool, info);
    return info;
  }

  /** Fast path for a PumpSwap BuyEvent/SellEvent decoded from `processed` WebSocket logs. */
  async fastPumpSwapTrade(w, ev, trade) {
    const sig = ev.signature;
    if (this.seenSigs.has(sig)) return null;
    let poolInfo = null;
    try {
      poolInfo = await this.resolvePumpSwapPool(trade.pool);
    } catch {
      poolInfo = null;
    }
    if (this.seenSigs.has(sig)) return null;
    if (!poolInfo) {
      this.fastStats.misses += 1;
      this.fastStats.missReasons['pool lookup failed'] = (this.fastStats.missReasons['pool lookup failed'] || 0) + 1;
      this.streamQueue.push({ w, ev });
      this.drainStream();
      return null;
    }
    const swap = swapFromPumpSwapTrade(trade, poolInfo, { signature: sig, slot: ev.slot ?? null, receivedAt: ev.receivedAt || Date.now() });
    if (!swap || swap.skip) {
      if (swap?.skip) {
        this.fastStats.misses += 1;
        this.fastStats.missReasons[swap.skip] = (this.fastStats.missReasons[swap.skip] || 0) + 1;
      }
      if (swap?.nonSolBuy) this.seenSigs.add(sig);
      else if (!swap?.skip) {
        this.streamQueue.push({ w, ev });
        this.drainStream();
      }
      return null;
    }
    this.fastStats.hits += 1;
    if (Number.isFinite(ev.createdAtMs) && !Number.isFinite(swap.blockTimeMs)) swap.blockTimeMs = ev.createdAtMs;
    let signal = null;
    try {
      signal = await this.processSignature(w, sig, { backfill: false, via: 'fast-logs', receivedAt: ev.receivedAt, knownSwap: swap });
    } catch {
      this.seenSigs.delete(sig);
      return null;
    }
    if (signal) {
      this.streamStats.signals += 1;
      if (signal.streamMs != null) {
        this.fastStats.lagMs.push(signal.streamMs);
        if (this.fastStats.lagMs.length > 50) this.fastStats.lagMs.shift();
      }
      this.confirmFastTrade(w, sig, swap).catch(() => {});
    }
    return signal;
  }

  /** Fast path for a full transaction delivered at `processed` commitment over Yellowstone gRPC. */
  async fastTxTrade(w, ev, swap) {
    const sig = ev.signature;
    if (this.seenSigs.has(sig)) return null;
    this.fastStats.hits += 1;
    let signal = null;
    try {
      signal = await this.processSignature(w, sig, { backfill: false, via: 'fast-logs', receivedAt: ev.receivedAt, knownSwap: swap });
    } catch {
      this.seenSigs.delete(sig);
      return null;
    }
    if (signal) {
      this.streamStats.signals += 1;
      if (signal.streamMs != null) {
        this.fastStats.lagMs.push(signal.streamMs);
        if (this.fastStats.lagMs.length > 50) this.fastStats.lagMs.shift();
      }
      this.confirmFastTrade(w, sig, swap).catch(() => {});
    }
    return signal;
  }

  /**
   * Fast path: a pump.fun trade read from the pushed logs (see pumpLogs.mjs for the safety
   * checks). Sells need the trader's balance after the trade (one `processed` account read) to
   * know what share was sold. The trade is then confirmed in the background; one that never
   * confirms is reported to onPhantomTrade so the copy can be closed.
   */
  async fastTrade(w, ev, trade) {
    const sig = ev.signature;
    if (this.seenSigs.has(sig)) return null;
    let heldAfterRaw = null;
    if (!trade.isBuy) {
      if (typeof this.skipSellShare === 'function' && this.skipSellShare(w.address)) {
        heldAfterRaw = 0n;
      } else {
        try {
          const atas = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => findProgramAddress([b58d(w.address), b58d(p), b58d(trade.mint)].map((b) => Buffer.from(b)), ASSOCIATED_TOKEN_PROGRAM));
          const res = await this.rpc('getMultipleAccounts', [atas, { encoding: 'base64', commitment: 'processed' }], { fast: true });
          const vals = res?.value;
          if (!Array.isArray(vals)) throw new Error('no balance');
          heldAfterRaw = vals.reduce((sum, a) => {
            const b = a?.data?.[0] ? Buffer.from(a.data[0], 'base64') : null;
            return sum + (b && b.length >= 72 ? b.readBigUInt64LE(64) : 0n);
          }, 0n);
        } catch {
          heldAfterRaw = null;
        }
      }
      if (heldAfterRaw === null) {
        // balance unknown: the normal path works out the sell share from the confirmed transaction
        this.fastStats.misses += 1;
        this.fastStats.missReasons['sell share unknown'] = (this.fastStats.missReasons['sell share unknown'] || 0) + 1;
        this.streamQueue.push({ w, ev });
        this.drainStream();
        return null;
      }
    }
    const swap = swapFromPumpTrade(trade, { signature: sig, slot: ev.slot ?? null, heldAfterRaw, receivedAt: ev.receivedAt || Date.now() });
    if (!swap) return null;
    if (Number.isFinite(ev.createdAtMs) && !Number.isFinite(swap.blockTimeMs)) swap.blockTimeMs = ev.createdAtMs;
    this.fastStats.hits += 1;
    let signal = null;
    try {
      signal = await this.processSignature(w, sig, { backfill: false, via: 'fast-logs', receivedAt: ev.receivedAt, knownSwap: swap });
    } catch (err) {
      this.seenSigs.delete(sig);
      return null;
    }
    if (signal) {
      this.streamStats.signals += 1;
      if (signal.streamMs != null) {
        this.fastStats.lagMs.push(signal.streamMs);
        if (this.fastStats.lagMs.length > 50) this.fastStats.lagMs.shift();
      }
      this.confirmFastTrade(w, sig, swap).catch(() => {});
    }
    return signal;
  }

  /** Background check that a fast-detected trade really landed as read. */
  async confirmFastTrade(w, sig, swap) {
    const wait = (ms) => new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
    for (const ms of this.confirmDelaysMs) {
      await wait(ms);
      if (!this.running) return 'stopped';
      let tx = null;
      try {
        tx = await this.getTransaction(sig);
      } catch {
        continue; // RPC trouble: try again
      }
      if (!tx) continue;
      const parsed = parseSwapFromTransaction(tx, w.address);
      if (parsed && !parsed.skip && parsed.side === swap.side && parsed.tokenMint === swap.tokenMint) {
        this.fastStats.confirmed += 1;
        return 'confirmed';
      }
      return this.reportPhantom(w, sig, swap, parsed?.skip === 'failed transaction' ? 'trader trade failed on-chain' : `trader trade did not match (${parsed?.skip || 'different trade'})`);
    }
    // not found after ~60 s: make sure it really isn't there before calling it a phantom
    try {
      const st = await this.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      const s = st?.value?.[0];
      if (s && !s.err) {
        this.fastStats.confirmed += 1;
        return 'confirmed';
      }
      if (s?.err) return this.reportPhantom(w, sig, swap, 'trader trade failed on-chain');
    } catch {
      return 'unknown'; // can't tell: leave the copy alone
    }
    return this.reportPhantom(w, sig, swap, 'trader trade never confirmed (dropped)');
  }

  reportPhantom(w, sig, swap, reason) {
    this.fastStats.phantoms += 1;
    this.fastStats.lastPhantom = { signature: sig, wallet: w.address, side: swap.side, mint: swap.tokenMint, reason, at: Date.now() };
    if (typeof this.onPhantomTrade === 'function') {
      try {
        this.onPhantomTrade({ signature: sig, wallet: w.address, side: swap.side, mint: swap.tokenMint, reason });
      } catch {
        // ignore
      }
    }
    return 'phantom';
  }

  /**
   * Spam-flooded wallet watched by balance: its SOL moved. Spam doesn't move it (dust is
   * ignored); a real buy or sell does, so check that wallet right now instead of waiting.
   */
  handleStreamAccount(address, ev) {
    const w = this.wallets.get(address);
    if (!w || !Number.isFinite(ev?.lamports)) return;
    const prev = w.streamLamports;
    w.streamLamports = ev.lamports;
    if (prev == null) return; // first value is the baseline
    if (Math.abs(ev.lamports - prev) / LAMPORTS_PER_SOL < 0.005) return; // dust / fee noise
    this.streamStats.balanceMoves = (this.streamStats.balanceMoves || 0) + 1;
    this.fastCheck(w, ev.receivedAt || Date.now(), 0, Number.isFinite(ev.slot) ? ev.slot : null);
  }

  fastCheck(w, receivedAt, attempt = 0, slot = null) {
    if (!this.running) return;
    // Flooded wallet + we know the block the balance moved in: read just that block. Runs next
    // to a slow backup check instead of waiting for it.
    if (w.mode === 'balances' && slot != null && attempt === 0) {
      this.slotCheck(w, slot, receivedAt).then(
        (found) => {
          if (found === null) this.fastCheck(w, receivedAt, 1); // block unreadable: old way
        },
        () => this.fastCheck(w, receivedAt, 1)
      );
      return;
    }
    if (w.busy) {
      // a check is already running; look again right after it
      if (attempt < 20) setTimeout(() => this.fastCheck(w, receivedAt, attempt + 1), 400).unref?.();
      return;
    }
    w.busy = true;
    const run = w.mode === 'balances' ? this.pollBalances(w, { via: 'stream', receivedAt }) : this.pollWallet(w, { via: 'stream', receivedAt });
    run
      .then((found) => {
        if (found?.length) this.streamStats.signals += found.length;
        // the RPC can lag the push by a moment: if nothing showed up yet, look once more
        if (!found?.length && attempt === 0) setTimeout(() => this.fastCheck(w, receivedAt, 1), 1200).unref?.();
      })
      .catch((err) => {
        w.error = err.message;
      })
      .finally(() => {
        w.busy = false;
        this.emitStatus();
      });
  }

  drainStream() {
    while (this.streamActive < this.streamMaxConcurrent && this.streamQueue.length) {
      const { w, ev } = this.streamQueue.shift();
      this.streamActive += 1;
      this.processSignature(w, ev.signature, { backfill: false, via: 'stream', receivedAt: ev.receivedAt, waitForTx: true })
        .then((sig) => {
          if (sig) {
            this.streamStats.signals += 1;
            if (sig.streamMs != null) {
              this.streamStats.lagMs.push(sig.streamMs);
              if (this.streamStats.lagMs.length > 50) this.streamStats.lagMs.shift();
            }
          }
        })
        .catch((err) => {
          // let the poller pick it up later
          this.seenSigs.delete(ev.signature);
          this.stream.fail(`could not read pushed trade: ${err.message}`);
        })
        .finally(() => {
          this.streamActive -= 1;
          this.drainStream();
        });
    }
  }

  getStatus() {
    const lag = this.streamStats.lagMs;
    return {
      ...this.status,
      running: this.running,
      stream: {
        ...this.stream.status(),
        extraFeed: this.extraStream ? { name: this.feedRace.extraName, ...this.extraStream.status(), firstMain: this.feedRace.main, firstExtra: this.feedRace.extra } : null,
        grpcFeed: this.grpcFeed ? { ...this.grpcFeed.status(), firstGrpc: this.feedRace.grpc, firstMain: this.feedRace.main } : null,
        enabled: this.streamEnabled && this.running,
        swapsSeen: this.streamStats.swapsSeen,
        notSwap: this.streamStats.notSwap,
        failedTx: this.streamStats.failedTx,
        signals: this.streamStats.signals,
        fastDetect: {
          on: Boolean(this.fastDetect()),
          hits: this.fastStats.hits,
          misses: this.fastStats.misses,
          forgedIgnored: this.fastStats.forged,
          confirmed: this.fastStats.confirmed,
          phantoms: this.fastStats.phantoms,
          missReasons: { ...this.fastStats.missReasons },
          medianMs: this.fastStats.lagMs.length ? [...this.fastStats.lagMs].sort((a, b) => a - b)[Math.floor(this.fastStats.lagMs.length / 2)] : null,
          lastPhantom: this.fastStats.lastPhantom,
        },
        balanceMoves: this.streamStats.balanceMoves || 0,
        blocksRead: this.streamStats.blocksRead || 0,
        balanceFeed: this.useBalanceStream ? { ...this.balanceStream.status(), url: this.balanceStream.url } : null,
        tokenFeed: this.tokenStream ? { ...this.tokenStream.status(), changes: this.tokenStats.events, signals: this.tokenStats.signals, avgProcessMs: this.tokenStats.lagMs.length ? Math.round(this.tokenStats.lagMs.reduce((a, b) => a + b, 0) / this.tokenStats.lagMs.length) : null } : null,
        avgProcessMs: lag.length ? Math.round(lag.reduce((a, b) => a + b, 0) / lag.length) : null,
      },
      wallets: [...this.wallets.values()].map((w) => ({
        address: w.address,
        label: w.label,
        initialized: w.initialized,
        mode: w.mode || 'history',
        tokenCount: w.tokenCount ?? null,
        lastPollAt: w.lastPollAt,
        error: w.error,
        slowSince: w.slowSince || null,
        lastMoveAt: w.lastMoveAt || null,
      })),
    };
  }

  emitStatus() {
    try {
      this.onStatus(this.getStatus());
    } catch {
      // ignore listener errors
    }
  }

  /** Keep under the provider's requests-per-second limit (Alchemy free tier ≈ 25/s). */
  async throttle() {
    const max = this.maxRps;
    if (!max) return;
    for (;;) {
      const now = Date.now();
      while (this.rpcTimes.length && now - this.rpcTimes[0] >= 1000) this.rpcTimes.shift();
      if (this.rpcTimes.length < max) {
        this.rpcTimes.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 - (now - this.rpcTimes[0]) + 5));
    }
  }

  /** RPC call; a 429 (rate limited) is retried a few times with growing pauses. Fast calls race fastRpcUrls. */
  async rpc(method, params, { fast = false, rpcUrl = this.rpcUrl } = {}) {
    const altUrls = rpcUrl === this.rpcUrl ? (this.fastRpcUrls || []).filter((u) => u && u !== this.rpcUrl) : [];
    for (let attempt = 0; ; attempt++) {
      if (!fast) await this.throttle();
      try {
        if (fast && altUrls.length && attempt === 0) {
          const urls = [rpcUrl, ...altUrls];
          if (method === 'getTransaction' || method === 'getSignatureStatuses') {
            const isIndexed =
              method === 'getTransaction'
                ? (r) => r != null
                : (r) => Array.isArray(r?.value) && r.value.some((st) => st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized'));
            let fallbackOk;
            let haveFallback = false;
            try {
              return await Promise.any(
                urls.map(async (u) => {
                  const r = await this.rpcOnce(method, params, u);
                  if (!isIndexed(r)) {
                    if (!haveFallback) {
                      fallbackOk = r;
                      haveFallback = true;
                    }
                    throw new Error('not indexed yet');
                  }
                  return r;
                })
              );
            } catch (raceErr) {
              if (haveFallback) return fallbackOk;
              throw raceErr;
            }
          }
          return await Promise.any(urls.map((u) => this.rpcOnce(method, params, u)));
        }
        return await this.rpcOnce(method, params, rpcUrl);
      } catch (err) {
        const e = err instanceof AggregateError ? err.errors?.find((x) => x?.rateLimited) || err.errors?.[0] || err : err;
        if (!fast && attempt === 0 && altUrls.length && !e.rateLimited && /unreachable|HTTP 5\d\d/i.test(e.message || '')) {
          try {
            return await this.rpcOnce(method, params, altUrls[0]);
          } catch {
            // keep original error handling below
          }
        }
        if (!e.rateLimited || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 200));
      }
    }
  }

  /**
   * Race primary RPC + any extra fastRpcUrls (e.g. Helius + Alchemy in parallel) so cross-provider
   * indexing lag never delays a live stream trade.
   */
  async rpcRace(method, params, isGood = (r) => r != null) {
    const extras = (this.fastRpcUrls || []).filter((u) => u && u !== this.rpcUrl);
    if (!extras.length) return this.rpc(method, params, { fast: true });
    const urls = [this.rpcUrl, ...extras];
    try {
      return await Promise.any(
        urls.map(async (u) => {
          const r = await this.rpcOnce(method, params, u);
          if (!isGood(r)) throw new Error('not indexed yet');
          return r;
        })
      );
    } catch {
      return null;
    }
  }

  async rpcOnce(method, params, rpcUrl = this.rpcUrl) {
    this.status.rpcCalls += 1;
    const ctrl = new AbortController();
    // Token-account listings of spam-flooded wallets can be several MB: give them more time
    const t = setTimeout(() => ctrl.abort(), method === 'getTokenAccountsByOwner' ? 30_000 : 10_000);
    t.unref?.();
    let res;
    const startedAt = Date.now();
    try {
      res = await this.fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.status.rpcCalls, method, params }),
        keepalive: true,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new RpcError(`RPC unreachable (${err.name === 'AbortError' ? 'timeout' : err.message})`);
    } finally {
      clearTimeout(t);
    }
    // round-trip time of light calls (heavy token-account listings would skew it)
    if (res.ok && (method === 'getSignaturesForAddress' || method === 'getBalance' || method === 'getTransaction')) {
      const ms = Date.now() - startedAt;
      this.status.rpcMs = this.status.rpcMs ? Math.round(this.status.rpcMs * 0.7 + ms * 0.3) : ms;
    }
    if (res.status === 429) throw new RpcError('RPC rate limit (429) — slowing down', { rateLimited: true });
    if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) {
      const rate = json.error.code === 429 || /rate|too many/i.test(json.error.message || '');
      throw new RpcError(`RPC error: ${json.error.message || json.error.code}`, { rateLimited: rate });
    }
    return json.result;
  }

  /**
   * Fetch a transaction in any format. Solana now has version 1 transactions; asking for
   * version 0 only makes the RPC refuse them (error -32015), which silently hid trades.
   * Request the newest version we parse, and fall back if an older RPC rejects that.
   */
  async getTransaction(sig, { fast = false } = {}) {
    const versions = this.txVersion != null ? [this.txVersion] : [1, 0];
    let lastErr = null;
    for (const v of versions) {
      try {
        const params = [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: v, commitment: 'confirmed' }];
        const tx = fast ? await this.rpcRace('getTransaction', params, (r) => r != null) : await this.rpc('getTransaction', params);
        if (this.txVersion == null) this.txVersion = v;
        return tx;
      } catch (err) {
        lastErr = err;
        if (err.rateLimited) throw err;
        // -32015 "version not supported" for this tx → nothing older will work either
        if (/version \(\d+\) is not supported/i.test(err.message)) throw err;
      }
    }
    throw lastErr;
  }

  async processSignature(w, sig, { backfill, via = 'poll', receivedAt = null, waitForTx = false, tx: knownTx = null, knownSwap = null }) {
    if (this.seenSigs.has(sig)) return null;
    this.seenSigs.add(sig);
    if (this.seenSigs.size > 5000) this.seenSigs = new Set([...this.seenSigs].slice(-2500));

    const fast = Boolean(waitForTx || via === 'stream' || via === 'token-stream');
    let tx = knownSwap ? null : knownTx || (await this.getTransaction(sig, { fast }));
    // A pushed trade (at 'processed' commitment) can arrive 30–150 ms before getTransaction serves it:
    // poll with fast micro-intervals (35ms, 55ms, 75ms…) instead of 200ms–700ms sleeps.
    for (let i = 0; !knownSwap && waitForTx && !tx && i < 15; i++) {
      await new Promise((r) => setTimeout(r, 35 + i * 20));
      tx = await this.getTransaction(sig, { fast });
    }
    this.status.txParsed += 1;
    const swap = knownSwap || parseSwapFromTransaction(tx, w.address);
    if (!swap || swap.skip) {
      const reason = swap?.skip || 'transaction not found';
      this.status.txSkipped += 1;
      this.status.skipReasons[reason] = (this.status.skipReasons[reason] || 0) + 1;
      this.status.recentSkips.unshift({ signature: sig, wallet: w.address, label: w.label, reason, at: Date.now() });
      this.status.recentSkips.length = Math.min(this.status.recentSkips.length, 15);
      return null;
    }

    // Copy speed: token details from DexScreener / Alchemy can take many seconds for a brand-new
    // coin. Wait at most tokenInfoBudgetMs, then pass the trade on with the trader's own
    // on-chain price; the details are filled in when they arrive.
    // pump.fun coins are all alike: 1 billion supply, mint and freeze authority revoked. Their
    // details are not worth waiting for: market cap comes from the trader's own fill price.
    const pumpCoin = isPumpFunCoin(swap) || swap.venue === 'launchlab' || (via === 'fast-logs' && Boolean(swap.curve));
    const liveStream = via === 'fast-logs' || via === 'stream' || via === 'token-stream';
    const useFastInfoCache = !backfill && liveStream && (Boolean(swap.curve) || isPumpFunCoin(swap)) && this.tokenInfo?.cache instanceof Map;
    const fastCachedHit = useFastInfoCache ? this.tokenInfo.cache.get(swap.tokenMint) : null;
    const budgetMs = pumpCoin ? Math.min(this.tokenInfoBudgetMs, this.pumpInfoBudgetMs) : this.tokenInfoBudgetMs;
    const infoPromise = this.tokenInfo.get(swap.tokenMint);
    let infoLate = false;
    let budgetTimer = null;
    const [info, solPrice] = await Promise.all([
      useFastInfoCache
        ? fastCachedHit && Date.now() - fastCachedHit.at < (this.tokenInfo.ttlMs || 60_000)
          ? Promise.resolve(fastCachedHit.info)
          : ((infoLate = true), Promise.resolve(null))
        : budgetMs > 0
          ? Promise.race([
              infoPromise,
              new Promise((resolve) => {
                budgetTimer = setTimeout(() => {
                  infoLate = true;
                  resolve(null);
                }, budgetMs);
                budgetTimer.unref?.();
              }),
            ])
          : infoPromise,
      typeof this.tokenInfo.solPriceFast === 'function' ? this.tokenInfo.solPriceFast() : this.tokenInfo.solPriceUsd(),
    ]);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (infoLate) {
      infoPromise.then((late) => {
        if (late && typeof this.onTokenInfoLate === 'function') this.onTokenInfoLate(swap.tokenMint, late);
      }, () => {});
    }
    const quoteUsd = swap.quoteSymbol === 'SOL' ? solPrice : 1;
    const usdValue = swap.quoteAmount * quoteUsd;
    const txPriceUsd = swap.priceInQuote * quoteUsd;
    const pumpFallback = pumpCoin && !info?.marketCapUsd && txPriceUsd > 0;

    const signal = {
      id: `sig-${sig.slice(0, 12)}`,
      chainId: 'solana',
      wallet: w.address,
      label: w.label,
      side: swap.side,
      tokenMint: swap.tokenMint,
      tokenDecimals: swap.tokenDecimals ?? null,
      symbol: info?.symbol || `${swap.tokenMint.slice(0, 4)}…${swap.tokenMint.slice(-4)}`,
      name: info?.name || null,
      tokenAmount: swap.tokenAmount,
      sellSharePct: swap.sellSharePct,
      heldBefore: Number.isFinite(swap.heldBefore) ? swap.heldBefore : null,
      quoteSymbol: swap.quoteSymbol,
      quoteAmount: swap.quoteAmount,
      usdValue,
      txPriceUsd,
      currentPriceUsd: info?.priceUsd || null,
      marketCapUsd: info?.marketCapUsd || (pumpFallback ? txPriceUsd * PUMP_SUPPLY : null),
      liquidityUsd: info?.liquidityUsd || null,
      dexId: info?.dexId || null,
      pairCreatedAt: info?.pairCreatedAt || null,
      pairUrl: info?.pairUrl || null,
      imageUrl: info?.imageUrl || null,
      authorityKnown: Boolean(info?.authorityKnown) || pumpCoin,
      mintAuthority: info?.authorityKnown ? info.mintAuthority ?? null : null,
      freezeAuthority: info?.authorityKnown ? info.freezeAuthority ?? null : null,
      venue: swap.venue || null,
      poolQuoteAmount: swap.poolQuoteAmount ?? null,
      curve:
        swap.curve && Number(swap.curve.virtualSolReserves) > 0 && Number(swap.curve.virtualTokenReserves) > 0
          ? {
              virtualSolReserves: Number(swap.curve.virtualSolReserves),
              virtualTokenReserves: Number(swap.curve.virtualTokenReserves),
              realTokenReserves: Number(swap.curve.realTokenReserves) || 0,
              realSolReserves: Number(swap.curve.realSolReserves) || 0,
              mayhem: Boolean(swap.curve.mayhem),
              cashback: Boolean(swap.curve.cashback),
              launchlab: Boolean(swap.curve.launchlab),
              tokenProgram: swap.curve.tokenProgram || null,
              at: swap.curve.at || Date.now(),
            }
          : null,
      signature: sig,
      explorerUrl: `https://solscan.io/tx/${sig}`,
      blockTime: swap.blockTime,
      detectedAt: Date.now(),
      ...computeDetectLatency({ detectedAt: Date.now(), receivedAt, blockTimeMs: swap.blockTimeMs, blockTime: swap.blockTime }),
      via,
      backfill: Boolean(backfill),
    };
    this.emittedSigs.set(sig, swap.tokenMint);
    if (this.emittedSigs.size > 3000) this.emittedSigs = new Map([...this.emittedSigs].slice(-1500));
    w.lastMoveAt = Date.now();
    this.status.signalsEmitted += 1;
    try {
      await this.onSignal(signal);
    } catch {
      // ignore listener errors
    }
    return signal;
  }

  /**
   * Missed-trade audit (read-only): every buy/sell this wallet really made in the last
   * `minutes`, read straight from its on-chain history, so it can be compared with what the
   * watcher picked up. Pages back through spam-flooded histories; failed transactions skipped.
   */
  async auditWallet(address, { minutes = 60, maxSigs = 4000, maxTx = 400 } = {}) {
    const since = Math.floor(Date.now() / 1000) - minutes * 60;
    // gentle on the RPC: an audit must never starve live copying, and must survive rate limits
    const patient = async (method, params) => {
      for (let i = 0; ; i++) {
        try {
          return await this.rpc(method, params);
        } catch (err) {
          if (!err.rateLimited || i >= 8) throw err;
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
      }
    };
    const all = [];
    let before;
    pages: while (all.length < maxSigs) {
      const opts = { limit: 500, commitment: 'confirmed' };
      if (before) opts.before = before;
      const page = (await patient('getSignaturesForAddress', [address, opts])) || [];
      if (!page.length) break;
      for (const s of page) {
        if (s.blockTime && s.blockTime < since) break pages;
        all.push(s);
      }
      before = page[page.length - 1].signature;
      if (page.length < 500) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const ok = all.filter((s) => !s.err);
    const toRead = ok.slice(0, maxTx);
    const swaps = [];
    const notSwap = {};
    let unreadable = 0;
    for (const s of toRead) {
      let tx = null;
      for (let i = 0; i < 6 && !tx; i++) {
        try {
          tx = await this.getTransaction(s.signature);
          if (!tx) break;
        } catch (err) {
          if (!err.rateLimited) break;
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        }
      }
      if (!tx) {
        unreadable += 1;
        continue;
      }
      await new Promise((r) => setTimeout(r, 60)); // ~15 reads/s at most
      const swap = parseSwapFromTransaction(tx, address);
      if (swap && !swap.skip) {
        swaps.push({ signature: s.signature, side: swap.side, tokenMint: swap.tokenMint, quoteSymbol: swap.quoteSymbol, quoteAmount: swap.quoteAmount, tokenAmount: swap.tokenAmount, priceInQuote: swap.priceInQuote, blockTime: swap.blockTime });
      } else {
        const why = swap?.skip || 'unreadable';
        notSwap[why] = (notSwap[why] || 0) + 1;
      }
    }
    const w = this.wallets.get(address);
    return {
      address,
      minutes,
      historyEntries: all.length,
      failedEntries: all.length - ok.length,
      read: toRead.length,
      truncated: ok.length > toRead.length,
      unreadable,
      notSwap,
      swaps,
      watch: w ? { mode: w.mode || 'transactions', floodedAt: w.floodedAt || null, lastPollAt: w.lastPollAt || null, error: w.error || null } : null,
      seenByWatcher: Object.fromEntries(swaps.map((s) => [s.signature, this.seenSigs.has(s.signature)])),
    };
  }

  /**
   * Read-only check of a wallet's recent history: how many of its last N transactions are
   * buys/sells this app can copy, and why the rest were ignored. Nothing is stored.
   */
  async checkWallet(address, { limit = 25 } = {}) {
    const probe = (await this.rpc('getSignaturesForAddress', [address, { limit: 100, commitment: 'confirmed' }])) || [];
    if (isFlooded(probe, 100)) {
      const h = await this.getHoldings(address);
      const spanSec = Math.max(1, probe[0].blockTime - probe[probe.length - 1].blockTime);
      return {
        address,
        verdict: 'busy',
        mode: 'balances',
        checked: probe.length,
        failed: probe.filter((x) => x.err).length,
        txPerMinute: Math.round((probe.length / spanSec) * 60),
        solBalance: h.sol,
        tokensHeld: [...h.tokens.values()].filter((v) => v > 0).length,
        swaps: [],
        swapCount: 0,
        buys: 0,
        sells: 0,
        ignored: {},
        newestTxAt: probe[0].blockTime * 1000,
        lastSwapAt: null,
      };
    }
    const sigs = probe.slice(0, Math.min(50, Math.max(1, limit)));
    const swaps = [];
    const ignored = {};
    let failed = 0;
    for (const s of sigs) {
      if (s.err) {
        failed += 1;
        continue;
      }
      let tx = null;
      try {
        tx = await this.getTransaction(s.signature);
      } catch (err) {
        if (err.rateLimited) throw err;
        ignored['could not be read'] = (ignored['could not be read'] || 0) + 1;
        continue;
      }
      const swap = parseSwapFromTransaction(tx, address);
      if (swap && !swap.skip) {
        swaps.push({ side: swap.side, tokenMint: swap.tokenMint, quoteSymbol: swap.quoteSymbol, quoteAmount: swap.quoteAmount, blockTime: swap.blockTime, signature: s.signature });
      } else {
        const r = swap?.skip || 'transaction not found';
        ignored[r] = (ignored[r] || 0) + 1;
      }
    }
    const newest = sigs[0]?.blockTime ? sigs[0].blockTime * 1000 : null;
    const lastSwapAt = swaps[0]?.blockTime || null;
    let verdict = 'copyable';
    if (!sigs.length) verdict = 'inactive';
    else if (!swaps.length) verdict = 'no_swaps';
    return {
      address,
      verdict,
      checked: sigs.length,
      failed,
      swaps: swaps.slice(0, 10),
      swapCount: swaps.length,
      buys: swaps.filter((x) => x.side === 'buy').length,
      sells: swaps.filter((x) => x.side === 'sell').length,
      ignored,
      newestTxAt: newest,
      lastSwapAt,
    };
  }

  async pollWallet(w, fast = null) {
    if (w.mode === 'balances') return this.pollBalances(w, fast);
    const initial = !w.initialized;
    // 100 per poll so a busy wallet can't make more trades between polls than we read
    const opts = { limit: 100, commitment: 'confirmed' };
    if (!initial && w.lastSig) opts.until = w.lastSig;
    const sigs = (await this.rpc('getSignaturesForAddress', [w.address, opts])) || [];
    w.lastPollAt = Date.now();
    w.error = null;
    if (sigs.length) w.lastSig = sigs[0].signature;
    w.initialized = true;

    // Flooded wallet (or more new entries than one poll can read): switch to balance tracking
    if (isFlooded(sigs, opts.limit)) {
      w.mode = 'balances';
      w.floodedAt = Date.now();
      this.syncStreams();
      return this.pollBalances(w, fast);
    }

    // Oldest first, successful only, capped per poll; first poll only backfills a few
    let todo = sigs.filter((x) => !x.err);
    if (initial) todo = todo.slice(0, Math.max(1, this.backfillCount));
    todo = todo.slice(0, this.maxTx).reverse();
    const out = [];
    for (const x of todo) {
      const sig = await this.processSignature(w, x.signature, { backfill: initial, via: fast?.via || 'poll', receivedAt: fast?.receivedAt || null });
      if (sig) out.push(sig);
    }
    return out;
  }

  /**
   * Token + SOL holdings of a wallet (both token programs), summed per mint.
   * A listing that fails must never look like "the wallet sold everything": for a failed
   * program the previous snapshot's part is reused, and with no previous part the whole
   * read fails (so nothing is diffed against a half-empty snapshot).
   */
  async getHoldings(address, prev = null) {
    const list = (programId) => this.rpc('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const [solR, splR, t22R] = await Promise.allSettled([this.rpc('getBalance', [address, { commitment: 'confirmed' }]), list(TOKEN_PROGRAM), list(TOKEN_2022_PROGRAM)]);
    if (solR.status === 'rejected') throw solR.reason;
    const parts = {};
    const partial = [];
    for (const [key, r] of [['spl', splR], ['t22', t22R]]) {
      if (r.status === 'fulfilled' && Array.isArray(r.value?.value)) {
        const tokens = new Map();
        const accounts = new Map();
        for (const acc of r.value.value) {
          const info = acc?.account?.data?.parsed?.info;
          if (!info?.mint) continue;
          tokens.set(info.mint, (tokens.get(info.mint) || 0) + uiAmount({ uiTokenAmount: info.tokenAmount }));
          if (acc.pubkey) accounts.set(info.mint, [...(accounts.get(info.mint) || []), acc.pubkey]);
        }
        parts[key] = { tokens, accounts };
      } else if (prev?.parts?.[key]) {
        parts[key] = prev.parts[key]; // keep last known: no fake "sold everything"
        partial.push(key);
      } else {
        const why = r.status === 'rejected' ? r.reason?.message : 'bad response';
        throw new RpcError(`could not read ${key === 'spl' ? 'SPL' : 'Token-2022'} token accounts (${why})`, { rateLimited: Boolean(r.reason?.rateLimited) });
      }
    }
    const tokens = new Map();
    const accounts = new Map();
    for (const part of Object.values(parts)) {
      for (const [m, v] of part.tokens) tokens.set(m, (tokens.get(m) || 0) + v);
      for (const [m, a] of part.accounts) accounts.set(m, [...(accounts.get(m) || []), ...a]);
    }
    const sol = solR.value;
    const lamports = typeof sol === 'number' ? sol : Number(sol?.value || 0);
    return { sol: lamports / LAMPORTS_PER_SOL, tokens, accounts, parts, partial, at: Date.now() };
  }

  /** SOL + USDC of a wallet (cheap: no full token listing). */
  async getPaymentBalances(address) {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const [sol, usdcAccs] = await Promise.all([
      this.rpc('getBalance', [address, { commitment: 'confirmed' }]),
      this.rpc('getTokenAccountsByOwner', [address, { mint: USDC }, { encoding: 'jsonParsed', commitment: 'confirmed' }]).catch(() => null),
    ]);
    const lamports = typeof sol === 'number' ? sol : Number(sol?.value || 0);
    let usdc = null;
    if (usdcAccs && Array.isArray(usdcAccs.value)) {
      usdc = 0;
      for (const a of usdcAccs.value) {
        const info = a?.account?.data?.parsed?.info;
        if (info?.mint === USDC) usdc += uiAmount({ uiTokenAmount: info.tokenAmount });
      }
    }
    return { sol: lamports / LAMPORTS_PER_SOL, usdc };
  }

  /**
   * The balance feed says this flooded wallet's SOL moved in `slot`. Read that one block
   * (transaction list with account keys only) and keep the transactions the wallet signed:
   * one request instead of opening hundreds of spam transactions.
   * Returns the signals found, or null when the block could not be read.
   */
  async slotCheck(w, slot, receivedAt) {
    if (!w.slotsChecked) w.slotsChecked = new Set();
    if (w.slotsChecked.has(slot)) return [];
    w.slotsChecked.add(slot);
    if (w.slotsChecked.size > 200) w.slotsChecked = new Set([...w.slotsChecked].slice(-100));
    w.lastMoveAt = Date.now();

    // Light path first: the wallet's newest history entries already carry their slot, so the
    // trade can be found without downloading the whole block (a heavy call that rate limits hit).
    for (let attempt = 0; attempt < 4 && this.running; attempt++) {
      let recent = null;
      try {
        recent = (await this.rpc('getSignaturesForAddress', [w.address, { limit: 300, commitment: 'confirmed' }], { fast: true })) || [];
      } catch {
        break; // fall back to the block read below
      }
      if (!recent.length || recent[0].slot == null) break; // this RPC gives no slots: use the block read
      const newest = recent[0].slot;
      const oldest = recent[recent.length - 1]?.slot ?? Infinity;
      if (newest < slot) {
        await sleep(60); // the slot isn't indexed yet
        continue;
      }
      if (oldest > slot && recent.length >= 300) break; // flooded past it: read the block instead
      this.streamStats.slotLookups = (this.streamStats.slotLookups || 0) + 1;
      const inSlot = recent.filter((s) => s.slot === slot && !s.err && !this.seenSigs.has(s.signature)).map((s) => s.signature);
      const foundList = await Promise.all(
        inSlot.map((sig) => this.processSignature(w, sig, { backfill: false, via: 'stream', receivedAt, waitForTx: true }).catch(() => null))
      );
      const out = [];
      for (const found of foundList) {
        if (found) {
          found.source = 'balances-verified';
          out.push(found);
        }
      }
      if (out.length) {
        this.streamStats.signals += out.length;
        w.lastSlotTradeAt = Date.now();
      } else if (!inSlot.length) {
        this.noteSkip(w, `slot-${slot}`, 'balance changed but no trade signed by this wallet (transfer in/out)');
      }
      return out;
    }

    let block = null;
    for (let attempt = 0; attempt < 10 && this.running; attempt++) {
      try {
        block = await this.rpc('getBlock', [slot, { encoding: 'json', transactionDetails: 'accounts', maxSupportedTransactionVersion: 0, rewards: false, commitment: 'confirmed' }], { fast: true });
        if (block) break;
        if (attempt >= 1) return null; // an empty answer (not 'not available yet'): this RPC can't serve it
      } catch (err) {
        if (/skipped|missing in long-term storage|-32007|-32009/i.test(err.message)) return null;
        if (err.rateLimited && attempt >= 3) return null;
      }
      await sleep(attempt < 4 ? 60 : 150); // a just-confirmed block can take a moment to be served
    }
    if (!block?.transactions) return null;
    this.streamStats.blocksRead = (this.streamStats.blocksRead || 0) + 1;
    const own = [];
    for (const t of block.transactions) {
      if (t?.meta?.err) continue;
      const keys = t?.transaction?.accountKeys || [];
      if (!keys.some((k) => k && k.pubkey === w.address && k.signer)) continue;
      const sig = t.transaction.signatures?.[0];
      if (sig && !this.seenSigs.has(sig)) own.push(sig);
    }
    const out = [];
    for (const sig of own) {
      const found = await this.processSignature(w, sig, { backfill: false, via: 'stream', receivedAt, waitForTx: true });
      if (found) {
        found.source = 'balances-verified';
        out.push(found);
      }
    }
    if (out.length) {
      this.streamStats.signals += out.length;
      w.lastSlotTradeAt = Date.now();
    } else if (!own.length) {
      this.noteSkip(w, `slot-${slot}`, 'balance changed but no trade signed by this wallet (transfer in/out)');
    }
    return out;
  }

  /** Is the live balance feed watching this wallet right now? */
  balanceFeedLive(w) {
    if (!this.running || !this.streamEnabled) return false;
    const feed = this.useBalanceStream ? this.balanceStream : this.stream;
    const st = feed.status();
    return Boolean(st.connected && feed.subs?.has(w.address) && feed.accountMode?.has(w.address) && Date.now() - (st.connectedAt || Date.now()) > 5000);
  }

  /**
   * Spam-flooded wallet ("balance mode"). Spammers can flood a wallet with transactions and
   * junk tokens, but they cannot move its SOL / USDC or sign as it. So:
   *  1. read SOL + USDC (cheap); unchanged → nothing happened, just remember where we are
   *  2. changed → read only the new signatures since last time, open the few successful ones,
   *     and keep the transactions this wallet signed itself → those are its real trades.
   */
  async pollBalances(w, fast = null) {
    // Every 5 minutes, check whether the flood stopped; if so go back to exact transaction reading
    if (w.floodedAt && Date.now() - (w.floodCheckAt || w.floodedAt) > 300_000) {
      w.floodCheckAt = Date.now();
      const probe = (await this.rpc('getSignaturesForAddress', [w.address, { limit: 100, commitment: 'confirmed' }])) || [];
      if (!isFlooded(probe, 100)) {
        w.mode = 'history';
        w.floodedAt = null;
        w.flood = null;
        if (probe.length) w.lastSig = probe[0].signature; // continue from now, no backfill
        this.syncStreams();
        return [];
      }
    }
    // newest signature first, then balances: a trade that lands in between still shows as a move
    const head = (await this.rpc('getSignaturesForAddress', [w.address, { limit: 1, commitment: 'confirmed' }])) || [];
    const bal = await this.getPaymentBalances(w.address);
    w.lastPollAt = Date.now();
    w.error = null;
    w.initialized = true;
    const newest = head[0]?.signature || null;
    const prev = w.flood;
    if (!prev) {
      w.flood = { sol: bal.sol, usdc: bal.usdc, seenSol: bal.sol, seenUsdc: bal.usdc, lastSig: newest, misses: 0, at: Date.now() };
      return []; // baseline
    }
    // moved vs the last confirmed baseline, or vs the last value we saw (a buy then a sell can
    // bring SOL back to where it was)
    const d = (a, b) => (a != null && b != null ? Math.abs(a - b) : 0);
    const moved = d(bal.sol, prev.sol) >= 0.005 || d(bal.sol, prev.seenSol) >= 0.005 || d(bal.usdc, prev.usdc) >= 0.5 || d(bal.usdc, prev.seenUsdc) >= 0.5;
    if (!moved && !prev.misses) {
      w.flood = { ...prev, sol: bal.sol, usdc: bal.usdc ?? prev.usdc, seenSol: bal.sol, seenUsdc: bal.usdc, lastSig: newest || prev.lastSig };
      return [];
    }
    // The live feed watches this wallet: each move was already read from its own block, so the
    // slow full scan is only a backup for a move the feed did not report.
    if (moved && !prev.misses && this.balanceFeedLive(w)) {
      const seenByFeed = (w.lastMoveAt || 0) >= (prev.at || 0);
      if (seenByFeed || !prev.waitedAt) {
        w.flood = seenByFeed
          ? { sol: bal.sol, usdc: bal.usdc ?? prev.usdc, seenSol: bal.sol, seenUsdc: bal.usdc, lastSig: newest || prev.lastSig, misses: 0, at: Date.now() }
          : { ...prev, waitedAt: Date.now() }; // the push may simply not have arrived yet
        return [];
      }
    }
    let out;
    try {
      out = await this.scanOwnTransactions(w, prev.lastSig, fast);
    } catch (err) {
      if ((prev.misses || 0) >= 1) {
        w.flood = { sol: bal.sol, usdc: bal.usdc ?? prev.usdc, seenSol: bal.sol, seenUsdc: bal.usdc, lastSig: newest || prev.lastSig, misses: 0, at: Date.now() };
      } else {
        w.flood = { ...prev, seenSol: bal.sol, seenUsdc: bal.usdc, misses: (prev.misses || 0) + 1 };
      }
      throw err;
    }
    if (out.length || (prev.misses || 0) >= 3) {
      if (!out.length) this.noteSkip(w, `bal-${Date.now()}`, 'balance changed but no trade signed by this wallet (transfer in/out)');
      w.flood = { sol: bal.sol, usdc: bal.usdc ?? prev.usdc, seenSol: bal.sol, seenUsdc: bal.usdc, lastSig: newest || prev.lastSig, misses: 0, at: Date.now() };
    } else {
      // the RPC may not list the trade yet: keep the scan start and look again next time
      w.flood = { ...prev, seenSol: bal.sol, seenUsdc: bal.usdc, misses: (prev.misses || 0) + 1 };
    }
    return out;
  }

  /** Read every signature newer than `untilSig`, keep successful transactions signed by the wallet. */
  async scanOwnTransactions(w, untilSig, fast = null) {
    const MAX_PAGES = 20; // 20k signatures ≈ a minute of a 300 tx/s spam flood
    const ok = [];
    let before;
    let pages = 0;
    let capped = false;
    for (;;) {
      const page = (await this.rpc('getSignaturesForAddress', [w.address, { limit: 1000, commitment: 'confirmed', ...(untilSig ? { until: untilSig } : {}), ...(before ? { before } : {}) }])) || [];
      pages += 1;
      for (const x of page) if (!x.err && !this.seenSigs.has(x.signature) && !this.spamSigs.has(x.signature)) ok.push(x.signature);
      if (page.length < 1000 || !untilSig) break;
      if (pages >= MAX_PAGES) {
        capped = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    if (capped) this.noteSkip(w, `scan-${Date.now()}`, 'too much spam between checks to read every transaction (oldest skipped)');
    this.status.floodScanned = (this.status.floodScanned || 0) + ok.length;
    // open successful ones (oldest first), a few at a time; only the wallet's own count
    const todo = ok.reverse().slice(-300);
    const out = [];
    for (let i = 0; i < todo.length; i += 4) {
      const batch = todo.slice(i, i + 4);
      const txs = await Promise.all(batch.map((sig) => this.getTransaction(sig).catch(() => null)));
      for (let k = 0; k < batch.length; k++) {
        const tx = txs[k];
        const keys = tx?.transaction?.message?.accountKeys || [];
        const signedByWallet = keys.some((key) => (typeof key === 'string' ? false : key.pubkey === w.address && key.signer));
        if (!signedByWallet) {
          if (tx) this.spamSigs.add(batch[k]); // spam sent by someone else: never open it again
          continue;
        }
        const sig = await this.processSignature(w, batch[k], { backfill: false, via: fast?.via || 'poll', receivedAt: fast?.receivedAt || null, tx });
        if (sig) {
          sig.source = 'balances-verified';
          out.push(sig);
        }
      }
    }
    if (this.spamSigs.size > 20000) this.spamSigs = new Set([...this.spamSigs].slice(-10000));
    return out;
  }

  noteSkip(w, sig, reason) {
    this.status.txSkipped += 1;
    this.status.skipReasons[reason] = (this.status.skipReasons[reason] || 0) + 1;
    this.status.recentSkips.unshift({ signature: sig, wallet: w.address, label: w.label, reason, at: Date.now() });
    this.status.recentSkips.length = Math.min(this.status.recentSkips.length, 15);
  }

  buildSignal(w, swap, info, { signature, explorerUrl, source = 'history', backfill = false }) {
    return {
      id: `sig-${String(signature).slice(0, 24)}`,
      chainId: 'solana',
      wallet: w.address,
      label: w.label,
      side: swap.side,
      tokenMint: swap.tokenMint,
      tokenDecimals: swap.tokenDecimals ?? null,
      symbol: info?.symbol || `${swap.tokenMint.slice(0, 4)}…${swap.tokenMint.slice(-4)}`,
      name: info?.name || null,
      tokenAmount: swap.tokenAmount,
      sellSharePct: swap.sellSharePct ?? null,
      heldBefore: Number.isFinite(swap.heldBefore) ? swap.heldBefore : Number.isFinite(swap.before) ? swap.before : null,
      quoteSymbol: swap.quoteSymbol,
      quoteAmount: swap.quoteAmount,
      usdValue: swap.usdValue ?? null,
      txPriceUsd: swap.txPriceUsd,
      currentPriceUsd: info?.priceUsd || null,
      marketCapUsd: info?.marketCapUsd || null,
      liquidityUsd: info?.liquidityUsd || null,
      dexId: info?.dexId || null,
      pairCreatedAt: info?.pairCreatedAt || null,
      pairUrl: info?.pairUrl || null,
      imageUrl: info?.imageUrl || null,
      authorityKnown: Boolean(info?.authorityKnown),
      mintAuthority: info?.mintAuthority ?? null,
      freezeAuthority: info?.freezeAuthority ?? null,
      signature,
      explorerUrl,
      source,
      blockTime: swap.blockTime,
      detectedAt: Date.now(),
      ...computeDetectLatency({ detectedAt: Date.now(), blockTimeMs: swap.blockTimeMs, blockTime: swap.blockTime }),
      backfill: Boolean(backfill),
    };
  }

  async emitSignal(signal) {
    this.status.signalsEmitted += 1;
    try {
      await this.onSignal(signal);
    } catch {
      // ignore listener errors
    }
  }

  /** One pass over every watched wallet. Safe to call manually ("Poll now"). */
  async pollOnce() {
    if (this.polling) return [];
    this.polling = true;
    this.status.lastPollAt = Date.now();
    const found = [];
    let hadError = null;
    try {
      // Every wallet is checked in parallel, each with a time budget, so one slow or noisy
      // wallet can never stop the others from being read.
      const jobs = [...this.wallets.values()].map(async (w) => {
        if (w.busy) return; // its previous check is still running
        w.busy = true;
        // 'busy' clears when the check really ends, so a slow check is never run twice at once
        const started = Date.now();
        const inner = this.pollWallet(w)
          .then(
            (r) => {
              w.slowSince = null;
              return r;
            },
            (err) => {
              w.slowSince = null;
              w.error = err.message; // a check that fails after its budget still reports why
              throw err;
            }
          )
          .finally(() => {
            w.busy = false;
          });
        inner.catch(() => {});
        try {
          const res = await withTimeout(inner, this.walletBudgetMs, `check of ${w.label || w.address.slice(0, 6)} took too long`);
          found.push(...res);
        } catch (err) {
          if (err.budget) {
            // slow (a spam-flooded wallet): it keeps running and its trades are still copied
            w.slowSince = w.slowSince || started;
            return;
          }
          w.error = err.message;
          if (!hadError || err.rateLimited) hadError = err;
        }
      });
      await Promise.all(jobs);
    } finally {
      this.polling = false;
    }
    if (hadError) {
      this.status.lastError = hadError.message;
      this.status.rateLimited = Boolean(hadError.rateLimited);
      this.backoffMs = hadError.rateLimited ? Math.min(120_000, (this.backoffMs || this.pollIntervalMs) * 2) : this.backoffMs;
    } else {
      this.status.lastError = null;
      this.status.rateLimited = false;
      this.status.lastSuccessAt = Date.now();
      this.backoffMs = 0;
    }
    this.emitStatus();
    return found;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      if (this.wallets.size) await this.pollOnce();
      if (!this.running) return;
      const wait = this.pollIntervalMs + this.backoffMs;
      this.status.nextPollInMs = wait;
      this.timer = setTimeout(loop, wait);
    };
    this.timer = setTimeout(loop, 250);
    this.syncStreams();
    this.emitStatus();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status.nextPollInMs = null;
    this.stream.stop();
    this.balanceStream.stop();
    this.tokenStream?.stop();
    this.extraStream?.stop();
    this.grpcFeed?.stop();
    this.emitStatus();
  }
}
