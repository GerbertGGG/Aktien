// D1 access helpers. Keeps raw SQL in one place so the rest of the code
// works with plain TS objects/arrays.

import { computeAdjustedCloses } from "./splitAdjustment";
import type {
  BacktestParams,
  BacktestRunOutput,
  Env,
  PricePoint,
  PriceRow,
  SplitRow,
  WatchlistEntry,
} from "./types";
import type { DailyBar } from "./unusualMoves";

/**
 * Atomically acquires the single-row run_lock so two overlapping calls to
 * runDailyUpdate() can't both fetch the same tickers at once (observed in
 * practice: this doubled requests for several tickers and blew through
 * Twelve Data's per-minute limit). Uses a conditional UPDATE so the
 * acquire-and-check happens as one atomic D1 statement; `meta.changes > 0`
 * means we won the lock. A lock older than `staleAfterMinutes` (crashed/
 * timed-out run) is treated as free.
 */
export async function tryAcquireRunLock(env: Env, staleAfterMinutes = 10): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE run_lock SET started_at = datetime('now'), finished_at = NULL
     WHERE id = 1 AND (
       finished_at IS NOT NULL
       OR started_at IS NULL
       OR started_at < datetime('now', ?)
     )`,
  )
    .bind(`-${staleAfterMinutes} minutes`)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function releaseRunLock(env: Env): Promise<void> {
  await env.DB.prepare(`UPDATE run_lock SET finished_at = datetime('now') WHERE id = 1`).run();
}

export async function getWatchlist(
  env: Env,
  opts: { activeOnly?: boolean } = {},
): Promise<WatchlistEntry[]> {
  const sql = opts.activeOnly
    ? "SELECT * FROM watchlist WHERE active = 1 ORDER BY is_benchmark ASC, ticker ASC"
    : "SELECT * FROM watchlist ORDER BY is_benchmark ASC, ticker ASC";
  const { results } = await env.DB.prepare(sql).all<WatchlistEntry>();
  return results ?? [];
}

export async function getScreenerTickers(env: Env): Promise<WatchlistEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM watchlist WHERE active = 1 AND is_benchmark = 0 ORDER BY ticker ASC",
  ).all<WatchlistEntry>();
  return results ?? [];
}

export async function getBenchmarkTicker(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT ticker FROM watchlist WHERE is_benchmark = 1 LIMIT 1",
  ).first<{ ticker: string }>();
  return row?.ticker ?? env.BENCHMARK_TICKER;
}

/** Full adjusted-close time series for a ticker, ascending by date. */
export async function getPriceSeries(env: Env, ticker: string): Promise<PricePoint[]> {
  const { results } = await env.DB.prepare(
    "SELECT date, adjusted_close FROM prices WHERE ticker = ? AND adjusted_close IS NOT NULL ORDER BY date ASC",
  )
    .bind(ticker)
    .all<PricePoint>();
  return results ?? [];
}

/** Adjusted-close + volume series for a ticker, ascending by date — input to computeUnusualMove. */
export async function getPriceSeriesWithVolume(env: Env, ticker: string): Promise<DailyBar[]> {
  const { results } = await env.DB.prepare(
    "SELECT date, adjusted_close, volume FROM prices WHERE ticker = ? AND adjusted_close IS NOT NULL ORDER BY date ASC",
  )
    .bind(ticker)
    .all<DailyBar>();
  return results ?? [];
}

export async function getLatestPriceDate(env: Env, ticker: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(date) AS max_date FROM prices WHERE ticker = ?",
  )
    .bind(ticker)
    .first<{ max_date: string | null }>();
  return row?.max_date ?? null;
}

export async function getPriceRowCount(env: Env, ticker: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM prices WHERE ticker = ?")
    .bind(ticker)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Upsert a batch of price rows for one ticker in a single D1 batch call. */
export async function upsertPrices(env: Env, rows: PriceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO prices (ticker, date, open, high, low, close, adjusted_close, volume, dividend_amount, split_coefficient)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticker, date) DO UPDATE SET
       open = excluded.open,
       high = excluded.high,
       low = excluded.low,
       close = excluded.close,
       adjusted_close = excluded.adjusted_close,
       volume = excluded.volume,
       dividend_amount = excluded.dividend_amount,
       split_coefficient = excluded.split_coefficient`,
  );
  const batch = rows.map((r) =>
    stmt.bind(
      r.ticker,
      r.date,
      r.open,
      r.high,
      r.low,
      r.close,
      r.adjusted_close,
      r.volume,
      r.dividend_amount,
      r.split_coefficient,
    ),
  );
  // D1 batches are capped well above our per-ticker row counts (~5-6k for
  // 'full' history), but chunk defensively to stay safe.
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    await env.DB.batch(chunk);
    total += chunk.length;
  }
  return total;
}

