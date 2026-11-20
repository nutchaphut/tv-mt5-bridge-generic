// Chart pictures for the Telegram posts: entry and exit (1-hour candles over 5-minute candles) and the daily summary (5-minute
// candles with the position boxes). Candles come from Yahoo Finance (free, no key) for the ticker the CHART_SYMBOLS var maps the
// alert symbol to, shifted onto the signal price because a futures or index feed sits a little off a broker's CFD. The VWAP
// resets at 17:00 New York (the futures trading day). QuickChart (Chart.js 3) draws the PNG. Every builder returns null on any
// failure, and the post then goes out as text.
const H = 3600e3, M5 = 300e3, DAY = 86400e3;
const C = { bg: '#151b21', grid: '#2a3139', txt: '#9aa4ad', up: '#2196f3', down: '#f23645', gold: '#f0c419', win: '#26a69a', vw: '#b388ff' };
const r2 = v => Math.round(v * 100000) / 100000;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const num = v => v.toLocaleString('en-US', v < 10 ? { minimumFractionDigits: 4, maximumFractionDigits: 5 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Minutes east of UTC of a time zone at time t (Intl, so daylight saving is handled).
export function zoneOffset(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

// 17:00 New York at or before t.
export function anchor(t) {
  const off = zoneOffset(t, 'America/New_York');
  return Math.floor((t + off - 17 * H) / DAY) * DAY + 17 * H - off;
}

// Yahoo adds a copy of the bar in progress stamped at its last trade (e.g. 18:00:01 next to 18:00:00), which squeezes every
// candle to a hairline: one bar per interval, the latest copy.
export function yahooBars(res, step) {
  const q = res.indicators.quote[0], by = new Map();
  res.timestamp.forEach((t, i) => { if (q.open[i] != null) by.set(Math.floor(t * 1000 / step) * step,
    { o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return [...by].map(([x, b]) => ({ x, ...b }));
}

async function bars(ticker, min, start, end) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${min === 60 ? '60m' : '5m'}` +
    `&period1=${Math.floor(start / 1000)}&period2=${Math.ceil(end / 1000)}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
  const res = r.ok ? (await r.json()).chart?.result?.[0] : null;
  if (!res?.timestamp) throw new Error(`yahoo ${r.status}`);
  return yahooBars(res, min * 60e3).filter(b => b.x >= start && b.x < end);
}

async function render(chart, width, height) {
  const r = await fetch('https://quickchart.io/chart', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '3', backgroundColor: C.bg, width, height, format: 'png', chart }), signal: AbortSignal.timeout(20000) });
  if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/png')) throw new Error(`quickchart ${r.status}`);
  return r.arrayBuffer();
}

// Running VWAP after each bar from `from` on, with a gap at each 17:00 New York reset.
// ponytail: resets step a whole day from the first anchor, so a daylight-saving week is an hour off; Intl per bar if it matters
function vwapLine(bars, from, X, off) {
  const out = []; let pv = 0, vv = 0, next = bars.length ? anchor(bars[0].x) + DAY : 0;
  for (const b of bars) {
    if (b.x >= next) { if (b.x > from) out.push({ x: X(b.x) - 1, y: null }); pv = vv = 0; next += DAY; }
    pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v;
    if (b.x >= from && vv) out.push({ x: X(b.x), y: r2(pv / vv + off) });
  }
  return out;
}

const candles = (bars, X, off, ids) => ({ ...ids, data: bars.map(b => ({ x: X(b.x), o: r2(b.o + off), h: r2(b.h + off), l: r2(b.l + off), c: r2(b.c + off) })),
  color: { up: C.up, down: C.down, unchanged: C.txt }, borderColor: { up: C.up, down: C.down, unchanged: C.txt } });
const label = (content, pos, fill, fg, border, size = 13) => ({ enabled: true, content, position: pos, backgroundColor: fill, color: fg, borderColor: border,
  borderWidth: 1.5, font: { size, weight: 'bold' }, xPadding: 8, yPadding: 5, cornerRadius: 5, borderRadius: 5 });
const hline = (y, color, text, pos, fill, fg, ids) => ({ type: 'line', ...ids, yMin: y, yMax: y, borderColor: color, borderWidth: 1.5, borderDash: [4, 4],
  label: label(text, pos, fill, fg, color) });
const tri = (pts, side, ids) => ({ ...ids, type: 'scatter', data: pts, pointStyle: 'triangle', rotation: side > 0 ? 0 : 180, radius: 7,
  backgroundColor: side > 0 ? C.up : C.down, borderColor: '#ffffff', borderWidth: 1 });

// Position boxes: risk from the entry to the stop, then the result from the entry to the exit.
function boxes(ann, k, t, x0, x1, ids) {
  ann[k + 'r'] = { type: 'box', ...ids, xMin: x0, xMax: x1, yMin: Math.min(t.entry, t.stop), yMax: Math.max(t.entry, t.stop),
    backgroundColor: 'rgba(242,54,69,0.22)', borderColor: 'rgba(242,54,69,0.7)', borderWidth: 1 };
  if (t.exit == null) return;
  const win = t.R > 0;
  ann[k + 'w'] = { type: 'box', ...ids, xMin: x0, xMax: x1, yMin: Math.min(t.entry, t.exit), yMax: Math.max(t.entry, t.exit),
    backgroundColor: win ? 'rgba(38,166,154,0.28)' : 'rgba(158,158,158,0.22)', borderColor: win ? 'rgba(38,166,154,0.8)' : 'rgba(158,158,158,0.6)', borderWidth: 1 };
}

const timeAxis = (min, max, step, extra = {}) => ({ type: 'time', min, max, grid: { display: false },
  ticks: { color: C.txt, font: { size: 12 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 30, major: { enabled: false } },
  time: { unit: 'hour', stepSize: step, displayFormats: { hour: 'HH:mm' } }, ...extra });
const chartOf = (datasets, annotations, scales) => ({ type: 'candlestick', data: { datasets },
  options: { layout: { padding: { left: 6, right: 6, top: 8, bottom: 4 } }, plugins: { legend: { display: false }, annotation: { annotations } }, scales } });

// Book trade -> drawing trade (R after costs).
export const fromBook = t => ({ side: t.side === 'long' ? 1 : -1, entry: t.entry, stop: t.sl, at: Date.parse(t.entryAt),
  exit: t.exit, exitAt: t.exitAt && t.exit != null ? Date.parse(t.exitAt) : undefined, R: t.Rnet });

// t: { side: 1 | -1, entry, stop, at (ms), exit?, exitAt?, R? }; tz: the time zone the axis shows. The entry picture shows what
// was known at the signal, the exit picture what was known at the exit.
export async function tradePng(t, ticker, tz = 'UTC') {
  try {
    const end = t.exitAt ?? t.at, at5 = Math.floor(t.at / M5) * M5, sh = zoneOffset(end, tz), X = x => x + sh;
    const m5 = await bars(ticker, 5, end - 600 * M5, end);
    const sig = m5.findLast(b => b.x < at5);
    if (!sig) return null;
    const off = t.entry - sig.c;
    const h1 = (await bars(ticker, 60, end - 36 * H, end)).filter(b => b.x + H <= end);
    const part = m5.filter(b => b.x >= Math.floor(end / H) * H);        // the hour in progress, as it stood
    if (part.length) h1.push({ x: part[0].x, o: part[0].o, h: Math.max(...part.map(b => b.h)), l: Math.min(...part.map(b => b.l)), c: part.at(-1).c });
    const ds = [], ann = {}, scales = {}, sc = t.side < 0 ? C.down : C.up, xEnd = X(t.exitAt ?? at5 + H);
    for (const [tf, pb, ahead, step] of [['h', h1, 3 * H, 6], ['m', m5.slice(-48), t.exitAt ? 20 * 60e3 : H, 1]]) {
      if (!pb.length) continue;
      const ids = { xAxisID: 'x' + tf, yAxisID: 'y' + tf }, aid = { xScaleID: 'x' + tf, yScaleID: 'y' + tf };
      const vl = vwapLine(m5, pb[0].x, X, off), vw = vl.findLast(p => p.y != null)?.y;
      ds.push(candles(pb, X, off, ids), { ...ids, type: 'line', data: vl, borderColor: C.vw, borderWidth: 2, pointRadius: 0, spanGaps: false },
        tri([{ x: X(sig.x), y: t.entry }], t.side, ids));
      const a = { e1: hline(t.entry, sc, t.side < 0 ? 'Sell' : 'Buy', 'start', sc, '#ffffff', aid), e2: hline(t.entry, sc, num(t.entry), 'end', sc, '#ffffff', aid),
        s1: hline(t.stop, C.gold, 'Stop', 'start', C.bg, C.gold, aid), s2: hline(t.stop, C.gold, num(t.stop), 'end', C.bg, C.gold, aid) };
      if (vw != null) a.v = { type: 'line', ...aid, yMin: vw, yMax: vw, borderWidth: 0, borderColor: 'rgba(0,0,0,0)',
        label: label(`VWAP ${num(vw)}`, 'end', C.bg, C.vw, C.vw, 12) };
      if (t.exit != null) {
        const ec = t.R > 0 ? C.win : C.down;
        a.x1 = hline(t.exit, ec, `Exit ${t.R >= 0 ? '+' : ''}${t.R.toFixed(2)}R`, 'start', ec, '#ffffff', aid);
        a.x2 = hline(t.exit, ec, num(t.exit), 'end', ec, '#ffffff', aid);
      }
      boxes(a, 'b', t, X(at5), xEnd, aid);
      // Tags closer than about one tag height: keep the more important one (the line stays).
      const ys = [...pb.flatMap(b => [b.h + off, b.l + off]), t.entry, t.stop, ...(t.exit != null ? [t.exit] : [])], gap = (Math.max(...ys) - Math.min(...ys)) * 0.075;
      for (const side of ['start', 'end']) {
        const kept = [];
        for (const k of ['e1', 'e2', 'x1', 'x2', 's1', 's2', 'v']) {
          const l = a[k]?.label;
          if (!l || l.position !== side) continue;
          if (kept.some(y => Math.abs(a[k].yMin - y) < gap)) l.enabled = false; else kept.push(a[k].yMin);
        }
      }
      for (const [k, v] of Object.entries(a)) ann[tf + k] = v;
      scales['x' + tf] = timeAxis(X(Math.floor(pb[0].x / H) * H), X(pb.at(-1).x) + ahead, step, { position: tf === 'h' ? 'top' : 'bottom' });
      scales['y' + tf] = { position: 'right', stack: 'panes', stackWeight: 1, grid: { color: C.grid }, ticks: { color: C.txt, font: { size: 12 } },
        title: { display: true, text: tf === 'h' ? '1 hour' : '5 min', color: C.txt, font: { size: 13, weight: 'bold' } } };
    }
    if (scales.ym) scales.ym.offset = true;
    return ds.length ? await render(chartOf(ds, ann, scales), 800, 900) : null;
  } catch (e) { console.log('chart failed:', e.message); return null; }
}

// Daily summary picture: 5-minute candles from S0 for 24 h with the day's trades of one symbol.
export async function dayPng(trades, S0, ticker, tz = 'UTC') {
  try {
    const S1 = S0 + DAY, sh = zoneOffset(S1, tz), X = x => x + sh, m5 = await bars(ticker, 5, anchor(S0), S1);
    const close = new Map(m5.map(b => [b.x, b.c])), tr = trades.map(fromBook).filter(t => t.exit != null);
    const off = median(tr.map(t => t.entry - close.get(Math.floor(t.at / M5) * M5 - M5)).filter(v => !Number.isNaN(v)));
    const sb = m5.filter(b => b.x >= S0);
    if (!sb.length) return null;
    const ys = [...sb.flatMap(b => [b.h + off, b.l + off]), ...tr.flatMap(t => [t.exit, t.stop])];
    const lo = Math.min(...ys), hi = Math.max(...ys), rng = hi - lo || 1, ann = {}, ids = { xAxisID: 'x', yAxisID: 'y' }, aid = { xScaleID: 'x', yScaleID: 'y' };
    tr.forEach((t, j) => {
      const x0 = X(Math.floor(t.at / M5) * M5), x1 = X(t.exitAt), win = t.R > 0, yb = win ? t.exit : t.stop;
      boxes(ann, `b${j}`, t, x0, x1, aid);
      ann[`c${j}`] = { type: 'line', ...aid, xMin: (x0 + x1) / 2, xMax: (x0 + x1) / 2, yMin: yb, yMax: yb, borderWidth: 0, borderColor: 'rgba(0,0,0,0)',
        label: { ...label(`${t.R >= 0 ? '+' : ''}${t.R.toFixed(2)}R`, 'center', '#fff3a8', win ? '#7a5b00' : '#c62828', '#8a6d00', 12),
          font: { size: 12, weight: 'bold', style: 'italic' }, xPadding: 6, yPadding: 3, yAdjust: yb > t.entry ? -16 : 16 } };
    });
    const y = { position: 'right', min: lo - 0.03 * rng, max: hi + 0.06 * rng, grid: { color: C.grid }, ticks: { color: C.txt, font: { size: 12 }, maxTicksLimit: 8 } };
    const ds = [candles(sb, X, off, ids), { ...ids, type: 'line', data: vwapLine(m5, S0, X, off), borderColor: C.vw, borderWidth: 1.8, pointRadius: 0, spanGaps: false },
      tri(tr.filter(t => t.side > 0).map(t => ({ x: X(Math.floor(t.at / M5) * M5), y: t.entry })), 1, ids),
      tri(tr.filter(t => t.side < 0).map(t => ({ x: X(Math.floor(t.at / M5) * M5), y: t.entry })), -1, ids)];
    return await render(chartOf(ds, ann, { x: timeAxis(X(S0), X(S1), 2), y }), 1280, 640);
  } catch (e) { console.log('chart failed:', e.message); return null; }
}
