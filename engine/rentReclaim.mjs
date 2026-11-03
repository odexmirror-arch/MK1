/**
 * Rent reclaim — gets back the SOL locked in EMPTY token accounts of the bot wallet.
 *
 * Every new coin the bot buys opens a token account (≈0.00204 SOL rent, more for Token-2022).
 * Jupiter doesn't close it after a full sell, so that SOL stays locked: about 2% of a $10 copy.
 * Closing an empty account returns all of its lamports to the wallet.
 *
 * Safety:
 *  - only accounts holding exactly 0 tokens, owned by the bot wallet, for mints that are not
 *    open, not being bought and not SOL/USDC are touched
 *  - every transaction is simulated on Solana first and only sent if the simulation passes
 *    (an account that can't be closed — e.g. withheld Token-2022 fees — is skipped)
 *  - the close instruction only works on empty accounts, so no tokens can ever be lost
 *
 * Zero dependencies: the transaction is built and signed here (legacy message format).
 */
import { base58Decode, base58Encode } from './onchainMeta.mjs';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CLOSE_ACCOUNT = 9; // SPL Token / Token-2022 instruction index
const MAX_PER_TX = 18; // keeps the transaction well under Solana's 1232-byte limit
const LAMPORTS = 1e9;

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

/**
 * Legacy transaction closing `accounts` ([{ pubkey, programId }]) into `owner`.
 * Returns { message: Buffer, keys: string[] } — sign `message` with the owner's key.
 */
export function buildCloseAccountsMessage({ owner, accounts, recentBlockhash }) {
  if (!accounts.length) throw new Error('nothing to close');
  const programs = [...new Set(accounts.map((a) => a.programId))];
  // order: signer+writable (owner), writable non-signers (the token accounts), readonly (programs)
  const keys = [owner, ...accounts.map((a) => a.pubkey), ...programs];
  const index = new Map(keys.map((k, i) => [k, i]));
  const header = Buffer.from([1, 0, programs.length]);
  const keyBytes = Buffer.concat([compactU16(keys.length), ...keys.map((k) => {
    const b = Buffer.from(base58Decode(k));
    if (b.length !== 32) throw new Error(`bad public key ${k}`);
    return b;
  })]);
  const bh = Buffer.from(base58Decode(recentBlockhash));
  if (bh.length !== 32) throw new Error('bad blockhash');
  const ixs = accounts.map((a) => Buffer.concat([
    Buffer.from([index.get(a.programId)]),
    compactU16(3),
    Buffer.from([index.get(a.pubkey), 0, 0]), // account, destination = owner, authority = owner
    compactU16(1),
    Buffer.from([CLOSE_ACCOUNT]),
  ]));
  const message = Buffer.concat([header, keyBytes, bh, compactU16(ixs.length), ...ixs]);
  return { message, keys };
}

/** Signed transaction (base64) from a message and the owner's keypair ({ sign(msg) → 64 bytes }). */
export function signMessageBase64(message, keypair) {
  const sig = Buffer.from(keypair.sign(message));
  if (sig.length !== 64) throw new Error('bad signature');
  return { base64: Buffer.concat([compactU16(1), sig, message]).toString('base64'), signature: base58Encode(sig) };
}

/** The bot wallet's empty token accounts that are safe to close. */
export async function findClosableAccounts(rpc, owner, { skipMints = new Set() } = {}) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    let r;
    try {
      r = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    } catch {
      continue;
    }
    for (const acc of r?.value || []) {
      const info = acc?.account?.data?.parsed?.info;
      if (!info || info.owner !== owner) continue;
      if (String(info.tokenAmount?.amount) !== '0') continue; // never touch an account with tokens
      if (info.state && info.state !== 'initialized') continue; // frozen accounts can't be closed
      if (info.mint === WSOL_MINT || info.mint === USDC_MINT || skipMints.has(info.mint)) continue;
      if (info.closeAuthority && info.closeAuthority !== owner) continue;
      out.push({ pubkey: acc.pubkey, programId: acc.account.owner || programId, mint: info.mint, lamports: Number(acc.account.lamports) || 0 });
    }
  }
  return out;
}

/**
 * Close the empty accounts. Each batch is simulated first; a batch that fails simulation is
 * retried one account at a time so a single unclosable account never blocks the rest.
 * Returns { closed, reclaimedSol, failed, signatures, skipped }.
 */
export async function reclaimRent({ rpc, keypair, owner, skipMints, dryRun = false, maxAccounts = 60, waitForSignature = null }) {
  const found = (await findClosableAccounts(rpc, owner, { skipMints })).slice(0, maxAccounts);
  const result = { found: found.length, foundSol: found.reduce((a, x) => a + x.lamports, 0) / LAMPORTS, closed: 0, reclaimedSol: 0, failed: 0, signatures: [], byMint: [], errors: [] };
  if (dryRun || !found.length) return result;
  const trySend = async (batch) => {
    const bh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = bh?.value?.blockhash || bh?.blockhash;
    const { message } = buildCloseAccountsMessage({ owner, accounts: batch, recentBlockhash: blockhash });
    const signed = signMessageBase64(message, keypair);
    const sim = await rpc('simulateTransaction', [signed.base64, { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
    if (sim?.value?.err) return { ok: false, error: `simulation: ${JSON.stringify(sim.value.err).slice(0, 120)}` };
    const sig = await rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
    const status = waitForSignature ? await waitForSignature(sig || signed.signature, 30_000) : 'success';
    return status === 'success' ? { ok: true, signature: sig || signed.signature } : { ok: false, error: `not confirmed (${status})`, signature: sig || signed.signature };
  };
  const done = (batch, r) => {
    if (r.ok) {
      result.closed += batch.length;
      result.reclaimedSol += batch.reduce((a, x) => a + x.lamports, 0) / LAMPORTS;
      result.signatures.push(r.signature);
      const feeShare = batch.length > 0 ? 0.000005 / batch.length : 0;
      for (const x of batch) {
        result.byMint.push({ mint: x.mint, sol: Math.max(0, x.lamports / LAMPORTS - feeShare) });
      }
    } else {
      result.failed += batch.length;
      if (result.errors.length < 5) result.errors.push(r.error);
    }
  };
  for (let i = 0; i < found.length; i += MAX_PER_TX) {
    const batch = found.slice(i, i + MAX_PER_TX);
    let r;
    try {
      r = await trySend(batch);
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (r.ok || batch.length === 1 || !String(r.error).startsWith('simulation')) {
      done(batch, r);
      continue;
    }
    // one bad account in the batch: close the others one by one
    for (const one of batch) {
      let r1;
      try {
        r1 = await trySend([one]);
      } catch (err) {
        r1 = { ok: false, error: err.message };
      }
      done([one], r1);
    }
  }
  // the 5000-lamport fee per transaction is paid from the reclaimed SOL
  result.feeSol = result.signatures.length * 0.000005;
  result.reclaimedSol = Math.max(0, result.reclaimedSol - result.feeSol);
  return result;
}