/** Raw (unadjusted) close-price series for a ticker, ascending by date — input to applySplitAdjustment. */
export async function getRawPriceSeries(env: Env, ticker: string): Promise<Array<{ date: string; close: number | null }>> {
  const { results } = await env.DB.prepare(
    "SELECT date, close FROM prices WHERE ticker = ? ORDER BY date ASC",
  )
    .bind(ticker)
    .all<{ date: string; close: number | null }>();
  return results ?? [];
}

/** Stored split history for a ticker, ascending by effective_date. NOT used by default — see applySplitAdjustment. */
export async function getSplits(env: Env, ticker: string): Promise<SplitRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT ticker, effective_date, split_factor FROM splits WHERE ticker = ? ORDER BY effective_date ASC",
  )
    .bind(ticker)
    .all<SplitRow>();
  return results ?? [];
}

/**
 * Recomputes `adjusted_close` for every stored price row of `ticker` from
 * the raw `close` column and the ticker's known split history (kept for
 * reference/future use — NOT called anywhere by default). Twelve Data's
 * `close` is already split-adjusted (see src/twelvedata.ts, src/cron.ts);
 * calling this on top of that would double-adjust every pre-split price.
 * Only reach for this again if a future data source genuinely returns
 * unadjusted closes, after verifying that with a real before/after-split
 * price check like the one documented in src/cron.ts.
 */
export async function applySplitAdjustment(env: Env, ticker: string): Promise<number> {
  const [splits, prices] = await Promise.all([getSplits(env, ticker), getRawPriceSeries(env, ticker)]);
  if (prices.length === 0) return 0;

  const adjusted = computeAdjustedCloses(prices, splits);

  const stmt = env.DB.prepare("UPDATE prices SET adjusted_close = ? WHERE ticker = ? AND date = ?");
  const updates = adjusted
    .filter((row) => row.adjusted_close !== null)
    .map((row) => stmt.bind(row.adjusted_close, ticker, row.date));

  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await env.DB.batch(updates.slice(i, i + CHUNK));
  }
  return updates.length;
}

/**
 * Repair tool: resets `adjusted_close` back to the raw `close` value for
 * every stored row of `ticker`. Twelve Data's `close` is already
 * split-adjusted, so this IS the correct value — use this to undo any
 * accidental double-adjustment (e.g. from an old deploy that still called
 * applySplitAdjustment). Returns the number of rows updated.
 */
export async function resetAdjustedCloseToRaw(env: Env, ticker: string): Promise<number> {
  const result = await env.DB.prepare("UPDATE prices SET adjusted_close = close WHERE ticker = ?").bind(ticker).run();
  return result.meta?.changes ?? 0;
}

export async function logFetch(
  env: Env,
  entry: {
    ticker: string;
    output_size: "daily_full" | "daily_compact";
    status: "ok" | "error" | "rate_limited" | "skipped_budget";
    message?: string;
    rows_upserted?: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fetch_log (ticker, output_size, status, message, rows_upserted)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.ticker,
      entry.output_size,
      entry.status,
      entry.message ?? null,
      entry.rows_upserted ?? 0,
    )
    .run();
}

/** Count of successful/errored provider requests already made today (UTC), used for the daily request budget. */
export async function countRequestsToday(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM fetch_log
     WHERE status IN ('ok', 'error')
       AND date(fetched_at) = date('now')`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Whether a given output_size (e.g. 'daily_full') has ever succeeded for a ticker — used to gate one-time backfills. */
export async function hasEverFetchedOk(env: Env, ticker: string, outputSize: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM fetch_log
     WHERE ticker = ? AND output_size = ? AND status = 'ok'
     LIMIT 1`,
  )
    .bind(ticker, outputSize)
    .first<{ present: number }>();
  return !!row;
}

