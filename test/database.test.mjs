// Database & persistence tests — run against a temp directory.
process.env.ODEX_RPC_MAX_RPS = '0'; // tests use in-memory RPC mocks: no request-rate limit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../engine/db.mjs';
import { PersistenceManager, serializeLive } from '../engine/persistence.mjs';
import { CopyTradingEngine, createDefaultExitRules } from '../engine/copyEngine.mjs';
import { LiveSignalService } from '../engine/liveSignals.mjs';
import { AlchemyService } from '../engine/alchemy.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'odexdb-'));
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function seededEngine() {
  const e = new CopyTradingEngine();
  e.resetToCleanState();
  e.settings.paperTrading = true;
  e.follows.push({
    id: 'fol-1', walletId: e.getActiveWallet().id, name: 'frank', handle: 'whale1', traderWallet: WALLET, chainId: 'solana',
    status: 'copying', mode: 'auto-exit', sizing: { type: 'fixed', amount: 75 }, tpPct: 50, slPct: 25, minTradeUsd: 1,
    maxOpenPositions: 10, maxAtRiskUsd: 1000, consecutiveLosses: 0, exitRules: createDefaultExitRules({ takeInitials: { enabled: true } }), filtersOverride: {},
  });
  return e;
}

async function buy(e) {
  const [r] = await e.processTraderSignal({
    chainId: 'solana', side: 'buy', traderHandle: 'whale1', traderWallet: WALLET, traderBuyUsd: 120,
    token: { address: `tok${Math.random()}`, symbol: 'MEME', isLaunchpad: true, marketCapUsd: 500000, traderFillPriceUsd: 0.001, currentPriceUsd: 0.00102, safety: {} },
  });
  return r;
}

for (const preferSqlite of [true, false]) {
  test(`D1 ${preferSqlite ? 'SQLite' : 'JSON'} store: set/get/setMany/keys survive reopening`, async () => {
    const dir = tmp();
    const a = await openDatabase({ dir, preferSqlite });
    assert.equal(a.kind, preferSqlite ? 'sqlite' : 'json');
    a.set('x', { n: 1 });
    a.setMany([['y', [1, 2]], ['z', 'str']]);
    a.close();
    const b = await openDatabase({ dir, preferSqlite });
    assert.deepEqual(b.get('x'), { n: 1 });
    assert.deepEqual(b.get('y'), [1, 2]);
    assert.equal(b.get('missing'), null);
    assert.deepEqual(b.keys().map((k) => k.key).sort(), ['x', 'y', 'z']);
    assert.ok(b.sizeBytes() > 0);
    b.close();
  });
}

test('D2 corrupt JSON file is kept as .bak and the store starts empty', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'odex-db.json'), '{not json');
  const s = await openDatabase({ dir, preferSqlite: false });
  assert.equal(s.get('engine'), null);
  assert.ok(fs.existsSync(path.join(dir, 'odex-db.json.bak')));
});

test('D3 full round trip: follows, positions, history, settings, cooldowns restored after "restart"', async () => {
  const dir = tmp();
  const e1 = seededEngine();
  e1.settings.maxChasePct = 33;
  e1.settings.externalWallets = { phantom: { address: WALLET, linkedAt: 1 } };
  await buy(e1);
  await buy(e1);
  const store1 = await openDatabase({ dir });
  const p1 = new PersistenceManager({ engine: e1, store: store1 });
  assert.equal(p1.saveNow(), true);
  store1.close();

  const e2 = new CopyTradingEngine(); // fresh process
  const store2 = await openDatabase({ dir });
  const p2 = new PersistenceManager({ engine: e2, store: store2 });
  const restored = p2.load();
  assert.equal(restored.follows, 1);
  assert.equal(restored.openPositions, 2);
  assert.equal(e2.history.length, e1.history.length);
  assert.equal(e2.settings.maxChasePct, 33);
  assert.equal(e2.settings.externalWallets.phantom.address, WALLET);
  assert.equal(e2.buyCooldownMap.size, 2);
  assert.ok(e2.settings.safety && 'blockRiskyCoins' in e2.settings.safety, 'nested defaults kept');
  // Restored engine keeps working: exits still fire on restored positions
  const pos = e2.positions[0];
  pos.currentPriceUsd = pos.entryPriceUsd * 1.3;
  await e2.evaluatePositionExits(pos, pos.openedAt + 2000);
  assert.equal(pos.initialsTaken, true);
  store2.close();
});

