-- npx wrangler d1 execute <your-db> --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS events (            -- every alert, and the Worker's own time exits / the EA's stop reports
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL, fired_at TEXT,
  symbol TEXT NOT NULL, ev TEXT NOT NULL,       -- ev: entry | exit
  side TEXT, price REAL, sl REAL, reason TEXT,
  blocked TEXT,                                 -- null = traded; news | dayloss | session | weekend | position | no position
  test INTEGER NOT NULL DEFAULT 0,
  news_title TEXT, news_min INTEGER,
  tg_msg INTEGER                                -- the Telegram post, so MT5 reports reply to it
);
CREATE INDEX IF NOT EXISTS events_symbol ON events (symbol, test, id);

CREATE TABLE IF NOT EXISTS fills (             -- the EA's reports
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL, received_at TEXT NOT NULL,
  kind TEXT NOT NULL, ok INTEGER NOT NULL,      -- kind: open | skip | close | stop | stopout | manual
  price REAL, lots REAL, profit REAL, risk REAL, msg TEXT, acct TEXT,
  test INTEGER NOT NULL DEFAULT 0, exec_at TEXT
);
CREATE INDEX IF NOT EXISTS fills_event ON fills (event_id);

CREATE TABLE IF NOT EXISTS news (ts TEXT PRIMARY KEY, title TEXT NOT NULL);   -- high-impact releases (UTC)
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);
