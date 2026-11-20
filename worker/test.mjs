// node test.mjs - the pure parts: paper book, blocks, alert checks, texts, chart helpers.
import assert from 'node:assert/strict';
import { pair, sumR, newsBlock, weekendBlock, sessionBlock, dueExits, badAlert } from './src/book.js';
import { entryText, exitText, blockText, fillText, summaryText } from './src/msg.js';
import { anchor, yahooBars, zoneOffset } from './src/chart.js';

const ev = (id, o) => ({ id, received_at: `2026-01-05T10:0${id}:00.000Z`, test: 0, blocked: null, ...o });
// paper book: long +2R, a blocked entry ignored, a short still open, an exit without a price
const E = [ev(1, { symbol: 'XAUUSD', ev: 'entry', side: 'long', price: 100, sl: 95 }), ev(2, { symbol: 'XAUUSD', ev: 'exit', price: 110 }),
  ev(3, { symbol: 'XAUUSD', ev: 'entry', side: 'long', price: 100, sl: 90, blocked: 'news' }),
  ev(4, { symbol: 'US500', ev: 'entry', side: 'short', price: 50, sl: 52 }), ev(5, { symbol: 'EURUSD', ev: 'entry', side: 'long', price: 1.1, sl: 1.09 }),
  ev(6, { symbol: 'EURUSD', ev: 'exit', price: null, reason: 'time' })];
const P = pair(E, { XAUUSD: 1 });
assert.equal(P.length, 3);
assert.deepEqual([P[0].R, P[0].Rnet, P[0].status], [2, 1.8, 'closed']);
assert.equal(P[1].status, 'open');
assert.equal(P[2].status, 'exit without price');
assert.equal(sumR(E, { XAUUSD: 1 }), 1.8);
assert.equal(dueExits(P, Date.parse('2026-01-05T11:05:00Z'), 60).length, 1);
assert.equal(dueExits(P, Date.parse('2026-01-05T11:05:00Z'), 0).length, 0);
// blocks
const t0 = Date.parse('2026-01-07T13:00:00Z');
assert.deepEqual(newsBlock(t0, [{ ts: '2026-01-07T13:30:00Z', title: 'CPI' }], 30, 0), { title: 'CPI', min: 30 });
assert.equal(newsBlock(t0, [{ ts: '2026-01-07T13:31:00Z', title: 'CPI' }], 30, 0), null);
assert.deepEqual(newsBlock(t0, [{ ts: '2026-01-07T12:58:00Z', title: 'NFP' }], 30, 2), { title: 'NFP', min: -2 });
assert.equal(weekendBlock(Date.parse('2026-01-09T20:30:00Z'), '20:00'), true);        // Friday after the cut-off
assert.equal(weekendBlock(Date.parse('2026-01-09T19:59:00Z'), '20:00'), false);
assert.equal(weekendBlock(Date.parse('2026-01-11T22:00:00Z'), '20:00'), false);       // Sunday reopen
assert.equal(weekendBlock(Date.parse('2026-01-10T12:00:00Z'), ''), false);            // off
assert.equal(sessionBlock(Date.parse('2026-01-07T06:59:00Z'), '07:00-20:00'), true);
assert.equal(sessionBlock(Date.parse('2026-01-07T07:00:00Z'), '07:00-20:00'), false);
assert.equal(sessionBlock(Date.parse('2026-01-07T01:00:00Z'), '22:00-02:00'), false);  // wraps midnight
assert.equal(sessionBlock(Date.parse('2026-01-07T03:00:00Z'), '22:00-02:00'), true);
assert.equal(sessionBlock(t0, ''), false);
// alert checks
assert.equal(badAlert({ symbol: 'XAUUSD', side: 'long', price: 100, sl: 95 }), null);
assert.equal(badAlert({ symbol: 'XAUUSD', side: 'exit', price: 100 }), null);
assert.match(badAlert({ symbol: 'XAUUSD', side: 'long', price: 100, sl: 105 }), /below/);
assert.match(badAlert({ symbol: 'XAUUSD', side: 'short', price: 100 }), /needs sl/);
assert.match(badAlert({ symbol: 'bad symbol!', side: 'long', price: 1, sl: 0.5 }), /symbol/);
assert.match(badAlert({ symbol: 'X', side: 'buy', price: 1 }), /side/);
// texts: never money, lots or an account
const fill = fillText({ kind: 'close', ok: 1, price: 105, profit: 40, acct: '123456' }, { price: 100 }, { risk: 20 });
assert.equal(fill, '🤖 MT5 closed at 105.00 · +2.00R on the account');
assert.ok(!/123456|40|\$/.test(fill));
assert.match(entryText({ ...E[0], test: 1 }, { tz: 'UTC', riskPct: 1 }), /^🧪 TEST · 🟢 BUY XAUUSD at 100\.00\nStop 95\.00 \(5\.00 away\) · risk 1% a trade/);
assert.match(exitText(P[0]), /EXIT XAUUSD long at 110\.00 · \+1\.80R after costs/);
assert.match(blockText({ side: 'short', symbol: 'US500', price: 50, blocked: 'dayloss', day_r: -3.2, day_cap: 3 }), /daily loss cap reached \(-3\.20R today, cap 3R\)/);
assert.match(summaryText({ trades: [P[0]], day: 1.8, month: 1.8, all: 1.8, riskPct: 1, now: '2026-01-05T21:00:00Z' }), /Day \+1\.80R \(\+1\.8%\)/);
// chart helpers
assert.equal(new Date(anchor(Date.parse('2026-01-07T23:00:00Z'))).toISOString(), '2026-01-07T22:00:00.000Z');   // 17:00 New York, winter
assert.equal(new Date(anchor(Date.parse('2026-07-07T23:00:00Z'))).toISOString(), '2026-07-07T21:00:00.000Z');   // summer
assert.equal(zoneOffset(t0, 'Asia/Tokyo'), 9 * 3600e3);
const yb = yahooBars({ timestamp: [1000, 1001, 1300], indicators: { quote: [{ open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [0, 0, 0] }] } }, 300e3);
assert.deepEqual(yb.map(b => b.o), [2, 3]);   // the in-progress copy a second later replaces its bar
console.log('all tests passed');
