-- Momentum-Screener: initial schema
-- Applies to Cloudflare D1 (SQLite dialect).

CREATE TABLE IF NOT EXISTS watchlist (
  ticker       TEXT PRIMARY KEY,
  name         TEXT,
  is_benchmark INTEGER NOT NULL DEFAULT 0,  -- 1 = Referenzindex (z.B. SPY), nicht Teil des Screener-Rankings
  active       INTEGER NOT NULL DEFAULT 1,  -- 0 = pausiert, wird nicht mehr aktualisiert/gerankt
  added_at     TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prices (
  ticker           TEXT NOT NULL,
  date             TEXT NOT NULL,           -- ISO yyyy-mm-dd
  open             REAL,
  high             REAL,
  low              REAL,
  close            REAL,
  adjusted_close   REAL,                    -- Split-/Dividenden-bereinigt, Basis fuer Momentum & Backtest
  volume           INTEGER,
  dividend_amount  REAL,
  split_coefficient REAL,
  PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_date ON prices (ticker, date);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices (date);

-- Protokoll jedes Alpha-Vantage-Requests: Grundlage fuer das taegliche
-- Rate-Limit-Budget (25 Requests/Tag) und fuer Debugging im Dashboard.
CREATE TABLE IF NOT EXISTS fetch_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker        TEXT NOT NULL,
  output_size   TEXT NOT NULL,              -- 'full' | 'compact'
  status        TEXT NOT NULL,              -- 'ok' | 'error' | 'rate_limited' | 'skipped_budget'
  message       TEXT,
  rows_upserted INTEGER NOT NULL DEFAULT 0,
  fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_fetched_at ON fetch_log (fetched_at);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy               TEXT NOT NULL DEFAULT 'momentum_12_1',
  params                 TEXT NOT NULL,     -- JSON: {top_n, lookback_months, skip_months, tx_cost_bps, risk_free_rate, oos_split}
  split                  TEXT NOT NULL,     -- 'full' | 'in_sample' | 'out_of_sample'
  start_date             TEXT,
  end_date               TEXT,
  cagr                   REAL,
  sharpe                 REAL,
  max_drawdown           REAL,
  volatility             REAL,
  benchmark_cagr         REAL,
  benchmark_sharpe       REAL,
  benchmark_max_drawdown REAL,
  benchmark_volatility   REAL,
  n_rebalances           INTEGER,
  created_at             TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_at ON backtest_runs (created_at);

CREATE TABLE IF NOT EXISTS backtest_equity_curve (
  run_id           INTEGER NOT NULL,
  date             TEXT NOT NULL,
  strategy_equity  REAL NOT NULL,
  benchmark_equity REAL NOT NULL,
  PRIMARY KEY (run_id, date),
  FOREIGN KEY (run_id) REFERENCES backtest_runs (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS backtest_holdings (
  run_id          INTEGER NOT NULL,
  rebalance_date  TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  momentum_score  REAL,
  weight          REAL NOT NULL,
  PRIMARY KEY (run_id, rebalance_date, ticker),
  FOREIGN KEY (run_id) REFERENCES backtest_runs (id) ON DELETE CASCADE
);
