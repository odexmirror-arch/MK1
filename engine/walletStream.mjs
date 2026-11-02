/**
 * Real-time wallet stream: Solana WebSocket `logsSubscribe` (one subscription per wallet).
 *
 * The RPC pushes every transaction that mentions a watched wallet the moment it is
 * confirmed (~0.4–1 s after the trader's trade), instead of us asking every 15 s.
 * Polling keeps running as a safety net; both paths share one "seen signature" set, so a
 * trade is never handled twice.
 *
 * Zero dependencies: uses the WebSocket built into Node 22.
 */

// Programs whose instructions are swaps (pump.fun, PumpSwap, Jupiter, Raydium, Meteora, Orca, …)
export const SWAP_PROGRAMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // pump.fun bonding curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', // Meteora dynamic bonding curve
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
];
const SWAP_IX_RE = /Instruction: (Buy|Sell|Swap\w*|BuyExact\w*|SellExact\w*|Route|SharedAccountsRoute|ExactOutRoute|SharedAccountsExactOutRoute)\b/;

/** Cheap pre-filter on the pushed logs: only possible swaps are worth a getTransaction call. */
export function looksLikeSwap(logs) {
  if (!Array.isArray(logs) || !logs.length) return true; // no logs to judge → let the parser decide
  const text = logs.join('\n');
  if (/Log truncated/i.test(text)) return true;
  if (SWAP_IX_RE.test(text)) return true;
  return SWAP_PROGRAMS.some((p) => text.includes(`Program ${p} invoke`));
}

