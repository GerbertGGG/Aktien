-- Single-row advisory lock so two overlapping calls to runDailyUpdate()
-- (e.g. the dashboard button clicked while the daily Cron Trigger is also
-- running, or two manual /api/admin/run-update calls in quick succession)
-- can't both fetch the same tickers at once. Observed in practice: without
-- this, concurrent runs double-fetched ~9 tickers and blew through Twelve
-- Data's 8-requests-per-minute limit.

CREATE TABLE IF NOT EXISTS run_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT,
  finished_at TEXT
);

INSERT OR IGNORE INTO run_lock (id, started_at, finished_at) VALUES (1, NULL, NULL);
