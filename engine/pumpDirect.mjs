/**
 * Direct pump.fun swaps — buy / sell on the bonding curve without Jupiter (Settings → Swap route).
 *
 * Built from pump.fun's official IDL (github.com/pump-fun/pump-public-docs, updated 13 Oct 2026):
 * `buy_exact_quote_in_v3` (spend exact SOL, minimum tokens out) and `sell_v3` (exact tokens,
 * minimum SOL out), 17 accounts each.
 *
 * Safety:
 *  - pump.fun itself enforces the price limit: the buy's `min_tokens_out` comes from your max
 *    chase / slippage, the sell's `min_sol_output` from the sell slippage
 *  - every swap is SIMULATED on Solana first; the simulation's token and SOL changes are checked
 *    against what we expect, and it is only sent if they match
 *  - only coins this can handle go direct: SOL-paired, still on the curve, not cashback, not
 *    mayhem, enough left on the curve. Everything else, and any build / simulation problem,
 *    falls back to Jupiter before anything is sent
 *  - instructions: compute budget, create-token-account-if-missing (buys) and the pump.fun trade.
 *    No transfers.
 */
import { findProgramAddress, base58Decode, base58Encode } from './onchainMeta.mjs';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const ZERO_KEY = '11111111111111111111111111111111';

// discriminators from the IDL
const DISC = {
  buyExactQuoteInV3: Buffer.from([225, 247, 80, 30, 213, 179, 132, 136]),
  sellV3: Buffer.from([28, 146, 222, 119, 38, 196, 105, 213]),
  bondingCurve: Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]),
};
// pump.fun's price-limit errors: the price moved past our limit (skip, never fall back)
export const PRICE_ERRORS = new Set([6002, 6003, 6042]); // TooMuchSolRequired, TooLittleSolReceived, BuySlippageBelowMinTokensOut

// 8 buyback fee recipients (FEE_RECIPIENTS.md); SOL-paired coins pass the wallet itself
export const BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
];

// 8 official mainnet Jito Block Engine tip accounts (getTipAccounts)
export const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];

// Tight compute unit budgets (~85k-95k CU actual on buy with ATA creation; ~50k-65k CU on sell)
export const DIRECT_BUY_UNITS = 115_000;
export const DIRECT_SELL_UNITS = 90_000;

