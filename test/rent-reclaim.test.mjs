// Rent reclaim: closing empty token accounts of the bot wallet (offline, mock RPC).
// Run: node --test test/rent-reclaim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildCloseAccountsMessage, signMessageBase64, findClosableAccounts, reclaimRent, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../engine/rentReclaim.mjs';
import { loadKeypair } from '../engine/realTrader.mjs';
import { base58Encode, base58Decode } from '../engine/onchainMeta.mjs';

function newKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { kp: loadKeypair(base58Encode(Buffer.concat([seed, pub]))), pub: Buffer.from(pub) };
}
const rnd = () => base58Encode(crypto.randomBytes(32));

test('RR1 the close transaction: legacy layout, owner signs, accounts writable, programs read-only, close = instruction 9', () => {
  const { kp, pub } = newKeypair();
  const a1 = rnd();
  const a2 = rnd();
  const bh = rnd();
  const { message, keys } = buildCloseAccountsMessage({ owner: kp.publicKey, accounts: [{ pubkey: a1, programId: TOKEN_PROGRAM }, { pubkey: a2, programId: TOKEN_2022_PROGRAM }], recentBlockhash: bh });
  assert.deepEqual([...message.subarray(0, 3)], [1, 0, 2], '1 signer, 0 read-only signers, 2 read-only programs');
  assert.equal(message[3], 5, 'owner + 2 accounts + 2 programs');
  assert.deepEqual(keys, [kp.publicKey, a1, a2, TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
  assert.ok(message.subarray(4, 36).equals(pub), 'owner first (fee payer + rent receiver)');
  const off = 4 + 5 * 32;
  assert.equal(base58Encode(message.subarray(off, off + 32)), bh);
  const ix = message.subarray(off + 32);
  assert.equal(ix[0], 2, 'two instructions');
  // ix 1: program index 3 (Token), 3 accounts [1, 0, 0], data [9]
  assert.deepEqual([...ix.subarray(1, 8)], [3, 3, 1, 0, 0, 1, 9]);
  assert.deepEqual([...ix.subarray(8, 15)], [4, 3, 2, 0, 0, 1, 9]);
  const signed = signMessageBase64(message, kp);
  const tx = Buffer.from(signed.base64, 'base64');
  assert.equal(tx[0], 1, 'one signature');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, tx.subarray(65), key, tx.subarray(1, 65)), 'valid signature over the message');
  assert.equal(base58Decode(signed.signature).length, 64);
  assert.ok(tx.length < 1232);
});

