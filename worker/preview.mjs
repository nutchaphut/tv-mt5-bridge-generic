// node preview.mjs - every Telegram text with sample values, to check wording before deploying.
import { pair } from './src/book.js';
import { entryText, exitText, blockText, fillText, summaryText } from './src/msg.js';

const e = { id: 1, received_at: '2026-01-07T13:05:00.000Z', symbol: 'XAUUSD', ev: 'entry', side: 'long', price: 2650.4, sl: 2644.9, test: 0 };
const x = { id: 2, received_at: '2026-01-07T14:05:00.000Z', symbol: 'XAUUSD', ev: 'exit', price: 2659.1, reason: 'tp' };
const t = pair([e, x], { XAUUSD: 0.3 })[0], o = { tz: 'Europe/London', riskPct: 1 };
const show = (name, s) => console.log(`--- ${name}\n${s}\n`);
show('entry', entryText(e, o));
show('exit', exitText(t, o));
show('time exit (price from MT5 later)', exitText({ ...t, exit: null, reason: 'time' }, o));
show('blocked: news', blockText({ ...e, blocked: 'news', news_title: 'CPI m/m', news_min: 12 }));
show('blocked: daily loss cap', blockText({ ...e, blocked: 'dayloss', day_r: -3.4, day_cap: 3 }));
show('MT5 open', fillText({ kind: 'open', ok: 1, price: 2650.6 }, e));
show('MT5 skip', fillText({ kind: 'skip', ok: 0, msg: 'signal 75 s old' }, e));
show('MT5 stop', fillText({ kind: 'stop', ok: 1, price: 2644.7, profit: -20.4 }, e, { risk: 20 }));
show('daily summary', summaryText({ trades: [t], day: t.Rnet, month: 4.2, all: 12.6, riskPct: 1, tz: 'Europe/London', now: '2026-01-07T21:00:00Z' }));