// ---------- addresses (verified against pump.fun's published global / event authority / fee config) ----------
const pdaCache = new Map();
const pda = (seeds, program) => {
  const k = `${program}|${seeds.map((s) => Buffer.from(s).toString('hex')).join('|')}`;
  if (!pdaCache.has(k)) pdaCache.set(k, findProgramAddress(seeds.map((s) => Buffer.from(s)), program));
  if (pdaCache.size > 5000) pdaCache.clear();
  return pdaCache.get(k);
};
export const globalPda = () => pda([Buffer.from('global')], PUMP_PROGRAM);
export const eventAuthorityPda = () => pda([Buffer.from('__event_authority')], PUMP_PROGRAM);
export const feeConfigPda = () => pda([Buffer.from('fee_config'), base58Decode(PUMP_PROGRAM)], PUMP_FEES_PROGRAM);
export const bondingCurveAddress = (mint) => pda([Buffer.from('bonding-curve'), base58Decode(mint)], PUMP_PROGRAM);
export const userVolumeAccumulatorPda = (user) => pda([Buffer.from('user_volume_accumulator'), base58Decode(user)], PUMP_PROGRAM);
export const ataAddress = (owner, mint, tokenProgram) => pda([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ATA_PROGRAM);

/** BondingCurve account (full current layout; older, shorter accounts are SOL-paired, non-cashback). */
export function decodeCurve(b64) {
  const b = Buffer.isBuffer(b64) ? b64 : Buffer.from(String(b64 || ''), 'base64');
  if (b.length < 81 || !b.subarray(0, 8).equals(DISC.bondingCurve)) return null;
  const u64 = (o) => b.readBigUInt64LE(o);
  const out = {
    virtualTokenReserves: u64(8),
    virtualQuoteReserves: u64(16),
    realTokenReserves: u64(24),
    realQuoteReserves: u64(32),
    tokenTotalSupply: u64(40),
    complete: b[48] === 1,
    creator: base58Encode(b.subarray(49, 81)),
    isMayhem: b.length > 81 ? b[81] === 1 : false,
    isCashback: b.length > 82 ? b[82] === 1 : false,
    quoteMint: b.length >= 115 ? base58Encode(b.subarray(83, 115)) : ZERO_KEY,
    layoutLen: b.length,
  };
  out.solPaired = out.quoteMint === ZERO_KEY || out.quoteMint === WSOL_MINT;
  return out;
}

/** Why this coin can't go direct (null = it can). */
export function directBlocker(curve) {
  if (!curve) return 'not a pump.fun curve coin';
  if (curve.complete) return 'coin left the curve (graduated)';
  if (!curve.solPaired) return 'curve is not priced in SOL';
  if (curve.isCashback) return 'cashback coin (v3 not supported)';
  if (curve.isMayhem) return 'mayhem coin';
  if (curve.virtualTokenReserves <= 0n || curve.virtualQuoteReserves <= 0n) return 'empty curve';
  return null;
}

// estimated total pump.fun fee for quoting only (the real fee is checked in the simulation)
export const EST_FEE_BPS = 125n;
/** Tokens out for a SOL budget (constant product on virtual reserves, after an estimated fee). */
export function quoteBuy(curve, lamportsIn) {
  const net = (BigInt(lamportsIn) * (10_000n - EST_FEE_BPS)) / 10_000n;
  return (curve.virtualTokenReserves * net) / (curve.virtualQuoteReserves + net);
}
/** SOL (lamports) out for selling tokens, after an estimated fee. */
export function quoteSell(curve, tokens) {
  const gross = (curve.virtualQuoteReserves * BigInt(tokens)) / (curve.virtualTokenReserves + BigInt(tokens));
  return (gross * (10_000n - EST_FEE_BPS)) / 10_000n;
}

// ---------- instructions ----------
const u64le = (v) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const u32le = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(v));
  return b;
};
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

export function computeBudgetIxs({ units = DIRECT_BUY_UNITS, microLamports = 100_000 } = {}) {
  return [
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([2]), u32le(units)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([3]), u64le(microLamports)]) },
  ];
}

export function systemTransferIx({ from, to, lamports }) {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [meta(from, true, true), meta(to, false, true)],
    data: Buffer.concat([u32le(2), u64le(lamports)]),
  };
}

/**
 * Resolve compute-unit price (microLamports) and optional Jito bundle tip (lamports) for a direct swap
 * from `settings.priorityFee` ({ mode: 'normal' | 'fast' | 'turbo' | 'custom', customSol }).
 */
