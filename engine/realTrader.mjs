/**
 * Real Solana trading — zero dependencies.
 *
 * Signs Jupiter Swap API v2 orders with the bot wallet's private key (Ed25519 via node:crypto)
 * and reports exact on-chain fills back to the copy engine. Used only when Paper Trading is OFF
 * and ODEX_TRADER_KEY is set in .env.
 *
 * Safety:
 *   - per-trade and rolling 24 h buy caps (in SOL), a SOL reserve kept for fees
 *   - the private key never leaves this module (never logged, saved or sent to the browser)
 *   - a swap whose result is unknown (timeout) is looked up on-chain before anything is recorded
 */
import crypto from 'node:crypto';
import { base58Decode, base58Encode, isOnCurve } from './onchainMeta.mjs';
import { reclaimRent as reclaimRentRun } from './rentReclaim.mjs';
import * as PD from './pumpDirect.mjs';
const PRICE_CODES = PD.PRICE_ERRORS;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LAMPORTS = 1_000_000_000;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DAY_MS = 86_400_000;

/**
 * Convert dashboard Priority Fee setting ({ mode: 'normal'|'fast'|'turbo'|'custom', customSol })
 * into compute-unit price (microLamports per CU) for a given CU limit, with safe ceiling clamping.
 * When `tradeSol` is provided on 'fast' or 'turbo' presets, caps priority spend proportionally on
 * small swaps (e.g. ~0.00025–0.00035 SOL on an $8 / ~0.083 SOL trade) so priority fees never eat TP.
 */
export function priorityMicroLamportsFor(priorityFee, cuUnits = 100_000, envOverride = null, { tradeSol = null } = {}) {
  if (envOverride !== null && envOverride !== undefined && String(envOverride).trim() !== '') {
    const ov = Number(envOverride);
    if (Number.isFinite(ov) && ov > 0) return Math.floor(ov);
  }
  if (!priorityFee || !priorityFee.mode) return 100_000;
  let targetSol = 0.0002;
  if (priorityFee.mode === 'fast') targetSol = 0.001;
  else if (priorityFee.mode === 'turbo') targetSol = 0.005;
  else if (priorityFee.mode === 'custom') {
    const c = Number(priorityFee.customSol);
    targetSol = Number.isFinite(c) && c > 0 ? Math.min(0.01, Math.max(0.00005, c)) : 0.002;
  }
  const sz = Number(tradeSol);
  if (Number.isFinite(sz) && sz > 0 && (priorityFee.mode === 'fast' || priorityFee.mode === 'turbo')) {
    const sizeCap = priorityFee.mode === 'turbo' ? Math.max(0.00035, sz * 0.004) : Math.max(0.00025, sz * 0.003);
    targetSol = Math.min(targetSol, sizeCap);
  }
  const units = Math.max(20_000, Number(cuUnits) || 100_000);
  const micro = Math.round((targetSol * LAMPORTS * 1_000_000) / units);
  return Math.min(150_000_000, Math.max(100_000, micro));
}

/**
 * Atomic Jito bundle tip (lamports) for direct pump.fun buys when Jito Block Engine is active.
 * Transferred via SystemProgram.transfer inside the swap tx (+ `?bundleOnly=true`), so if a swap
 * reverts (e.g. 6042 price ceiling) the tip rolls back to 0 SOL.
 */
export function jitoTipLamportsFor(priorityFee, { side = 'buy', tradeSol = null, hasJito = false, envTipLamports = null } = {}) {
  if (side !== 'buy' || !hasJito) return 0;
  if (envTipLamports !== null && envTipLamports !== undefined && String(envTipLamports).trim() !== '') {
    const ov = Number(envTipLamports);
    if (Number.isFinite(ov)) {
      const n = Math.max(0, Math.floor(ov));
      return n >= 1_000 ? n : 0;
    }
  }
  if (!priorityFee || !priorityFee.mode) return 0;
  const mode = String(priorityFee.mode).toLowerCase();
  const sz = Number(tradeSol);
  const hasSz = Number.isFinite(sz) && sz > 0;
  let tip = 100_000; // 0.0001 SOL on normal
  if (mode === 'turbo') {
    tip = hasSz ? Math.min(1_500_000, Math.max(250_000, Math.round(sz * 2_500_000))) : 1_500_000;
  } else if (mode === 'fast') {
    tip = hasSz ? Math.min(600_000, Math.max(150_000, Math.round(sz * 1_500_000))) : 600_000;
  } else if (mode === 'custom') {
    const c = Number(priorityFee.customSol);
    const customSol = Number.isFinite(c) && c > 0 ? Math.min(0.01, Math.max(0.0001, c)) : 0.002;
    tip = Math.round(customSol * 0.6 * LAMPORTS);
  }
  return tip >= 1_000 ? tip : 0;
}

// ---------- keys & signing ----------