/** https://host/path → wss://host/path (Alchemy, Helius, QuickNode and the public RPC all work this way). */
export function toWsUrl(httpUrl) {
  try {
    const u = new URL(httpUrl);
    if (u.protocol === 'https:') u.protocol = 'wss:';
    else if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export class WalletStream {
  constructor({
    url = null,
    WebSocketImpl = globalThis.WebSocket,
    onLogs = () => {},
    onAccount = () => {},
    onAccountUnsupported = () => {},
    onChange = () => {},
    commitment = process.env.ODEX_STREAM_COMMITMENT || 'processed',
    keepaliveMs = 30_000,
    maxBackoffMs = 30_000,
    redactUrl = (s) => s,
    floodPerSec = 25,
    floodCooldownMs = 15 * 60_000,
  } = {}) {
    this.url = url;
    this.WS = WebSocketImpl;
    this.onLogs = onLogs;
    this.onAccount = onAccount;
    this.onAccountUnsupported = onAccountUnsupported;
    this.accountUnsupported = false;
    this.onChange = onChange;
    this.commitment = commitment;
    this.keepaliveMs = keepaliveMs;
    this.maxBackoffMs = maxBackoffMs;
    this.redactUrl = redactUrl;
    // A wallet that is mentioned by hundreds of transactions a second (shared program / fee
    // accounts, spam-flooded wallets) would drown the stream: drop it from real-time for a while.
    this.floodPerSec = floodPerSec;
    this.floodCooldownMs = floodCooldownMs;
    this.rate = new Map(); // address → { windowStart, count }
    this.tooBusy = new Map(); // address → retry-after timestamp
    // Spam-flooded wallets: watch only their SOL balance (accountSubscribe). Spam does not move
    // it; the owner's own buys and sells do, and each change triggers an immediate check.
    this.accountMode = new Set();
    this.subKind = new Map(); // address → 'logs' | 'account'
    this.wanted = new Set(); // wallet addresses we want subscribed
    this.subs = new Map(); // address → subscription id
    this.subByID = new Map(); // subscription id → address
    this.pending = new Map(); // request id → { kind, address }
    this.ws = null;
    this.running = false;
    this.nextId = 1;
    this.backoffMs = 1000;
    this.timers = { reconnect: null, keepalive: null, deadline: null, connect: null };
    this.stats = { connected: false, connectedAt: null, downSince: null, events: 0, swapEvents: 0, lastEventAt: null, reconnects: 0, lastError: null, lastErrorAt: null };
  }

  get supported() {
    return typeof this.WS === 'function' && Boolean(this.url);
  }

  status() {
    return {
      enabled: this.running,
      provider: /helius-rpc\.com/i.test(this.url || '') ? 'helius' : /alchemy\.com/i.test(this.url || '') ? 'alchemy' : /mainnet-beta\.solana\.com/i.test(this.url || '') ? 'public' : 'custom',
      supported: this.supported,
      connected: this.stats.connected,
      connectedAt: this.stats.connectedAt,
      downSince: this.stats.downSince,
      subscriptions: this.subs.size,
      wanted: this.wanted.size,
      balanceWatch: [...this.accountMode],
      tooBusy: [...this.tooBusy].filter(([, t]) => Date.now() < t).map(([address, retryAt]) => ({ address, retryAt })),
      events: this.stats.events,
      swapEvents: this.stats.swapEvents,
      lastEventAt: this.stats.lastEventAt,
      reconnects: this.stats.reconnects,
      lastError: this.stats.lastError,
      lastErrorAt: this.stats.lastErrorAt,
    };
  }

  changed() {
    try {
      this.onChange(this.status());
    } catch {
      // ignore
    }
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    if (this.running) this.reconnectNow();
  }

  setWallets(addresses) {
    this.wanted = new Set(addresses);
    if (!this.isOpen()) return;
    for (const a of this.wanted) if (!this.subs.has(a) && !this.isPending(a)) this.subscribe(a);
    for (const [a, id] of [...this.subs]) {
      if (!this.wanted.has(a)) {
        this.unsubscribe(a, id);
        this.accountMode.delete(a);
      }
    }
    for (const a of [...this.accountMode]) if (!this.wanted.has(a)) this.accountMode.delete(a);
    this.changed();
  }

  isOpen() {
    return this.ws && this.ws.readyState === 1;
  }

  isPending(address) {
    for (const p of this.pending.values()) if (p.kind === 'sub' && p.address === address) return true;
    return false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.downSince = Date.now();
    this.connect();
  }

  stop() {
    this.running = false;
    for (const k of Object.keys(this.timers)) {
      clearTimeout(this.timers[k]);
      clearInterval(this.timers[k]);
      this.timers[k] = null;
    }
    this.teardown();
    this.changed();
  }

  teardown() {
    const ws = this.ws;
    this.ws = null;
    this.subs.clear();
    this.subByID.clear();
    this.subKind.clear();
    this.pending.clear();
    this.stats.connected = false;
    if (ws) {
      try {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  fail(message) {
    this.stats.lastError = this.redactUrl(String(message || 'stream error'));
    this.stats.lastErrorAt = Date.now();
  }

  connect() {
    if (!this.running) return;
    if (!this.supported) {
      this.fail(typeof this.WS !== 'function' ? 'WebSocket not available in this Node version (needs Node 22+)' : 'no stream URL');
      this.changed();
      return;
    }
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.fail(err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      clearTimeout(this.timers.connect);
      this.stats.connected = true;
      this.stats.connectedAt = Date.now();
      this.stats.downSince = null;
      this.backoffMs = 1000;
      for (const a of this.wanted) this.subscribe(a);
      this.startKeepalive();
      this.changed();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    // Node's WebSocket reports a failed handshake with only an 'error' (no 'close'), so a
    // connection that never opened is treated as closed here; a 10 s connect timeout covers hangs.
    const dropped = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.timers.connect);
      this.teardown();
      this.stats.downSince = this.stats.downSince || Date.now();
      this.changed();
      this.scheduleReconnect();
    };
    clearTimeout(this.timers.connect);
    this.timers.connect = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) {
        this.fail('stream connection timed out');
        dropped();
      }
    }, 10_000);
    this.timers.connect.unref?.();
    ws.onerror = (ev) => {
      this.fail(ev?.message || ev?.error?.message || 'connection error');
      if (ws.readyState !== 1) dropped();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (ev && ev.code && ev.code !== 1000) this.fail(`connection closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      dropped();
    };
  }

  scheduleReconnect() {
    if (!this.running) return;
    clearTimeout(this.timers.reconnect);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
    this.stats.reconnects += 1;
    this.timers.reconnect = setTimeout(() => this.connect(), wait);
    this.timers.reconnect.unref?.();
  }

  reconnectNow() {
    clearTimeout(this.timers.reconnect);
    this.teardown();
    this.stats.downSince = this.stats.downSince || Date.now();
    this.backoffMs = 1000;
    this.connect();
  }

  /** Every 30 s send a tiny request; no answer within 10 s means the connection is dead. */
  startKeepalive() {
    clearInterval(this.timers.keepalive);
    this.timers.keepalive = setInterval(() => {
      if (!this.isOpen()) return;
      const id = this.send({ method: 'slotUnsubscribe', params: [0] }, { kind: 'ping' });
      clearTimeout(this.timers.deadline);
      this.timers.deadline = setTimeout(() => {
        if (this.pending.has(id)) {
          this.fail('no answer from the stream (keepalive timed out)');
          this.reconnectNow();
        }
      }, 10_000);
      this.timers.deadline.unref?.();
    }, this.keepaliveMs);
    this.timers.keepalive.unref?.();
  }

  send(msg, meta = null) {
    const id = this.nextId++;
    if (meta) this.pending.set(id, meta);
    try {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...msg }));
    } catch (err) {
      this.fail(err.message);
    }
    return id;
  }

  subscribe(address) {
    const until = this.tooBusy.get(address);
    if (until && Date.now() < until) return;
    if (until) this.tooBusy.delete(address);
    if (this.accountMode.has(address)) {
      this.send({ method: 'accountSubscribe', params: [address, { commitment: this.commitment, encoding: 'base64' }] }, { kind: 'sub', address, sub: 'account' });
    } else {
      this.send({ method: 'logsSubscribe', params: [{ mentions: [address] }, { commitment: this.commitment }] }, { kind: 'sub', address, sub: 'logs' });
    }
  }

  /** Watch a wallet by its SOL balance (spam-flooded) or by its transactions (normal). */
  setBalanceWatch(address, on) {
    if (Boolean(on) === this.accountMode.has(address)) return;
    if (on) this.accountMode.add(address);
    else this.accountMode.delete(address);
    if (!this.isOpen() || !this.wanted.has(address)) return;
    this.unsubscribe(address);
    this.subscribe(address);
    this.changed();
  }

  unsubscribe(address, id = this.subs.get(address)) {
    if (id == null) return;
    const method = this.subKind.get(address) === 'account' ? 'accountUnsubscribe' : 'logsUnsubscribe';
    if (this.isOpen()) this.send({ method, params: [id] });
    this.subs.delete(address);
    this.subByID.delete(id);
    this.subKind.delete(address);
  }

  /** true when this wallet just got dropped from real-time for flooding the stream */
  checkFlood(address) {
    const now = Date.now();
    let r = this.rate.get(address);
    if (!r || now - r.windowStart > 10_000) {
      r = { windowStart: now, count: 0 };
      this.rate.set(address, r);
    }
    r.count += 1;
    if (r.count <= this.floodPerSec * 10) return false;
    this.rate.delete(address);
    if (this.subKind.get(address) !== 'account') {
      if (typeof this.keepLogsOnFlood === 'function' && this.keepLogsOnFlood()) return false;
      // Too many transactions mention it: switch to watching its SOL balance only
      this.unsubscribe(address);
      this.accountMode.add(address);
      this.subscribe(address);
      this.fail(`${address.slice(0, 6)}… is spam-flooded (over ${this.floodPerSec} transactions/s): watching its balance in real time instead`);
      this.changed();
      return true;
    }
    // Even its balance changes non-stop: leave it to the regular checks for a while
    this.unsubscribe(address);
    this.tooBusy.set(address, now + this.floodCooldownMs);
    this.fail(`${address.slice(0, 6)}… is too busy for real-time; its trades are found by the regular checks`);
    const t = setTimeout(() => {
      if (this.running && this.wanted.has(address) && this.isOpen() && !this.subs.has(address)) this.subscribe(address);
    }, this.floodCooldownMs + 1000);
    t.unref?.();
    this.changed();
    return true;
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p.kind === 'sub') {
        if (msg.error) {
          this.fail(`subscribe failed for ${p.address.slice(0, 6)}…: ${msg.error.message || msg.error.code}`);
          if (p.sub === 'account' && /not found|not supported|unknown method/i.test(msg.error.message || '')) {
            this.accountUnsupported = true; // this provider can't watch balances (e.g. Alchemy)
            try {
              this.onAccountUnsupported(p.address);
            } catch {
              // ignore
            }
          }
        } else if (this.wanted.has(p.address) && !(p.sub === 'logs' && this.accountMode.has(p.address))) {
          this.subs.set(p.address, msg.result);
          this.subByID.set(msg.result, p.address);
          this.subKind.set(p.address, p.sub || 'logs');
        } else {
          this.send({ method: p.sub === 'account' ? 'accountUnsubscribe' : 'logsUnsubscribe', params: [msg.result] });
        }
        this.changed();
      }
      return;
    }
    if (msg.method === 'accountNotification') {
      const address = this.subByID.get(msg.params?.subscription);
      const value = msg.params?.result?.value;
      if (!address || !value) return;
      this.stats.events += 1;
      this.stats.lastEventAt = Date.now();
      if (this.checkFlood(address)) return;
      try {
        this.onAccount(address, { lamports: Number(value.lamports), slot: msg.params?.result?.context?.slot ?? null, receivedAt: Date.now() });
      } catch {
        // ignore listener errors
      }
      return;
    }
    if (msg.method === 'logsNotification') {
      const address = this.subByID.get(msg.params?.subscription);
      const value = msg.params?.result?.value;
      if (!address || !value?.signature) return;
      this.stats.events += 1;
      this.stats.lastEventAt = Date.now();
      if (this.checkFlood(address)) return;
      try {
        this.onLogs(address, { signature: value.signature, err: value.err, logs: value.logs, slot: msg.params?.result?.context?.slot ?? null, receivedAt: Date.now() });
      } catch {
        // ignore listener errors
      }
    }
  }
}
