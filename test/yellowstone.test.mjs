// Yellowstone gRPC feed: protobuf codec + a real HTTP/2 (h2c) fake Geyser server.
// Run: node --test test/yellowstone.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { YellowstoneFeed, encodeSubscribeRequest, decodeSubscribeUpdate, pbFields } from '../engine/yellowstone.mjs';
import { base58Encode } from '../engine/onchainMeta.mjs';

const W1 = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const W2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

// test-side encoder for SubscribeUpdate
const varint = (n) => { let v = BigInt(n); const o = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return Buffer.from(o); };
const fv = (f, n) => Buffer.concat([varint((f << 3) | 0), varint(n)]);
const fb = (f, b) => Buffer.concat([varint((f << 3) | 2), varint(b.length), b]);
const fs = (f, s) => fb(f, Buffer.from(s));
function txUpdate({ filters, sig, slot, logs, failed = false, vote = false }) {
  const meta = Buffer.concat([...(failed ? [fb(1, fb(1, Buffer.from([1, 2, 3])))] : []), fv(2, 5000), ...logs.map((l) => fs(6, l))]);
  const info = Buffer.concat([fb(1, sig), fv(2, vote ? 1 : 0), fb(4, meta)]);
  return Buffer.concat([...filters.map((x) => fs(1, x)), fb(4, Buffer.concat([fb(1, info), fv(2, slot)]))]);
}
const frame = (m) => { const h = Buffer.alloc(5); h.writeUInt32BE(m.length, 1); return Buffer.concat([h, m]); };

test('YS1 SubscribeRequest: one transaction filter per wallet, vote/failed excluded, processed, ping', () => {
  const req = pbFields(encodeSubscribeRequest({ wallets: [W1, W2], pingId: 7 }));
  const entries = req.filter((f) => f.field === 3).map((e) => pbFields(e.value));
  assert.equal(entries.length, 2);
  const keys = entries.map((e) => e.find((x) => x.field === 1).value.toString());
  assert.deepEqual(keys, [W1, W2]);
  const filter = pbFields(entries[0].find((x) => x.field === 2).value);
  assert.equal(filter.find((x) => x.field === 1).value, 0n, 'vote = false');
  assert.equal(filter.find((x) => x.field === 2).value, 0n, 'failed = false');
  assert.equal(filter.find((x) => x.field === 3).value.toString(), W1, 'account_include');
  assert.equal(req.find((f) => f.field === 6).value, 0n, 'processed');
  assert.equal(pbFields(req.find((f) => f.field === 9).value)[0].value, 7n, 'ping id');
});

test('YS2 SubscribeUpdate decode: signature, slot, logs, error, vote, pings', () => {
  const sig = crypto.randomBytes(64);
  const u = decodeSubscribeUpdate(txUpdate({ filters: [W1], sig, slot: 463_200_000, logs: ['Program log: hi', 'Program X success'] }));
  assert.equal(u.kind, 'tx');
  assert.deepEqual(u.filters, [W1]);
  assert.equal(u.signature, base58Encode(sig));
  assert.equal(u.slot, 463_200_000);
  assert.deepEqual(u.logs, ['Program log: hi', 'Program X success']);
  assert.equal(u.err, null);
  assert.ok(decodeSubscribeUpdate(txUpdate({ filters: [W1], sig, slot: 1, logs: [], failed: true })).err, 'failed tx has err');
  assert.equal(decodeSubscribeUpdate(fb(6, Buffer.alloc(0))).kind, 'ping');
  assert.equal(decodeSubscribeUpdate(fb(9, fv(1, 3))).kind, 'pong');
});

test('YS3 live over HTTP/2: subscribes with the key, delivers the trade to the right wallet, answers pings, reconnects', async () => {
  const seenHeaders = [];
  const requests = [];
  let streams = 0;
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    streams += 1;
    seenHeaders.push(headers);
    stream.on('error', () => {}); // the fake server's own end of the dropped stream
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    let buf = Buffer.alloc(0);
    stream.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const len = buf.readUInt32BE(1);
        requests.push(pbFields(buf.subarray(5, 5 + len)));
        buf = buf.subarray(5 + len);
      }
    });
    if (streams === 1) {
      // server ping, a vote tx (ignored), the trader's trade, then drop the connection
      stream.write(frame(fb(6, Buffer.alloc(0))));
      stream.write(frame(txUpdate({ filters: [W1], sig: crypto.randomBytes(64), slot: 5, logs: ['vote'], vote: true })));
      const sig = crypto.randomBytes(64);
      server.sig = base58Encode(sig);
      // split one message across two writes (HTTP/2 data frames can cut messages anywhere)
      const m = frame(txUpdate({ filters: [W1], sig, slot: 463_000_123, logs: ['Program 6EF8 invoke [1]'] }));
      stream.write(m.subarray(0, 10));
      setTimeout(() => {
        stream.write(m.subarray(10));
        setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 30);
      }, 20);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const got = [];
  const feed = new YellowstoneFeed({ url: `http://127.0.0.1:${port}?api-key=secret-key`, onTx: (a, ev) => got.push({ a, ...ev }), pingMs: 60_000, maxBackoffMs: 50 });
  feed.backoff = 20;
  feed.setWallets([W1, W2]);
  feed.start();
  const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
  await until(() => got.length === 1);
  assert.equal(got[0].a, W1);
  assert.equal(got[0].signature, server.sig);
  assert.equal(got[0].slot, 463_000_123);
  assert.deepEqual(got[0].logs, ['Program 6EF8 invoke [1]']);
  assert.equal(seenHeaders[0]['x-token'], 'secret-key', 'key sent as x-token');
  assert.equal(seenHeaders[0][':path'], '/geyser.Geyser/Subscribe');
  await until(() => requests.length >= 2);
  assert.ok(requests[1].some((f) => f.field === 9), 'answered the server ping (filters kept)');
  assert.ok(requests[1].some((f) => f.field === 3), 'ping request still carries the filters');
  await until(() => streams >= 2, 3000);
  assert.ok(feed.stats.connects >= 1);
  feed.stop();
  server.close();
});