/** Accepts a base58 secret key (64-byte Phantom/Solflare export or 32-byte seed) or a JSON byte array. */
export function loadKeypair(secret) {
  const s = String(secret || '').trim();
  if (!s) throw new Error('no key');
  let bytes;
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error('key JSON must be an array of numbers');
    bytes = Uint8Array.from(arr);
  } else {
    bytes = base58Decode(s);
  }
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error(`key must be 64 or 32 bytes (got ${bytes.length})`);
  const seed = Buffer.from(bytes.subarray(0, 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (bytes.length === 64 && !Buffer.from(bytes.subarray(32)).equals(pub)) {
    throw new Error('key is damaged: its public half does not match the private half');
  }
  const publicKey = base58Encode(pub);
  return Object.freeze({
    publicKey,
    publicKeyBytes: Buffer.from(pub),
    sign: (msg) => crypto.sign(null, msg, privateKey),
    verify: (msg, sig) => crypto.verify(null, msg, crypto.createPublicKey(privateKey), sig),
  });
}

function readCompactU16(buf, off) {
  let len = 0;
  let size = 0;
  for (;;) {
    if (off + size >= buf.length || size > 2) throw new Error('bad transaction (length field)');
    const b = buf[off + size];
    len |= (b & 0x7f) << (7 * size);
    size += 1;
    if ((b & 0x80) === 0) break;
  }
  return [len, size];
}

/**
 * Sign a serialized legacy / v0 transaction (base64) in our signer slot. Other signer slots
 * (e.g. a market maker's) are left untouched. Returns { signedBase64, signature }.
 */
export function signTransactionBase64(b64, keypair) {
  const tx = Buffer.from(String(b64), 'base64');
  const [numSigs, sigLenSize] = readCompactU16(tx, 0);
  const msgOff = sigLenSize + 64 * numSigs;
  if (numSigs < 1 || msgOff >= tx.length) throw new Error('bad transaction (no signature slots)');
  const msg = tx.subarray(msgOff);
  let o = 0;
  if (msg[0] & 0x80) {
    const version = msg[0] & 0x7f;
    if (version !== 0) throw new Error(`transaction version ${version} is not supported`);
    o = 1;
  }
  const numRequired = msg[o];
  o += 3;
  const [numKeys, keysLenSize] = readCompactU16(msg, o);
  o += keysLenSize;
  let slot = -1;
  for (let i = 0; i < Math.min(numRequired, numKeys, numSigs); i++) {
    if (msg.subarray(o + 32 * i, o + 32 * i + 32).equals(keypair.publicKeyBytes)) {
      slot = i;
      break;
    }
  }
  if (slot < 0) throw new Error('this transaction is not for the bot wallet (signer not found)');
  const sig = keypair.sign(msg);
  sig.copy(tx, sigLenSize + 64 * slot);
  // the transaction id is the first signature (the fee payer's)
  const firstSig = slot === 0 ? sig : tx.subarray(sigLenSize, sigLenSize + 64);
  return { signedBase64: tx.toString('base64'), signature: base58Encode(firstSig), slot };
}

// ---------- the trader ----------

export class RealTrader {
  /**
   * @param env       process.env (ODEX_TRADER_KEY, JUPITER_API_KEY, caps)
   * @param rpc       (method, params) => result   Solana JSON-RPC
   * @param solPrice  () => SOL price in USD
   * @param state     saved state (spend log, trade log) from the database
   * @param onChange  called after every trade so the state can be saved
   */
  constructor({ env = process.env, rpc, solPrice, fetchImpl = (...a) => fetch(...a), state = null, onChange = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), fastRpcUrls = [], confirmWsUrl = null, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.rpc = rpc;
    this.solPrice = solPrice;
    this.fetch = fetchImpl;
    this.onChange = onChange;
    this.sleep = sleep;
    this.now = now;
    this.fastRpcUrls = Array.isArray(fastRpcUrls) ? [...new Set(fastRpcUrls.filter(Boolean))] : [];
    this.confirmWsUrl = confirmWsUrl ? String(confirmWsUrl).trim() : null;
    this.WebSocketImpl = WebSocketImpl || null;
    this.confirmWs = null;
    this.confirmWsTimer = null;
    this.confirmWsWanted = false;
    this.confirmWsId = 1;
    this.confirmWsPendingId = new Map();
    this.confirmWsSubToSig = new Map();
    this.confirmWsSigToSub = new Map();
    this.sigWaiters = new Map();
    this.resolvedSigs = new Map();
    this.ownTxCache = new Map();
    this.jupBase = (env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2').replace(/\/+$/, '');
    this.jupKey = env.JUPITER_API_KEY || '';
    const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    // Limits from .env / Railway variables; the per-buy and daily SOL limits can be changed from
    // the dashboard (capsOverride, saved with the settings), which then wins over the variable
    this.envCaps = {
      maxSolPerTrade: num(env.ODEX_REAL_MAX_SOL_PER_TRADE, 0.5),
      maxSolPerDay: num(env.ODEX_REAL_MAX_SOL_PER_DAY, 2), // 0 = no daily cap
      reserveSol: num(env.ODEX_REAL_RESERVE_SOL, 0.02), // kept for fees + token-account rent
      sellRetrySec: num(env.ODEX_REAL_SELL_RETRY_SEC, 3), // exits retry fast: a falling coin can't wait
    };
    this.capsOverride = () => null;
    const self = this;
    const pick = (k) => {
      const o = self.capsOverride?.();
      const v = o && o[k] !== null && o[k] !== undefined && o[k] !== '' ? Number(o[k]) : NaN;
      return Number.isFinite(v) && v >= 0 ? v : self.envCaps[k];
    };
    this.caps = {
      get maxSolPerTrade() {
        return pick('maxSolPerTrade');
      },
      set maxSolPerTrade(v) {
        self.envCaps.maxSolPerTrade = Number(v);
      },
      get maxSolPerDay() {
        return pick('maxSolPerDay');
      },
      set maxSolPerDay(v) {
        self.envCaps.maxSolPerDay = Number(v);
      },
      get reserveSol() {
        return self.envCaps.reserveSol;
      },
      set reserveSol(v) {
        self.envCaps.reserveSol = Number(v);
      },
      get sellRetrySec() {
        return self.envCaps.sellRetrySec;
      },
      set sellRetrySec(v) {
        self.envCaps.sellRetrySec = Number(v);
      },
    };
    this.keypair = null;
    this.keyError = null;
    const secret = env.ODEX_TRADER_KEY || '';
    if (secret) {
      try {
        this.keypair = loadKeypair(secret);
      } catch (err) {
        this.keyError = `ODEX_TRADER_KEY: ${err.message}`;
      }
    }
    this.decimals = new Map([[WSOL_MINT, 9], [USDC_MINT, 6]]);
    this.spendLog = Array.isArray(state?.spendLog) ? state.spendLog : []; // [{ t, sol }]
    this.trades = Array.isArray(state?.trades) ? state.trades : []; // newest first
    this.lastError = null;
    this.balance = null; // { sol, usdc, at }
    this.sellBlockedUntil = new Map(); // mint -> time (back-off after a failed sell)
    this.pendingBuySol = 0; // SOL of buys signed/sending but not finished yet
    this.prefetchedBalance = null; // { at, promise }: balance read while Jupiter quotes a buy
    this.lastBuyDoneAt = 0; // a balance read before this moment may still hold a finished buy's SOL
    // Swap route (Settings): 'jupiter' (default) or 'direct' (pump.fun curve coins, Jupiter fallback)
    this.routeSetting = () => 'jupiter';
    this.priorityMicroLamports = () => 100_000;
    this.jitoTipLamports = () => 0;
    this.directStats = { direct: 0, fallbacks: 0, priceSkips: 0, lastFallback: null, lastFallbackAt: null, lastDirectAt: null };
    this.blockhashCache = null; // { hash, at }
  }

  hasJitoEndpoint() {
    return Array.isArray(this.fastRpcUrls) && this.fastRpcUrls.some((u) => /jito\.wtf/i.test(String(u)));
  }

  get address() {
    return this.keypair?.publicKey || null;
  }

  ready() {
    return Boolean(this.keypair) && typeof this.rpc === 'function';
  }

  exportState() {
    return { spendLog: this.spendLog.slice(-500), trades: this.trades.slice(0, 300) };
  }

  spent24hSol() {
    const cutoff = this.now() - DAY_MS;
    this.spendLog = this.spendLog.filter((x) => x.t >= cutoff);
    return this.spendLog.reduce((a, x) => a + x.sol, 0);
  }

  /** USD a real buy may use right now under the per-trade and 24 h caps (NaN if SOL price unknown). */
  buyRoomUsd() {
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) return NaN;
    const perTrade = this.caps.maxSolPerTrade > 0 ? this.caps.maxSolPerTrade : Infinity;
    const daily = this.caps.maxSolPerDay > 0 ? Math.max(0, this.caps.maxSolPerDay - this.spent24hSol() - this.pendingBuySol) : Infinity;
    const sol = Math.min(perTrade, daily);
    return Number.isFinite(sol) ? sol * px * 0.999 : Infinity;
  }

  status() {
    return {
      configured: Boolean(this.keypair),
      ready: this.ready(),
      address: this.address,
      keyError: this.keyError,
      jupiterKey: Boolean(this.jupKey),
      swapRoute: this.routeSetting(),
      directStats: { ...this.directStats },
      caps: { maxSolPerTrade: this.caps.maxSolPerTrade, maxSolPerDay: this.caps.maxSolPerDay, reserveSol: this.caps.reserveSol, sellRetrySec: this.caps.sellRetrySec },
      envCaps: { maxSolPerTrade: this.envCaps.maxSolPerTrade, maxSolPerDay: this.envCaps.maxSolPerDay },
      spent24hSol: Number(this.spent24hSol().toFixed(6)),
      balance: this.balance,
      lastError: this.lastError,
      lastTrade: this.trades[0] || null,
      trades: this.trades.slice(0, 20),
    };
  }

  // ---------- chain reads ----------

  async getDecimals(mint) {
    if (this.decimals.has(mint)) return this.decimals.get(mint);
    const r = await this.rpc('getTokenSupply', [mint]);
    const d = Number(r?.value?.decimals);
    if (!Number.isInteger(d)) throw new Error('could not read token decimals');
    this.decimals.set(mint, d);
    return d;
  }

  /** Raw (integer) token balance of the bot wallet for one mint, across all its token accounts. */
  async getTokenBalanceRaw(mint) {
    const sum = (r, onlyMint) => {
      let raw = 0n;
      for (const acc of r?.value || []) {
        const info = acc?.account?.data?.parsed?.info;
        if (onlyMint && info?.mint !== mint) continue;
        const amt = info?.tokenAmount;
        if (amt?.amount) raw += BigInt(amt.amount);
        if (Number.isInteger(amt?.decimals)) this.decimals.set(mint, amt.decimals);
      }
      return raw;
    };
    const r = await this.rpc('getTokenAccountsByOwner', [this.address, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const raw = sum(r, false);
    if (raw > 0n || mint === USDC_MINT) return raw;
    // Nothing found by mint: also look through every token account of both token programs.
    // Newer pump.fun coins are Token-2022 tokens and some RPC providers miss them in the
    // mint-filtered lookup — that made held tokens look "gone" and blocked their sells.
    let total = 0n;
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      try {
        const all = await this.rpc('getTokenAccountsByOwner', [this.address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        total += sum(all, true);
      } catch {
        // try the other program
      }
    }
    return total;
  }

  async refreshBalance({ solOnly = false } = {}) {
    if (!this.ready()) return null;
    if (solOnly) {
      const solR = await this.rpc('getBalance', [this.address, { commitment: 'confirmed' }]);
      this.balance = { sol: Number(solR?.value ?? solR ?? 0) / LAMPORTS, usdc: this.balance?.usdc ?? 0, at: this.now() };
      return this.balance;
    }
    const [solR, usdcRaw] = await Promise.all([this.rpc('getBalance', [this.address, { commitment: 'confirmed' }]), this.getTokenBalanceRaw(USDC_MINT).catch(() => 0n)]);
    this.balance = { sol: Number(solR?.value ?? solR ?? 0) / LAMPORTS, usdc: Number(usdcRaw) / 1e6, at: this.now() };
    return this.balance;
  }

  // ---------- Jupiter ----------

  async jup(pathname, { method = 'GET', query = null, body = null, timeoutMs = 15_000 } = {}) {
    const url = new URL(`${this.jupBase}${pathname}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.jupKey ? { 'x-api-key': this.jupKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        keepalive: true,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const err = new Error(`Jupiter ${pathname} HTTP ${res.status}${json?.error || json?.errorMessage ? `: ${json.error || json.errorMessage}` : ''}`);
        err.httpStatus = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`Jupiter ${pathname} timed out`);
        e.timeout = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async order({ inputMint, outputMint, amountRaw, slippagePct }) {
    const query = { inputMint, outputMint, amount: amountRaw.toString(), taker: this.address };
    if (Number.isFinite(slippagePct) && slippagePct > 0) query.slippageBps = Math.round(slippagePct * 100);
    const o = await this.jup('/order', { query });
    if (!o || !o.transaction) {
      throw new Error(o?.errorMessage ? `Jupiter: ${o.errorMessage}${o.errorCode ? ` (code ${o.errorCode})` : ''}` : 'Jupiter returned no route for this token');
    }
    return { ...o, fetchedAt: this.now() };
  }

  // ---------- engine hooks ----------

  /** Hooks for ChainExecutionAdapter.liveHooks */
  hooks() {
    return {
      getSwapQuote: (args) => this.quote(args),
      executeSwap: (args) => this.execute(args),
    };
  }

  quoteAssetMint(assetMode) {
    return assetMode === 'stable' ? USDC_MINT : WSOL_MINT;
  }

  /** Buys of this coin still in progress (and for 3 s after they return, until they are booked). */
  buyInProgress(mint) {
    return (this.buyMintsInFlight?.get(mint) || 0) > 0;
  }

  /**
   * "Sell everything" sells the whole wallet balance of the coin (no dust left). While a buy of the
   * same coin is in progress, that balance can include tokens of a position not booked yet —
   * then only this position's own tokens are sold.
   */
  sellAmountFor(mint, tokenAmount, positionTokens) {
    if (tokenAmount === 'all' && this.buyInProgress(mint) && Number(positionTokens) > 0) return Number(positionTokens);
    return tokenAmount;
  }

  async quote({ side, token, amountUsd, slippagePct, tokenAmount, assetMode = 'native', forceJupiter = false, urgent = false, positionTokens = null }) {
    if (side === 'sell') tokenAmount = this.sellAmountFor(token.address, tokenAmount, positionTokens);
    if (!this.ready()) throw new Error(this.keyError || 'real trading is not set up (ODEX_TRADER_KEY missing)');
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) throw new Error('SOL price not known yet');
    if (Number.isInteger(token?.decimals)) this.decimals.set(token.address, token.decimals);
    const quoteMint = this.quoteAssetMint(assetMode);
    // Direct pump.fun route: instant local quote from the curve (no Jupiter round trip)
    if (!forceJupiter && this.routeSetting() === 'direct' && quoteMint === WSOL_MINT) {
      try {
        const dq = await this.directQuote({ side, token, amountUsd, slippagePct, tokenAmount, px });
        if (dq) return dq;
      } catch (err) {
        if (err?.skipBuy) throw err;
        this.noteFallback(`quote: ${err.message}`);
      }
    }
    const marketPx = Number(token.currentPriceUsd) || 0;
    const t0 = this.now();
    let order;
    let quotedPriceUsd;
    let tokDec;
    if (side === 'buy') {
      const amountRaw = quoteMint === WSOL_MINT ? BigInt(Math.floor((amountUsd / px) * LAMPORTS)) : BigInt(Math.floor(amountUsd * 1e6));
      // copy speed: the wallet balance and a brand-new coin's decimals (one RPC call each) are
      // read while Jupiter quotes; native SOL buys skip USDC token-account RPC lookups
      const solOnly = quoteMint === WSOL_MINT;
      this.prefetchedBalance = { at: this.now(), solOnly, promise: this.refreshBalance({ solOnly }).catch(() => null) };
      [tokDec, order] = await Promise.all([this.getDecimals(token.address), this.order({ inputMint: quoteMint, outputMint: token.address, amountRaw, slippagePct })]);
      const tokensOut = Number(order.outAmount) / 10 ** tokDec;
      quotedPriceUsd = tokensOut > 0 ? amountUsd / tokensOut : 0;
    } else {
      const until = urgent ? 0 : this.sellBlockedUntil.get(token.address) || 0;
      if (this.now() < until) throw Object.assign(new Error(`waiting ${Math.ceil((until - this.now()) / 1000)} s before retrying this sell`), { backoff: true });
      const cachedHeld = this.mintMetaCache?.get(token.address)?.heldRaw || 0n;
      const knownDec = this.decimals.get(token.address);
      const activeBuying = (this.activeBuyCount?.get(token.address) || 0) > 0;
      let optimisticRaw = null;
      if (cachedHeld > 0n && Number.isInteger(knownDec) && !activeBuying) {
        if (tokenAmount === 'all') {
          optimisticRaw = cachedHeld;
        } else {
          const want = BigInt(Math.floor(Number(tokenAmount) * 10 ** knownDec));
          if (want > 0n) optimisticRaw = want > cachedHeld ? cachedHeld : want;
        }
      }
      // Fire Jupiter /order immediately using cached heldRaw in parallel with live RPC balance check
      const orderOptP =
        optimisticRaw !== null
          ? this.order({ inputMint: token.address, outputMint: quoteMint, amountRaw: optimisticRaw, slippagePct }).then(
              (o) => ({ ok: true, o }),
              (e) => ({ ok: false, e })
            )
          : null;
      const [dec, held] = await Promise.all([this.getDecimals(token.address), this.getTokenBalanceRaw(token.address)]);
      tokDec = dec;
      if (!this.mintMetaCache) this.mintMetaCache = new Map();
      const prevMeta = this.mintMetaCache.get(token.address);
      this.mintMetaCache.set(token.address, { ...(prevMeta || {}), heldRaw: held });
      const raw = await this.sellAmountRaw(token.address, tokenAmount, tokDec, held);
      if (orderOptP && raw === optimisticRaw) {
        const opt = await orderOptP;
        if (!opt.ok) throw opt.e;
        order = opt.o;
      } else {
        order = await this.order({ inputMint: token.address, outputMint: quoteMint, amountRaw: raw, slippagePct });
      }
      const outUsd = quoteMint === WSOL_MINT ? (Number(order.outAmount) / LAMPORTS) * px : Number(order.outAmount) / 1e6;
      const tokens = Number(raw) / 10 ** tokDec;
      quotedPriceUsd = tokens > 0 ? outUsd / tokens : 0;
    }
    if (!(quotedPriceUsd > 0)) throw new Error('Jupiter quote has no output');
    const ref = marketPx > 0 ? marketPx : quotedPriceUsd;
    // all-in cost vs the market price (route fees + price impact)
    const priceImpactPct = Math.max(0, side === 'buy' ? (quotedPriceUsd / ref - 1) * 100 : (1 - quotedPriceUsd / ref) * 100);
    return {
      quotedPriceUsd,
      expectedFillPriceUsd: quotedPriceUsd,
      priceImpactPct: Math.min(99, priceImpactPct),
      liquidityUsd: Number(token.liquidityUsd) || null,
      maxAllowedSlippagePct: slippagePct,
      timestamp: this.now(),
      real: true,
      _order: order,
      _slippagePct: slippagePct,
      _side: side,
      _quoteMs: this.now() - t0,
    };
  }

  // ---------- direct pump.fun route ----------

  noteFallback(why) {
    this.directStats.fallbacks += 1;
    this.directStats.lastFallback = String(why).slice(0, 200);
    this.directStats.lastFallbackAt = this.now();
  }

  async refreshBlockhash() {
    if (this.blockhashInFlight) return this.blockhashInFlight;
    this.blockhashInFlight = (async () => {
      try {
        const r = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        const hash = r?.value?.blockhash || r?.blockhash;
        if (!hash) throw new Error('no blockhash');
        this.blockhashCache = { hash, at: this.now() };
        return hash;
      } finally {
        this.blockhashInFlight = null;
      }
    })();
    return this.blockhashInFlight;
  }

  async recentBlockhash() {
    const c = this.blockhashCache;
    if (c) {
      const age = this.now() - c.at;
      if (age < 30_000) {
        if (age > 8_000) this.refreshBlockhash().catch(() => {});
        return c.hash;
      }
    }
    return this.refreshBlockhash();
  }

  /** Keep a fresh recentBlockhash in memory so direct pump.fun quotes never wait on getLatestBlockhash. */
  startBlockhashWarmer(intervalMs = 10_000) {
    if (this.blockhashTimer) return;
    const tick = () => {
      if (!this.ready() || this.routeSetting() !== 'direct') return;
      this.refreshBlockhash().catch(() => {});
    };
    tick();
    this.blockhashTimer = setInterval(tick, intervalMs);
    this.blockhashTimer.unref?.();
  }

  stopBlockhashWarmer() {
    if (this.blockhashTimer) {
      clearInterval(this.blockhashTimer);
      this.blockhashTimer = null;
    }
  }

  /**
   * Pre-warm and hold open TLS / HTTP keep-alive sockets to Jupiter and all fast broadcast RPCs
   * (Helius Staked, Helius, Alchemy, Jito Block Engines) so sudden copy trades skip the ~150–250 ms
   * cold TCP + TLS handshake. Credit-metered Sodae URLs are skipped so monthly credits stay untouched.
   */
  async warmConnections() {
    if (!this.ready()) return 0;
    const origins = new Set();
    try {
      origins.add(new URL(this.jupBase).origin);
    } catch {
      // ignore invalid URL
    }
    for (const u of this.fastRpcUrls || []) {
      try {
        const parsed = new URL(u);
        if (/sodae/i.test(parsed.hostname)) continue;
        origins.add(parsed.origin);
      } catch {
        // ignore invalid URL
      }
    }
    let warmed = 0;
    await Promise.allSettled(
      [...origins].map(async (origin) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        t.unref?.();
        try {
          await this.fetch(origin, {
            method: 'OPTIONS',
            keepalive: true,
            signal: ctrl.signal,
          });
          warmed += 1;
        } catch {
          // TLS handshake still warms the pool even if an endpoint rejects OPTIONS
        } finally {
          clearTimeout(t);
        }
      })
    );
    return warmed;
  }

  startConnectionWarmer(intervalMs = 15_000) {
    if (this.connectionWarmTimer) return;
    if (this.confirmWsUrl) {
      this.confirmWsWanted = true;
      this.ensureConfirmWs();
    }
    const tick = () => {
      if (!this.ready()) return;
      if (this.confirmWsUrl) this.ensureConfirmWs();
      this.warmConnections().catch(() => {});
    };
    tick();
    this.connectionWarmTimer = setInterval(tick, intervalMs);
    this.connectionWarmTimer.unref?.();
  }

  stopConnectionWarmer() {
    if (this.connectionWarmTimer) {
      clearInterval(this.connectionWarmTimer);
      this.connectionWarmTimer = null;
    }
    this.confirmWsWanted = false;
    this.closeConfirmWs();
  }

  /** Cache a parsed own-wallet transaction (e.g. from Yellowstone gRPC) for 0-RPC readFill deltas. */
  cacheOwnTransaction(signature, tx) {
    if (!signature || !tx?.meta || tx.meta.err) return;
    if (!this.ownTxCache) this.ownTxCache = new Map();
    if (this.ownTxCache.size > 150) {
      for (const [k, v] of this.ownTxCache) if (this.now() - v.at > 120_000) this.ownTxCache.delete(k);
      if (this.ownTxCache.size > 150) this.ownTxCache.clear();
    }
    this.ownTxCache.set(signature, { tx, at: this.now() });
  }

  /**
   * Push-notify an in-flight signature wait in 0 ms once Solana reaches `confirmed` / `finalized`.
   * Never marks a swap succeeded at `processed` (~1% fork risk).
   */
  notifySignature(signature, { err = null, confirmationStatus = 'confirmed', tx = null } = {}) {
    if (!signature) return false;
    if (tx && !err) this.cacheOwnTransaction(signature, tx);
    if (!err && confirmationStatus !== 'confirmed' && confirmationStatus !== 'finalized') return false;
    let status;
    if (err) {
      if (!this.lastSigErrors) this.lastSigErrors = new Map();
      if (this.lastSigErrors.size > 200) this.lastSigErrors.clear();
      this.lastSigErrors.set(signature, err);
      status = 'failed';
    } else {
      status = 'success';
    }
    if (!this.resolvedSigs) this.resolvedSigs = new Map();
    if (this.resolvedSigs.size > 300) {
      for (const [k, v] of this.resolvedSigs) if (this.now() - v.at > 60_000) this.resolvedSigs.delete(k);
      if (this.resolvedSigs.size > 300) this.resolvedSigs.clear();
    }
    this.resolvedSigs.set(signature, { status, at: this.now() });
    const set = this.sigWaiters?.get(signature);
    if (set) {
      this.sigWaiters.delete(signature);
      for (const fn of set) fn(status);
    }
    const subId = this.confirmWsSigToSub?.get(signature);
    if (subId !== undefined) {
      this.confirmWsSigToSub.delete(signature);
      this.confirmWsSubToSig?.delete(subId);
    }
    return true;
  }

  sendSignatureSubscribe(signature) {
    if (!signature || !this.confirmWs || this.confirmWs.readyState !== 1) return;
    if (this.confirmWsSigToSub?.has(signature)) return;
    for (const sig of this.confirmWsPendingId?.values() || []) if (sig === signature) return;
    const id = this.confirmWsId++;
    this.confirmWsPendingId.set(id, signature);
    try {
      this.confirmWs.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'signatureSubscribe',
          params: [signature, { commitment: 'confirmed' }],
        })
      );
    } catch {
      this.confirmWsPendingId.delete(id);
    }
  }

  ensureConfirmWs() {
    if (!this.confirmWsUrl || !this.WebSocketImpl || !this.ready()) return;
    if (this.confirmWs && (this.confirmWs.readyState === 0 || this.confirmWs.readyState === 1)) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.confirmWsUrl);
    } catch {
      return;
    }
    this.confirmWs = ws;
    const cleanupAndRetry = () => {
      if (this.confirmWs !== ws) return;
      this.confirmWs = null;
      this.confirmWsPendingId?.clear();
      this.confirmWsSubToSig?.clear();
      this.confirmWsSigToSub?.clear();
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (this.confirmWsWanted || (this.sigWaiters && this.sigWaiters.size > 0)) {
        clearTimeout(this.confirmWsTimer);
        this.confirmWsTimer = setTimeout(() => this.ensureConfirmWs(), 1500);
        this.confirmWsTimer.unref?.();
      }
    };
    ws.onopen = () => {
      if (this.confirmWs !== ws) return;
      for (const sig of this.sigWaiters?.keys() || []) this.sendSignatureSubscribe(sig);
    };
    ws.onmessage = (ev) => {
      if (this.confirmWs !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev?.data === 'string' ? ev.data : String(ev?.data || ''));
      } catch {
        return;
      }
      if (msg?.id !== undefined && this.confirmWsPendingId?.has(msg.id)) {
        const sig = this.confirmWsPendingId.get(msg.id);
        this.confirmWsPendingId.delete(msg.id);
        if (msg.result !== undefined && msg.result !== null) {
          if (this.sigWaiters?.has(sig)) {
            this.confirmWsSubToSig.set(msg.result, sig);
            this.confirmWsSigToSub.set(sig, msg.result);
          } else {
            // Waiter already finished before subscription ack: unsubscribe immediately
            try {
              ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.confirmWsId++, method: 'signatureUnsubscribe', params: [msg.result] }));
            } catch {
              // ignore
            }
          }
        }
        return;
      }
      if (msg?.method === 'signatureNotification') {
        const subId = msg.params?.subscription;
        const sig = this.confirmWsSubToSig?.get(subId);
        if (sig) {
          this.confirmWsSubToSig.delete(subId);
          this.confirmWsSigToSub.delete(sig);
          const err = msg.params?.result?.value?.err ?? null;
          this.notifySignature(sig, { err, confirmationStatus: 'confirmed' });
        }
      }
    };
    ws.onerror = () => {
      if (ws.readyState !== 1) cleanupAndRetry();
    };
    ws.onclose = () => cleanupAndRetry();
  }

  closeConfirmWs() {
    clearTimeout(this.confirmWsTimer);
    this.confirmWsTimer = null;
    const ws = this.confirmWs;
    this.confirmWs = null;
    this.confirmWsPendingId?.clear();
    this.confirmWsSubToSig?.clear();
    this.confirmWsSigToSub?.clear();
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  /** Register a one-shot listener resolved in 0 ms by WebSocket signatureSubscribe or notifySignature. */
  watchSignatureOnce(signature) {
    if (!signature) return { promise: new Promise(() => {}), cancel: () => {} };
    const hit = this.resolvedSigs?.get(signature);
    if (hit && this.now() - hit.at < 60_000) {
      return { promise: Promise.resolve(hit.status), cancel: () => {} };
    }
    if (!this.sigWaiters) this.sigWaiters = new Map();
    let fn;
    const promise = new Promise((resolve) => {
      fn = resolve;
    });
    let set = this.sigWaiters.get(signature);
    if (!set) {
      set = new Set();
      this.sigWaiters.set(signature, set);
    }
    set.add(fn);
    if (this.confirmWsUrl) {
      this.ensureConfirmWs();
      this.sendSignatureSubscribe(signature);
    }
    const cancel = () => {
      const cur = this.sigWaiters?.get(signature);
      if (cur) {
        cur.delete(fn);
        if (cur.size === 0) {
          this.sigWaiters.delete(signature);
          const subId = this.confirmWsSigToSub?.get(signature);
          if (subId !== undefined) {
            this.confirmWsSigToSub.delete(signature);
            this.confirmWsSubToSig?.delete(subId);
            if (this.confirmWs?.readyState === 1) {
              try {
                this.confirmWs.send(JSON.stringify({ jsonrpc: '2.0', id: this.confirmWsId++, method: 'signatureUnsubscribe', params: [subId] }));
              } catch {
                // ignore
              }
            }
          }
        }
      }
    };
    return { promise, cancel };
  }

  /**
   * One RPC read (curve, mint, wallet, wallet's token account), then a local quote. Returns null
   * when the coin can't go direct (it then uses Jupiter), or a quote shaped like Jupiter's.
   */
  async directQuote({ side, token, amountUsd, slippagePct, tokenAmount, px }) {
    const mint = token.address;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint || ''))) return null;
    if (token?.venue === 'launchlab' || token?.venue === 'pumpswap' || token?.stage === 'graduated' || token?.curve?.launchlab) return null;
    const t0 = this.now();
    const curveAddr = PD.bondingCurveAddress(mint);
    const ataSpl = PD.ataAddress(this.address, mint, PD.TOKEN_PROGRAM);
    const ata2022 = PD.ataAddress(this.address, mint, PD.TOKEN_2022_PROGRAM);
    if (!this.mintMetaCache) this.mintMetaCache = new Map();
    const cachedMeta = this.mintMetaCache.get(mint);
    const activeBuying = (this.activeBuyCount?.get(mint) || 0) > 0;
    const fastTc =
      token?.curve &&
      !token.curve.launchlab &&
      (!token.curve.at || this.now() - Number(token.curve.at) < 2000) &&
      Number(token.curve.virtualSolReserves) > 0 &&
      Number(token.curve.virtualTokenReserves) > 0 &&
      !token.curve.mayhem &&
      !token.curve.cashback &&
      (side === 'buy'
        ? Number(token.curve.realTokenReserves) > 0 && (token.curve.tokenProgram === PD.TOKEN_PROGRAM || token.curve.tokenProgram === PD.TOKEN_2022_PROGRAM) && Number(this.balance?.sol) > 0
        : cachedMeta && cachedMeta.heldRaw > 0n && !activeBuying && (token.curve.tokenProgram === PD.TOKEN_PROGRAM || token.curve.tokenProgram === PD.TOKEN_2022_PROGRAM || cachedMeta.tokenProgram))
        ? token.curve
        : null;
    let curve;
    let baseTokenProgram;
    let userAta;
    let ataExists;
    let preTokens;
    let preLamports;
    let blockhash;
    if (fastTc) {
      curve = {
        virtualTokenReserves: BigInt(Math.round(Number(fastTc.virtualTokenReserves))),
        virtualQuoteReserves: BigInt(Math.round(Number(fastTc.virtualSolReserves))),
        realTokenReserves: BigInt(Math.round(Number(fastTc.realTokenReserves || 0))),
        complete: false,
        solPaired: true,
        isCashback: false,
        isMayhem: false,
      };
      baseTokenProgram = fastTc.tokenProgram === PD.TOKEN_PROGRAM || fastTc.tokenProgram === PD.TOKEN_2022_PROGRAM ? fastTc.tokenProgram : cachedMeta.tokenProgram;
      userAta = baseTokenProgram === PD.TOKEN_2022_PROGRAM ? ata2022 : ataSpl;
      ataExists = side === 'sell';
      preTokens = side === 'sell' ? cachedMeta.heldRaw : 0n;
      preLamports = BigInt(Math.round(Number(this.balance?.sol || 0) * 1e9));
      blockhash = await this.recentBlockhash().catch(() => null);
    } else {
      const [bhP, accP] = [this.recentBlockhash().catch(() => null), this.rpc('getMultipleAccounts', [[curveAddr, mint, this.address, ataSpl, ata2022], { encoding: 'base64', commitment: 'processed' }])];
      const acc = await accP;
      const [curveAcc, mintAcc, userAcc, ataSplAcc, ata2022Acc] = acc?.value || [];
      if (!curveAcc || curveAcc.owner !== PD.PUMP_PROGRAM) return null; // not on pump.fun's curve
      curve = PD.decodeCurve(curveAcc.data?.[0]);
      const blocker = PD.directBlocker(curve);
      if (blocker) {
        if (side === 'buy' && blocker === 'curve is not priced in SOL') {
          throw Object.assign(new Error('curve is not priced in SOL (token-paired curve skipped)'), { skipBuy: true });
        }
        this.noteFallback(blocker);
        return null;
      }
      baseTokenProgram = mintAcc?.owner;
      if (baseTokenProgram !== PD.TOKEN_PROGRAM && baseTokenProgram !== PD.TOKEN_2022_PROGRAM) return null;
      if (!cachedMeta?.tokenProgram) {
        this.mintMetaCache.set(mint, { ...(cachedMeta || {}), tokenProgram: baseTokenProgram });
      }
      userAta = baseTokenProgram === PD.TOKEN_2022_PROGRAM ? ata2022 : ataSpl;
      const ataAcc = baseTokenProgram === PD.TOKEN_2022_PROGRAM ? ata2022Acc : ataSplAcc;
      preTokens = ataAcc ? PD.tokenAccountAmount(ataAcc.data?.[0]) : 0n;
      ataExists = Boolean(ataAcc);
      preLamports = BigInt(userAcc?.lamports || 0);
      blockhash = await bhP;
    }
    const tokDec = Number.isInteger(token?.decimals) ? token.decimals : this.decimals.get(mint) ?? 6;
    this.decimals.set(mint, tokDec);
    let quotedPriceUsd;
    const d = { curve, baseTokenProgram, userAta, ataExists, preTokens, preLamports, fastCurve: Boolean(fastTc), tokDec, blockhash };
    if (side === 'buy') {
      const lamportsIn = BigInt(Math.floor((amountUsd / px) * 1e9));
      const tokensOut = PD.quoteBuy(curve, lamportsIn);
      if (tokensOut <= 0n || tokensOut > curve.realTokenReserves) {
        this.noteFallback('buy would empty the curve');
        return null;
      }
      Object.assign(d, { lamportsIn, tokensOut });
      quotedPriceUsd = amountUsd / (Number(tokensOut) / 10 ** tokDec);
    } else {
      if (preTokens <= 0n) throw Object.assign(new Error('the bot wallet holds none of this token'), { noTokens: true });
      const want = tokenAmount === 'all' ? preTokens : BigInt(Math.floor(Number(tokenAmount) * 10 ** tokDec));
      const amount = want > preTokens ? preTokens : want;
      if (amount <= 0n) throw new Error('sell amount is too small');
      const lamportsOut = PD.quoteSell(curve, amount);
      Object.assign(d, { amount, lamportsOut });
      const outUsd = (Number(lamportsOut) / 1e9) * px;
      quotedPriceUsd = outUsd / (Number(amount) / 10 ** tokDec);
    }
    const marketPx = Number(token.currentPriceUsd) || 0;
    const ref = marketPx > 0 ? marketPx : quotedPriceUsd;
    return {
      quotedPriceUsd,
      expectedFillPriceUsd: quotedPriceUsd,
      priceImpactPct: Math.min(99, Math.max(0, side === 'buy' ? (quotedPriceUsd / ref - 1) * 100 : (1 - quotedPriceUsd / ref) * 100)),
      liquidityUsd: Number(token.liquidityUsd) || null,
      maxAllowedSlippagePct: slippagePct,
      timestamp: this.now(),
      real: true,
      route: 'direct',
      _direct: d,
      _slippagePct: slippagePct,
      _side: side,
      _quoteMs: this.now() - t0,
    };
  }

  /**
   * Build, simulate (with balance checks) and send a direct pump.fun swap.
   * { ok, signature, exec, inAmount, sendMs } | { priceMoved } | { unknown, signature } | { fallback, error }
   * `fallback` always means NOTHING was sent, so Jupiter can safely be used instead.
   */
  async executeDirect({ side, token, quote, slippagePct, tooLate = () => false }) {
    const d = quote._direct;
    const mint = token.address;
    const slip = Number.isFinite(slippagePct) && slippagePct > 0 ? slippagePct : side === 'sell' ? 15 : 10;
    const keep = BigInt(Math.max(0, Math.floor((100 - Math.min(95, slip)) * 100))); // basis points kept
    const buyback = PD.BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * PD.BUYBACK_FEE_RECIPIENTS.length)];
    let ixs;
    let minOut;
    let priorityLamports = 0;
    let tipLamports = 0n;
    try {
      // Every transaction must be unique: two copies of the same size for the same coin, built in the
      // same second with the same cached blockhash, would otherwise be byte-identical — one
      // signature, one swap on-chain, but both booked. Right-size CU limits (~95k buy / ~65k sell) so
      // Solana validators rank our reward-per-CU higher in the leader slot.
      this.directNonce = ((this.directNonce || 0) + 1) % 10_000;
      const baseUnits = side === 'buy' ? 95_000 : 65_000;
      const units = baseUnits + this.directNonce;
      const tradeSol = Number(side === 'buy' ? d.lamportsIn : d.lamportsOut) / LAMPORTS;
      const microLamports = this.priorityMicroLamports(units, side, tradeSol);
      priorityLamports = Math.ceil((units * Math.max(0, Number(microLamports) || 0)) / 1_000_000);
      if (side === 'buy') {
        const rawTip = Math.max(0, Math.floor(Number(this.jitoTipLamports?.(side, tradeSol) || 0)));
        tipLamports = BigInt(rawTip >= 1_000 ? rawTip : 0);
        if (tipLamports > 0n && d.preLamports !== undefined) {
          const room = d.preLamports - d.lamportsIn - 3_500_000n;
          if (room < 1_000n) tipLamports = 0n;
          else if (tipLamports > room) tipLamports = room;
        }
      }
      const budget = PD.computeBudgetIxs({ units, microLamports });
      if (side === 'buy') {
        minOut = (d.tokensOut * keep) / 10_000n;
        if (minOut <= 0n) return { fallback: true, error: 'minimum tokens is 0' };
        ixs = [...budget, PD.createAtaIdempotentIx({ payer: this.address, owner: this.address, mint, tokenProgram: d.baseTokenProgram }), PD.buyExactQuoteInIx({ user: this.address, mint, baseTokenProgram: d.baseTokenProgram, lamportsIn: d.lamportsIn, minTokensOut: minOut, buybackFeeRecipient: buyback })];
        if (tipLamports >= 1_000n) {
          const tipTo = PD.JITO_TIP_ACCOUNTS[Math.floor(Math.random() * PD.JITO_TIP_ACCOUNTS.length)];
          ixs.push(PD.systemTransferIx({ from: this.address, to: tipTo, lamports: tipLamports }));
        }
      } else {
        minOut = (d.lamportsOut * keep) / 10_000n;
        ixs = [...budget, PD.sellIx({ user: this.address, mint, baseTokenProgram: d.baseTokenProgram, amount: d.amount, minSolOutput: minOut, buybackFeeRecipient: buyback })];
      }
    } catch (err) {
      return { fallback: true, error: `build: ${err.message}` };
    }
    let signed;
    try {
      const blockhash = d.blockhash || (await this.recentBlockhash());
      const { message } = PD.compileMessage({ payer: this.address, instructions: ixs, recentBlockhash: blockhash });
      signed = PD.signLegacy(message, this.keypair);
    } catch (err) {
      return { fallback: true, error: `sign: ${err.message}` };
    }
    const bundleOnly = tipLamports >= 1_000n;
    // ----- fastCurve swap: start simulation + blast + send in parallel in the same tick -----
    if (d.fastCurve) {
      if (side === 'buy' && tooLate()) return { late: true, error: "too late to send — it would land past the late-copy limit after the trader's buy" };
      if (!this.sentSigs) this.sentSigs = new Map();
      for (const [k, t] of this.sentSigs) if (this.now() - t > 120_000) this.sentSigs.delete(k);
      if (this.sentSigs.has(signed.signature)) return { fallback: true, error: 'identical transaction already sent — not sending it twice' };
      this.sentSigs.set(signed.signature, this.now());
    }
    const simP = this.rpc('simulateTransaction', [signed.base64, { encoding: 'base64', commitment: 'processed', sigVerify: true, replaceRecentBlockhash: false, accounts: { encoding: 'base64', addresses: [this.address, d.userAta] } }]);
    let fastSent = false;
    let fastSendStart = 0;
    let fastSig = signed.signature;
    let fastSendP = null;
    let fastConfirmP = null;
    if (d.fastCurve) {
      fastSent = true;
      fastSendStart = this.now();
      this.blastSignedTransaction(signed.base64, { bundleOnly });
      fastSendP = this.rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]).catch(() => null);
      // Start signature confirmation micro-polling immediately in parallel with simulation & send
      fastConfirmP = this.waitForSignature(fastSig, 25_000);
    }
    // ----- simulate and check the balance changes -----
    let sim;
    try {
      sim = await simP;
    } catch (err) {
      if (!fastSent) return { fallback: true, error: `simulation: ${err.message}` };
    }
    const simErr = sim?.value?.err;
    if (simErr && !fastSent) {
      const code = PD.customErrorCode(simErr);
      if (PRICE_CODES.has(code)) return { priceMoved: true, error: `pump.fun refused: price past the limit (${code})` };
      if (/BlockhashNotFound/i.test(JSON.stringify(simErr))) this.blockhashCache = null;
      return { fallback: true, error: `simulation failed: ${JSON.stringify(simErr).slice(0, 160)}` };
    }
    const post = sim?.value?.accounts || [];
    const postLamports = post[0] ? BigInt(post[0].lamports || 0) : null;
    const postTokens = post[1] ? PD.tokenAccountAmount(post[1].data?.[0]) : side === 'sell' ? 0n : null;
    if (!fastSent && (postLamports === null || postTokens === null)) return { fallback: true, error: 'simulation returned no balances' };
    const tokDelta = postTokens !== null ? postTokens - d.preTokens : minOut;
    const solDelta = postLamports !== null ? postLamports - d.preLamports : 0n;
    let inAmount;
    let outAmount;
    if (side === 'buy') {
      // tokens received at least the minimum; SOL spent no more than the budget + Jito tip + fees, rent and
      // the one-time pump.fun volume account (≈0.0018 SOL) — 0.006 SOL margin
      if (!fastSent && tokDelta < minOut) return { fallback: true, error: `simulation gave ${tokDelta} tokens, under the ${minOut} minimum` };
      if (!d.fastCurve && -solDelta > d.lamportsIn + tipLamports + 6_000_000n) return { fallback: true, error: `simulation spent ${-solDelta} lamports, more than expected` };
      inAmount = d.lamportsIn;
      outAmount = tokDelta > 0n ? tokDelta : d.tokensOut;
    } else {
      if (!fastSent && -tokDelta !== d.amount) return { fallback: true, error: `simulation sold ${-tokDelta} tokens, expected ${d.amount}` };
      if (!fastSent && solDelta < minOut - 200_000n) return { fallback: true, error: `simulation returned ${solDelta} lamports, under the minimum` };
      inAmount = d.amount;
      outAmount = solDelta > 0n ? solDelta : d.lamportsOut;
    }
    let sendStart = fastSendStart;
    let sig = fastSig;
    if (fastSent) {
      const r = await fastSendP;
      if (typeof r === 'string') sig = r;
    } else {
      // the simulation took time: still within the late-copy limit? (nothing sent → Jupiter is not tried either)
      if (tooLate()) return { late: true, error: "too late to send — it would land past the late-copy limit after the trader's buy" };
      // never send (or book) the same signature twice
      if (!this.sentSigs) this.sentSigs = new Map();
      for (const [k, t] of this.sentSigs) if (this.now() - t > 120_000) this.sentSigs.delete(k);
      if (this.sentSigs.has(signed.signature)) return { fallback: true, error: 'identical transaction already sent — not sending it twice' };
      this.sentSigs.set(signed.signature, this.now());
      // ----- send (fast RPCs + main RPC in parallel) and confirm -----
      sendStart = this.now();
      this.blastSignedTransaction(signed.base64, { bundleOnly });
      try {
        const r = await this.rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
        if (typeof r === 'string') sig = r;
      } catch (err) {
        // the fast RPCs above still got it; the status check decides
      }
    }
    const st = fastConfirmP ? await fastConfirmP : await this.waitForSignature(sig, 25_000);
    const sendMs = this.now() - sendStart;
    if (st === 'unknown') return { unknown: true, signature: sig, error: 'sent but not confirmed in 25 s' };
    if (st === 'failed') {
      // it landed but failed: nothing changed except the network fee. Price errors are skips.
      let errObj = this.lastSigErrors?.get(sig) || null;
      if (!errObj) {
        try {
          const s2 = await this.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
          errObj = s2?.value?.[0]?.err || null;
        } catch {
          // ignore
        }
      }
      const code = PD.customErrorCode(errObj);
      if (PRICE_CODES.has(code)) return { priceMoved: true, error: `pump.fun refused: price moved past the limit while sending (${code})`, signature: sig };
      return { fallback: true, sentFailed: true, signature: sig, error: `direct swap failed on-chain${code !== null ? ` (${code})` : ''}` };
    }
    this.directStats.direct += 1;
    this.directStats.lastDirectAt = this.now();
    if (!this.mintMetaCache) this.mintMetaCache = new Map();
    if (side === 'buy') {
      const prev = this.mintMetaCache.get(mint)?.heldRaw || d.preTokens || 0n;
      this.mintMetaCache.set(mint, { tokenProgram: d.baseTokenProgram, heldRaw: prev + BigInt(outAmount || 0n) });
    } else {
      const prev = this.mintMetaCache.get(mint)?.heldRaw || d.preTokens || 0n;
      const rem = prev > BigInt(inAmount || 0n) ? prev - BigInt(inAmount || 0n) : 0n;
      this.mintMetaCache.set(mint, { tokenProgram: d.baseTokenProgram, heldRaw: rem });
    }
    // exact amounts from the simulation as a fallback; readFill prefers the real transaction
    const exec = { totalInputAmount: String(inAmount), totalOutputAmount: String(outAmount), networkLamports: 5000 + priorityLamports + Number(tipLamports) };
    return { ok: true, signature: sig, exec, inAmount: String(inAmount), sendMs };
  }

  /**
   * Send SOL from the bot wallet to another wallet (Bot Wallet → Send).
   * amountSol: a number, or 'max' (everything that can go). keepReserve: keep the fee reserve
   * (real positions are open and need fees to sell). Checks the recipient, simulates the exact
   * transfer, then sends it. Returns { ok, signature, sentSol, feeSol, balance } or { ok:false, error }.
   */
  async sendSol({ to, amountSol, keepReserve = true, dryRun = false } = {}) {
    if (!this.ready()) return { ok: false, error: this.keyError || 'the bot wallet is not set up' };
    if (this.sendInFlight) return { ok: false, error: 'a send is already in progress' };
    const dest = String(to || '').trim();
    let destBytes;
    try {
      destBytes = base58Decode(dest);
    } catch {
      destBytes = null;
    }
    if (!destBytes || destBytes.length !== 32 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) return { ok: false, error: 'that is not a valid Solana address' };
    if (dest === this.address) return { ok: false, error: 'that is the bot wallet itself' };
    if (!isOnCurve(Buffer.from(destBytes))) return { ok: false, error: 'that address is not a normal wallet (it belongs to a program) — SOL sent there could be lost' };
    this.sendInFlight = true;
    try {
      const FEE = 5_000n + 100n; // base fee + a tiny priority fee (1,000 units × 100,000 µlamports)
      const [balR, destR] = await Promise.all([
        this.rpc('getBalance', [this.address, { commitment: 'confirmed' }]),
        this.rpc('getAccountInfo', [dest, { encoding: 'base64', commitment: 'confirmed' }]),
      ]);
      const have = BigInt(Number(balR?.value ?? balR ?? 0));
      const destAcc = destR?.value || null;
      if (destAcc && destAcc.owner !== PD.SYSTEM_PROGRAM) return { ok: false, error: 'that address is a token account or program, not a wallet — use the wallet address itself' };
      if (destAcc?.executable) return { ok: false, error: 'that address is a program, not a wallet' };
      // SOL promised to buys in progress and (with open real positions) the fee reserve stay
      const pending = BigInt(Math.ceil((this.pendingBuySol || 0) * 1e9));
      const reserve = keepReserve ? BigInt(Math.ceil((this.caps.reserveSol || 0) * 1e9)) : 0n;
      const usable = have - FEE - pending - reserve;
      let lamports;
      if (amountSol === 'max') lamports = usable;
      else {
        const n = Number(amountSol);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'enter an amount above 0' };
        lamports = BigInt(Math.round(n * 1e9));
      }
      if (lamports <= 0n) return { ok: false, error: `nothing to send: the wallet has ${(Number(have) / 1e9).toFixed(4)} SOL${reserve ? `, ${(Number(reserve) / 1e9).toFixed(3)} SOL is kept for selling the open positions` : ''}` };
      if (lamports > usable) {
        return { ok: false, error: `not enough SOL: ${(Number(usable > 0n ? usable : 0n) / 1e9).toFixed(6)} SOL can be sent${reserve ? ` (${(Number(reserve) / 1e9).toFixed(3)} SOL is kept for selling the open positions)` : ''}${pending ? ' (some SOL is reserved for buys in progress)' : ''}` };
      }
      if (!destAcc && lamports < 890_880n) return { ok: false, error: 'a new (empty) wallet needs at least 0.00089 SOL, or Solana rejects the transfer' };
      // what stays behind must not be stranded below the network's minimum either
      const left = have - lamports - FEE;
      if (left > 0n && left < 890_880n) return { ok: false, error: `that would leave ${(Number(left) / 1e9).toFixed(6)} SOL, below Solana's 0.00089 SOL minimum — send a little less, or press Max` };
      const ix = { programId: PD.SYSTEM_PROGRAM, keys: [{ pubkey: this.address, isSigner: true, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(lamports); return b; })()]) };
      const blockhash = await this.recentBlockhash();
      const { message } = PD.compileMessage({ payer: this.address, instructions: [...PD.computeBudgetIxs({ units: 1_000, microLamports: 100_000 }), ix], recentBlockhash: blockhash });
      const signed = PD.signLegacy(message, this.keypair);
      // ----- simulate: exactly `lamports` leaves, exactly `lamports` arrives -----
      const sim = await this.rpc('simulateTransaction', [signed.base64, { encoding: 'base64', commitment: 'confirmed', sigVerify: true, replaceRecentBlockhash: false, accounts: { encoding: 'base64', addresses: [this.address, dest] } }]);
      if (sim?.value?.err) return { ok: false, error: `the network rejected the transfer in a test run: ${JSON.stringify(sim.value.err).slice(0, 160)}` };
      const post = sim?.value?.accounts || [];
      const fromAfter = post[0] ? BigInt(post[0].lamports || 0) : null;
      const toAfter = post[1] ? BigInt(post[1].lamports || 0) : null;
      const toBefore = BigInt(destAcc?.lamports || 0);
      if (fromAfter === null || toAfter === null) return { ok: false, error: 'the test run returned no balances — nothing was sent' };
      if (toAfter - toBefore !== lamports || have - fromAfter > lamports + 20_000n) return { ok: false, error: 'the test run did not move exactly the amount asked — nothing was sent' };
      const sentSol = Number(lamports) / 1e9;
      if (dryRun) return { ok: true, dryRun: true, sentSol, feeSol: Number(have - fromAfter - lamports) / 1e9, to: dest };
      // ----- send + confirm -----
      let sig = signed.signature;
      this.blastSignedTransaction(signed.base64);
      try {
        const r = await this.rpc('sendTransaction', [signed.base64, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
        if (typeof r === 'string') sig = r;
      } catch {
        // the status check decides
      }
      const st = await this.waitForSignature(sig, 30_000);
      this.record({ side: 'transfer', mint: null, symbol: 'SOL', signature: sig, ok: st === 'success' ? true : st === 'failed' ? false : null, route: 'transfer', to: dest, sol: sentSol, error: st === 'success' ? null : st === 'failed' ? 'transfer failed on-chain' : 'not confirmed in 30 s' });
      const balance = await this.refreshBalance().catch(() => this.balance);
      if (st === 'failed') return { ok: false, signature: sig, error: 'the transfer failed on-chain (only the network fee was taken)' };
      if (st !== 'success') return { ok: false, unknown: true, signature: sig, error: `sent but not confirmed in 30 s — check Solscan before sending again: ${sig}` };
      return { ok: true, signature: sig, sentSol, feeSol: Number(FEE) / 1e9, to: dest, balance };
    } catch (err) {
      return { ok: false, error: `could not send: ${err.message}` };
    } finally {
      this.sendInFlight = false;
    }
  }

  /**
   * The coin is no longer in the bot wallet: find the transaction that took it out (the bot's
   * token accounts for this mint keep their history even after they are closed) and how much SOL
   * came back. { held: bigint, sale: { signature, receivedSol, t } | null }
   */
  async findTokenExit(mint, { skip = new Set(), since = 0 } = {}) {
    if (!this.ready()) throw new Error(this.keyError || 'the bot wallet is not set up');
    const held = await this.getTokenBalanceRaw(mint);
    if (held > 0n) return { held, sale: null };
    const atas = [PD.TOKEN_PROGRAM, PD.TOKEN_2022_PROGRAM].map((tp) => PD.ataAddress(this.address, mint, tp));
    const sigs = [];
    for (const a of atas) {
      try {
        const list = (await this.rpc('getSignaturesForAddress', [a, { limit: 25, commitment: 'confirmed' }])) || [];
        for (const x of list) if (!x.err) sigs.push(x);
      } catch {
        // try the other account
      }
    }
    sigs.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
    // every exit since the position opened that the bot has not booked yet (an earlier partial
    // sell such as "Initials" is already booked and must not be counted twice)
    let receivedSol = 0;
    let netSol = 0;
    let txCount = 0;
    const signatures = [];
    let lastT = 0;
    const seenSig = new Set();
    for (const x of sigs.slice(0, 40)) {
      if (seenSig.has(x.signature)) continue;
      seenSig.add(x.signature);
      if (since && x.blockTime && x.blockTime * 1000 < since - 60_000) continue;
      let tx;
      try {
        tx = await this.rpc('getTransaction', [x.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      } catch {
        continue;
      }
      if (!tx?.meta || tx.meta.err) continue;
      const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      const me = keys.indexOf(this.address);
      if (me < 0) continue;
      const amt = (list) => (list || []).filter((b) => b.mint === mint && b.owner === this.address).reduce((s2, b) => s2 + BigInt(b.uiTokenAmount?.amount || '0'), 0n);
      const tokDelta = amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances);
      const solDelta = (Number(tx.meta.postBalances?.[me] || 0) - Number(tx.meta.preBalances?.[me] || 0)) / 1e9;
      // the coin's whole on-chain result: every buy, sell and rent refund of this coin's account
      netSol += solDelta;
      txCount += 1;
      if (tokDelta < 0n && !skip.has(x.signature)) {
        // a transaction that took tokens out and that the bot has not booked yet
      } else continue;
      receivedSol += Math.max(0, solDelta);
      signatures.push(x.signature);
      lastT = Math.max(lastT, (tx.blockTime || x.blockTime || 0) * 1000);
    }
    const onchain = txCount ? { netSol, txCount } : null;
    if (signatures.length) return { held: 0n, onchain, sale: { signature: signatures[0], signatures, receivedSol, t: lastT || this.now() } };
    return { held: 0n, onchain, sale: null };
    return { held: 0n, sale: null };
  }

  /** How many raw tokens to sell: never more than the wallet holds. */
  async sellAmountRaw(mint, tokenAmount, decimals, preHeld = null) {
    const held = preHeld !== null ? preHeld : await this.getTokenBalanceRaw(mint);
    if (held <= 0n) throw Object.assign(new Error('the bot wallet holds none of this token'), { noTokens: true });
    if (tokenAmount === 'all') return held;
    const want = BigInt(Math.floor(Number(tokenAmount) * 10 ** decimals));
    // never turn a tiny partial sell into "sell everything" (other positions may share this wallet balance)
    if (want <= 0n) throw new Error('sell amount is too small');
    return want > held ? held : want;
  }

  /**
   * Fire-and-forget direct broadcast of the signed transaction (`skipPreflight: true`) across all
   * configured fast RPCs (Helius, Alchemy, Jito Block Engine) in parallel with Jupiter `/execute`
   * so the transaction reaches the Solana leader in milliseconds.
   */
  blastSignedTransaction(signedBase64, { bundleOnly = false } = {}) {
    if (!this.fastRpcUrls?.length) return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [signedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
    });
    for (const rawUrl of this.fastRpcUrls) {
      let url = rawUrl;
      if (bundleOnly && /jito\.wtf\/api\/v1\/transactions/i.test(String(rawUrl)) && !/[?&]bundleOnly=/i.test(String(rawUrl))) {
        url = `${rawUrl}${String(rawUrl).includes('?') ? '&' : '?'}bundleOnly=true`;
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      t.unref?.();
      try {
        Promise.resolve(
          this.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
            signal: ctrl.signal,
          })
        )
          .catch(() => {})
          .finally(() => clearTimeout(t));
      } catch {
        clearTimeout(t);
      }
    }
  }

  fail(error, extra = {}) {
    this.lastError = { at: this.now(), error };
    return { ok: false, error, paper: false, ...extra };
  }

  record(entry) {
    this.trades.unshift({ t: this.now(), ...entry });
    if (this.trades.length > 300) this.trades.length = 300;
    try {
      this.onChange();
    } catch {
      // saving is best-effort
    }
  }

  async execute(args) {
    const mint = args?.token?.address;
    if (args?.side !== 'buy' || !mint) {
      if (args?.side === 'sell') args = { ...args, tokenAmount: this.sellAmountFor(mint, args.tokenAmount, args.positionTokens) };
      return this.executeNow(args);
    }
    if (!this.buyMintsInFlight) this.buyMintsInFlight = new Map();
    if (!this.activeBuyCount) this.activeBuyCount = new Map();
    this.buyMintsInFlight.set(mint, (this.buyMintsInFlight.get(mint) || 0) + 1);
    this.activeBuyCount.set(mint, (this.activeBuyCount.get(mint) || 0) + 1);
    try {
      return await this.executeNow(args);
    } finally {
      const act = (this.activeBuyCount.get(mint) || 1) - 1;
      if (act > 0) this.activeBuyCount.set(mint, act);
      else this.activeBuyCount.delete(mint);
      // keep it marked a moment longer: the engine books the new position right after this returns
      const t = setTimeout(() => {
        const n = (this.buyMintsInFlight.get(mint) || 1) - 1;
        if (n > 0) this.buyMintsInFlight.set(mint, n);
        else this.buyMintsInFlight.delete(mint);
      }, 3000);
      t.unref?.();
    }
  }

  async executeNow({ side, token, amountUsd, quote, slippagePct, tokenAmount, assetMode = 'native', newTokenAccount = false, urgent = false, positionTokens = null, deadlineAt = null, entryCeilingUsd = null }) {
    // Late-copy limit: a buy must be on its way while it can still land within the limit after the
    // trader's buy (~1 s to land). Checked here and again right before sending.
    const LAND_MS = 1000;
    const tooLate = () => side === 'buy' && Number.isFinite(Number(deadlineAt)) && deadlineAt > 0 && Date.now() > deadlineAt - LAND_MS;
    const lateError = () => "too late to send — it would land past the late-copy limit after the trader's buy";
    if (tooLate()) return this.fail(lateError(), { late: true });
    if (!this.ready()) return this.fail(this.keyError || 'real trading is not set up (ODEX_TRADER_KEY missing)');
    const px = Number(this.solPrice()) || 0;
    if (!(px > 0)) return this.fail('SOL price not known yet');
    if (Number.isInteger(token?.decimals)) this.decimals.set(token.address, token.decimals);
    const mint = token.address;
    const quoteMint = this.quoteAssetMint(assetMode);

    if (side === 'sell' && !urgent) {
      const until = this.sellBlockedUntil.get(mint) || 0;
      if (this.now() < until) return this.fail(`waiting ${Math.ceil((until - this.now()) / 1000)} s before retrying this sell`, { backoff: true });
    }

    // ----- buy limits -----
    let solIn = 0;
    let reserved = null; // this buy's entry in the daily-cap log
    let pendingAdded = 0; // this buy's SOL counted as "in progress"
    // a buy that never went out gives its daily-cap room back
    const release = (result) => {
      if (reserved) this.spendLog = this.spendLog.filter((x) => x !== reserved);
      reserved = null;
      return result;
    };
    try {
    if (side === 'buy') {
      solIn = amountUsd / px;
      if (this.caps.maxSolPerTrade > 0 && solIn > this.caps.maxSolPerTrade + 1e-9) {
        return this.fail(`buy of ${solIn.toFixed(4)} SOL is over the ${this.caps.maxSolPerTrade} SOL per-trade limit`);
      }
      const spent = this.spent24hSol();
      if (this.caps.maxSolPerDay > 0 && spent + solIn > this.caps.maxSolPerDay + 1e-9) {
        return this.fail(`daily limit reached: ${spent.toFixed(3)} of ${this.caps.maxSolPerDay} SOL spent in the last 24 h`);
      }
      // Count the buy against the daily cap right away, before any await: two buys running at
      // the same time could otherwise both pass the check and go over the cap together.
      reserved = { t: this.now(), sol: solIn };
      this.spendLog.push(reserved);
      // SOL already promised to other buys still in progress is not spendable. This buy's own SOL
      // is promised BEFORE any await, so two buys at the same moment can never both pass.
      const pendingSol = quoteMint === WSOL_MINT ? this.pendingBuySol : 0;
      if (quoteMint === WSOL_MINT) {
        pendingAdded = solIn;
        this.pendingBuySol += solIn;
      }
      try {
        const needSol = (quoteMint === WSOL_MINT ? solIn : 0) + pendingSol + this.caps.reserveSol;
        // Copy speed: the balance was read while Jupiter quoted (no extra wait). It is used only
        // if it is fresh and no other buy finished since (that buy's SOL could still be in it).
        const pre = this.prefetchedBalance;
        this.prefetchedBalance = null;
        const usable = pre && (quoteMint === WSOL_MINT || !pre.solOnly) && this.now() - pre.at < 5000 && pre.at > this.lastBuyDoneAt;
        const directBal = quote?._direct?.preLamports !== undefined && this.now() - quote.timestamp < 5000 && quote.timestamp > this.lastBuyDoneAt ? { sol: Number(quote._direct.preLamports) / LAMPORTS, usdc: this.balance?.usdc ?? 0, at: quote.timestamp } : null;
        const bal = directBal || (usable && (await pre.promise)) || (await this.refreshBalance({ solOnly: quoteMint === WSOL_MINT }));
        if (bal.sol < needSol) return release(this.fail(`not enough SOL: wallet has ${bal.sol.toFixed(4)}, needs ${needSol.toFixed(4)} (incl. ${this.caps.reserveSol} SOL kept for fees${pendingSol > 0 ? `, ${pendingSol.toFixed(4)} SOL for buys in progress` : ''})`));
        if (quoteMint === USDC_MINT && bal.usdc < amountUsd) return release(this.fail(`not enough USDC: wallet has ${bal.usdc.toFixed(2)}`));
      } catch (err) {
        return release(this.fail(`could not read wallet balance: ${err.message}`));
      }
    }

    // ----- route: direct pump.fun swap (Settings → Swap route), else Jupiter -----
    let order = null;
    let exec = null;
    let signature = null;
    let timing = null;
    let directNote = null;
    if (tooLate()) return release(this.fail(lateError(), { late: true }));
    if (quote?._direct && quote._side === side && this.now() - quote.timestamp < 6000) {
      const dr = await this.executeDirect({ side, token, quote, slippagePct, tooLate });
      if (dr.ok) {
        exec = dr.exec;
        signature = dr.signature;
        order = { inAmount: dr.inAmount };
        timing = { route: 'direct', quoteMs: quote._quoteMs ?? null, sendMs: dr.sendMs };
      } else if (dr.late) {
        // nothing was sent: skip the copy (Jupiter would be even later)
        release();
        return this.fail(dr.error, { late: true });
      } else if (dr.priceMoved && side === 'sell') {
        // a sell must get out: pump.fun refused our limit, so Jupiter (live slippage) takes it
        directNote = dr.error;
        this.noteFallback(`sell: ${dr.error}`);
        quote = null;
      } else if (dr.priceMoved) {
        this.directStats.priceSkips += 1;
        release();
        if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + this.caps.sellRetrySec * 1000);
        this.record({ side, mint, symbol: token.symbol, signature: dr.signature || null, ok: false, route: 'direct', error: dr.error });
        return { ok: false, error: `price moved too far before we could copy — ${dr.error}`, paper: false, priceMoved: true, txHash: dr.signature || null };
      } else if (dr.unknown) {
        // sent but not confirmed: never fall back (that could buy twice) — check the wallet
        this.record({ side, mint, symbol: token.symbol, signature: dr.signature, ok: null, route: 'direct', error: dr.error });
        if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + 30_000);
        return this.fail(`swap result unknown (${dr.error}). Check the wallet on Solscan: ${dr.signature}`, { unknown: true, txHash: dr.signature });
      } else {
        // nothing landed (or a failed swap changed nothing): use Jupiter instead
        directNote = dr.error;
        this.noteFallback(dr.error);
        quote = null;
      }
    }
    if (!exec) {
      // ----- order (reuse the quote's if it is fresh and for the same slippage) -----
      order = quote?._order;
      const fresh = order && quote._side === side && quote._slippagePct === slippagePct && this.now() - order.fetchedAt < 8000;
      let quoteMs = fresh ? quote._quoteMs ?? null : null;
      try {
        if (!fresh) {
          let q = await this.quote({ side, token, amountUsd, slippagePct, tokenAmount, assetMode, forceJupiter: true, urgent, positionTokens });
          // Enforce maxChasePct entryCeilingUsd on fallback / re-quoted Jupiter buys so a delayed fallback can never buy tops past maxChasePct
          if (side === 'buy' && Number(entryCeilingUsd) > 0 && Number(q.quotedPriceUsd) > 0) {
            const ceil = Number(entryCeilingUsd);
            let room = (1 - Number(q.quotedPriceUsd) / ceil) * 100;
            if (!(room >= 0.5)) {
              this.directStats.priceSkips += 1;
              return release({ ok: false, error: 'price moved too far before we could copy — fallback quote exceeded max chase ceiling', paper: false, priceMoved: true });
            }
            const curSlip = Number.isFinite(slippagePct) && slippagePct > 0 ? slippagePct : 10;
            if (room < curSlip) {
              const cappedSlip = Math.max(0.5, Math.floor(room * 10) / 10);
              q = await this.quote({ side, token, amountUsd, slippagePct: cappedSlip, tokenAmount, assetMode, forceJupiter: true, urgent, positionTokens });
              room = (1 - Number(q.quotedPriceUsd) / ceil) * 100;
              if (!(room >= cappedSlip - 0.05)) {
                this.directStats.priceSkips += 1;
                return release({ ok: false, error: 'price moved too far before we could copy — fallback quote exceeded max chase ceiling', paper: false, priceMoved: true });
              }
            }
          }
          order = q._order;
          quoteMs = q._quoteMs ?? null;
        }
      } catch (err) {
        if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + this.caps.sellRetrySec * 1000);
        // keep the reason flags: the engine pauses exits when the tokens are gone from the wallet
        return release(this.fail(err.message, { backoff: Boolean(err.backoff), noTokens: Boolean(err.noTokens) }));
      }

      if (tooLate()) return release(this.fail(lateError(), { late: true }));
      let signed;
      try {
        signed = signTransactionBase64(order.transaction, this.keypair);
      } catch (err) {
        return release(this.fail(`signing failed: ${err.message}`));
      }
      // the same signature is never sent or booked twice (a reused order would be one swap, booked twice)
      if (!this.sentSigs) this.sentSigs = new Map();
      for (const [k, t] of this.sentSigs) if (this.now() - t > 120_000) this.sentSigs.delete(k);
      const sigKey = signed.signature || signed.signedBase64.slice(4, 92);
      if (this.sentSigs.has(sigKey)) return release(this.fail('this exact swap was already sent — not sending it twice'));
      this.sentSigs.set(sigKey, this.now());
      // from here on the buy may reach the chain: it stays counted against the daily cap unless
      // it is known not to have landed (a lost response must not reopen the cap)

      let execErr = null;
      let fastChainConfirmed = false;
      const sendStart = this.now();
      // Blast the signed transaction directly (skipPreflight: true) to fast RPCs / Jito in parallel
      this.blastSignedTransaction(signed.signedBase64);
      const jupP = this.jup('/execute', { method: 'POST', body: { signedTransaction: signed.signedBase64, requestId: order.requestId }, timeoutMs: 45_000 }).then(
        (v) => ({ kind: 'jup', exec: v, err: null }),
        (err) => ({ kind: 'jup', exec: null, err })
      );
      const wsWatch = signed.signature ? this.watchSignatureOnce(signed.signature) : null;
      const wsConfirmP = wsWatch
        ? wsWatch.promise.then((st) => (st === 'success' ? { kind: 'chain', ok: true } : jupP))
        : null;
      try {
        if ((this.fastRpcUrls?.length > 0 || this.confirmWsUrl) && signed.signature) {
          let raceDone = false;
          let wakePoll = null;
          const chainConfirmP =
            this.fastRpcUrls?.length > 0
              ? (async () => {
                  let step = 0;
                  while (!raceDone) {
                    const waitMs = step < 4 ? 35 : step < 10 ? 65 : 100;
                    step += 1;
                    await Promise.race([
                      this.sleep(waitMs),
                      new Promise((r) => {
                        wakePoll = r;
                      }),
                    ]);
                    if (raceDone) break;
                    try {
                      const r = await this.rpc('getSignatureStatuses', [[signed.signature], { searchTransactionHistory: true }]);
                      const st = r?.value?.[0];
                      if (st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
                        return { kind: 'chain', ok: true };
                      }
                    } catch {
                      // keep racing until jupP finishes
                    }
                  }
                  return jupP;
                })()
              : null;
          const racers = [jupP, wsConfirmP, chainConfirmP].filter(Boolean);
          const winner = await Promise.race(racers);
          raceDone = true;
          wakePoll?.();
          if (winner?.kind === 'chain' && winner.ok) {
            fastChainConfirmed = true;
          } else {
            const jr = winner?.kind === 'jup' ? winner : await jupP;
            exec = jr.exec;
            execErr = jr.err;
          }
        } else {
          const racers = [jupP, wsConfirmP].filter(Boolean);
          const winner = await Promise.race(racers);
          if (winner?.kind === 'chain' && winner.ok) {
            fastChainConfirmed = true;
          } else {
            const jr = winner?.kind === 'jup' ? winner : await jupP;
            exec = jr.exec;
            execErr = jr.err;
          }
        }
      } finally {
        wsWatch?.cancel();
      }

      // copy speed, measured: Jupiter quote time and send → landed time
      timing = { route: 'jupiter', quoteMs, sendMs: this.now() - sendStart, ...(directNote ? { directFallback: directNote } : {}) };
      let landed = fastChainConfirmed || Boolean(exec && (exec.status === 'Success' || Number(exec.code) === 0));
      signature = exec?.signature || signed.signature;
      // The same signed swap was also sent straight to Solana: Jupiter can report "failed to land"
      // while our own copy lands. Check the chain briefly before calling it failed — otherwise the
      // tokens would sit in the wallet with no position tracking them.
      if (!fastChainConfirmed && exec && !landed && !execErr && this.fastRpcUrls?.length) {
        const st = await this.waitForSignature(signature, side === 'sell' ? 4000 : 8000);
        if (st === 'success') landed = true;
      }
      if (!fastChainConfirmed && (!exec || (!landed && execErr))) {
        // response lost: look the transaction up on-chain before deciding
        const st = await this.waitForSignature(signature, 30_000);
        landed = st === 'success';
        if (st === 'unknown') {
          this.record({ side, mint, symbol: token.symbol, signature, ok: null, error: `result unknown: ${execErr?.message || 'no response'}` });
          if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + 30_000);
          return this.fail(`swap result unknown (${execErr?.message || 'no response'}). Check the wallet on Solscan: ${signature}`, { unknown: true, txHash: signature });
        }
      }
      if (!landed) {
        release(); // a swap that did not land does not use up the daily cap
        if (side === 'sell') this.sellBlockedUntil.set(mint, this.now() + this.caps.sellRetrySec * 1000);
        const why = exec?.error || (exec?.code !== undefined ? `Jupiter code ${exec.code}` : execErr?.message || 'swap failed');
        this.record({ side, mint, symbol: token.symbol, signature, ok: false, error: why });
        return this.fail(`swap did not go through: ${why}`, { txHash: exec?.signature || null });
      }
    }
    this.sellBlockedUntil.delete(mint);

    // ----- exact amounts -----
    const tokDec = await this.getDecimals(mint).catch(() => null);
    let fill;
    try {
      fill = await this.readFill({
        signature,
        side,
        mint,
        quoteMint,
        exec: exec || (order?.outAmount ? { totalInputAmount: String(order.inAmount), totalOutputAmount: String(order.outAmount) } : null),
        exactExec: Boolean(exec),
        order,
        tokDec,
        newTokenAccount,
        fastCurve: Boolean(quote?._direct?.fastCurve),
      });
    } catch (err) {
      // The swap DID land: never report it as failed (that would leave untracked tokens in the
      // wallet). Book it from the quote and say the numbers are estimated.
      const big = (v) => {
        try {
          return BigInt(String(v));
        } catch {
          return null;
        }
      };
      const inputRaw = big(exec?.totalInputAmount) ?? big(order.inAmount);
      const outputRaw = big(exec?.totalOutputAmount) ?? big(order.outAmount);
      const dec = tokDec ?? this.decimals.get(mint);
      if (inputRaw === null || outputRaw === null || dec === undefined || dec === null) {
        this.record({ side, mint, symbol: token.symbol, signature, ok: true, error: `landed, amounts unreadable: ${err.message}` });
        return this.fail(`swap landed but its amounts could not be read — check the wallet: ${signature}`, { unknown: true, landed: true, txHash: signature });
      }
      fill = { inputRaw, outputRaw, inputFeeRaw: 0n, outputFeeRaw: 0n, networkLamports: 5000, tokDec: dec, estimated: true };
    }
    if (timing?.route !== 'direct') {
      if (!this.mintMetaCache) this.mintMetaCache = new Map();
      const prevMeta = this.mintMetaCache.get(mint);
      const tokenProgram = prevMeta?.tokenProgram || token?.curve?.tokenProgram || null;
      if (side === 'buy') {
        const prevHeld = prevMeta?.heldRaw || 0n;
        this.mintMetaCache.set(mint, { ...(tokenProgram ? { tokenProgram } : {}), heldRaw: prevHeld + BigInt(fill.outputRaw || 0n) });
      } else {
        const prevHeld = prevMeta?.heldRaw || 0n;
        const soldRaw = BigInt(fill.inputRaw || 0n);
        const rem = prevHeld > soldRaw ? prevHeld - soldRaw : 0n;
        this.mintMetaCache.set(mint, { ...(tokenProgram ? { tokenProgram } : {}), heldRaw: rem });
      }
    }
    const quoteUsd = (raw) => (quoteMint === WSOL_MINT ? (Number(raw) / LAMPORTS) * px : Number(raw) / 1e6);
    const networkFeeUsd = (fill.networkLamports / LAMPORTS) * px;
    let result;
    if (side === 'buy') {
      const spentUsd = quoteUsd(fill.inputRaw);
      const tokens = Number(fill.outputRaw) / 10 ** fill.tokDec;
      const routeFeeUsd = fill.inputFeeRaw > 0n ? quoteUsd(fill.inputFeeRaw) : 0;
      result = {
        ok: true,
        paper: false,
        txHash: signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        tokensReceived: tokens,
        spentUsd,
        platformFeeUsd: routeFeeUsd,
        networkFeeUsd,
        fillPriceUsd: tokens > 0 ? (spentUsd - routeFeeUsd) / tokens : quote?.expectedFillPriceUsd || 0,
        router: order.router || null,
        executedAt: this.now(),
      };
      // replace the reserved cap amount with what was really spent
      reserved.sol = quoteMint === WSOL_MINT ? Number(fill.inputRaw) / LAMPORTS : spentUsd / px;
    } else {
      const tokensSold = Number(fill.inputRaw) / 10 ** fill.tokDec;
      const receivedUsd = quoteUsd(fill.outputRaw); // what reached the wallet (before the network fee)
      const routeFeeUsd = fill.outputFeeRaw > 0n ? quoteUsd(fill.outputFeeRaw) : 0;
      result = {
        ok: true,
        paper: false,
        txHash: signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        tokensSold,
        receivedUsd,
        platformFeeUsd: routeFeeUsd,
        networkFeeUsd,
        // engine: gross − platform fee − network fee = what the wallet really gained
        fillPriceUsd: tokensSold > 0 ? (receivedUsd + routeFeeUsd) / tokensSold : 0,
        router: order.router || null,
        executedAt: this.now(),
      };
    }
    if (fill.estimated) result.estimated = true;
    result.timing = timing;
    this.record({ side, mint, symbol: token.symbol, signature, ok: true, timing, estimated: Boolean(fill.estimated), usd: Number((side === 'buy' ? result.spentUsd : result.receivedUsd).toFixed(4)), networkFeeUsd: Number(networkFeeUsd.toFixed(4)) });
    this.refreshBalance().catch(() => {});
    return result;
    } finally {
      if (pendingAdded) {
        this.lastBuyDoneAt = this.now();
        this.pendingBuySol -= pendingAdded;
        if (this.pendingBuySol < 1e-9) this.pendingBuySol = 0; // no float leftovers
      }
    }
  }

  /**
   * Close the bot wallet's EMPTY token accounts and get their rent back (≈0.002 SOL per coin
   * ever traded). skipMints: coins open or being bought. dryRun: only count what is reclaimable.
   */
  async reclaimRent({ skipMints = new Set(), dryRun = false } = {}) {
    if (!this.ready()) return { ok: false, error: this.keyError || 'real trading is not set up (ODEX_TRADER_KEY missing)' };
    if (this.reclaiming) return { ok: false, error: 'a rent reclaim is already running' };
    this.reclaiming = true;
    try {
      const r = await reclaimRentRun({ rpc: (m, p) => this.rpc(m, p), keypair: this.keypair, owner: this.address, skipMints, dryRun, waitForSignature: (sig, ms) => this.waitForSignature(sig, ms) });
      if (!dryRun && (r.closed || r.failed)) {
        this.record({ side: 'reclaim', symbol: `${r.closed} empty token account${r.closed === 1 ? '' : 's'}`, signature: r.signatures[0] || null, ok: r.closed > 0, sol: Number(r.reclaimedSol.toFixed(6)), error: r.failed ? `${r.failed} could not be closed: ${r.errors[0] || ''}` : null });
        this.refreshBalance().catch(() => {});
      }
      this.lastReclaim = { at: this.now(), ...r };
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      this.reclaiming = false;
    }
  }

  /** Confirm signature status via WebSocket push + micro-poll race: 'success' | 'failed' | 'unknown'. */
  async waitForSignature(signature, maxMs) {
    const hit = this.resolvedSigs?.get(signature);
    if (hit && this.now() - hit.at < 60_000) return hit.status;
    const wsWatch = this.watchSignatureOnce(signature);
    let done = false;
    let wakeSleep = null;
    const pollP = (async () => {
      const until = this.now() + maxMs;
      let step = 0;
      while (!done && this.now() < until) {
        try {
          const r = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
          const st = r?.value?.[0];
          if (st) {
            if (st.err) {
              if (!this.lastSigErrors) this.lastSigErrors = new Map();
              if (this.lastSigErrors.size > 200) this.lastSigErrors.clear();
              this.lastSigErrors.set(signature, st.err);
              return 'failed';
            }
            if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'success';
          }
        } catch {
          // keep trying
        }
        if (done) break;
        const waitMs = step < 4 ? 35 : step < 10 ? 65 : 100;
        step += 1;
        await Promise.race([
          this.sleep(waitMs),
          new Promise((r) => {
            wakeSleep = r;
          }),
        ]);
      }
      return 'unknown';
    })();
    try {
      return await Promise.race([wsWatch.promise, pollP]);
    } finally {
      done = true;
      wakeSleep?.();
      wsWatch.cancel();
    }
  }

  /**
   * Exact amounts: Jupiter's execute result where present, the on-chain transaction for the
   * network fee (fee + priority + new token-account rent).
   */
  async readFill({ signature, side, mint, quoteMint, exec, exactExec = true, order, tokDec, newTokenAccount = false, fastCurve = false }) {
    const big = (v) => {
      try {
        return v === undefined || v === null || v === '' ? null : BigInt(String(v));
      } catch {
        return null;
      }
    };
    let inputRaw = big(exec?.totalInputAmount) ?? big(exec?.inputAmountResult) ?? big(order.inAmount);
    let outputRaw = big(exec?.totalOutputAmount) ?? big(exec?.outputAmountResult);
    const inputFeeRaw = big(exec?.totalInputAmount) !== null && big(exec?.inputAmountResult) !== null ? big(exec.totalInputAmount) - big(exec.inputAmountResult) : 0n;
    const outputFeeRaw = big(exec?.outputAmountResult) !== null && big(exec?.totalOutputAmount) !== null ? big(exec.outputAmountResult) - big(exec.totalOutputAmount) : 0n;
    let networkLamports = Number.isFinite(Number(exec?.networkLamports)) && Number(exec.networkLamports) >= 5000 ? Number(exec.networkLamports) : 5000;
    let decimals = tokDec;
    const cachedOwn = this.ownTxCache?.get(signature);
    let tx = cachedOwn && this.now() - cachedOwn.at < 120_000 ? cachedOwn.tx : null;
    // When Jupiter /execute or Direct simulation already gave exact input & output amounts, never sleep
    // waiting on getTransaction indexing: check ownTxCache (0 ms) or try once immediately (0 sleep).
    // On fastCurve direct swaps where simulation already computed exact amounts, book in 0 ms without blocking on getTransaction.
    const haveExecAmounts = inputRaw !== null && outputRaw !== null;
    const maxTries = tx || (fastCurve && haveExecAmounts) ? 0 : exactExec && haveExecAmounts ? 1 : haveExecAmounts ? 2 : 6;
    const waitMs = haveExecAmounts ? 45 : 200;
    for (let i = 0; i < maxTries && !tx; i++) {
      try {
        tx = await this.rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      } catch {
        tx = null;
      }
      if (!tx && i + 1 < maxTries) await this.sleep(waitMs);
    }
    // Fast path (the transaction was not read): a first buy of a coin still paid the token
    // account's rent. Count it, or rent reclaim would later book that same SOL as extra profit.
    if (!tx && side === 'buy' && newTokenAccount) networkLamports += 2_039_280;
    if (tx?.meta) {
      const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      if (keys.includes(TOKEN_2022_PROGRAM) && !this.mintMetaCache?.get(mint)?.tokenProgram) {
        if (!this.mintMetaCache) this.mintMetaCache = new Map();
        this.mintMetaCache.set(mint, { ...(this.mintMetaCache.get(mint) || {}), tokenProgram: TOKEN_2022_PROGRAM });
      } else if (keys.includes(TOKEN_PROGRAM) && !keys.includes(TOKEN_2022_PROGRAM) && !this.mintMetaCache?.get(mint)?.tokenProgram) {
        if (!this.mintMetaCache) this.mintMetaCache = new Map();
        this.mintMetaCache.set(mint, { ...(this.mintMetaCache.get(mint) || {}), tokenProgram: TOKEN_PROGRAM });
      }
      const me = keys.indexOf(this.address);
      const solDelta = me >= 0 ? BigInt(tx.meta.postBalances[me]) - BigInt(tx.meta.preBalances[me]) : null; // lamports
      const tokDelta = (m) => {
        let pre = 0n;
        let post = 0n;
        for (const b of tx.meta.preTokenBalances || []) if (b.owner === this.address && b.mint === m) {
          pre += BigInt(b.uiTokenAmount.amount);
          decimals = m === mint ? b.uiTokenAmount.decimals : decimals;
        }
        for (const b of tx.meta.postTokenBalances || []) if (b.owner === this.address && b.mint === m) {
          post += BigInt(b.uiTokenAmount.amount);
          decimals = m === mint ? b.uiTokenAmount.decimals : decimals;
        }
        return post - pre;
      };
      const tDelta = tokDelta(mint);
      if (side === 'buy') {
        if (tDelta > 0n) outputRaw = tDelta;
        if (quoteMint === WSOL_MINT && solDelta !== null) {
          const spent = -solDelta; // swap input + fees + rent
          if (inputRaw === null) inputRaw = spent;
          networkLamports = Number(spent - inputRaw);
        } else networkLamports = Number(tx.meta.fee || 5000);
      } else {
        if (tDelta < 0n) inputRaw = -tDelta;
        if (quoteMint === WSOL_MINT && solDelta !== null) {
          if (outputRaw === null) outputRaw = solDelta + BigInt(tx.meta.fee || 5000);
          networkLamports = Number(outputRaw - solDelta);
        } else networkLamports = Number(tx.meta.fee || 5000);
      }
      if (!(networkLamports >= 0)) networkLamports = Number(tx.meta.fee || 5000);
    }
    if (decimals === null || decimals === undefined) decimals = await this.getDecimals(mint);
    if (inputRaw === null || outputRaw === null) throw new Error('swap landed but amounts could not be read');
    return { inputRaw, outputRaw, inputFeeRaw: inputFeeRaw > 0n ? inputFeeRaw : 0n, outputFeeRaw: outputFeeRaw > 0n ? outputFeeRaw : 0n, networkLamports, tokDec: decimals };
  }

  /**
   * Safe end-to-end check that sends nothing: builds a tiny SOL→USDC order for the bot wallet,
   * signs it and asks the RPC to simulate it with signature verification.
   */
  async selfTest() {
    if (!this.ready()) return { ok: false, error: this.keyError || 'ODEX_TRADER_KEY is not set in .env' };
    const steps = [];
    try {
      const probe = crypto.randomBytes(32);
      if (!this.keypair.verify(probe, this.keypair.sign(probe))) throw new Error('key cannot produce valid signatures');
      steps.push(`key loaded and signs correctly (wallet ${this.address})`);
      const bal = await this.refreshBalance();
      steps.push(`balance: ${bal.sol.toFixed(4)} SOL, ${bal.usdc.toFixed(2)} USDC`);
      if (bal.sol < 0.003) {
        steps.push('wallet needs SOL before a swap can be simulated — send some SOL to it, then run the test again');
        return { ok: true, steps, warning: 'Key works. Fund the wallet to finish the test.' };
      }
      const lamports = 1_000_000n; // 0.001 SOL
      const o = await this.order({ inputMint: WSOL_MINT, outputMint: USDC_MINT, amountRaw: lamports, slippagePct: 1 });
      steps.push(`Jupiter route ok (${o.router || 'route'}), 0.001 SOL → ${(Number(o.outAmount) / 1e6).toFixed(4)} USDC`);
      const s = signTransactionBase64(o.transaction, this.keypair);
      steps.push('transaction signed with the bot key');
      const sim = await this.rpc('simulateTransaction', [s.signedBase64, { encoding: 'base64', sigVerify: true, commitment: 'processed' }]);
      const err = sim?.value?.err;
      if (err) {
        steps.push(`simulation failed: ${JSON.stringify(err)}`);
        return { ok: false, steps, error: `simulation failed: ${JSON.stringify(err)}` };
      }
      steps.push('simulation passed (signature valid, swap would succeed) — nothing was sent');
      return { ok: true, steps };
    } catch (err) {
      steps.push(`error: ${err.message}`);
      return { ok: false, steps, error: err.message };
    }
  }
}
