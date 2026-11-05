/**
 * Fast trade detection: read a pump.fun trade straight from the logs Helius pushes at
 * `processed` commitment, without waiting for getTransaction (which only answers once the
 * transaction is confirmed).
 *
 * Safety (fake-trade baiting): anyone can send a transaction that mentions a trader's wallet and
 * write "Program data: …" lines that look like a pump.fun TradeEvent. Only the Solana runtime
 * writes the "Program <id> invoke [n]" / "Program <id> success" lines (program logs are always
 * prefixed "Program log:" or "Program data:"), so the invoke stack is tracked and a TradeEvent is
 * only trusted when pump.fun's own program is the one running when it is written. pump.fun only
 * accepts a trade signed by `user`, so a genuine TradeEvent with user = the trader means the
 * trader signed it. Anything unclear (truncated logs, several trades, token-paired coins, a curve
 * completing in the same transaction) returns null → the normal confirmed path is used.
 */
import { base58Encode } from './onchainMeta.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const RAYDIUM_LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const FAST_TRADE_PROGRAMS = new Set([PUMP_PROGRAM, PUMP_AMM_PROGRAM, RAYDIUM_LAUNCHLAB_PROGRAM]);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ZERO_KEY = '11111111111111111111111111111111';
const TRADE_EVENT = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
export const PUMP_SWAP_BUY_EVENT = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
export const PUMP_SWAP_SELL_EVENT = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
export const PUMP_SWAP_POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
// events that mean the trade was not a plain curve trade (curve completed / synthetic migration)
const COMPLETE_EVENT = Buffer.from('X3JhnNQumAg=', 'base64');
const POST_COMPLETE_BUY_EVENT = Buffer.from('b7BtizFs1fs=', 'base64');

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const END_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed\b.*)$/;
const DATA_RE = /^Program data: ([A-Za-z0-9+/=]+)$/;

/** Borsh reader for the TradeEvent fields (IDL order). Throws when the data runs out. */
function reader(b) {
  let o = 0;
  const need = (n) => {
    if (o + n > b.length) throw new Error('short');
  };
  return {
    pubkey() {
      need(32);
      const v = base58Encode(b.subarray(o, o + 32));
      o += 32;
      return v;
    },
    u64() {
      need(8);
      const v = b.readBigUInt64LE(o);
      o += 8;
      return v;
    },
    i64() {
      need(8);
      const v = b.readBigInt64LE(o);
      o += 8;
      return v;
    },
    u16() {
      need(2);
      const v = b.readUInt16LE(o);
      o += 2;
      return v;
    },
    u32() {
      need(4);
      const v = b.readUInt32LE(o);
      o += 4;
      return v;
    },
    bool() {
      need(1);
      return b[o++] === 1;
    },
    string() {
      const n = this.u32();
      if (n > 64) throw new Error('bad string');
      need(n);
      const v = b.subarray(o, o + n).toString('utf8');
      o += n;
      return v;
    },
    left: () => b.length - o,
  };
}

/** Decode a TradeEvent body (after the 8-byte discriminator). Fields after ix_name are optional. */
export function decodeTradeEvent(body) {
  const r = reader(body);
  const ev = {
    mint: r.pubkey(),
    solAmount: r.u64(),
    tokenAmount: r.u64(),
    isBuy: r.bool(),
    user: r.pubkey(),
    timestamp: r.i64(),
    virtualSolReserves: r.u64(),
    virtualTokenReserves: r.u64(),
    realSolReserves: r.u64(),
    realTokenReserves: r.u64(),
  };
  // fee fields, then quote mint (newer layouts). Missing tail = an older SOL-only layout.
  ev.quoteMint = WSOL_MINT;
  try {
    r.pubkey(); // fee_recipient
    r.u64(); // fee_basis_points
    ev.fee = r.u64();
    r.pubkey(); // creator
    r.u64(); // creator_fee_basis_points
    ev.creatorFee = r.u64();
    r.bool(); // track_volume
    r.u64(); // total_unclaimed_tokens
    r.u64(); // total_claimed_tokens
    r.u64(); // current_sol_volume
    r.i64(); // last_update_timestamp
    ev.ixName = r.string();
    if (r.left() > 0) {
      ev.mayhem = r.bool();
      const cbBps = r.u64(); // cashback_fee_basis_points
      const cbAmt = r.u64(); // cashback
      ev.cashback = cbBps > 0n || cbAmt > 0n;
      r.u64(); // buyback_fee_basis_points
      r.u64(); // buyback_fee
      const n = r.u32(); // shareholders
      if (n > 64) throw new Error('bad vec');
      for (let i = 0; i < n; i++) {
        r.pubkey();
        r.u16();
      }
      const qm = r.pubkey();
      ev.quoteMint = qm === ZERO_KEY ? WSOL_MINT : qm;
      ev.quoteAmount = r.u64();
    }
  } catch {
    // tail missing: keep what was read (the core trade fields are complete)
    ev.partialLayout = true;
  }
  return ev;
}

