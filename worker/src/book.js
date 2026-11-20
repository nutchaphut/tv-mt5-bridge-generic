// Pure helpers: the paper book (entries and exits paired per symbol, scored in R) and the entry blocks.
// R = move from entry to exit / stop distance; Rnet subtracts the symbol's round-trip cost (price units, COSTS var).

export function pair(events, costs = {}) {
  const trades = [], open = new Map();
  for (const e of events) {
    if (e.blocked) continue;                       // refused by the Worker: never traded, never booked
    const sym = e.symbol;
    if (e.ev === 'entry') {
      if (open.has(sym)) trades.push({ ...open.get(sym), status: 'no exit' });
      open.set(sym, { id: e.id, symbol: sym, side: e.side, entry: e.price, sl: e.sl, entryAt: e.fired_at || e.received_at,
        news: e.news_title || null, test: e.test || 0 });
    } else if (e.ev === 'exit' && open.has(sym)) {
      const t = open.get(sym), at = e.fired_at || e.received_at;
      open.delete(sym);
      if (e.price == null) { trades.push({ ...t, exitId: e.id, exitAt: at, reason: e.reason, status: 'exit without price' }); continue; }
      const risk = Math.abs(t.entry - t.sl), move = (t.side === 'long' ? 1 : -1) * (e.price - t.entry);
      trades.push({ ...t, exitId: e.id, exitAt: at, exit: e.price, reason: e.reason, R: move / risk,
        Rnet: (move - (+costs[sym] || 0)) / risk, status: 'closed' });
    }
  }
  for (const t of open.values()) trades.push({ ...t, status: 'open' });
  return trades.sort((a, b) => a.id - b.id);
}

// Sum of Rnet of the closed trades among these events (the daily loss cap passes one day's events).
export const sumR = (events, costs) => pair(events, costs).reduce((s, t) => s + (t.status === 'closed' ? t.Rnet : 0), 0);

// A release due within `before` minutes after the entry, or out at most `after` minutes before it: the nearest one, or null.
export function newsBlock(entryMs, releases, before = 30, after = 0) {
  let hit = null;
  for (const r of releases) {
    const min = Math.round((Date.parse(r.ts) - entryMs) / 60000);
    if (min >= -after && min <= before && (!hit || Math.abs(min) < Math.abs(hit.min))) hit = { title: r.title, min };
  }
  return hit;
}

// Friday from `cutoff` (UTC, "HH:MM") until the Sunday 22:00 UTC reopen. Empty cutoff = never.
export function weekendBlock(ms, cutoff) {
  if (!cutoff) return false;
  const [ch, cm] = cutoff.split(':').map(Number);
  const d = new Date(ms), day = d.getUTCDay(), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (day === 5 && mins >= ch * 60 + cm) || day === 6 || (day === 0 && mins < 22 * 60);
}

// Entries only inside "HH:MM-HH:MM" (UTC; may wrap past midnight). Empty = always open. True = outside, blocked.
export function sessionBlock(ms, window) {
  if (!window) return false;
  const [a, b] = window.split('-').map(s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; });
  const d = new Date(ms), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return a <= b ? !(mins >= a && mins < b) : !(mins >= a || mins < b);
}

// Open trades held at least maxMin minutes: the cron sends their time exit.
export const dueExits = (trades, now, maxMin) => maxMin > 0
  ? trades.filter(t => t.status === 'open' && Date.parse(t.entryAt) + maxMin * 60000 <= now) : [];

// Check of an alert body. Returns an error text, or null when it can be stored.
export function badAlert(b) {
  if (!b || typeof b !== 'object') return 'body is not a JSON object';
  if (typeof b.symbol !== 'string' || !/^[A-Za-z0-9._!:-]{1,20}$/.test(b.symbol)) return 'symbol missing or invalid';
  if (!['long', 'short', 'exit'].includes(b.side)) return 'side must be long, short or exit';
  if (b.side !== 'exit' || b.price != null) if (!(+b.price > 0)) return 'price must be a positive number';
  if (b.side === 'exit') return null;
  if (!(+b.sl > 0)) return 'an entry needs sl (stop price)';
  if (b.side === 'long' ? +b.sl >= +b.price : +b.sl <= +b.price) return 'sl must be below the price for long, above for short';
  return null;
}
