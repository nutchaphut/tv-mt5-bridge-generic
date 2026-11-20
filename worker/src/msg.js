// Telegram texts. Rule: never an account number, balance, lot size or money amount - prices, R (risk units) and risk % only.

export const px = (v, ref = v) => v == null ? '?' : (+v).toLocaleString('en-US', ref < 10 ? { minimumFractionDigits: 4, maximumFractionDigits: 5 }
  : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sR = r => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
export const when = (iso, tz = 'UTC') => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const held = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const tag = test => test ? '🧪 TEST · ' : '';

export function entryText(e, { tz = 'UTC', riskPct } = {}) {
  const buy = e.side === 'long';
  return `${tag(e.test)}${buy ? '🟢 BUY' : '🔴 SELL'} ${e.symbol} at ${px(e.price)}\n` +
    `Stop ${px(e.sl)} (${px(Math.abs(e.price - e.sl), e.price)} away)` + (riskPct ? ` · risk ${riskPct}% a trade` : '') + '\n' +
    (e.news_title ? `News: ${e.news_title} ${e.news_min >= 0 ? 'in' : ''} ${Math.abs(e.news_min)} min${e.news_min < 0 ? ' ago' : ''}\n` : '') +
    `🕒 ${when(e.fired_at || e.received_at, tz)} (${tz})`;
}

// t: a closed (or priceless) trade from book.pair
export function exitText(t, { tz = 'UTC' } = {}) {
  const how = t.reason ? ` (${t.reason})` : '';
  if (t.exit == null) return `${tag(t.test)}⏱ EXIT ${t.symbol} ${t.side}${how}: closing at market, the price comes with MT5's report`;
  return `${tag(t.test)}${t.Rnet > 0 ? '✅' : '❌'} EXIT ${t.symbol} ${t.side} at ${px(t.exit)} · ${sR(t.Rnet)} after costs${how}\n` +
    `Entry ${px(t.entry)} · held ${held(Date.parse(t.exitAt) - Date.parse(t.entryAt))} · 🕒 ${when(t.exitAt, tz)} (${tz})`;
}

const WHY = {
  news: e => `high-impact news ${e.news_min >= 0 ? `in ${e.news_min} min` : `${-e.news_min} min ago`} (${e.news_title})`,
  dayloss: e => `daily loss cap reached (${sR(e.day_r)} today, cap ${e.day_cap}R)`,
  session: () => 'outside the trading hours', weekend: () => 'weekend cut-off', position: e => `already in a ${e.symbol} position`,
};
export const blockText = e => `${tag(e.test)}⛔ Not taken: ${e.side === 'long' ? 'BUY' : 'SELL'} ${e.symbol} at ${px(e.price)} - ` +
  (WHY[e.blocked] ? WHY[e.blocked](e) : e.blocked);

// f: an MT5 report; e: its event; open: the entry's 'open' report (for R = profit / money at risk, shown as R only).
export function fillText(f, e, open) {
  if (f.kind === 'open') return f.ok ? `🤖 MT5 filled at ${px(f.price)} (signal ${px(e.price)})` : `⚠️ MT5 could not open: ${f.msg || 'refused'}`;
  if (f.kind === 'skip') return `⚠️ MT5 skipped: ${f.msg || 'no reason given'}`;
  if (!f.ok) return `⚠️ MT5 close failed: ${f.msg || 'refused'}`;
  const r = open?.risk > 0 && f.profit != null ? ` · ${sR(f.profit / open.risk)} on the account` : '';
  const by = { close: 'closed', stop: 'closed by its stop', manual: 'closed by hand', stopout: 'stopped out by the broker' }[f.kind] || f.kind;
  return `🤖 MT5 ${by} at ${px(f.price)}${r}`;
}

// Daily summary: the trades closed in the last 24 h, then running totals. riskPct turns R into % of the account (simple sum).
export function summaryText({ trades, day, month, all, riskPct, tz = 'UTC', now }) {
  const lines = trades.map(t => `${t.Rnet > 0 ? '✅' : '❌'} ${when(t.entryAt, tz)} ${t.symbol} ${t.side} ${sR(t.Rnet)}`);
  const pct = r => riskPct ? ` (${r >= 0 ? '+' : ''}${(r * riskPct).toFixed(1)}%)` : '';
  return `📊 DAILY SUMMARY · ${when(now, tz)} (${tz})\n` + (lines.length ? lines.join('\n') : 'No closed trades in the last 24 hours') + '\n' +
    `Day ${sR(day)}${pct(day)} · month ${sR(month)}${pct(month)} · all ${sR(all)}${pct(all)}`;
}