test('D4 the Alchemy key is never written; a custom RPC URL is', async () => {
  const KEY = 'alch_SECRETKEY00000000xyz';
  const engine = new CopyTradingEngine();
  const live = new LiveSignalService({ engine, alchemy: new AlchemyService({ apiKey: KEY }), env: {}, broadcast: () => {} });
  const dir = tmp();
  const store = await openDatabase({ dir });
  const p = new PersistenceManager({ engine, live, store });
  p.saveNow();
  store.close();
  const raw = fs.readFileSync(path.join(dir, 'odex.db'));
  assert.ok(!raw.includes(Buffer.from(KEY)), 'database file must not contain the key');
  assert.equal(serializeLive(live).config.rpcProvider, 'alchemy');
  live.updateConfig({ rpcUrl: 'https://my-rpc.example' });
  assert.equal(serializeLive(live).config.rpcUrl, 'https://my-rpc.example');
  live.watcher.stop();
});

test('D5 live signals config + manual watches + signals persist', async () => {
  const dir = tmp();
  const engine = new CopyTradingEngine();
  const live = new LiveSignalService({ engine, env: {}, broadcast: () => {} });
  live.addManual('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'whale');
  live.updateConfig({ paperCopy: true, pollSec: 30 });
  live.signals.push({ signature: 's1', side: 'buy', symbol: 'MEME', usdValue: 5 });
  live.signals.push({ signature: 'bal-fake', side: 'sell', symbol: 'SPAM', usdValue: 0, source: 'balances' });
  const store = await openDatabase({ dir });
  new PersistenceManager({ engine, live, store }).saveNow();
  live.watcher.stop();
  store.close();

  const engine2 = new CopyTradingEngine();
  const live2 = new LiveSignalService({ engine: engine2, env: {}, broadcast: () => {} });
  const store2 = await openDatabase({ dir });
  const r = new PersistenceManager({ engine: engine2, live: live2, store: store2 }).load();
  assert.equal(r.signals, 1);
  assert.equal(live2.config.manual[0].label, 'whale');
  assert.equal(live2.config.paperCopy, true);
  assert.equal(live2.config.pollSec, 30);
  store2.close();
});

test('D6 changes are saved automatically shortly after engine events', async () => {
  const dir = tmp();
  const e = seededEngine();
  const store = await openDatabase({ dir });
  const p = new PersistenceManager({ engine: e, store, fastMs: 20, slowMs: 50 }).attach();
  await buy(e); // emits position_opened
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(p.saves >= 1);
  assert.equal(store.get('engine').positions.length, 1);
  p.close();
});

test('D7 backup export → import into a fresh engine; foreign files are rejected', async () => {
  const e1 = seededEngine();
  await buy(e1);
  const s1 = await openDatabase({ dir: tmp() });
  const backup = JSON.parse(JSON.stringify(new PersistenceManager({ engine: e1, store: s1 }).exportBackup()));
  const e2 = new CopyTradingEngine();
  const s2 = await openDatabase({ dir: tmp() });
  const p2 = new PersistenceManager({ engine: e2, store: s2 });
  const r = p2.importBackup(backup);
  assert.equal(r.follows, 1);
  assert.equal(e2.positions.length, 1);
  assert.throws(() => p2.importBackup({ hello: 'world' }), /Not an Odex Mirror backup/);
});

import http from 'node:http';
import { SupabaseMirror } from '../engine/supabase.mjs';

/** Tiny in-memory PostgREST look-alike for the odex_kv table. */
function mockSupabase({ tableExists = true, key = 'service-key-1234567890' } = {}) {
  const rows = new Map();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    if (req.headers.apikey !== key) return send(401, { message: 'Invalid API key' });
    if (!req.url.startsWith('/rest/v1/odex_kv') || !tableExists) return send(404, { code: 'PGRST205', message: "Could not find the table 'public.odex_kv'" });
    if (req.method === 'GET') return send(200, [...rows.values()]);
    if (req.method === 'POST') {
      for (const r of JSON.parse(body)) rows.set(r.key, r);
      return send(201);
    }
    return send(405, { message: 'no' });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${server.address().port}`, rows, close: () => server.close() })));
}

test('D8 Supabase mirror: pushes saves, restores a fresh install, never stores the key, reports a missing table', async () => {
  const sb = await mockSupabase();
  // the mirror requires https for real use; the mock runs on http, so allow it explicitly
  const mirror = new SupabaseMirror({ url: sb.url, key: 'service-key-1234567890', minIntervalMs: 10 });
  Object.defineProperty(mirror, 'enabled', { get: () => true });
  const t = await mirror.test();
  assert.equal(t.ok, true);

  const e1 = seededEngine();
  await buy(e1);
  const s1 = await openDatabase({ dir: tmp() });
  const p1 = new PersistenceManager({ engine: e1, store: s1, cloud: mirror });
  p1.saveNow();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(sb.rows.has('engine'), 'engine state pushed to Supabase');
  assert.ok(!JSON.stringify([...sb.rows.values()]).includes('service-key-1234567890'), 'key never written into the data');

  // fresh install restores from the cloud
  const e2 = new CopyTradingEngine();
  const s2 = await openDatabase({ dir: tmp() });
  const p2 = new PersistenceManager({ engine: e2, store: s2, cloud: mirror });
  const restored = p2.restoreFromRows(await mirror.pullAll());
  assert.equal(restored.follows, 1);
  assert.equal(e2.positions.length, 1);
  sb.close();

  const missing = await mockSupabase({ tableExists: false });
  const m2 = new SupabaseMirror({ url: missing.url, key: 'service-key-1234567890' });
  Object.defineProperty(m2, 'enabled', { get: () => true });
  const r2 = await m2.test();
  assert.equal(r2.ok, false);
  assert.equal(r2.tableMissing, true);
  missing.close();

  const bad = await mockSupabase();
  const m3 = new SupabaseMirror({ url: bad.url, key: 'wrong-key-000000000000' });
  Object.defineProperty(m3, 'enabled', { get: () => true });
  assert.match((await m3.test()).error, /rejected the key/);
  bad.close();
});

test('D9 paper fills carry no made-up transaction hash and link back to the follow', async () => {
  const e = seededEngine();
  await buy(e);
  const h = e.history.find((x) => x.status === 'filled' && x.side === 'buy');
  assert.ok(h, 'buy filled');
  assert.equal(h.txHash, null);
  assert.equal(h.explorerUrl, null);
  assert.equal(h.followId, 'fol-1');
  assert.equal(h.traderWallet, WALLET);
  assert.equal(e.positions[0].traderWallet, WALLET);
});

test('settings migration: a saved 20 s real-copy limit (old default) becomes 10 s', async () => {
  const { CopyTradingEngine } = await import('../engine/copyEngine.mjs');
  const { restoreEngine } = await import('../engine/persistence.mjs');
  const e = new CopyTradingEngine();
  restoreEngine(e, { settings: { maxRealSignalAgeSec: 20 } });
  assert.equal(e.settings.maxRealSignalAgeSec, 10);
  const e2 = new CopyTradingEngine();
  restoreEngine(e2, { settings: { maxRealSignalAgeSec: 15 } });
  assert.equal(e2.settings.maxRealSignalAgeSec, 15, 'a value set on purpose is kept');
});

test('D10 clear storage: wipes kv rows, compacts SQLite file size, and resets traderLog', async () => {
  const e = seededEngine();
  e.traderLog = Array.from({ length: 500 }, (_, i) => ({ t: Date.now() - i * 1000, side: 'buy', sym: `COIN${i}` }));
  await buy(e);
  const store = await openDatabase({ dir: tmp() });
  store.set('bigBlob', { pad: 'x'.repeat(250_000) });
  const p = new PersistenceManager({ engine: e, store });
  p.saveNow();
  const sizeBefore = store.sizeBytes();
  assert.ok(sizeBefore > 200_000, 'database holds bulk payload');

  e.resetToCleanState();
  assert.equal(e.follows.length, 0);
  assert.equal(e.positions.length, 0);
  assert.equal(e.history.length, 0);
  assert.equal(e.traderLog.length, 0);

  store.clear();
  p.saveNow();
  store.compact();
  const sizeAfter = store.sizeBytes();
  assert.equal(store.get('bigBlob'), null);
  assert.ok(sizeAfter < sizeBefore * 0.25, `expected compacted size (${sizeAfter}) << before (${sizeBefore})`);
  store.close();
});
