// Dax chat: Claude tool loop with read-only tools, basic mode, limits (offline, mock API).
// Run: node --test test/dax-chat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DaxChat, basicDaxAnswer, periodFromQuestion } from '../engine/daxChat.mjs';

const KEY = 'sk-ant-test-SECRETKEY-1234567890';

function mockApi(script) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const next = script.shift();
    if (next instanceof Error) throw next;
    const { status = 200, json } = next;
    return { ok: status < 400, status, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

test('DC1 Dax looks at the report with a tool, then answers; only read-only tools exist', async () => {
  const { calls, fetchImpl } = mockApi([
    { json: { content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'get_report', input: { period: '24h' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } } },
    { json: { content: [{ type: 'text', text: 'ROBODICK lost because the stop sold 23 points past its limit.' }], stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 } } },
  ]);
  const seen = [];
  const dax = new DaxChat({ apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl, tools: { get_report: ({ period }) => (seen.push(period), '# Dax report\n- ROBODICK −53% (stop 30%)') } });
  const r = await dax.reply([{ role: 'user', text: 'why did ROBODICK lose?' }]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'ai');
  assert.match(r.text, /23 points past/);
  assert.deepEqual(r.toolsUsed, ['get_report']);
  assert.deepEqual(seen, ['24h']);
  // request shape: endpoint, headers, model, tools, tool_result round trip
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].headers['x-api-key'], KEY);
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  const names = calls[0].body.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_open_positions', 'get_report', 'get_settings', 'get_trader_trades']);
  assert.ok(!names.some((n) => /sell|buy|trade_now|set|update|withdraw/.test(n) && n !== 'get_trader_trades' && n !== 'get_settings'), 'no tool can trade or change anything');
  const second = calls[1].body.messages;
  assert.equal(second[1].role, 'assistant');
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'tu1');
  assert.match(second[2].content[0].content, /ROBODICK/);
});

test('DC2 voice questions ask for short spoken answers', async () => {
  const { calls, fetchImpl } = mockApi([{ json: { content: [{ type: 'text', text: 'About 15 percent down.' }], stop_reason: 'end_turn' } }]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl });
  await dax.reply([{ role: 'user', text: 'how am I doing' }], { voice: true });
  assert.match(calls[0].body.system, /VOICE conversation/);
  assert.equal(calls[0].body.max_tokens, 400);
});

test('DC3 without a key Dax answers in basic mode from his findings', async () => {
  const dax = new DaxChat({ apiKey: '', basicAnswer: (q) => `basic: ${q}` });
  const r = await dax.reply([{ role: 'user', text: 'what happened today' }]);
  assert.deepEqual([r.ok, r.mode, r.text], [true, 'basic', 'basic: what happened today']);
  const report = { period: { label: 'Last 24 hours' }, findings: [{ text: 'Real SOL: 3 trades.' }, { text: 'Wallet low.' }] };
  assert.match(basicDaxAnswer('x', report), /• Real SOL: 3 trades\.[\s\S]*ANTHROPIC_API_KEY/);
  assert.doesNotMatch(basicDaxAnswer('x', report, { voice: true }), /•|ANTHROPIC/);
  assert.equal(periodFromQuestion('how was this week'), '7d');
  assert.equal(periodFromQuestion('today?'), 'today');
  assert.equal(periodFromQuestion('why did I lose'), '24h');
});