test('RR2 only empty, unfrozen, own accounts are picked; SOL, USDC, open coins and other close authorities are never touched', async () => {
  const { kp } = newKeypair();
  const me = kp.publicKey;
  const acc = (mint, amount, extra = {}, lamports = 2039280) => ({ pubkey: rnd(), account: { owner: TOKEN_PROGRAM, lamports, data: { parsed: { info: { mint, owner: me, state: 'initialized', tokenAmount: { amount: String(amount), decimals: 6 }, ...extra } } } } });
  const OPEN = 'Open1111111111111111111111111111111111pump';
  const list = [
    acc('Empty111111111111111111111111111111111pump', 0),
    acc('Full1111111111111111111111111111111111pump', 5),
    acc('So11111111111111111111111111111111111111112', 0),
    acc('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 0),
    acc(OPEN, 0),
    acc('Frzn1111111111111111111111111111111111pump', 0, { state: 'frozen' }),
    acc('Auth1111111111111111111111111111111111pump', 0, { closeAuthority: rnd() }),
    { ...acc('NotMine11111111111111111111111111111111pump', 0), account: { owner: TOKEN_PROGRAM, lamports: 1, data: { parsed: { info: { mint: 'x', owner: rnd(), tokenAmount: { amount: '0' } } } } } },
  ];
  const rpc = async (m, p) => (m === 'getTokenAccountsByOwner' ? { value: p[1].programId === TOKEN_PROGRAM ? list : [] } : null);
  const out = await findClosableAccounts(rpc, me, { skipMints: new Set([OPEN]) });
  assert.deepEqual(out.map((x) => x.mint), ['Empty111111111111111111111111111111111pump']);
  assert.equal(out[0].lamports, 2039280);
});

test('RR3 simulate first; a batch with one bad account is retried one by one; dry run sends nothing; fee taken off', async () => {
  const { kp } = newKeypair();
  const me = kp.publicKey;
  const accounts = Array.from({ length: 4 }, (_, i) => ({ pubkey: rnd(), account: { owner: TOKEN_2022_PROGRAM, lamports: 2074080, data: { parsed: { info: { mint: `Mint${i}`.padEnd(44, '1'), owner: me, state: 'initialized', tokenAmount: { amount: '0' } } } } } }));
  const bad = accounts[2].pubkey;
  const sent = [];
  const rpc = async (m, p) => {
    if (m === 'getTokenAccountsByOwner') return { value: p[1].programId === TOKEN_2022_PROGRAM ? accounts : [] };
    if (m === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
    if (m === 'simulateTransaction') {
      const tx = Buffer.from(p[0], 'base64');
      const hasBad = tx.includes(Buffer.from(base58Decode(bad)));
      return { value: { err: hasBad ? { InstructionError: [0, { Custom: 35 }] } : null } };
    }
    if (m === 'sendTransaction') {
      sent.push(p[0]);
      return base58Encode(crypto.randomBytes(64));
    }
    throw new Error(`unexpected ${m}`);
  };
  const dry = await reclaimRent({ rpc, keypair: kp, owner: me, dryRun: true });
  assert.equal(dry.found, 4);
  assert.ok(Math.abs(dry.foundSol - 4 * 0.00207408) < 1e-9);
  assert.equal(sent.length, 0, 'dry run sends nothing');
  const r = await reclaimRent({ rpc, keypair: kp, owner: me, waitForSignature: async () => 'success' });
  assert.equal(r.closed, 3);
  assert.equal(r.failed, 1);
  assert.equal(sent.length, 3, 'batch failed simulation → the 3 good ones sent one by one, the bad one never sent');
  assert.ok(Math.abs(r.reclaimedSol - (3 * 0.00207408 - 3 * 0.000005)) < 1e-9);
  assert.match(r.errors[0], /simulation/);
});

test('RR4 an unconfirmed send is not counted as reclaimed', async () => {
  const { kp } = newKeypair();
  const me = kp.publicKey;
  const accounts = [{ pubkey: rnd(), account: { owner: TOKEN_PROGRAM, lamports: 2039280, data: { parsed: { info: { mint: 'A'.repeat(44), owner: me, state: 'initialized', tokenAmount: { amount: '0' } } } } } }];
  const rpc = async (m, p) => {
    if (m === 'getTokenAccountsByOwner') return { value: p[1].programId === TOKEN_PROGRAM ? accounts : [] };
    if (m === 'getLatestBlockhash') return { value: { blockhash: base58Encode(crypto.randomBytes(32)) } };
    if (m === 'simulateTransaction') return { value: { err: null } };
    if (m === 'sendTransaction') return base58Encode(crypto.randomBytes(64));
  };
  const r = await reclaimRent({ rpc, keypair: kp, owner: me, waitForSignature: async () => 'unknown' });
  assert.equal(r.closed, 0);
  assert.equal(r.reclaimedSol, 0);
  assert.match(r.errors[0], /not confirmed/);
});

test('RR5 creditReclaimedRent and backfillScorecardLog fold reclaimed rent into the closed real position row', async () => {
  const { CopyTradingEngine } = await import('../engine/copyEngine.mjs');
  const e = new CopyTradingEngine();
  e.positions.push({
    id: 'pos-1',
    isPaper: false,
    chainId: 'solana',
    tokenAddress: 'Mint1pump',
    symbol: 'ASCEND',
    initialCostUsd: 6.0907,
    investedSol: 0.066046,
    soldUsd: 6.1674,
    soldSol: 0.066877,
    realizedPnlUsd: 0.0767,
    entrySolPriceUsd: 92.22,
    remainingTokens: 0,
    openedAt: 1000,
    closedAt: 2000,
  });
  e.realizedLog.push({ t: 2000, pid: 'pos-1', pnl: 0.08, posPnl: 0.08, sol: 0.000867, sym: 'ASCEND', paper: false, closes: true });
  e.creditReclaimedRent({ byMint: [{ mint: 'Mint1pump', sol: 0.001509 }], reclaimedSol: 0.001509, px: 92.22, at: 32000 });
  const c = e.getStateSnapshot().closedPositions.find((p) => p.id === 'pos-1');
  assert.equal(c.pnlSol, 0.0023);
  assert.equal(c.pnlUsd, 0.22);
  assert.equal(e.realizedLog.length, 1);
  assert.equal(e.realizedLog[0].sol, 0.002376);
});
