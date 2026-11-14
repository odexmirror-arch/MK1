/**
 * Yellowstone gRPC (Geyser) live feed — zero dependencies (node:http2 + a minimal protobuf codec).
 *
 * Subscribes to the transactions of the followed wallets (vote and failed transactions excluded,
 * so spam costs no bandwidth) at `processed` commitment and hands each one to `onTx` with the
 * signature, slot, error and log messages — the same shape the WebSocket feeds deliver, so the
 * watcher's fast trade detection and dedupe work unchanged. Reconnects with backoff; answers the
 * server's pings and pings on its own to keep the stream open.
 *
 * Schema (yellowstone-grpc geyser.proto / solana-storage.proto), only the fields used here:
 *   SubscribeRequest { map<string, FilterTransactions> transactions = 3; optional CommitmentLevel commitment = 6; optional Ping ping = 9; }
 *   FilterTransactions { optional bool vote = 1; optional bool failed = 2; repeated string account_include = 3; }
 *   SubscribeUpdate { repeated string filters = 1; oneof { Transaction transaction = 4; Ping ping = 6; Pong pong = 9; } }
 *   SubscribeUpdateTransaction { TransactionInfo transaction = 1; uint64 slot = 2; }
 *   TransactionInfo { bytes signature = 1; bool is_vote = 2; Transaction transaction = 3; TransactionStatusMeta meta = 4; }
 *   TransactionStatusMeta { TransactionError err = 1; repeated string log_messages = 6; bool log_messages_none = 11; }
 */
import http2 from 'node:http2';
import { base58Encode } from './onchainMeta.mjs';

// ---------- minimal protobuf ----------
function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const fVarint = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const fBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const fString = (field, s) => fBytes(field, Buffer.from(String(s), 'utf8'));

/** Parse one protobuf message into [{ field, wire, value }] (value: BigInt for varints, Buffer otherwise). */
export function pbFields(buf) {
  const out = [];
  let o = 0;
  const readVarint = () => {
    let r = 0n;
    let shift = 0n;
    for (;;) {
      if (o >= buf.length) throw new Error('truncated varint');
      const b = buf[o++];
      r |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return r;
      shift += 7n;
    }
  };
  while (o < buf.length) {
    const key = Number(readVarint());
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: readVarint() });
    else if (wire === 2) {
      const len = Number(readVarint());
      if (o + len > buf.length) throw new Error('truncated field');
      out.push({ field, wire, value: buf.subarray(o, o + len) });
      o += len;
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(o, o + 8) });
      o += 8;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(o, o + 4) });
      o += 4;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}
const first = (fields, n) => fields.find((f) => f.field === n);

function readRepeatedU64(fields, fieldNum) {
  const out = [];
  for (const f of fields) {
    if (f.field !== fieldNum) continue;
    if (f.wire === 0) out.push(Number(f.value));
    else if (f.wire === 2 && Buffer.isBuffer(f.value)) {
      let o = 0;
      const b = f.value;
      while (o < b.length) {
        let r = 0n;
        let shift = 0n;
        for (;;) {
          if (o >= b.length) break;
          const byte = b[o++];
          r |= BigInt(byte & 0x7f) << shift;
          if (!(byte & 0x80)) break;
          shift += 7n;
        }
        out.push(Number(r));
      }
    }
  }
  return out;
}

function decodeTokenBalance(buf) {
  const tf = pbFields(buf);
  const accIdx = first(tf, 1);
  const mint = first(tf, 2);
  const uiTok = first(tf, 3);
  const owner = first(tf, 4);
  if (!mint || !uiTok) return null;
  const uf = pbFields(uiTok.value);
  const uiAmt = first(uf, 1);
  const dec = first(uf, 2);
  const amtStr = first(uf, 3);
  const uiAmtStr = first(uf, 4);
  return {
    accountIndex: accIdx ? Number(accIdx.value) : 0,
    mint: mint.value.toString('utf8'),
    owner: owner ? owner.value.toString('utf8') : null,
    uiTokenAmount: {
      amount: amtStr ? amtStr.value.toString('utf8') : '0',
      decimals: dec ? Number(dec.value) : 0,
      uiAmount: uiAmt && uiAmt.value.length === 8 ? uiAmt.value.readDoubleLE(0) : null,
      uiAmountString: uiAmtStr ? uiAmtStr.value.toString('utf8') : undefined,
    },
  };
}