/**
 * Decode a Raydium LaunchLab (LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj) 139-byte TradeEvent body
 * (147 bytes including the 8-byte TRADE_EVENT discriminator).
 */
export function decodeLaunchLabTradeEvent(body) {
  if (!body || body.length < 139) return null;
  const r = reader(body);
  const poolState = r.pubkey(); // 0..32
  const totalBaseSell = r.u64(); // 32..40
  const virtualBase = r.u64(); // 40..48
  const virtualQuote = r.u64(); // 48..56
  const realBaseBefore = r.u64(); // 56..64
  const realQuoteBefore = r.u64(); // 64..72
  const realBaseAfter = r.u64(); // 72..80
  const realQuoteAfter = r.u64(); // 80..88
  const amountIn = r.u64(); // 88..96
  const amountOut = r.u64(); // 96..104
  const protocolFee = r.u64(); // 104..112
  const platformFee = r.u64(); // 112..120
  const creatorFee = r.u64(); // 120..128
  const shareFee = r.u64(); // 128..136
  const tradeDirection = body[136]; // 0 = Buy, 1 = Sell
  const poolStatus = body[137];
  const exactIn = body[138] === 1;
  if (!(virtualBase > realBaseAfter) || !(virtualQuote > 0n)) return null;
  return {
    poolState,
    totalBaseSell,
    virtualBase,
    virtualQuote,
    realBaseBefore,
    realQuoteBefore,
    realBaseAfter,
    realQuoteAfter,
    amountIn,
    amountOut,
    protocolFee,
    platformFee,
    creatorFee,
    shareFee,
    isBuy: tradeDirection === 0,
    complete: poolStatus !== 0,
    exactIn,
    virtualTokenReserves: Number(virtualBase - realBaseAfter),
    virtualSolReserves: Number(virtualQuote + realQuoteAfter),
    realTokenReserves: Number(totalBaseSell > realBaseAfter ? totalBaseSell - realBaseAfter : virtualBase - realBaseAfter),
    realSolReserves: Number(realQuoteAfter),
    poolSolLamports: Number(realQuoteAfter > realQuoteBefore ? realQuoteAfter - realQuoteBefore : realQuoteBefore - realQuoteAfter),
  };
}

/** Extract a verified Raydium LaunchLab TradeEvent from transaction logs (invoke-stack checked). */
export function launchLabTradeFromLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) return null;
  const stack = [];
  const events = [];
  for (const raw of logs) {
    const line = String(raw);
    if (/^Log truncated/i.test(line)) return null;
    let m = INVOKE_RE.exec(line);
    if (m) {
      if (Number(m[2]) !== stack.length + 1) return null;
      stack.push(m[1]);
      continue;
    }
    m = END_RE.exec(line);
    if (m) {
      if (stack[stack.length - 1] !== m[1] || m[2] !== 'success') return null;
      stack.pop();
      continue;
    }
    m = DATA_RE.exec(line);
    if (!m) continue;
    if (stack[stack.length - 1] !== RAYDIUM_LAUNCHLAB_PROGRAM) continue;
    let data;
    try {
      data = Buffer.from(m[1], 'base64');
    } catch {
      continue;
    }
    if (data.length === 147 && data.subarray(0, 8).equals(TRADE_EVENT)) {
      try {
        const ev = decodeLaunchLabTradeEvent(data.subarray(8));
        if (ev && !ev.complete) events.push(ev);
      } catch {
        // ignore malformed
      }
    }
  }
  return events.length === 1 ? events[0] : null;
}

/**
 * The trader's pump.fun trade from pushed logs, or { skip: reason }.
 * Only returns a trade when exactly one genuine TradeEvent for `trader` is found.
 */