export function resolveDirectPriority({
  priorityFee = null,
  side = 'buy',
  units = DIRECT_BUY_UNITS,
  hasJito = false,
  baseMicroLamports = 100_000,
  envTipLamports = null,
} = {}) {
  const floorMicro = Math.max(0, Math.round(Number(baseMicroLamports) || 0));
  const cu = Math.max(50_000, Number(units) || DIRECT_BUY_UNITS);
  const canTip = side === 'buy' && Boolean(hasJito);
  const explicitTip =
    envTipLamports !== null && envTipLamports !== undefined && envTipLamports !== '' && Number.isFinite(Number(envTipLamports))
      ? Math.max(0, Math.round(Number(envTipLamports)))
      : null;

  if (!priorityFee || typeof priorityFee !== 'object') {
    return {
      microLamports: floorMicro || 100_000,
      jitoTipLamports: canTip && explicitTip !== null ? explicitTip : 0,
    };
  }

  const mode = String(priorityFee.mode || 'normal').toLowerCase();
  let microLamports;
  let jitoTipLamports = 0;

  if (mode === 'turbo') {
    if (canTip) {
      microLamports = Math.max(floorMicro, 7_500_000); // ~0.00086 SOL on 115k CU
      jitoTipLamports = 1_500_000; // 0.0015 SOL Jito tip (atomic: 0 SOL paid if swap reverts)
    } else if (side === 'buy') {
      microLamports = Math.max(floorMicro, 15_000_000); // ~0.00173 SOL on 115k CU
    } else {
      microLamports = Math.max(floorMicro, 7_500_000); // ~0.00068 SOL on 90k CU sell
    }
  } else if (mode === 'fast') {
    if (canTip) {
      microLamports = Math.max(floorMicro, 3_500_000); // ~0.00040 SOL on 115k CU
      jitoTipLamports = 600_000; // 0.0006 SOL Jito tip
    } else if (side === 'buy') {
      microLamports = Math.max(floorMicro, Math.round((1_000_000 * 1_000_000) / cu)); // ~0.001 SOL
    } else {
      microLamports = Math.max(floorMicro, 4_000_000); // ~0.00036 SOL on 90k CU sell
    }
  } else if (mode === 'custom') {
    const customSol = Math.min(0.02, Math.max(0.0001, Number(priorityFee.customSol) || 0.002));
    const totalLamports = Math.round(customSol * 1_000_000_000);
    if (canTip && totalLamports >= 200_000) {
      const cuLamports = Math.round(totalLamports * 0.35);
      microLamports = Math.max(floorMicro, Math.round((cuLamports * 1_000_000) / cu));
      jitoTipLamports = totalLamports - cuLamports;
    } else if (side === 'buy') {
      microLamports = Math.max(floorMicro, Math.round((totalLamports * 1_000_000) / cu));
    } else {
      const sellLamports = Math.min(totalLamports, 1_500_000);
      microLamports = Math.max(floorMicro, Math.round((sellLamports * 1_000_000) / cu));
    }
  } else {
    // 'normal' (Market Auto ~0.0002 SOL)
    if (canTip) {
      microLamports = Math.max(floorMicro, 1_000_000); // ~0.000115 SOL
      jitoTipLamports = 100_000; // 0.0001 SOL
    } else {
      microLamports = Math.max(floorMicro, floorMicro > 0 ? floorMicro : 1_000_000);
    }
  }

  if (explicitTip !== null) {
    jitoTipLamports = canTip ? explicitTip : 0;
  }
  if (jitoTipLamports > 0 && jitoTipLamports < 1_000) {
    jitoTipLamports = 0;
  }
  return { microLamports, jitoTipLamports };
}

export function createAtaIdempotentIx({ payer, owner, mint, tokenProgram }) {
  return {
    programId: ATA_PROGRAM,
    keys: [meta(payer, true, true), meta(ataAddress(owner, mint, tokenProgram), false, true), meta(owner, false, false), meta(mint, false, false), meta(SYSTEM_PROGRAM, false, false), meta(tokenProgram, false, false)],
    data: Buffer.from([1]),
  };
}

/** The 17 v3 accounts, in IDL order (same for buys and sells). */
export function v3Accounts({ user, mint, baseTokenProgram, buybackFeeRecipient = BUYBACK_FEE_RECIPIENTS[0] }) {
  const curve = bondingCurveAddress(mint);
  return [
    meta(globalPda(), false, false),
    meta(mint, false, false),
    meta(WSOL_MINT, false, false), // quote mint: wrapped SOL for SOL-paired coins
    meta(baseTokenProgram, false, false),
    meta(TOKEN_PROGRAM, false, false), // quote token program (SPL Token for wrapped SOL)
    meta(curve, false, true),
    meta(ataAddress(curve, mint, baseTokenProgram), false, true),
    meta(ataAddress(curve, WSOL_MINT, TOKEN_PROGRAM), false, true), // derived; unused for SOL pairs
    meta(user, true, true),
    meta(ataAddress(user, mint, baseTokenProgram), false, true),
    meta(ataAddress(user, WSOL_MINT, TOKEN_PROGRAM), false, true), // derived; unused for SOL pairs
    meta(userVolumeAccumulatorPda(user), false, true),
    meta(feeConfigPda(), false, false),
    meta(buybackFeeRecipient, false, true),
    meta(SYSTEM_PROGRAM, false, false),
    meta(eventAuthorityPda(), false, false),
    meta(PUMP_PROGRAM, false, false),
  ];
}