export async function hasFetchedOkToday(env: Env, ticker: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM fetch_log
     WHERE ticker = ? AND status = 'ok' AND date(fetched_at) = date('now')
     LIMIT 1`,
  )
    .bind(ticker)
    .first<{ present: number }>();
  return !!row;
}

export async function getRecentFetchLog(env: Env, limit = 30) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM fetch_log ORDER BY fetched_at DESC LIMIT ?",
  )
    .bind(limit)
    .all();
  return results ?? [];
}

/** Persists one backtest segment (full | in_sample | out_of_sample) and its equity curve / holdings. Returns the new run id. */
export async function saveBacktestRun(
  env: Env,
  params: BacktestParams,
  output: BacktestRunOutput,
): Promise<number> {
  const runRow = await env.DB.prepare(
    `INSERT INTO backtest_runs
       (strategy, params, split, start_date, end_date, cagr, sharpe, max_drawdown, volatility,
        benchmark_cagr, benchmark_sharpe, benchmark_max_drawdown, benchmark_volatility, n_rebalances)
     VALUES ('momentum_12_1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      JSON.stringify(params),
      output.split,
      output.start_date,
      output.end_date,
      output.strategy.cagr,
      output.strategy.sharpe,
      output.strategy.max_drawdown,
      output.strategy.volatility,
      output.benchmark.cagr,
      output.benchmark.sharpe,
      output.benchmark.max_drawdown,
      output.benchmark.volatility,
      output.n_rebalances,
    )
    .first<{ id: number }>();

  const runId = runRow!.id;

  if (output.equity_curve.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO backtest_equity_curve (run_id, date, strategy_equity, benchmark_equity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id, date) DO UPDATE SET
         strategy_equity = excluded.strategy_equity,
         benchmark_equity = excluded.benchmark_equity`,
    );
    const batch = output.equity_curve.map((p) => stmt.bind(runId, p.date, p.strategy_equity, p.benchmark_equity));
    const CHUNK = 500;
    for (let i = 0; i < batch.length; i += CHUNK) {
      await env.DB.batch(batch.slice(i, i + CHUNK));
    }
  }

  if (output.holdings.length > 0) {
    const stmt = env.DB.prepare(
      `INSERT INTO backtest_holdings (run_id, rebalance_date, ticker, momentum_score, weight)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, rebalance_date, ticker) DO UPDATE SET
         momentum_score = excluded.momentum_score,
         weight = excluded.weight`,
    );
    const batch = output.holdings.map((h) => stmt.bind(runId, h.rebalance_date, h.ticker, h.momentum_score, h.weight));
    const CHUNK = 500;
    for (let i = 0; i < batch.length; i += CHUNK) {
      await env.DB.batch(batch.slice(i, i + CHUNK));
    }
  }

  return runId;
}

/** Most recent run per split ('full' | 'in_sample' | 'out_of_sample'), based on created_at. */
export async function getLatestBacktestRuns(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT br.* FROM backtest_runs br
     INNER JOIN (
       SELECT split, MAX(created_at) AS max_created_at FROM backtest_runs GROUP BY split
     ) latest ON br.split = latest.split AND br.created_at = latest.max_created_at
     ORDER BY br.split ASC`,
  ).all();
  return results ?? [];
}

export async function getEquityCurve(env: Env, runId: number) {
  const { results } = await env.DB.prepare(
    "SELECT date, strategy_equity, benchmark_equity FROM backtest_equity_curve WHERE run_id = ? ORDER BY date ASC",
  )
    .bind(runId)
    .all();
  return results ?? [];
}

export async function getHoldings(env: Env, runId: number) {
  const { results } = await env.DB.prepare(
    "SELECT rebalance_date, ticker, momentum_score, weight FROM backtest_holdings WHERE run_id = ? ORDER BY rebalance_date ASC, weight DESC",
  )
    .bind(runId)
    .all();
  return results ?? [];
}
