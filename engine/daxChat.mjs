/**
 * Dax chat — talk to the report agent (text, voice messages, voice calls).
 *
 * With ANTHROPIC_API_KEY set, every question goes to Claude with READ-ONLY tools over the bot's
 * own records (Dax's report, open positions, the trader trade log, settings). Dax can look at
 * everything but can never buy, sell or change a setting: no such tool exists.
 * Without a key Dax still answers in basic mode from his report findings.
 *
 * Zero dependencies: Node 22's fetch. The key stays on the server and is never put in a reply.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 5;
const MAX_HISTORY = 24; // messages sent per request (the browser keeps the conversation)

const TOOLS = [
  {
    name: 'get_report',
    description: "Dax's full trade report for a period: results real vs paper, each trader (setup, copied vs skipped buys and why, our result vs the trader's own result per coin), exits that sold past their limit, results by exit, speed, bot wallet and limits, failed real orders, and a CSV of every closed trade. Use this first for any question about results, losses, wins or why something happened.",
    input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', '24h', '7d', 'all'], description: 'today = UTC day so far' } }, required: ['period'] },
  },
  {
    name: 'get_open_positions',
    description: 'Positions open right now: coin, real or paper, cost, current value and PnL, peak gain, how long held, exit rules that apply.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_trader_trades',
    description: "The followed traders' own buys and sells (price, USD size, % of bag sold, market cap) and what the bot did with each (copied or skipped and why), newest first. Filter by coin symbol or mint and by hours back. Use it to explain why the trader won or lost on a coin and how our copy differed.",
    input_schema: { type: 'object', properties: { coin: { type: 'string', description: 'symbol (e.g. ALONE) or mint address; omit for all coins' }, hours: { type: 'number', description: 'how far back, default 24' }, limit: { type: 'number', description: 'max rows, default 60' } } },
  },
  {
    name: 'get_settings',
    description: 'Current setup: paper or real mode, each trader (mode, exit rules, size, stop loss, max chase, top-ups, daily SOL limit, sell-when-trader-sells), overall real-SOL limits and the bot wallet balance.',
    input_schema: { type: 'object', properties: {} },
  },
];

function systemPrompt({ voice }) {
  return [
    'You are Dax, the built-in report agent of Odex Mirror, a Solana copy-trading bot that copies followed wallets (for example the trader "Decu") with paper money or real SOL from a bot wallet.',
    "You can read everything the bot recorded through your tools. You can NOT trade, sell, change settings or move funds — if asked, say what the user can change and where (trader Settings, exit rules presets such as \"Follow the trader\" or \"Fast scalp\", Settings → Trading & risk).",
    'Always get the facts from the tools before answering about results; never invent numbers. Quote the exact coins, percentages and dollar amounts you found. Compare our copy with the trader\'s own result on the same coin when explaining a win or a loss (entry later/higher, exit rule that sold us, how far past its limit, the trader holding through a dip, etc.).',
    'Be direct and practical: give the cause, the numbers, and the one or two changes that would help most. You are not a financial advisor: no promises of profit.',
    'Reply in the language the user writes or speaks in.',
    voice
      ? 'This is a VOICE conversation: answer in at most 3 short spoken sentences, no lists, no tables, no markdown, no emojis, round numbers (say "about 15 percent"). Offer to go deeper if needed.'
      : 'This is a text chat: be concise. Short paragraphs or a few bullets; a small table only when comparing several trades.',
  ].join('\n');
}

export class DaxChat {
  constructor({
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    model = process.env.DAX_MODEL || (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'gemini-2.5-flash' : 'claude-sonnet-5-5'),
    fetchImpl = (...a) => fetch(...a),
    tools = {},
    basicAnswer = null,
    now = () => Date.now(),
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.model = model;
    this.fetch = fetchImpl;
    this.tools = tools; // { get_report(input), get_open_positions(), get_trader_trades(input), get_settings() } → string | object
    this.basicAnswer = basicAnswer; // (question) → string, used without a key
    this.now = now;
    this.recent = []; // request times for the rate limit
    this.stats = { requests: 0, lastError: null, lastErrorAt: null, inputTokens: 0, outputTokens: 0 };
  }

  get aiEnabled() {
    return Boolean(this.apiKey);
  }

  get provider() {
    if (String(this.apiKey || '').startsWith('AIza')) return 'gemini';
    if (String(this.apiKey || '').startsWith('sk-ant-')) return 'anthropic';
    if (String(this.model || '').startsWith('gemini-')) return 'gemini';
    return 'anthropic';
  }

  get activeModel() {
    if (this.provider === 'gemini') {
      return String(this.model || '').startsWith('gemini-') ? this.model : 'gemini-2.5-flash';
    }
    return String(this.model || '').startsWith('claude-') ? this.model : 'claude-sonnet-5-5';
  }

  status() {
    return {
      ai: this.aiEnabled,
      provider: this.aiEnabled ? this.provider : null,
      model: this.aiEnabled ? this.activeModel : null,
      requests: this.stats.requests,
      lastError: this.stats.lastError,
      lastErrorAt: this.stats.lastErrorAt,
    };
  }

  /** At most 20 questions a minute (protects the API bill if something loops). */
  allow() {
    const t = this.now();
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.recent.length >= 20) return false;
    this.recent.push(t);
    return true;
  }

  async runTool(name, input) {
    const fn = this.tools[name];
    if (typeof fn !== 'function') return `Unknown tool ${name}`;
    try {
      const out = await fn(input || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(cut)` : text;
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  /**
   * One reply. history: [{ role: 'user'|'assistant', text }] (oldest first, last = the question).
   * Returns { ok, text, mode: 'ai'|'basic', toolsUsed }.
   */
  async reply(history, { voice = false } = {}) {
    const clean = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
    while (clean.length && clean[0].role !== 'user') clean.shift(); // the API needs a user turn first
    const question = clean.length ? clean[clean.length - 1].content : '';
    if (!question || clean[clean.length - 1].role !== 'user') return { ok: false, error: 'Ask Dax something first.' };
    if (!this.allow()) return { ok: false, error: 'Dax is getting a lot of questions — try again in a minute.' };
    this.stats.requests += 1;

    if (!this.aiEnabled) {
      const text = this.basicAnswer ? await this.basicAnswer(question, { voice }) : 'Dax needs a GEMINI_API_KEY or ANTHROPIC_API_KEY to chat.';
      return { ok: true, text, mode: 'basic', toolsUsed: [] };
    }

    if (this.provider === 'gemini') {
      return this.replyGemini(clean, { voice });
    }

    const messages = clean.slice();
    const toolsUsed = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res;
      try {
        res = await this.call({ messages, voice, allowTools: round < MAX_TOOL_ROUNDS });
      } catch (err) {
        this.stats.lastError = String(err.message || err).slice(0, 200);
        this.stats.lastErrorAt = this.now();
        return { ok: false, error: `Dax could not reach Claude: ${this.stats.lastError}` };
      }
      const blocks = Array.isArray(res.content) ? res.content : [];
      const uses = blocks.filter((b) => b.type === 'tool_use');
      if (res.stop_reason === 'tool_use' && uses.length) {
        messages.push({ role: 'assistant', content: blocks });
        const results = [];
        for (const u of uses) {
          toolsUsed.push(u.name);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: await this.runTool(u.name, u.input) });
        }
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { ok: true, text: text || '(no answer)', mode: 'ai', provider: 'anthropic', toolsUsed };
    }
    return { ok: false, error: 'Dax looked at too many things at once — ask a narrower question.' };
  }

  async replyGemini(clean, { voice = false } = {}) {
    const contents = clean.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const toolsUsed = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let res;
      try {
        res = await this.callGemini({ contents, voice, allowTools: round < MAX_TOOL_ROUNDS });
      } catch (err) {
        this.stats.lastError = String(err.message || err).slice(0, 200);
        this.stats.lastErrorAt = this.now();
        return { ok: false, error: `Dax could not reach Gemini: ${this.stats.lastError}` };
      }
      const candidate = res?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const fnCalls = parts.filter((p) => p && p.functionCall && p.functionCall.name);
      if (fnCalls.length) {
        contents.push({ role: 'model', parts });
        const responseParts = [];
        for (const p of fnCalls) {
          const { name, args } = p.functionCall;
          toolsUsed.push(name);
          const raw = await this.runTool(name, args || {});
          let responseObj;
          try {
            const parsed = JSON.parse(raw);
            responseObj = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { result: parsed };
          } catch {
            responseObj = { result: raw };
          }
          responseParts.push({
            functionResponse: {
              name,
              response: responseObj,
            },
          });
        }
        contents.push({ role: 'user', parts: responseParts });
        continue;
      }
      const text = parts
        .filter((p) => typeof p?.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('\n')
        .trim();
      return { ok: true, text: text || '(no answer)', mode: 'ai', provider: 'gemini', toolsUsed };
    }
    return { ok: false, error: 'Dax looked at too many things at once — ask a narrower question.' };
  }

  async callGemini({ contents, voice, allowTools }) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const model = this.activeModel;
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt({ voice }) }] },
        contents,
        generationConfig: {
          maxOutputTokens: voice ? 400 : 2048,
          temperature: 0.2,
        },
      };
      if (allowTools) {
        body.tools = [
          {
            functionDeclarations: TOOLS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            })),
          },
        ];
      }
      const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`;
      const r = await this.fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      if (!r.ok) throw new Error(json?.error?.message ? `${r.status}: ${json.error.message}` : `HTTP ${r.status}`);
      if (json?.usageMetadata) {
        this.stats.inputTokens += Number(json.usageMetadata.promptTokenCount) || 0;
        this.stats.outputTokens += Number(json.usageMetadata.candidatesTokenCount) || 0;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('timed out');
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async call({ messages, voice, allowTools }) {
    if (this.provider === 'gemini') {
      const contents = (messages || []).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));
      const json = await this.callGemini({ contents, voice, allowTools });
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .filter((p) => typeof p?.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('\n')
        .trim();
      return { ...json, content: [{ type: 'text', text }] };
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const body = { model: this.activeModel, max_tokens: voice ? 400 : 1500, system: systemPrompt({ voice }), messages };
      if (allowTools) body.tools = TOOLS;
      const r = await this.fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      if (!r.ok) throw new Error(json?.error?.message ? `${r.status}: ${json.error.message}` : `HTTP ${r.status}`);
      if (json?.usage) {
        this.stats.inputTokens += Number(json.usage.input_tokens) || 0;
        this.stats.outputTokens += Number(json.usage.output_tokens) || 0;
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('timed out');
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Basic-mode answer (no API key): Dax's findings for the period the question points at. */
export function basicDaxAnswer(question, report, { voice = false } = {}) {
  const f = report.findings || [];
  const lead = `Here is what I found for ${report.period.label.toLowerCase()}:`;
  const lines = f.slice(0, voice ? 3 : 8).map((x) => x.text);
  const note = voice ? '' : '\n\n(Basic mode: I can only read out my report findings. Add ANTHROPIC_API_KEY on Railway and I can answer any question about your trades.)';
  return voice ? `${lead} ${lines.join(' ')}` : `${lead}\n\n${lines.map((l) => `• ${l}`).join('\n')}${note}`;
}

/** Which report period a question is about. */
export function periodFromQuestion(q) {
  const s = String(q || '').toLowerCase();
  if (/week|7 ?d|seven days/.test(s)) return '7d';
  if (/all time|ever|everything/.test(s)) return 'all';
  if (/today|this morning|tonight/.test(s)) return 'today';
  return '24h';
}

// ---------------------------------------------------------------------------------------------
// Smart basic mode (no API key): Dax works out what the question is about and answers it from
// the bot's own records (read-only), instead of reading out the whole report every time.
// ---------------------------------------------------------------------------------------------
const usd = (v) => {
  const n = Number(v) || 0;
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;
};
const pct = (v) => (Number.isFinite(Number(v)) && v !== null ? `${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(1)}%` : '—');
const secs = (ms) => (Number.isFinite(ms) && ms !== null ? (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`) : '—');
const med = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export const DAX_TOPICS = [
  ['help', /^\s*(hi|hello|hey|yo|sup|salam|help|menu)\b|what can you|who are you|how do i use/i],
  ['delay', /delay|latenc|speed|slow|fast|\bms\b|millisec|how quick|lag\b|behind the trader|seconds? (late|behind)/i],
  ['skips', /skip|miss(ed)?\b|not cop|did ?n[o']?t cop|why.*(not|n't|no).*(buy|cop)|chase|blocked|rejected/i],
  ['vs', /\bvs\b|versus|against|compar|trader (won|win|made|profit)|why.*(lost|lose|losing)|decu (won|win|made)/i],
  ['open', /\bopen\b|holding|position|\bbags?\b|what do (i|we) (hold|have)/i],
  ['recent', /last trades?|recent|closed|history|latest trades?|last (buy|sell)s?/i],
  ['pnl', /pnl|p&l|profit|\bloss|\blost\b|\blose\b|losing|\bwin|made|make|earn|result|perform|how (am|are|did|is) (i|we|it|the bot)|money/i],
  ['wallet', /wallet|balance|sol left|how much sol|funds|buys? left/i],
  ['settings', /setting|limit|max chase|config|route|jupiter|direct|stop.?loss|take.?profit|fast (trade )?detect|paper mode|real mode/i],
  ['trader', /(decu|trader)('?s)? (trades|buys|sells|bought|sold|doing)|what did .* (buy|sell)|trader activity/i],
  ['report', /report|summary|overview|findings|status|how('?s| is) (it|everything) going/i],
];

export function daxTopics(question) {
  const q = String(question || '');
  const hits = DAX_TOPICS.filter(([, re]) => re.test(q)).map(([k]) => k);
  // "why did we lose" is a vs-trader question, not a plain PnL question
  if (hits.includes('vs') && hits.includes('pnl')) hits.splice(hits.indexOf('pnl'), 1);
  return hits;
}

/**
 * ctx: { report, openPositions(), traderTrades({hours,limit}), settings(), signals[], realTrades[],
 *        fastDetect, swapRoute, directStats }
 */
export function smartDaxAnswer(question, ctx, { voice = false } = {}) {
  const topics = daxTopics(question);
  const r = ctx.report;
  const period = r?.period?.label?.toLowerCase() || 'the last 24 hours';
  const parts = [];
  const add = (title, lines) => {
    if (!lines || !lines.length) return;
    parts.push(voice ? lines.join(' ') : `**${title}**\n${lines.map((l) => (l.startsWith('  ') ? l : `• ${l}`)).join('\n')}`);
  };

  const sections = {
    help: () =>
      add('Hi, I’m Dax', [
        'I read the Odex records and answer from them. Try:',
        '“what is the delay right now?”',
        '“why were trades skipped?”',
        '“how much did we make today?”',
        '“what are my open positions?”',
        '“last trades” · “us vs Decu” · “wallet balance” · “settings”',
      ]),
    delay: () => {
      const since = Date.now() - 24 * 3600_000;
      const sigs = (ctx.signals || []).filter((s) => !s.backfill && (s.detectedAt || 0) >= since);
      const copied = sigs.filter((s) => (s.copies || []).some((c) => c.ok));
      const spotMs = med(sigs.map((s) => (s.blockTime && s.detectedAt ? s.detectedAt - s.blockTime : null)));
      const pushMs = med(sigs.map((s) => Number(s.streamMs)));
      const copyMs = med(copied.flatMap((s) => (s.copies || []).filter((c) => c.ok).map((c) => Number(c.handledMs))));
      const orders = (ctx.realTrades || []).filter((t) => t.ok && t.timing && (t.t || 0) >= since);
      const sendMs = med(orders.map((t) => Number(t.timing.sendMs)));
      const fast = sigs.filter((s) => s.via === 'fast-logs').length;
      const lines = [];
      if (!sigs.length) lines.push(`No live trades from your traders in the last 24 h, so there is nothing to measure yet.`);
      else {
        lines.push(`Trader trade → Odex sees it: ~${secs(spotMs)} (median of ${sigs.length} live trades)`);
        if (pushMs !== null) lines.push(`Push → signal ready: ${secs(pushMs)}`);
        if (copyMs !== null) lines.push(`Signal → copy done: ${secs(copyMs)}`);
        if (sendMs !== null) lines.push(`Real order sent → landed: ${secs(sendMs)} (${orders.length} real orders)`);
        const total = [spotMs, copyMs].every((x) => x !== null) ? spotMs + copyMs : null;
        if (total !== null) lines.push(`Total, trader → our copy: ~${secs(total)}`);
        lines.push(`Fast-detected (read from the push): ${fast} of ${sigs.length}`);
        const last = copied.slice(0, voice ? 1 : 3);
        if (last.length && !voice) {
          lines.push('Last copies:');
          for (const s of last) {
            const c = (s.copies || []).find((x) => x.ok);
            lines.push(`  ${s.symbol} ${s.side} — seen ${secs(s.blockTime ? s.detectedAt - s.blockTime : null)} after the trader, copied in ${secs(Number(c?.handledMs))} (${s.via === 'fast-logs' ? 'fast detect' : s.via || 'poll'})`);
          }
        }
      }
      if (ctx.feedRace && (ctx.feedRace.main || ctx.feedRace.extra || ctx.feedRace.grpc)) lines.push(`Live feeds — heard the trade first: Helius ${ctx.feedRace.main}${ctx.feedRace.extra ? `, ${ctx.feedRace.extraName || 'Sodae'} WebSocket ${ctx.feedRace.extra}` : ''}${ctx.feedRace.grpc !== undefined ? `, Yellowstone gRPC ${ctx.feedRace.grpc}` : ''}`);
      lines.push(`Swap route: ${ctx.swapRoute === 'direct' ? 'Direct pump.fun' : 'Jupiter'} · Fast Trade Detection: ${ctx.fastDetect?.on ? 'on' : 'off'}${!ctx.fastDetect?.on || ctx.swapRoute !== 'direct' ? ' — turn both on in Settings → Trading & risk for ~1 s copies' : ''}`);
      if (ctx.fastDetect?.on && ctx.fastDetect.phantoms) lines.push(`Phantom trades closed (trader trade never landed): ${ctx.fastDetect.phantoms}`);
      add('Delay', lines);
    },
    skips: () => {
      const lines = [];
      for (const t of r?.data?.traders || []) {
        if (!t.buysSeen) continue;
        lines.push(`${t.handle}: ${t.buysSeen} buys seen, ${t.copiedBuys} copied, ${t.missedBuys} skipped`);
        for (const [why, n] of t.reasons.slice(0, voice ? 2 : 5)) lines.push(`  ${n}× ${why}`);
        const wonMissed = (t.missedCoins || []).filter((m) => Number(m.traderPct) > 0).slice(0, 3);
        if (wonMissed.length && !voice) lines.push(`  Skipped coins the trader won on: ${wonMissed.map((m) => `${m.sym || m.mint.slice(0, 4)} ${pct(m.traderPct)}`).join(', ')}`);
      }
      if (!lines.length) lines.push(`No trader buys were skipped in ${period}.`);
      else if (lines.some((l) => /chase/i.test(l))) lines.push('“Price ran past your max chase” means other copiers pushed the price up before we got in — Direct + Fast Trade Detection cut that most.');
      add(`Skips — ${period}`, lines);
    },
    pnl: () => {
      const line = (k, s) => (s && (s.trades || s.sells) ? `${k}: ${usd(s.realized)} from ${s.trades || s.sells} closed trades (${s.wins || 0} won, ${s.losses || 0} lost)${k === 'Real SOL' && s.realizedSol ? ` = ${s.realizedSol > 0 ? '+' : ''}${s.realizedSol} SOL` : ''}` : `${k}: no closed trades`);
      add(`Results — ${period}`, [line('Real SOL', r?.data?.real), line('Paper', r?.data?.paper)]);
    },
    open: () => {
      const list = (ctx.openPositions?.() || []).slice(0, voice ? 3 : 10);
      add('Open positions', list.length ? list.map((p) => `${p.coin} (${p.kind}, ${p.trader}) — cost $${Number(p.costUsd).toFixed(2)}, now $${Number(p.valueUsd).toFixed(2)} ${pct(p.pnlPct)}, held ${p.heldSec != null ? secs(p.heldSec * 1000) : '—'}`) : ['No open positions right now.']);
    },
    recent: () => {
      const closed = (r?.data?.closed || []).slice(-(voice ? 3 : 8)).reverse();
      add(`Last closed trades — ${period}`, closed.length ? closed.map((c) => `${c.sym} (${c.real ? 'real' : 'paper'}) ${usd(c.pnl)} ${pct(c.pnlPct)} — ${c.cause || 'closed'}, ${ago(c.closedAt)}`) : [`No trades closed in ${period}.`]);
    },
    vs: () => {
      const lines = [];
      for (const t of r?.data?.traders || []) {
        for (const v of (t.vs || []).slice(-(voice ? 2 : 6))) {
          lines.push(`${v.sym}: us ${pct(v.oursPct)} vs ${t.handle} ${pct(v.traderPct)}${v.causes?.length ? ` — we closed on ${v.causes[v.causes.length - 1]}` : ''}`);
        }
      }
      const e = r?.data?.entries;
      if (e && !voice) {
        for (const k of ['real', 'paper']) {
          const x = e[k];
          if (x?.first?.n || x?.re?.n) lines.push(`${k === 'real' ? 'Real' : 'Paper'}: first entries ${usd(x.first.pnl)} (${x.first.n}), re-entries ${usd(x.re.pnl)} (${x.re.n})`);
        }
      }
      const notes = (r?.findings || []).filter((f) => /trader|chase|late|behind|re-entr|wave/i.test(f.text)).slice(0, voice ? 1 : 3).map((f) => f.text);
      add(`Us vs the trader — ${period}`, lines.length || notes.length ? [...lines, ...notes] : [`No closed copies in ${period} to compare.`]);
    },
    wallet: () => {
      const w = r?.data?.wallet;
      add('Bot wallet', w ? [`${w.sol != null ? w.sol.toFixed(4) : '—'} SOL (keeps ${w.reserve ?? '—'} for fees)`, `Limits: ${w.perBuy || 'no'} SOL per buy, ${w.perDay || 'no'} SOL per day — used ${w.spent24h ?? 0} SOL in the last 24 h`, ...(w.buysLeft != null ? [`About ${w.buysLeft} more buys at the usual size`] : [])] : ['The bot wallet is not set up (no ODEX_TRADER_KEY).']);
    },
    settings: () => {
      const s = ctx.settings?.() || {};
      const lines = [`Mode: ${s.mode || '—'}`, `Swap route: ${ctx.swapRoute === 'direct' ? 'Direct pump.fun' : 'Jupiter'} · Fast Trade Detection: ${ctx.fastDetect?.on ? 'on' : 'off'}`];
      for (const t of (s.traders || []).slice(0, voice ? 1 : 5)) lines.push(`${t.name} (${t.status}${t.pauseReason ? `: ${t.pauseReason}` : ''}) — max chase ${t.maxChasePct ?? '—'}%, SL ${t.stopLossPct ?? '—'}%, TP ${t.takeProfitPct ?? '—'}%, sells with trader: ${t.sellsWhenTraderSells ? 'yes' : 'no'}, real SOL/day ${t.realSolPerDay ?? 'no limit'}`);
      add('Settings', lines);
    },
    trader: () => {
      const list = (ctx.traderTrades?.({ hours: 24, limit: voice ? 3 : 10 }) || []);
      add('Trader trades — last 24 h', list.length ? list.map((e) => `${e.trader} ${e.side} ${e.coin || e.mint.slice(0, 4)} $${Number(e.usd || 0).toFixed(0)}${e.side === 'sell' && e.soldPctOfBag ? ` (${Number(e.soldPctOfBag).toFixed(0)}% of bag)` : ''} — ${e.copies?.some((c) => c.copied) ? 'copied' : e.copies?.[0]?.reason ? `skipped: ${e.copies[0].reason}` : 'not copied'}, ${ago(Date.parse(e.at))}`) : ['No trades from your traders in the last 24 h.']);
    },
    report: () => add(`Report — ${period}`, (r?.findings || []).slice(0, voice ? 3 : 8).map((f) => f.text)),
  };

  const chosen = topics.length ? topics.slice(0, 3) : [];
  for (const k of chosen) sections[k]?.();
  if (!parts.length) {
    // not sure what was asked: a short answer, not the whole report
    sections.pnl();
    parts.push(voice ? 'Ask me about delay, skips, open positions, profit, or the last trades.' : 'I’m not sure what you meant — ask me about **delay**, **skips**, **open positions**, **profit**, **last trades**, **us vs the trader**, **wallet** or **settings**.');
  }
  return parts.join(voice ? ' ' : '\n\n');
}