function decodeTimestampMs(buf) {
  if (!buf || !buf.length) return null;
  const f = pbFields(buf);
  const sec = Number(first(f, 1)?.value ?? 0);
  const nanos = Number(first(f, 2)?.value ?? 0);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0);
}

function decodeGrpcTransaction({ signature, slot, fi, mf, err, logs, createdAtMs = null }) {
  try {
    const txMsgField = first(fi, 3);
    if (!txMsgField || txMsgField.wire !== 2) return null;
    const txFields = pbFields(txMsgField.value);
    const msgField = first(txFields, 2);
    if (!msgField || msgField.wire !== 2) return null;
    const msgFields = pbFields(msgField.value);
    const hdrField = first(msgFields, 1);
    const hdrFields = hdrField && hdrField.wire === 2 ? pbFields(hdrField.value) : [];
    const numSigners = Number(first(hdrFields, 1)?.value ?? 1);
    const staticKeys = msgFields.filter((x) => x.field === 2 && x.wire === 2 && x.value.length === 32).map((x) => base58Encode(x.value));
    if (!staticKeys.length) return null;
    const loadedW = mf.filter((x) => x.field === 12 && x.wire === 2 && x.value.length === 32).map((x) => base58Encode(x.value));
    const loadedR = mf.filter((x) => x.field === 13 && x.wire === 2 && x.value.length === 32).map((x) => base58Encode(x.value));
    const accountKeys = [
      ...staticKeys.map((pubkey, i) => ({ pubkey, signer: i < numSigners })),
      ...loadedW.map((pubkey) => ({ pubkey, signer: false })),
      ...loadedR.map((pubkey) => ({ pubkey, signer: false })),
    ];
    const preBalances = readRepeatedU64(mf, 3);
    const postBalances = readRepeatedU64(mf, 4);
    if (!preBalances.length || !postBalances.length) return null;
    const feeField = first(mf, 2);
    const preTokenBalances = mf.filter((x) => x.field === 7 && x.wire === 2).map((x) => decodeTokenBalance(x.value)).filter(Boolean);
    const postTokenBalances = mf.filter((x) => x.field === 8 && x.wire === 2).map((x) => decodeTokenBalance(x.value)).filter(Boolean);
    const nowMs = Date.now();
    const saneCreatedAt = Number.isFinite(createdAtMs) && createdAtMs <= nowMs ? createdAtMs : null;
    const refMs = saneCreatedAt ?? nowMs;
    return {
      slot: slot ?? null,
      blockTime: Math.floor(refMs / 1000),
      blockTimeMs: saneCreatedAt,
      meta: {
        err: err || null,
        fee: feeField ? Number(feeField.value) : 5000,
        preBalances,
        postBalances,
        preTokenBalances,
        postTokenBalances,
        logMessages: Array.isArray(logs) ? logs : [],
      },
      transaction: {
        signatures: signature ? [signature] : [],
        message: { accountKeys },
      },
    };
  } catch {
    return null;
  }
}

// ---------- messages ----------
const COMMITMENT = { processed: 0, confirmed: 1, finalized: 2 };

/** SubscribeRequest: one transaction filter per wallet (the filter name is the wallet address). */
export function encodeSubscribeRequest({ wallets = [], commitment = 'processed', pingId = null } = {}) {
  const parts = [];
  for (const w of wallets) {
    const filter = Buffer.concat([fVarint(1, 0), fVarint(2, 0), fString(3, w)]); // vote=false, failed=false, account_include=[w]
    parts.push(fBytes(3, Buffer.concat([fString(1, w), fBytes(2, filter)]))); // map entry { key, value }
  }
  parts.push(fVarint(6, COMMITMENT[commitment] ?? 0));
  if (pingId !== null) parts.push(fBytes(9, fVarint(1, pingId)));
  return Buffer.concat(parts);
}

