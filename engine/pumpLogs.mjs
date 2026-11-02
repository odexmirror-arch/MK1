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
  if (t.quoteMint !== WSOL_MINT) return { skip: 'coin not priced in SOL' };
  if (t.solAmount <= 0n || t.tokenAmount <= 0n) return { skip: 'empty trade' };
  if (seenTokenProgram && !t.tokenProgram) t.tokenProgram = seenTokenProgram;
  return { trade: t };
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
