/**
 * Storage layer — zero dependencies.
 *
 * Uses Node's built-in SQLite (`node:sqlite`, Node ≥ 22.5) and falls back to an atomic
 * JSON file on older Node versions. Both expose the same tiny key/value API:
 *
 *   const db = await openDatabase({ dir: './data' });
 *   db.set('engine', {...}); db.get('engine'); db.info(); db.close();
 */
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

async function loadSqlite() {
  // node:sqlite prints an "experimental" warning on some Node versions — keep the console clean
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning?.message || warning).includes('SQLite')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const mod = await import('node:sqlite');
    return mod.DatabaseSync || null;
  } catch {
    return null;
  } finally {
    setTimeout(() => {
      process.emitWarning = original;
    }, 0);
  }
}

class SqliteStore {
  constructor(DatabaseSync, file) {
    this.kind = 'sqlite';
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    this.getStmt = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this.setStmt = this.db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    this.delStmt = this.db.prepare('DELETE FROM kv WHERE key = ?');
    this.keysStmt = this.db.prepare('SELECT key, updated_at, length(value) AS bytes FROM kv ORDER BY key');
  }

  get(key) {
    const row = this.getStmt.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  set(key, value) {
    this.setStmt.run(key, JSON.stringify(value), Date.now());
  }

  setMany(entries) {
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of entries) this.set(k, v);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  delete(key) {
    this.delStmt.run(key);
  }

  keys() {
    return this.keysStmt.all().map((r) => ({ key: r.key, updatedAt: r.updated_at, bytes: r.bytes }));
  }

  sizeBytes() {
    let total = 0;
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        total += fs.statSync(f).size;
      } catch {
        // file may not exist yet
      }
    }
    return total;
  }

  /** Fold the write-ahead log back into the main file so it doesn't keep growing. */
  checkpoint() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      return true;
    } catch {
      return false;
    }
  }

  /** Reclaim disk pages after wiping large records so file size drops right away. */
  compact() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db.exec('VACUUM;');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    this.db.exec('DELETE FROM kv;');
    this.compact();
  }

  close() {
    this.checkpoint();
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

class JsonStore {
  constructor(file) {
    this.kind = 'json';
    this.file = file;
    this.data = { schema_version: SCHEMA_VERSION, kv: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.kv) this.data = parsed;
    } catch {
      // new or unreadable file — start empty (a corrupt file is kept as .bak)
      if (fs.existsSync(file)) {
        try {
          fs.copyFileSync(file, `${file}.bak`);
        } catch {
          // ignore
        }
      }
    }
  }

  flush() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return this.data.kv[key]?.value ?? null;
  }

  set(key, value) {
    this.data.kv[key] = { value, updatedAt: Date.now() };
    this.flush();
  }

  setMany(entries) {
    for (const [k, v] of entries) this.data.kv[k] = { value: v, updatedAt: Date.now() };
    this.flush();
  }

  delete(key) {
    delete this.data.kv[key];
    this.flush();
  }

  keys() {
    return Object.entries(this.data.kv).map(([key, v]) => ({ key, updatedAt: v.updatedAt, bytes: JSON.stringify(v.value).length }));
  }

  sizeBytes() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  checkpoint() {
    return true;
  }

  compact() {
    return true;
  }

  clear() {
    this.data.kv = {};
    this.flush();
  }

  close() {}
}

export async function openDatabase({ dir, preferSqlite = true, name = 'odex' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (preferSqlite) {
    const DatabaseSync = await loadSqlite();
    if (DatabaseSync) {
      try {
        return new SqliteStore(DatabaseSync, path.join(dir, `${name}.db`));
      } catch {
        // fall through to JSON (e.g. locked or unsupported file system)
      }
    }
  }
  return new JsonStore(path.join(dir, `${name}-db.json`));
}