/** SubscribeUpdate → { kind: 'tx', filters, signature, slot, err, logs, isVote } | { kind: 'ping' } | { kind: 'pong' } | { kind: 'other' } */
export function decodeSubscribeUpdate(buf) {
  const f = pbFields(buf);
  const filters = f.filter((x) => x.field === 1 && x.wire === 2).map((x) => x.value.toString('utf8'));
  const tx = first(f, 4);
  if (tx && tx.wire === 2) {
    const t = pbFields(tx.value);
    const info = first(t, 1);
    const slot = first(t, 2);
    const fi = info ? pbFields(info.value) : [];
    const sig = first(fi, 1);
    const isVote = first(fi, 2);
    const meta = first(fi, 4);
    const mf = meta ? pbFields(meta.value) : [];
    const errField = first(mf, 1);
    const logsNone = first(mf, 11);
    const logs = mf.filter((x) => x.field === 6 && x.wire === 2).map((x) => x.value.toString('utf8'));
    const signature = sig ? base58Encode(sig.value) : null;
    const slotNum = slot ? Number(slot.value) : null;
    const errObj = errField && errField.value?.length ? { encoded: errField.value.toString('base64') } : null;
    const logsList = logsNone && logsNone.value ? null : logs;
    const createdAtField = first(f, 11);
    const createdAtMs = createdAtField && createdAtField.wire === 2 ? decodeTimestampMs(createdAtField.value) : null;
    const parsedTx = !errObj ? decodeGrpcTransaction({ signature, slot: slotNum, fi, mf, err: errObj, logs: logsList, createdAtMs }) : null;
    const out = {
      kind: 'tx',
      filters,
      signature,
      slot: slotNum,
      createdAtMs,
      // any TransactionError means the transaction failed (its exact code is not needed here)
      err: errObj,
      logs: logsList,
      isVote: Boolean(isVote && isVote.value),
    };
    if (parsedTx) out.tx = parsedTx;
    return out;
  }
  if (first(f, 6)) return { kind: 'ping' };
  if (first(f, 9)) return { kind: 'pong' };
  return { kind: 'other' };
}

const frame = (msg) => {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(msg.length, 1);
  return Buffer.concat([h, msg]);
};

// ---------- client ----------
export class YellowstoneFeed {
  /**
   * url: http(s)://host:port[?api-key=…] — the key (from the URL or `token`) is sent as x-token.
   * onTx(address, { signature, err, logs, slot, receivedAt })
   */
  constructor({ url, token = null, onTx = () => {}, onChange = () => {}, redactUrl = (s) => s, connect = http2.connect, pingMs = 10_000, maxBackoffMs = 30_000 } = {}) {
    const u = new URL(url);
    this.token = token || u.searchParams.get('api-key') || u.searchParams.get('x-token') || null;
    u.search = '';
    this.origin = u.origin;
    this.onTx = onTx;
    this.onChange = onChange;
    this.redactUrl = redactUrl;
    this.connect = connect;
    this.pingMs = pingMs;
    this.maxBackoffMs = maxBackoffMs;
    this.wallets = new Set();
    this.running = false;
    this.session = null;
    this.stream = null;
    this.backoff = 1000;
    this.stats = { connected: false, connects: 0, txs: 0, bytes: 0, lastTxAt: null, lastError: null, lastErrorAt: null };
  }

  status() {
    return { kind: 'yellowstone-grpc', url: this.redactUrl(this.origin), wallets: this.wallets.size, ...this.stats };
  }