export function buyExactQuoteInIx({ user, mint, baseTokenProgram, lamportsIn, minTokensOut, buybackFeeRecipient }) {
  return { programId: PUMP_PROGRAM, keys: v3Accounts({ user, mint, baseTokenProgram, buybackFeeRecipient }), data: Buffer.concat([DISC.buyExactQuoteInV3, u64le(lamportsIn), u64le(minTokensOut)]) };
}
export function sellIx({ user, mint, baseTokenProgram, amount, minSolOutput, buybackFeeRecipient }) {
  return { programId: PUMP_PROGRAM, keys: v3Accounts({ user, mint, baseTokenProgram, buybackFeeRecipient }), data: Buffer.concat([DISC.sellV3, u64le(amount), u64le(minSolOutput)]) };
}

// ---------- legacy message ----------
function compactU16(n) {
  const out = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) break;
  }
  return Buffer.from(out);
}

/** Compile instructions into a legacy message (payer first; signers, writables, then read-only). */
export function compileMessage({ payer, instructions, recentBlockhash }) {
  const acc = new Map(); // pubkey → { signer, writable }
  const add = (k, s, w) => {
    const c = acc.get(k) || { signer: false, writable: false };
    acc.set(k, { signer: c.signer || s, writable: c.writable || w });
  };
  add(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(ix.programId, false, false);
  }
  const all = [...acc.entries()];
  const group = (s, w) => all.filter(([k, v]) => v.signer === s && v.writable === w).map(([k]) => k);
  const signW = [payer, ...group(true, true).filter((k) => k !== payer)];
  const signR = group(true, false);
  const plainW = group(false, true);
  const plainR = group(false, false);
  const keys = [...signW, ...signR, ...plainW, ...plainR];
  const index = new Map(keys.map((k, i) => [k, i]));
  const header = Buffer.from([signW.length + signR.length, signR.length, plainR.length]);
  const keyBytes = Buffer.concat([compactU16(keys.length), ...keys.map((k) => {
    const b = Buffer.from(base58Decode(k));
    if (b.length !== 32) throw new Error(`bad public key ${k}`);
    return b;
  })]);
  const bh = Buffer.from(base58Decode(recentBlockhash));
  if (bh.length !== 32) throw new Error('bad blockhash');
  const ixBytes = instructions.map((ix) => Buffer.concat([
    Buffer.from([index.get(ix.programId)]),
    compactU16(ix.keys.length),
    Buffer.from(ix.keys.map((k) => index.get(k.pubkey))),
    compactU16(ix.data.length),
    ix.data,
  ]));
  const message = Buffer.concat([header, keyBytes, bh, compactU16(instructions.length), ...ixBytes]);
  return { message, keys, numSigners: signW.length + signR.length };
}

export function signLegacy(message, keypair) {
  const sig = Buffer.from(keypair.sign(message));
  if (sig.length !== 64) throw new Error('bad signature');
  const tx = Buffer.concat([compactU16(1), sig, message]);
  if (tx.length > 1232) throw new Error(`transaction too large (${tx.length} bytes)`);
  return { base64: tx.toString('base64'), signature: base58Encode(sig) };
}

/** Custom program error code from a simulation / status error, if any. */
export function customErrorCode(err) {
  const ie = err?.InstructionError;
  const c = Array.isArray(ie) ? ie[1]?.Custom : null;
  return Number.isInteger(c) ? c : null;
}
/** Token account amount from base64 account data (bytes 64–72). */
export function tokenAccountAmount(b64) {
  const b = Buffer.from(String(b64 || ''), 'base64');
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
}
