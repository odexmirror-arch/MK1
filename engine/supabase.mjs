/**
 * Supabase cloud mirror — zero dependencies (Supabase REST / PostgREST over fetch).
 *
 * The local SQLite database stays the source of truth (fast, works offline). Every save is
 * also pushed to a Supabase table so your data survives a lost PC and a fresh install can be
 * restored from the cloud. Keys live only in the server's .env and are never sent to the browser.
 *
 * Table (run once in Supabase → SQL editor):
 *   create table if not exists public.odex_kv (
 *     key text primary key,
 *     value jsonb not null,
 *     updated_at timestamptz not null default now()
 *   );
 *   alter table public.odex_kv enable row level security;   -- no policies: only the service key can read/write
 */
import { maskSecret, redact } from './env.mjs';

export const SUPABASE_TABLE_SQL = `create table if not exists public.odex_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.odex_kv enable row level security;`;

export function isSupabaseUrl(url) {
  try {
    const u = new URL(String(url));
    // https only; plain http is allowed just for a local Supabase (supabase start) on this machine
    return (u.protocol === 'https:' && Boolean(u.hostname)) || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch {
    return false;
  }
}

export class SupabaseMirror {
  constructor({ url = '', key = '', table = 'odex_kv', fetchImpl = (...a) => fetch(...a), minIntervalMs = 5000 } = {}) {
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs;
    this.configure({ url, key, table });
  }

  configure({ url = '', key = '', table = 'odex_kv' } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = String(key || '').trim();
    this.table = /^[a-z_][a-z0-9_]{0,62}$/i.test(table || '') ? table : 'odex_kv';
    this.stats = { pushes: 0, pulls: 0, lastSyncAt: null, lastError: null, lastErrorAt: null, tableMissing: false };
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastPushAt = 0;
  }

  get enabled() {
    return Boolean(this.url && this.key && isSupabaseUrl(this.url));
  }

  headers(extra = {}) {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...extra };
  }

  endpoint(query = '') {
    return `${this.url}/rest/v1/${this.table}${query}`;
  }

  async request(method, query, body, extraHeaders) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await this.fetch(this.endpoint(query), {
        method,
        headers: this.headers(extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
        const missing = res.status === 404 || /does not exist|relation .* not exist|PGRST205|Could not find the table/i.test(msg);
        const err = new Error(missing ? `Table "${this.table}" not found in Supabase. Run the setup SQL first.` : res.status === 401 || res.status === 403 ? 'Supabase rejected the key (check it is the service role key).' : `Supabase: ${msg}`);
        err.tableMissing = missing;
        throw err;
      }
      return json;
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Supabase request timed out' : err.message;
      this.stats.lastError = redact(message, this.key);
      this.stats.lastErrorAt = Date.now();
      this.stats.tableMissing = Boolean(err.tableMissing);
      throw Object.assign(new Error(this.stats.lastError), { tableMissing: err.tableMissing });
    } finally {
      clearTimeout(t);
    }
  }

  /** Check URL, key and table. Returns { ok, rows, error, tableMissing }. */
  async test() {
    if (!this.enabled) return { ok: false, error: 'Supabase is not configured.' };
    try {
      const rows = await this.request('GET', '?select=key,updated_at&limit=50');
      this.stats.lastError = null;
      this.stats.tableMissing = false;
      return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (err) {
      return { ok: false, error: err.message, tableMissing: Boolean(err.tableMissing) };
    }
  }

  /** Upsert key/value rows now. */
  async push(entries) {
    if (!this.enabled || !entries?.length) return false;
    const now = new Date().toISOString();
    const rows = entries.map(([key, value]) => ({ key, value, updated_at: now }));
    await this.request('POST', '?on_conflict=key', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    this.stats.pushes += 1;
    this.stats.lastSyncAt = Date.now();
    this.stats.lastError = null;
    this.stats.tableMissing = false;
    this.lastPushAt = Date.now();
    return true;
  }

  /** Coalesce frequent saves: at most one push every minIntervalMs, always with the newest data. */
  schedule(entries) {
    if (!this.enabled) return;
    this.pending = entries;
    if (this.timer) return;
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastPushAt));
    this.timer = setTimeout(async () => {
      this.timer = null;
      const batch = this.pending;
      this.pending = null;
      try {
        await this.push(batch);
      } catch {
        // error kept in stats; next save retries
      }
    }, wait);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const batch = this.pending;
      this.pending = null;
      await this.push(batch).catch(() => {});
    }
  }

  /** All rows as a Map key → value. */
  async pullAll() {
    const rows = await this.request('GET', '?select=key,value,updated_at');
    this.stats.pulls += 1;
    this.stats.lastError = null;
    const out = new Map();
    for (const r of Array.isArray(rows) ? rows : []) out.set(r.key, r.value);
    return out;
  }

  status() {
    let host = null;
    try {
      host = this.url ? new URL(this.url).host : null;
    } catch {
      host = null;
    }
    return {
      configured: this.enabled,
      host,
      table: this.table,
      keyMasked: this.key ? maskSecret(this.key) : null,
      pushes: this.stats.pushes,
      lastSyncAt: this.stats.lastSyncAt,
      lastError: this.stats.lastError,
      lastErrorAt: this.stats.lastErrorAt,
      tableMissing: this.stats.tableMissing,
    };
  }
}
