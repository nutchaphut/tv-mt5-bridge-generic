# tv-mt5-bridge-generic

TradingView alert → Cloudflare Worker → Telegram + MetaTrader 5.

```
TradingView alert ──webhook──▶ Worker (Cloudflare, D1 database)
                                ├─ paper book in R (risk units)
                                ├─ entry blocks: news, daily loss cap, trading hours, weekend, one position per symbol
                                ├─ Telegram post with a chart picture (entry, exit, blocked, daily summary)
                                └─ order queue ◀──polls── MT5 EA (SignalBridge.mq5) ──reports fills, stops, closes──▶ Worker
```

- **Any alert works**: an indicator alert or a Pine strategy's order alerts. The Worker holds no strategy logic.
- **One position per symbol.** An entry while that symbol is open is stored and posted as blocked, never traded.
- **Paper book**: every traded alert is booked in R (move ÷ stop distance) after a per-symbol cost. `GET /log/<KEY>` downloads it as CSV.
- **The EA** sizes each trade so the stop loses `RiskPct` % of the balance, sends the stop with the order, closes on the exit alert, and reports everything back. Broker stops and hand closes are reported too, and close the paper trade.
- **Telegram never shows** an account number, balance, lot size or money: prices, R and risk % only.

> **Disclaimer.** This is software, not financial advice. Trading is risky. Run it on a demo account first and check every
> setting yourself. Provided as is, without warranty (see LICENSE).

## 1. Worker (Cloudflare)

Needs a free Cloudflare account. Pick one way:

**One click:** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nutchaphut/tv-mt5-bridge-generic/tree/main/worker)

It copies the Worker to your GitHub, creates the database, and asks for `KEY` (plus the optional Telegram secrets).

**From a terminal** (Node.js 22+):

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy              # creates the database, prints https://tv-mt5-bridge.<you>.workers.dev
npx wrangler secret put KEY      # a long random string
npx wrangler secret put TG_TOKEN # optional: Telegram bot token
npx wrangler secret put TG_CHAT  # optional: chat or channel id
```

A random key: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. The Worker creates its tables itself.

Settings are the `[vars]` in `worker/wrangler.toml`, each explained there:
- **Book and posts:** risk %, per-symbol costs, chart tickers, time zone.
- **News block:** currencies, minutes before and after a release.
- **Limits:** daily loss cap in R, trading hours, weekend cut-off, maximum hold time.
- **Schedule:** the daily summary hour.

Change one, then `npx wrangler deploy` again.

**Telegram:**
1. Create a bot with @BotFather; that gives `TG_TOKEN`.
2. Add the bot to your channel or group as an admin.
3. Set `TG_CHAT` to the chat id (for a channel, `-100…`; @userinfobot or the bot's `getUpdates` shows it).

**Charts:** `CHART_SYMBOLS` maps an alert symbol to a Yahoo Finance ticker, for example `XAUUSD` → `GC=F` or `US500` → `ES=F`. Candles are shifted onto your alert's price, and QuickChart draws the picture. A symbol not in the map gets text posts only.

**News:** the cron reads the ForexFactory weekly calendar every 6 hours and stores high-impact releases of `NEWS_CURRENCIES`.

## 2. TradingView alert

Webhook URL: `https://<your-worker>/hook/<KEY>`. The message must be JSON.

```json
{"symbol":"XAUUSD","side":"long","price":{{close}},"sl":2644.9,"time":"{{timenow}}"}
{"symbol":"XAUUSD","side":"exit","price":{{close}},"reason":"tp"}
```

- `side`: `long`, `short` or `exit`.
- `sl` (the stop price) is required on entries, and must be below the price for long, above for short.
- Optional fields:
  - `time`: when the alert fired; it's used for the blocks.
  - `reason`: shown on exits.
  - `test: true`: marks a test.
  - `quiet: true`: no Telegram post.

**From a Pine strategy,** build the JSON in the order's `alert_message` with your stop:

```pine
strategy.entry("L", strategy.long, alert_message = '{"symbol":"' + syminfo.ticker + '","side":"long","price":' + str.tostring(close) + ',"sl":' + str.tostring(stop) + '}')
strategy.exit("X", "L", stop = stop, alert_message = '{"symbol":"' + syminfo.ticker + '","side":"exit","price":' + str.tostring(close) + ',"reason":"stop"}')
```

Then create the alert on the strategy with the message `{{strategy.order.alert_message}}`.

**Testing:** post to `https://<your-worker>/test/<KEY>` instead. It's stored as a test, posted with "🧪 TEST", and only an EA with `TestQueue = true` takes it.

```bash
curl -X POST https://<your-worker>/test/<KEY> -d '{"symbol":"XAUUSD","side":"long","price":2650.4,"sl":2644.9}'
```

## 3. MT5 EA

1. Copy `mt5/SignalBridge.mq5` to `MQL5/Experts/` (MT5: File → Open Data Folder) and compile it in MetaEditor (F7).
2. MT5: **Tools → Options → Expert Advisors**: tick *Allow WebRequest for listed URL* and add your Worker URL.
3. Attach the EA to one chart per symbol you trade, with Algo Trading on. Inputs:

| Input | Meaning |
|---|---|
| `WorkerUrl` | `https://<your-worker>`, no trailing slash |
| `Key` | the `KEY` secret |
| `RiskPct` | % of balance lost if the stop is hit |
| `SignalSymbol` | the alert's symbol to trade on this chart; empty = the chart symbol starting with it (`XAUUSD` → `XAUUSDm`) |
| `TestQueue` | `true` = take only test alerts |
| `MaxAgeSec` | skip a signal older than this (never a stale order) |
| `Magic` | marks this EA's positions |

**How the EA behaves:**
- At start it syncs to the newest signal, so it never replays old ones.
- It skips rather than shrinks a trade: when the stop is too close, the lot is below the minimum, or margin is short.
- Every skip is reported and posted.

## Routes

| Route | Who |
|---|---|
| `POST /hook/<KEY>` | TradingView alerts |
| `POST /test/<KEY>` | test alerts |
| `GET /orders/<KEY>?after=<id>&test=0` · `/orders/<KEY>/last` | the EA's order queue |
| `POST /fills/<KEY>` | the EA's reports |
| `GET /log/<KEY>` | paper book CSV (`?test=1` for tests) |
| `GET /chart/<KEY>?id=<entry id>` | chart picture of one trade |
| `GET /run/<KEY>?task=summary\|news\|exits` | run a cron task now |

## Development

```bash
cd worker
node test.mjs        # unit tests
node preview.mjs     # every Telegram text with sample values
npx wrangler dev     # local Worker; copy .dev.vars.example to .dev.vars and set KEY
```

## Licence

MIT, see [LICENSE](LICENSE).
