// tv-mt5-bridge-generic: TradingView alert -> this Worker (paper book in D1, entry blocks) -> Telegram post with a chart picture
// -> MT5 bridge EA, which polls /orders, trades, and reports back to /fills. Configuration: wrangler.toml [vars] and secrets
// (README). Every route answers fast: TradingView cancels a webhook after about 3 s and never retries it, so Telegram and
// charts run after the answer (ctx.waitUntil).
import { pair, sumR, newsBlock, weekendBlock, sessionBlock, dueExits, badAlert } from './book.js';
import { entryText, exitText, blockText, fillText, summaryText } from './msg.js';
import { sendTelegram, sendPost } from './tg.js';
import { tradePng, dayPng, fromBook } from './chart.js';

const H = 3600e3;
// TradingView's published webhook addresses (checked only when TV_IPS_ONLY = "1").
const TV_IPS = ['52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7'];
const parse = v => { try { return JSON.parse(v || '{}'); } catch { return {}; } };
const cfg = env => ({ costs: parse(env.COSTS), charts: parse(env.CHART_SYMBOLS), tz: env.TZ || 'UTC', riskPct: +env.RISK_PCT || 0 });
const iso = ms => new Date(ms).toISOString();
const at = r => r.fired_at || r.received_at;
const tgOn = env => !!(env.TG_TOKEN && env.TG_CHAT);
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// The tables, created on the first request of each Worker instance (no separate schema step).
const SCHEMA = [
  // every alert, and the Worker's own time exits / the EA's stop reports. ev: entry | exit;
  // blocked: null = traded, else news | dayloss | session | weekend | position | no position; tg_msg: the Telegram post
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, fired_at TEXT,
    symbol TEXT NOT NULL, ev TEXT NOT NULL, side TEXT, price REAL, sl REAL, reason TEXT, blocked TEXT,
    test INTEGER NOT NULL DEFAULT 0, news_title TEXT, news_min INTEGER, tg_msg INTEGER)`,
  'CREATE INDEX IF NOT EXISTS events_symbol ON events (symbol, test, id)',
  // the EA's reports. kind: open | skip | close | stop | stopout | manual
  `CREATE TABLE IF NOT EXISTS fills (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, received_at TEXT NOT NULL,
    kind TEXT NOT NULL, ok INTEGER NOT NULL, price REAL, lots REAL, profit REAL, risk REAL, msg TEXT, acct TEXT,
    test INTEGER NOT NULL DEFAULT 0, exec_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS fills_event ON fills (event_id)',
  'CREATE TABLE IF NOT EXISTS news (ts TEXT PRIMARY KEY, title TEXT NOT NULL)',   // high-impact releases (UTC)
  'CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)',
];
let ready;
const init = env => (ready ??= env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { ready = null; throw e; }));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname, k = env.KEY;
    if (!k) return text('set the KEY secret: npx wrangler secret put KEY', 500);
    await init(env);
    if (req.method === 'POST' && (p === `/hook/${k}` || p === `/test/${k}`)) return hook(req, env, ctx, p.startsWith('/test/'));
    if (req.method === 'GET' && (p === `/orders/${k}` || p === `/orders/${k}/last`)) return orders(env, url, p.endsWith('/last'));
    if (req.method === 'POST' && p === `/fills/${k}`) return fills(req, env, ctx);
    if (req.method === 'GET' && p === `/log/${k}`) return log(env, url);
    if (req.method === 'GET' && p === `/chart/${k}`) return chartRoute(env, url);
    if (req.method === 'GET' && p === `/run/${k}`) return text(await run(env, url.searchParams.get('task'), Date.now(), true));
    return text('not found', 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await init(env);
      for (const task of ['exits', 'news', 'summary']) await run(env, task, Date.now()).catch(e => console.log(task, e.message));
    })());
  },
};

