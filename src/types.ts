// Shared types for the Momentum-Screener Worker.
// Kept dependency-free (no Zod etc.) to stay small inside the Workers bundle.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Secret — set via `wrangler secret put ALPHA_VANTAGE_KEY`, never in code.
  ALPHA_VANTAGE_KEY: string;

  // Optional secret — set via `wrangler secret put ADMIN_TOKEN` to require
  // an `x-admin-token` header on /api/admin/* routes. If unset, those routes
  // are open (fine for a single-user personal deployment, but set this if
  // you're not the only one who can reach the Worker's URL).
  ADMIN_TOKEN?: string;

  // Vars (see wrangler.toml [vars]) — all strings, parsed where used.
  BENCHMARK_TICKER: string;
  DEFAULT_TOP_N: string;
  DEFAULT_LOOKBACK_MONTHS: string;
  DEFAULT_SKIP_MONTHS: string;
  DEFAULT_TX_COST_BPS: string;
  DEFAULT_RISK_FREE_RATE: string;
  DEFAULT_OOS_SPLIT: string;
  MAX_REQUESTS_PER_DAY: string;
  MAX_REQUESTS_PER_MINUTE: string;
}

export interface WatchlistEntry {
  ticker: string;
  name: string | null;
  is_benchmark: number; // 0 | 1 (SQLite has no boolean type)
  active: number; // 0 | 1
  added_at: string;
}

export interface PriceRow {
  ticker: string;
  date: string; // ISO yyyy-mm-dd
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjusted_close: number;
  volume: number | null;
  dividend_amount: number | null;
  split_coefficient: number | null;
}

/** Minimal (date, adjusted_close) pair used throughout screener/backtest math. */
export interface PricePoint {
  date: string;
  adjusted_close: number;
}

export interface MomentumScoreResult {
  ticker: string;
  as_of_date: string;
  status: "ok" | "insufficient_history";
  momentum_12_1: number | null;
  price_t_minus_1m: number | null;
  price_t_minus_12m: number | null;
  date_t_minus_1m: string | null;
  date_t_minus_12m: string | null;
}

export interface ScreenerResult {
  as_of_date: string | null;
  lookback_months: number;
  skip_months: number;
  top_n: number;
  ranked: MomentumScoreResult[]; // sorted desc by momentum_12_1, insufficient-history entries last
  top: MomentumScoreResult[];
}

export interface BacktestParams {
  top_n: number;
  lookback_months: number;
  skip_months: number;
  tx_cost_bps: number; // basis points, e.g. 10 = 0.10%
  risk_free_rate: number; // annualized, e.g. 0.04 = 4%
  oos_split: number; // fraction of rebalance dates used for "in_sample", e.g. 0.7
  benchmark_ticker: string;
}

export type BacktestSplit = "full" | "in_sample" | "out_of_sample";

export interface BacktestMetrics {
  cagr: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  volatility: number | null;
}

export interface EquityPoint {
  date: string;
  strategy_equity: number;
  benchmark_equity: number;
}

export interface HoldingRecord {
  rebalance_date: string;
  ticker: string;
  momentum_score: number | null;
  weight: number;
}

export interface BacktestRunOutput {
  split: BacktestSplit;
  start_date: string | null;
  end_date: string | null;
  n_rebalances: number;
  strategy: BacktestMetrics;
  benchmark: BacktestMetrics;
  equity_curve: EquityPoint[];
  holdings: HoldingRecord[];
}