export function pumpTradeFromLogs(logs, trader, { err = null } = {}) {
  if (err) return { skip: 'failed transaction' };
  if (!Array.isArray(logs) || !logs.length) return { skip: 'no logs' };
  const stack = [];
  const trades = [];
  let complete = false;
  let seenTokenProgram = null;
  for (const raw of logs) {
    const line = String(raw);
    if (/^Log truncated/i.test(line)) return { skip: 'logs truncated' };
    let m = INVOKE_RE.exec(line);
    if (m) {
      const depth = Number(m[2]);
      if (depth !== stack.length + 1) return { skip: 'invoke stack out of order' };
      if (stack.includes(PUMP_PROGRAM) && (m[1] === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' || m[1] === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')) {
        if (m[1] === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' || !seenTokenProgram) seenTokenProgram = m[1];
      }
      stack.push(m[1]);
      continue;
    }
    m = END_RE.exec(line);
    if (m) {
      if (stack[stack.length - 1] !== m[1]) return { skip: 'invoke stack out of order' };
      if (m[2] !== 'success') return { skip: 'a program failed' };
      stack.pop();
      continue;
    }
    m = DATA_RE.exec(line);
    if (!m) continue;
    let data;
    try {
      data = Buffer.from(m[1], 'base64');
    } catch {
      continue;
    }
    if (data.length < 8) continue;
    const disc = data.subarray(0, 8);
    const isTrade = disc.equals(TRADE_EVENT);
    const isComplete = disc.equals(COMPLETE_EVENT) || disc.equals(POST_COMPLETE_BUY_EVENT);
    if (!isTrade && !isComplete) continue;
    // the core check: only pump.fun itself or trusted migration programs can write a trusted event
    const activeProg = stack[stack.length - 1];
    if (!FAST_TRADE_PROGRAMS.has(activeProg)) {
      if (isTrade) return { skip: 'trade record written by another program (ignored)', forged: true };
      continue;
    }
    if (activeProg === RAYDIUM_LAUNCHLAB_PROGRAM && data.length === 147) continue;
    if (isComplete) {
      complete = true;
      continue;
    }
    let ev;
    try {
      ev = decodeTradeEvent(data.subarray(8));
      ev.program = activeProg;
    } catch {
      return { skip: 'trade record unreadable' };
    }
    if (ev.user === trader) trades.push(ev);
  }
  if (stack.length) return { skip: 'logs incomplete' };
  if (!trades.length) return { skip: 'no pump.fun trade by this wallet' };
  if (trades.length > 1) return { skip: 'several trades in one transaction' };
  if (complete) return { skip: 'curve completed in this transaction' };
  const t = trades[0];
  if (t.quoteMint !== WSOL_MINT) return { skip: 'coin not priced in SOL', nonSolBuy: Boolean(t.isBuy) };
  if (t.solAmount <= 0n || t.tokenAmount <= 0n) return { skip: 'empty trade' };
  if (seenTokenProgram && !t.tokenProgram) t.tokenProgram = seenTokenProgram;
  return { trade: t };
}

/**
 * Decode a PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) Pool account (base64 or Buffer)
 * into { baseMint, quoteMint }. Returns null when the buffer is not a valid PumpSwap Pool.
 */
export function decodePumpSwapPool(raw) {
  const b = Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? Buffer.from(raw, 'base64') : null;
  if (!b || b.length < 107 || !b.subarray(0, 8).equals(PUMP_SWAP_POOL_DISC)) return null;
  return {
    baseMint: base58Encode(b.subarray(43, 75)),
    quoteMint: base58Encode(b.subarray(75, 107)),
  };
}

/**
 * Decode a PumpSwap BuyEvent or SellEvent body (after the 8-byte discriminator, >=240 bytes).
 */
export function decodePumpSwapEvent(body, isBuy) {
  if (!body || body.length < 240) throw new Error('short pumpswap event');
  const r = reader(body);
  const timestamp = r.i64();
  const baseAmount = r.u64(); // base_amount_out (buy) / base_amount_in (sell)
  const limitQuoteAmount = r.u64(); // max_quote_amount_in / min_quote_amount_out
  const userBaseTokenReserves = r.u64(); // user base balance BEFORE this swap
  const userQuoteTokenReserves = r.u64(); // user quote balance BEFORE this swap
  const poolBaseTokenReserves = r.u64(); // pool base reserves BEFORE this swap
  const poolQuoteTokenReserves = r.u64(); // pool quote reserves BEFORE this swap
  const quoteAmount = r.u64(); // pool quote leg (quote_amount_in / quote_amount_out)
  const lpFeeBps = r.u64();
  const lpFee = r.u64();
  const protocolFeeBps = r.u64();
  const protocolFee = r.u64();
  const quoteAmountWithLpFee = r.u64();
  const userQuoteAmount = r.u64(); // user_quote_amount_in / user_quote_amount_out (all fees included)
  const pool = r.pubkey();
  const user = r.pubkey();
  const userBaseTokenAccount = r.pubkey();
  const userQuoteTokenAccount = r.pubkey();
  return {
    isBuy: Boolean(isBuy),
    timestamp,
    baseAmount,
    limitQuoteAmount,
    userBaseTokenReserves,
    userQuoteTokenReserves,
    poolBaseTokenReserves,
    poolQuoteTokenReserves,
    quoteAmount,
    lpFeeBps,
    lpFee,
    protocolFeeBps,
    protocolFee,
    quoteAmountWithLpFee,
    userQuoteAmount,
    pool,
    user,
    userBaseTokenAccount,
    userQuoteTokenAccount,
  };
}

/**
 * Extract the trader's verified PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) BuyEvent or
 * SellEvent from pushed logs at `processed` commitment, with strict runtime invoke-stack checks.
 */
export function pumpSwapTradeFromLogs(logs, trader, { err = null } = {}) {
  if (err) return { skip: 'failed transaction' };
  if (!Array.isArray(logs) || !logs.length) return { skip: 'no logs' };
  const stack = [];
  const trades = [];
  let complete = false;
  for (const raw of logs) {
    const line = String(raw);
    if (/^Log truncated/i.test(line)) return { skip: 'logs truncated' };
    let m = INVOKE_RE.exec(line);
    if (m) {
      if (Number(m[2]) !== stack.length + 1) return { skip: 'invoke stack out of order' };
      stack.push(m[1]);
      continue;
    }
    m = END_RE.exec(line);
    if (m) {
      if (stack[stack.length - 1] !== m[1]) return { skip: 'invoke stack out of order' };
      if (m[2] !== 'success') return { skip: 'a program failed' };
      stack.pop();
      continue;
    }
    m = DATA_RE.exec(line);
    if (!m) continue;
    let data;
    try {
      data = Buffer.from(m[1], 'base64');
    } catch {
      continue;
    }
    if (data.length < 8) continue;
    const disc = data.subarray(0, 8);
    if (disc.equals(COMPLETE_EVENT) || disc.equals(POST_COMPLETE_BUY_EVENT)) {
      if (stack[stack.length - 1] === PUMP_PROGRAM) complete = true;
      continue;
    }
    const isBuy = disc.equals(PUMP_SWAP_BUY_EVENT);
    const isSell = !isBuy && disc.equals(PUMP_SWAP_SELL_EVENT);
    if (!isBuy && !isSell) continue;
    const activeProg = stack[stack.length - 1];
    if (activeProg !== PUMP_AMM_PROGRAM) {
      return { skip: 'trade record written by another program (ignored)', forged: true };
    }
    let ev;
    try {
      ev = decodePumpSwapEvent(data.subarray(8), isBuy);
    } catch {
      return { skip: 'trade record unreadable' };
    }
    if (ev.user === trader) trades.push(ev);
  }
  if (stack.length) return { skip: 'logs incomplete' };
  if (!trades.length) return { skip: 'no pumpswap trade by this wallet' };
  if (trades.length > 1) return { skip: 'several trades in one transaction' };
  if (complete) return { skip: 'curve completed in this transaction' };
  const t = trades[0];
  if (t.baseAmount <= 0n || t.quoteAmount <= 0n) return { skip: 'empty trade' };
  return { trade: t };
}

/**
 * Convert a decoded PumpSwap event + resolved pool mints ({ baseMint, quoteMint, decimals }) into
 * the watcher's standard swap shape (including heldBefore and sellSharePct without extra RPC reads).
 */
export function swapFromPumpSwapTrade(t, poolInfo, { signature, slot = null, receivedAt = Date.now() } = {}) {
  if (!t || !poolInfo?.baseMint || !poolInfo?.quoteMint) return null;
  const { baseMint, quoteMint } = poolInfo;
  const decimals = Number.isInteger(poolInfo.decimals) ? poolInfo.decimals : 6;
  let isBuy;
  let tokenMint;
  let tokenRaw;
  let poolSolLamports;
  let walletSolLamports;
  let heldBeforeRaw;
  if (quoteMint === WSOL_MINT && baseMint !== WSOL_MINT) {
    isBuy = Boolean(t.isBuy);
    tokenMint = baseMint;
    tokenRaw = t.baseAmount;
    poolSolLamports = t.quoteAmount;
    walletSolLamports = t.userQuoteAmount > 0n ? t.userQuoteAmount : t.quoteAmount;
    heldBeforeRaw = t.userBaseTokenReserves;
  } else if (baseMint === WSOL_MINT && quoteMint !== WSOL_MINT) {
    isBuy = !t.isBuy;
    tokenMint = quoteMint;
    tokenRaw = t.userQuoteAmount > 0n ? t.userQuoteAmount : t.quoteAmount;
    poolSolLamports = t.baseAmount;
    walletSolLamports = t.baseAmount;
    heldBeforeRaw = t.userQuoteTokenReserves;
  } else {
    return { skip: 'coin not priced in SOL', nonSolBuy: Boolean(t.isBuy) };
  }
  const scale = 10 ** decimals;
  const tokenAmount = Number(tokenRaw) / scale;
  const poolSol = Number(poolSolLamports) / 1e9;
  const walletSol = Number(walletSolLamports) / 1e9;
  if (!(tokenAmount > 0) || !(poolSol > 0)) return null;
  const heldBefore = Number(heldBeforeRaw) / scale;
  let sellSharePct = null;
  if (!isBuy) {
    sellSharePct = heldBeforeRaw > 0n ? Math.min(100, Number(((Number(tokenRaw) / Number(heldBeforeRaw)) * 100).toFixed(2))) : 100;
  }
  return {
    side: isBuy ? 'buy' : 'sell',
    sellSharePct,
    heldBefore,
    tokenMint,
    tokenDecimals: decimals,
    tokenAmount,
    quoteSymbol: 'SOL',
    quoteMint: WSOL_MINT,
    quoteAmount: walletSol,
    priceInQuote: poolSol / tokenAmount,
    poolQuoteAmount: poolSol,
    signature,
    slot,
    blockTime: Number(t.timestamp) > 0 ? Math.min(receivedAt, Number(t.timestamp) * 1000) : receivedAt,
    venue: 'pumpswap',
    fastDetect: true,
  };
}

/**
 * Turn a TradeEvent into the watcher's swap shape (same fields as parseSwapFromTransaction).
 * `heldAfterRaw` (the trader's token balance after the trade, raw units) is needed for sells.
 */
export function swapFromPumpTrade(t, { signature, slot = null, heldAfterRaw = null, decimals = 6, receivedAt = Date.now() } = {}) {
  const scale = 10 ** decimals;
  const tokenAmount = Number(t.tokenAmount) / scale;
  // TradeEvent.sol_amount is the SOL that reached the curve (fees are on top for buys, taken
  // off for sells): it is the pool leg, like poolSolLeg() gives for a confirmed transaction
  const poolSol = Number(t.solAmount) / 1e9;
  const fees = Number((t.fee || 0n) + (t.creatorFee || 0n)) / 1e9;
  const walletSol = t.isBuy ? poolSol + fees : Math.max(0, poolSol - fees);
  let sellSharePct = null;
  if (!t.isBuy) {
    if (heldAfterRaw === null) return null;
    const before = Number(BigInt(heldAfterRaw) + t.tokenAmount);
    sellSharePct = before > 0 ? Math.min(100, Number(((Number(t.tokenAmount) / before) * 100).toFixed(2))) : 100;
  }
  return {
    side: t.isBuy ? 'buy' : 'sell',
    sellSharePct,
    tokenMint: t.mint,
    tokenDecimals: decimals,
    tokenAmount,
    quoteSymbol: 'SOL',
    quoteMint: WSOL_MINT,
    quoteAmount: walletSol,
    priceInQuote: poolSol / tokenAmount,
    poolQuoteAmount: poolSol,
    signature,
    slot,
    // the event's own timestamp is the block's clock (seconds); the push time is more exact
    blockTime: Number(t.timestamp) > 0 ? Math.min(receivedAt, Number(t.timestamp) * 1000) : receivedAt,
    venue: t.program && t.program !== PUMP_PROGRAM ? 'pumpswap' : 'pumpfun',
    fastDetect: true,
    curve: {
      virtualSolReserves: t.virtualSolReserves,
      virtualTokenReserves: t.virtualTokenReserves,
      realTokenReserves: t.realTokenReserves,
      mayhem: Boolean(t.mayhem),
      cashback: Boolean(t.cashback),
      tokenProgram: t.tokenProgram || null,
    },
  };
}