test('DC4 API errors are reported without the key; history must start with a question; rate limit', async () => {
  const { fetchImpl } = mockApi([{ status: 401, json: { error: { message: 'invalid x-api-key' } } }]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl });
  const r = await dax.reply([{ role: 'assistant', text: 'hello' }, { role: 'user', text: 'hi' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
  assert.ok(!r.error.includes(KEY));
  assert.equal((await dax.reply([{ role: 'assistant', text: 'only me' }])).ok, false);
  let t = 0;
  const lim = new DaxChat({ apiKey: '', basicAnswer: () => 'ok', now: () => t });
  for (let i = 0; i < 20; i++) assert.equal((await lim.reply([{ role: 'user', text: 'q' }])).ok, true);
  assert.match((await lim.reply([{ role: 'user', text: 'q' }])).error, /a lot of questions/);
  t += 61_000;
  assert.equal((await lim.reply([{ role: 'user', text: 'q' }])).ok, true, 'free again after a minute');
});

test('DC5 a tool that throws is reported to Claude, not crashing the chat', async () => {
  const { calls, fetchImpl } = mockApi([
    { json: { content: [{ type: 'tool_use', id: 'a', name: 'get_open_positions', input: {} }], stop_reason: 'tool_use' } },
    { json: { content: [{ type: 'text', text: 'No positions could be read.' }], stop_reason: 'end_turn' } },
  ]);
  const dax = new DaxChat({ apiKey: KEY, fetchImpl, tools: { get_open_positions: () => { throw new Error('db busy'); } } });
  const r = await dax.reply([{ role: 'user', text: 'open positions?' }]);
  assert.equal(r.ok, true);
  assert.match(calls[1].body.messages[2].content[0].content, /Tool error: db busy/);
});

// ---------- smart basic mode (no API key) ----------
import { smartDaxAnswer, daxTopics } from '../engine/daxChat.mjs';

function smartCtx() {
  const now = Date.now();
  return {
    report: {
      period: { label: 'Last 24 hours' },
      findings: [{ text: 'FINDING-ONE' }, { text: 'Entries were behind the trader’s copier wave.' }],
      data: {
        real: { realized: -4.2, realizedSol: -0.021, trades: 3, wins: 1, losses: 2 },
        paper: { realized: 12.5, trades: 5, wins: 4, losses: 1 },
        closed: [{ sym: 'ACT', real: true, pnl: -1.5, pnlPct: -15, cause: 'stop loss', closedAt: now - 60_000 }],
        wallet: { sol: 0.4321, reserve: 0.02, perBuy: 0.05, perDay: 0.5, spent24h: 0.1, buysLeft: 8 },
        entries: { real: { first: { n: 2, pnl: 1 }, re: { n: 1, pnl: -5 } }, paper: { first: { n: 0, pnl: 0 }, re: { n: 0, pnl: 0 } } },
        traders: [{ handle: 'Decu', buysSeen: 10, copiedBuys: 6, missedBuys: 4, reasons: [['Price ran past your max chase', 3], ['re-entry cooldown', 1]], missedCoins: [{ sym: 'MOON', mint: 'm', traderPct: 40 }], vs: [{ sym: 'ACT', oursPct: -15, traderPct: 12, causes: ['stop loss'] }] }],
      },
    },
    openPositions: () => [{ coin: 'PEPE', kind: 'real', trader: 'Decu', costUsd: 10, valueUsd: 12, pnlPct: 20, heldSec: 90 }],
    traderTrades: () => [{ trader: 'Decu', side: 'buy', coin: 'MOON', mint: 'm', usd: 300, at: new Date(now - 120_000).toISOString(), copies: [{ copied: false, reason: 'Price ran past your max chase' }] }],
    settings: () => ({ mode: 'paper', traders: [{ name: 'Decu', status: 'active', maxChasePct: 15, stopLossPct: 20, takeProfitPct: 50, sellsWhenTraderSells: true }] }),
    signals: [
      { symbol: 'PEPE', side: 'buy', detectedAt: now - 5000, blockTime: now - 6200, streamMs: 150, via: 'fast-logs', copies: [{ ok: true, handledMs: 400 }] },
      { symbol: 'DOG', side: 'buy', detectedAt: now - 9000, blockTime: now - 11_000, streamMs: 1800, via: 'stream', copies: [{ ok: true, handledMs: 600 }] },
    ],
    realTrades: [{ t: now - 5000, ok: true, timing: { route: 'direct', sendMs: 700 } }],
    swapRoute: 'direct',
    fastDetect: { on: true, phantoms: 0 },
  };
}

test('DC-S1 questions are routed to the right topic', () => {
  assert.deepEqual(daxTopics('how much is the delay rn ?'), ['delay']);
  assert.ok(daxTopics('why were trades skipped').includes('skips'));
  assert.ok(daxTopics('what are my open positions').includes('open'));
  assert.ok(daxTopics('how much did we make today').includes('pnl'));
  assert.ok(daxTopics('why did we lose against decu').includes('vs'));
  assert.ok(!daxTopics('why did we lose against decu').includes('pnl'));
  assert.deepEqual(daxTopics('hi'), ['help']);
});

test('DC-S2 each question gets its own answer from the data, not the report dump', () => {
  const ctx = smartCtx();
  const delay = smartDaxAnswer('how much is the delay rn ?', ctx);
  assert.match(delay, /Delay/);
  assert.match(delay, /1\.6 s|1\.2 s|2\.0 s/, 'median trader → seen time');
  assert.match(delay, /Fast-detected .*1 of 2/);
  assert.doesNotMatch(delay, /FINDING-ONE/);
  const skips = smartDaxAnswer('why were trades skipped?', ctx);
  assert.match(skips, /3× Price ran past your max chase/);
  assert.match(skips, /MOON \+40\.0%/);
  assert.match(smartDaxAnswer('open positions', ctx), /PEPE \(real, Decu\).*\+20\.0%/);
  assert.match(smartDaxAnswer('how much profit today', ctx), /Real SOL: −\$4\.20 from 3 closed trades/);
  assert.match(smartDaxAnswer('wallet balance', ctx), /0\.4321 SOL/);
  assert.match(smartDaxAnswer('last trades', ctx), /ACT \(real\) −\$1\.50 −15\.0% — stop loss/);
  assert.match(smartDaxAnswer('us vs decu', ctx), /ACT: us −15\.0% vs Decu \+12\.0%/);
  assert.match(smartDaxAnswer('what did decu buy', ctx), /Decu buy MOON \$300 — skipped: Price ran past your max chase/);
  assert.match(smartDaxAnswer('show settings', ctx), /max chase 15%/);
  assert.match(smartDaxAnswer('give me the report', ctx), /FINDING-ONE/);
  const unsure = smartDaxAnswer('banana', ctx);
  assert.match(unsure, /not sure what you meant/);
  assert.doesNotMatch(unsure, /FINDING-ONE/);
});

test('DC-S3 voice answers are short plain sentences; no-data cases say so', () => {
  const ctx = smartCtx();
  const v = smartDaxAnswer('what is the delay', ctx, { voice: true });
  assert.doesNotMatch(v, /\*\*|•/);
  ctx.signals = [];
  assert.match(smartDaxAnswer('delay?', ctx), /nothing to measure yet/);
  ctx.openPositions = () => [];
  assert.match(smartDaxAnswer('open positions', ctx), /No open positions/);
});

test('DC-G1 Gemini API smart agent: functionCalling round-trip with read-only tools', async () => {
  const GEMINI_KEY = 'AIzaSyTestGeminiKey12345678901234567890';
  const { calls, fetchImpl } = mockApi([
    {
      json: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'get_report', args: { period: 'today' } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15 },
      },
    },
    {
      json: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Decu made 1 paper trade today on Superman (−$3.30).' }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 25 },
      },
    },
  ]);
  const dax = new DaxChat({
    apiKey: GEMINI_KEY,
    model: 'gemini-2.5-flash',
    fetchImpl,
    tools: { get_report: ({ period }) => `# Report (${period})\n- Superman −$3.30` },
  });
  assert.equal(dax.provider, 'gemini');
  assert.equal(dax.activeModel, 'gemini-2.5-flash');
  const r = await dax.reply([{ role: 'user', text: 'how did Decu do today?' }]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'ai');
  assert.equal(r.provider, 'gemini');
  assert.deepEqual(r.toolsUsed, ['get_report']);
  assert.match(r.text, /Superman/);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], GEMINI_KEY);
  assert.equal(calls[1].body.contents[2].parts[0].functionResponse.name, 'get_report');
});