// ---- TradingView alert ----
async function hook(req, env, ctx, isTest) {
  if (!isTest && env.TV_IPS_ONLY === '1' && !TV_IPS.includes(req.headers.get('cf-connecting-ip'))) return text('forbidden', 403);
  let b;
  try { b = JSON.parse(await req.text()); } catch { return text('bad json', 400); }
  const bad = badAlert(b);
  if (bad) return text(bad, 400);
  const now = Date.now(), fired = Date.parse(b.time), ev = b.side === 'exit' ? 'exit' : 'entry';
  const row = { received_at: iso(now), fired_at: fired ? iso(fired) : null, symbol: b.symbol.toUpperCase(), ev,
    side: ev === 'entry' ? b.side : null, price: b.price == null ? null : +b.price, sl: ev === 'entry' ? +b.sl : null,
    reason: b.reason ? String(b.reason).slice(0, 40) : null, test: isTest || b.test === true ? 1 : 0, news_title: null, news_min: null, blocked: null };
  const t = fired || now;
  const [last, news, today] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM events WHERE symbol = ? AND test = ? AND blocked IS NULL ORDER BY id DESC LIMIT 1').bind(row.symbol, row.test),
    env.DB.prepare('SELECT ts, title FROM news WHERE ts BETWEEN ? AND ?').bind(iso(t - 2 * H), iso(t + 2 * H)),
    env.DB.prepare('SELECT * FROM events WHERE test = ? AND COALESCE(fired_at, received_at) >= ? ORDER BY id').bind(row.test, iso(t - t % 86400e3)),
  ]);
  const inPos = last.results[0]?.ev === 'entry';
  if (ev === 'exit') {
    if (!inPos) row.blocked = 'no position';                 // stored, never sent to MT5, never posted
  } else {
    const cap = +env.DAY_LOSS_R || 0, dayR = cap > 0 ? sumR(today.results, cfg(env).costs) : 0;
    const before = env.NEWS_BEFORE_MIN === undefined ? 30 : +env.NEWS_BEFORE_MIN, after = +env.NEWS_AFTER_MIN || 0;
    const nb = before > 0 || after > 0 ? newsBlock(t, news.results, before, after) : null;
    if (weekendBlock(t, env.WEEKEND_CUTOFF_UTC)) row.blocked = 'weekend';
    else if (sessionBlock(t, env.SESSION_UTC)) row.blocked = 'session';
    else if (inPos) row.blocked = 'position';
    else if (nb) { row.blocked = 'news'; row.news_title = nb.title; row.news_min = nb.min; }
    else if (cap > 0 && dayR <= -cap) { row.blocked = 'dayloss'; row.day_r = dayR; row.day_cap = cap; }
  }
  const ins = await env.DB.prepare(`INSERT INTO events (received_at, fired_at, symbol, ev, side, price, sl, reason, blocked, test, news_title, news_min)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(row.received_at, row.fired_at, row.symbol, row.ev, row.side, row.price, row.sl,
    row.reason, row.blocked, row.test, row.news_title, row.news_min).first();
  row.id = ins.id;
  if (tgOn(env) && b.quiet !== true && row.blocked !== 'no position') ctx.waitUntil(post(env, row, inPos ? last.results[0] : null).catch(e => console.log('post', e.message)));
  return text('ok');
}

async function post(env, row, entry) {
  const c = cfg(env), ticker = c.charts[row.symbol];
  if (row.blocked) return sendTelegram(env, blockText(row));
  let id;
  if (row.ev === 'entry') {
    const png = ticker ? await tradePng({ side: row.side === 'long' ? 1 : -1, entry: row.price, stop: row.sl, at: Date.parse(at(row)) }, ticker, c.tz) : null;
    id = await sendPost(env, entryText(row, c), png);
  } else {
    const tr = pair([entry, row], c.costs)[0];
    const png = ticker && tr.exit != null ? await tradePng(fromBook(tr), ticker, c.tz) : null;
    id = await sendPost(env, exitText(tr, c), png);
  }
  if (id) await env.DB.prepare('UPDATE events SET tg_msg = ? WHERE id = ?').bind(id, row.id).run();
}

// ---- MT5 EA ----
// Lines "id|entry|symbol|side|sl|age seconds|" and "id|exit|symbol|||age seconds|entry id"; /last = the newest id, so a starting
// EA never replays old signals. Exits written from the EA's own stop reports ("broker ...") are not sent back to it.
async function orders(env, url, last) {
  const test = url.searchParams.get('test') === '1' ? 1 : 0;
  if (last) return text(String((await env.DB.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE test = ?').bind(test).first()).id));
  const after = parseInt(url.searchParams.get('after') || '0', 10) || 0, now = Date.now();
  const { results } = await env.DB.prepare(`SELECT e.*, (SELECT MAX(x.id) FROM events x WHERE x.test = e.test AND x.ev = 'entry'
      AND x.symbol = e.symbol AND x.blocked IS NULL AND x.id < e.id) AS entry_id
    FROM events e WHERE e.test = ? AND e.id > ? AND e.blocked IS NULL AND COALESCE(e.reason, '') NOT LIKE 'broker%' ORDER BY e.id LIMIT 20`)
    .bind(test, after).all();
  return text(results.map(e => [e.id, e.ev, e.symbol, e.side || '', e.sl ?? '', Math.round((now - Date.parse(e.received_at)) / 1000),
    e.ev === 'exit' ? e.entry_id ?? '' : ''].join('|')).join('\n'));
}

// The EA's report: open, skip, close (its own close on an exit line), stop / stopout / manual (closes it did not send).
async function fills(req, env, ctx) {
  let f;
  try { f = JSON.parse(await req.text()); } catch { return text('bad json', 400); }
  const s = (v, n) => v == null || v === '' ? null : String(v).slice(0, n), num = v => v == null || v === '' || !Number.isFinite(+v) ? null : +v;
  const row = { event_id: parseInt(f.event_id, 10) || 0, kind: s(f.kind, 16) || '', ok: f.ok ? 1 : 0, price: num(f.price) > 0 ? +f.price : null,
    lots: num(f.lots), profit: num(f.profit), risk: num(f.risk), msg: s(f.msg, 200), acct: s(f.acct, 32), test: f.test ? 1 : 0,
    exec_at: num(f.at) ? iso(+f.at) : null };
  // The same close reported twice (the EA's trade event and its poll can both see it): keep the first.
  if (!['open', 'skip'].includes(row.kind) && await env.DB.prepare(`SELECT 1 FROM fills WHERE event_id = ? AND kind = ? AND acct IS ? AND received_at > ?`)
    .bind(row.event_id, row.kind, row.acct, iso(Date.now() - 120e3)).first()) return text('ok');
  await env.DB.prepare(`INSERT INTO fills (event_id, received_at, kind, ok, price, lots, profit, risk, msg, acct, test, exec_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(row.event_id, iso(Date.now()), row.kind, row.ok, row.price, row.lots, row.profit,
    row.risk, row.msg, row.acct, row.test, row.exec_at).run();
  const e = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(row.event_id).first();
  if (e && row.ok && row.price != null && !['open', 'skip'].includes(row.kind)) {
    if (e.ev === 'exit' && e.price == null) {                // a time exit has no alert price: the broker's close price books it
      await env.DB.prepare('UPDATE events SET price = ? WHERE id = ?').bind(row.price, e.id).run();
    } else if (e.ev === 'entry') {                           // a stop or hand close: book it if the paper trade is still open
      const last = await env.DB.prepare('SELECT id FROM events WHERE symbol = ? AND test = ? AND blocked IS NULL ORDER BY id DESC LIMIT 1')
        .bind(e.symbol, e.test).first();
      if (last?.id === e.id) await env.DB.prepare(`INSERT INTO events (received_at, fired_at, symbol, ev, price, reason, test)
        VALUES (?, ?, ?, 'exit', ?, ?, ?)`).bind(iso(Date.now()), row.exec_at, e.symbol, row.price, `broker ${row.kind}`, e.test).run();
    }
  }
  if (e && tgOn(env)) ctx.waitUntil((async () => {
    const entryId = e.ev === 'entry' ? e.id : (await env.DB.prepare(`SELECT MAX(id) AS id FROM events WHERE ev = 'entry' AND symbol = ? AND test = ?
      AND blocked IS NULL AND id < ?`).bind(e.symbol, e.test, e.id).first())?.id;
    const open = await env.DB.prepare(`SELECT * FROM fills WHERE event_id = ? AND kind = 'open' AND ok = 1 AND acct IS ? ORDER BY id DESC LIMIT 1`)
      .bind(entryId ?? -1, row.acct).first();
    await sendTelegram(env, fillText(row, e, open), e.tg_msg);
  })().catch(x => console.log('fill post', x.message)));
  return text('ok');
}

// ---- cron tasks (every 5 minutes) and /run/<KEY>?task= for trying them by hand ----
async function run(env, task, now, force = false) {
  const st = async k => (await env.DB.prepare('SELECT v FROM state WHERE k = ?').bind(k).first())?.v;
  const put = (k, v) => env.DB.prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();
  if (task === 'exits') {                                    // time exit after MAX_HOLD_MIN (off when unset)
    const max = +env.MAX_HOLD_MIN || 0;
    if (!max) return 'MAX_HOLD_MIN not set';
    const { results } = await env.DB.prepare('SELECT * FROM events WHERE COALESCE(fired_at, received_at) >= ? ORDER BY id').bind(iso(now - 7 * 86400e3)).all();
    const due = [0, 1].flatMap(test => dueExits(pair(results.filter(e => e.test === test), cfg(env).costs), now, max));
    for (const t of due) {
      const r = await env.DB.prepare(`INSERT INTO events (received_at, symbol, ev, reason, test) VALUES (?, ?, 'exit', 'time', ?) RETURNING id`)
        .bind(iso(now), t.symbol, t.test).first();
      if (tgOn(env)) {
        const id = await sendTelegram(env, exitText({ ...t, reason: 'time', exit: null }, cfg(env)));
        if (id) await env.DB.prepare('UPDATE events SET tg_msg = ? WHERE id = ?').bind(id, r.id).run();
      }
    }
    return `${due.length} time exit(s)`;
  }
  if (task === 'news') {                                     // ForexFactory's weekly calendar, high impact, every 6 h
    if (!force && now - (+(await st('news_at')) || 0) < 6 * H) return 'news fresh';
    const cur = (env.NEWS_CURRENCIES || 'USD').split(',').map(x => x.trim().toUpperCase());
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'user-agent': 'Mozilla/5.0 (tv-mt5-bridge)' } });
    if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
    const rows = (await r.json()).filter(e => cur.includes(e.country) && e.impact === 'High').map(e => [Date.parse(e.date), e.title])
      .filter(([ms]) => ms && new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() > 0);   // all-day items have no release time
    if (rows.length) await env.DB.batch(rows.map(([ms, title]) => env.DB.prepare('INSERT OR REPLACE INTO news (ts, title) VALUES (?, ?)')
      .bind(iso(ms), String(title).slice(0, 120))));
    await put('news_at', now);
    return `${rows.length} high-impact release(s) stored`;
  }
  if (task === 'summary') {                                  // daily summary at SUMMARY_UTC_HOUR (default 21), once a day
    const hour = env.SUMMARY_UTC_HOUR === undefined ? 21 : +env.SUMMARY_UTC_HOUR, today = iso(now).slice(0, 10);
    if (!force && (new Date(now).getUTCHours() !== hour || await st('summary_day') === today)) return 'not summary time';
    if (!tgOn(env)) return 'Telegram not set';
    // ponytail: reads the whole book for the all-time line; page it by month if the table grows past ~100k rows
    const { results } = await env.DB.prepare('SELECT * FROM events WHERE test = 0 ORDER BY id').all();
    const c = cfg(env), closed = pair(results, c.costs).filter(t => t.status === 'closed');
    const since = ms => closed.filter(t => Date.parse(t.exitAt) >= ms), sum = ts => ts.reduce((s, t) => s + t.Rnet, 0);
    const day = since(now - 24 * H), m0 = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const bySym = {};
    for (const t of day) if (c.charts[t.symbol]) bySym[t.symbol] = (bySym[t.symbol] || 0) + 1;
    const top = Object.keys(bySym).sort((a, b) => bySym[b] - bySym[a])[0];
    const png = top ? await dayPng(day.filter(t => t.symbol === top), Math.floor((now - 24 * H) / 300e3) * 300e3, c.charts[top], c.tz) : null;
    await sendPost(env, summaryText({ trades: day, day: sum(day), month: sum(since(m0)), all: sum(closed), riskPct: c.riskPct, tz: c.tz, now: iso(now) }), png);
    await put('summary_day', today);
    return `summary sent (${day.length} trade(s))`;
  }
  return 'task must be exits, news or summary';
}