  setWallets(addresses) {
    const next = new Set(addresses);
    const same = next.size === this.wallets.size && [...next].every((a) => this.wallets.has(a));
    this.wallets = next;
    // a new SubscribeRequest on the open stream replaces the filters
    if (!same && this.stream && !this.stream.closed) this.write(encodeSubscribeRequest({ wallets: [...this.wallets] }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try {
      this.stream?.close();
    } catch {
      // ignore
    }
    try {
      this.session?.close();
    } catch {
      // ignore
    }
    this.stream = null;
    this.session = null;
    this.stats.connected = false;
    this.onChange();
  }

  write(msg) {
    try {
      this.stream?.write(frame(msg));
    } catch {
      // the close handler reconnects
    }
  }

  fail(why) {
    this.stats.lastError = this.redactUrl(String(why)).slice(0, 200);
    this.stats.lastErrorAt = Date.now();
    this.stats.connected = false;
    clearInterval(this.pingTimer);
    try {
      this.session?.destroy();
    } catch {
      // ignore
    }
    this.session = null;
    this.stream = null;
    this.onChange();
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.backoff);
    this.retryTimer.unref?.();
    this.backoff = Math.min(this.maxBackoffMs, this.backoff * 2);
  }

  open() {
    if (!this.running) return;
    if (!this.wallets.size) {
      // nothing to watch yet: check again shortly
      this.retryTimer = setTimeout(() => this.open(), 5000);
      this.retryTimer.unref?.();
      return;
    }
    let session;
    try {
      session = this.connect(this.origin);
    } catch (err) {
      return this.fail(err.message);
    }
    this.session = session;
    session.on('error', (err) => this.fail(err.message));
    session.on('goaway', () => this.fail('server closed the connection'));
    const headers = { ':method': 'POST', ':path': '/geyser.Geyser/Subscribe', 'content-type': 'application/grpc', te: 'trailers' };
    if (this.token) {
      headers['x-token'] = this.token;
      headers['x-api-key'] = this.token;
    }
    const stream = session.request(headers, { endStream: false });
    this.stream = stream;
    let buf = Buffer.alloc(0);
    stream.on('response', (h) => {
      const status = h['grpc-status'];
      if (status !== undefined && String(status) !== '0') return this.fail(`gRPC ${status}: ${h['grpc-message'] || 'refused'}`);
      this.stats.connected = true;
      this.stats.connects += 1;
      this.backoff = 1000;
      this.onChange();
    });
    stream.on('data', (chunk) => {
      this.stats.bytes += chunk.length;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const msg = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        this.handle(msg);
      }
    });
    stream.on('trailers', (h) => {
      const status = h['grpc-status'];
      if (status !== undefined && String(status) !== '0') this.fail(`gRPC ${status}: ${decodeURIComponent(String(h['grpc-message'] || 'stream ended'))}`);
    });
    stream.on('error', (err) => this.fail(err.message));
    stream.on('close', () => {
      if (this.stream === stream) this.fail('stream closed');
    });
    this.write(encodeSubscribeRequest({ wallets: [...this.wallets] }));
    clearInterval(this.pingTimer);
    let pingId = 1;
    this.pingTimer = setInterval(() => this.write(encodeSubscribeRequest({ wallets: [...this.wallets], pingId: pingId++ })), this.pingMs);
    this.pingTimer.unref?.();
  }

  handle(msg) {
    let u;
    try {
      u = decodeSubscribeUpdate(msg);
    } catch {
      return; // malformed message: skip it
    }
    if (u.kind === 'ping') {
      // the server checks the client is alive
      this.write(encodeSubscribeRequest({ wallets: [...this.wallets], pingId: 1 }));
      return;
    }
    if (u.kind !== 'tx' || !u.signature || u.isVote) return;
    this.stats.txs += 1;
    this.stats.lastTxAt = Date.now();
    const receivedAt = Date.now();
    // the filter name is the watched wallet the transaction matched
    const addresses = u.filters.length ? u.filters : [...this.wallets];
    for (const address of addresses) {
      if (!this.wallets.has(address)) continue;
      try {
        this.onTx(address, { signature: u.signature, err: u.err, logs: u.logs, slot: u.slot, tx: u.tx || null, createdAtMs: u.createdAtMs ?? null, receivedAt });
      } catch {
        // listener errors never break the feed
      }
    }
  }
}