// ---- paper book as CSV, and a chart preview of one trade ----
async function log(env, url) {
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE test = ? ORDER BY id').bind(url.searchParams.get('test') === '1' ? 1 : 0).all();
  const cols = ['id', 'symbol', 'side', 'entryAt', 'entry', 'sl', 'exitAt', 'exit', 'reason', 'R', 'Rnet', 'status'];
  const cell = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return new Response([cols.join(','), ...pair(results, cfg(env).costs).map(t => cols.map(k => cell(t[k])).join(','))].join('\n'),
    { headers: { 'content-type': 'text/csv; charset=utf-8' } });
}

async function chartRoute(env, url) {
  const id = +url.searchParams.get('id');
  const e = await env.DB.prepare('SELECT * FROM events WHERE id = ? AND ev = ?').bind(id, 'entry').first();
  if (!e || e.blocked) return text('no traded entry with that id', 404);
  const { results } = await env.DB.prepare('SELECT * FROM events WHERE symbol = ? AND test = ? AND id >= ? ORDER BY id LIMIT 50').bind(e.symbol, e.test, id).all();
  const c = cfg(env), ticker = c.charts[e.symbol];
  if (!ticker) return text(`CHART_SYMBOLS has no ticker for ${e.symbol}`, 400);
  const png = await tradePng(fromBook(pair(results, c.costs)[0]), ticker, c.tz);
  return png ? new Response(png, { headers: { 'content-type': 'image/png' } }) : text('chart failed (see the Worker log)', 502);
}
