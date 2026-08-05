// Backtest engine for the 12-1 momentum screener.
//
// Design goals mirror the project brief:
//  - Monthly rebalancing, point-in-time momentum (no look-ahead: every
//    ranking decision at date T only ever reads price data with date <= T).
//  - Transaction costs charged on portfolio turnover at every rebalance.
//  - SPY buy-and-hold benchmark over the identical date range.
//  - CAGR / Sharpe / Max Drawdown / annualized volatility for both legs.
//  - Out-of-sample split: the SAME fixed parameters are evaluated on the
//    first `oos_split` fraction of the rebalance periods ("in_sample") and
//    the remaining fraction ("out_of_sample") — there is no parameter
//    fitting anywhere in this module, so the split is purely a consistency
//    check, not an optimization step.
//  - Survivorship bias: NOT corrected here (would require historical index
//    membership data we don't have on the free tier). Surfaced instead as
//    an explicit disclaimer in the API response and dashboard — see
//    `survivorship_bias_note` below and README.

import { getBenchmarkTicker, getPriceSeries, getScreenerTickers } from "./db";
import { isMonthEnd } from "./dates";
import { computeMomentum } from "./momentum";
import { PriceIndex } from "./priceIndex";
import { computeMetrics } from "./stats";
import type { BacktestParams, BacktestRunOutput, BacktestSplit, Env, HoldingRecord } from "./types";

export const SURVIVORSHIP_BIAS_NOTE =
  "Die Watchlist enthaelt nur heute existierende ('ueberlebende') Aktien. " +
  "Historische Backtest-Ergebnisse koennen dadurch optimistisch verzerrt sein, " +
  "weil Aktien, die im Betrachtungszeitraum insolvent gingen, delisted oder " +
  "uebernommen wurden, nicht im Universum enthalten sind.";

interface CandidateTicker {
  ticker: string;
  index: PriceIndex;
}

const PERIODS_PER_YEAR = 12; // monthly rebalancing

export async function resolveBacktestParams(env: Env, overrides: Partial<BacktestParams> = {}): Promise<BacktestParams> {
  const benchmarkTicker = overrides.benchmark_ticker ?? (await getBenchmarkTicker(env));
  return {
    top_n: overrides.top_n ?? (Number(env.DEFAULT_TOP_N) || 5),
    lookback_months: overrides.lookback_months ?? (Number(env.DEFAULT_LOOKBACK_MONTHS) || 12),
    skip_months: overrides.skip_months ?? (Number(env.DEFAULT_SKIP_MONTHS) || 1),
    tx_cost_bps: overrides.tx_cost_bps ?? (Number(env.DEFAULT_TX_COST_BPS) || 10),
    risk_free_rate: overrides.risk_free_rate ?? (Number(env.DEFAULT_RISK_FREE_RATE) || 0.04),
    oos_split: overrides.oos_split ?? (Number(env.DEFAULT_OOS_SPLIT) || 0.7),
    benchmark_ticker: benchmarkTicker,
  };
}

function findMonthEndDates(dates: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (isMonthEnd(dates[i]!, i, dates)) out.push(dates[i]!);
  }
  return out;
}

function selectTopN(
  candidates: CandidateTicker[],
  asOfDate: string,
  topN: number,
  lookbackMonths: number,
  skipMonths: number,
): { ticker: string; score: number }[] {
  const scored = candidates
    .map((c) => ({ ticker: c.ticker, result: computeMomentum(c.ticker, c.index, asOfDate, lookbackMonths, skipMonths) }))
    .filter((s) => s.result.status === "ok" && s.result.momentum_12_1 !== null)
    .map((s) => ({ ticker: s.ticker, score: s.result.momentum_12_1! }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/** Runs the strategy + benchmark over a (possibly already-sliced) list of rebalance dates. Exported for testing. */
export function runSegment(
  split: BacktestSplit,
  rebalanceDates: string[],
  candidates: CandidateTicker[],
  benchmarkIndex: PriceIndex,
  params: BacktestParams,
): BacktestRunOutput {
  if (rebalanceDates.length < 2) {
    return {
      split,
      start_date: rebalanceDates[0] ?? null,
      end_date: rebalanceDates[0] ?? null,
      n_rebalances: 0,
      strategy: { cagr: null, sharpe: null, max_drawdown: null, volatility: null },
      benchmark: { cagr: null, sharpe: null, max_drawdown: null, volatility: null },
      equity_curve: [],
      holdings: [],
    };
  }

  const txCostRate = params.tx_cost_bps / 10_000;

  const firstDate = rebalanceDates[0]!;
  const benchmarkStart = benchmarkIndex.onOrBefore(firstDate)?.price ?? null;

  let strategyEquity = 1;
  let oldWeights = new Map<string, number>();
  const strategyReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  const strategyEquitySeries: number[] = [1];
  const benchmarkEquitySeries: number[] = [1];
  const equityCurve: BacktestRunOutput["equity_curve"] = [
    { date: firstDate, strategy_equity: 1, benchmark_equity: 1 },
  ];
  const holdings: HoldingRecord[] = [];

  for (let i = 0; i < rebalanceDates.length - 1; i++) {
    const rebalanceDate = rebalanceDates[i]!;
    const nextDate = rebalanceDates[i + 1]!;

    const selected = selectTopN(candidates, rebalanceDate, params.top_n, params.lookback_months, params.skip_months);
    const newWeights = new Map<string, number>();
    if (selected.length > 0) {
      const w = 1 / selected.length;
      for (const s of selected) newWeights.set(s.ticker, w);
    }

    // Turnover-based transaction cost: sum of absolute weight changes across
    // the union of previously- and newly-held tickers (both the "sell" leg
    // of exited/reduced positions and the "buy" leg of new/increased ones).
    const allTickers = new Set([...oldWeights.keys(), ...newWeights.keys()]);
    let turnover = 0;
    for (const t of allTickers) {
      turnover += Math.abs((newWeights.get(t) ?? 0) - (oldWeights.get(t) ?? 0));
    }
    const cost = txCostRate * turnover;

    // Gross portfolio return over the holding period, before costs.
    let grossReturn = 0;
    for (const [ticker, weight] of newWeights) {
      const idx = candidates.find((c) => c.ticker === ticker)?.index;
      const priceStart = idx?.onOrBefore(rebalanceDate)?.price;
      const priceEnd = idx?.onOrBefore(nextDate)?.price;
      if (priceStart && priceEnd && priceStart > 0) {
        grossReturn += weight * (priceEnd / priceStart - 1);
      }
    }

    const effectiveReturn = (1 - cost) * (1 + grossReturn) - 1;
    strategyEquity *= 1 + effectiveReturn;
    strategyReturns.push(effectiveReturn);
    strategyEquitySeries.push(strategyEquity);

    const benchPriceStart = benchmarkIndex.onOrBefore(rebalanceDate)?.price;
    const benchPriceEnd = benchmarkIndex.onOrBefore(nextDate)?.price;
    const benchReturn = benchPriceStart && benchPriceEnd && benchPriceStart > 0 ? benchPriceEnd / benchPriceStart - 1 : 0;
    benchmarkReturns.push(benchReturn);
    const benchmarkEquity = benchmarkStart && benchPriceEnd ? benchPriceEnd / benchmarkStart : (benchmarkEquitySeries.at(-1) ?? 1);
    benchmarkEquitySeries.push(benchmarkEquity);

    equityCurve.push({ date: nextDate, strategy_equity: strategyEquity, benchmark_equity: benchmarkEquity });

    for (const [ticker, weight] of newWeights) {
      const scoreEntry = selected.find((s) => s.ticker === ticker);
      holdings.push({
        rebalance_date: rebalanceDate,
        ticker,
        momentum_score: scoreEntry?.score ?? null,
        weight,
      });
    }

    oldWeights = newWeights;
  }

  const lastDate = rebalanceDates[rebalanceDates.length - 1]!;
  const strategyMetrics = computeMetrics(
    strategyEquitySeries,
    strategyReturns,
    PERIODS_PER_YEAR,
    firstDate,
    lastDate,
    params.risk_free_rate,
  );
  const benchmarkMetrics = computeMetrics(
    benchmarkEquitySeries,
    benchmarkReturns,
    PERIODS_PER_YEAR,
    firstDate,
    lastDate,
    params.risk_free_rate,
  );

  return {
    split,
    start_date: firstDate,
    end_date: lastDate,
    n_rebalances: rebalanceDates.length - 1,
    strategy: strategyMetrics,
    benchmark: benchmarkMetrics,
    equity_curve: equityCurve,
    holdings,
  };
}

export interface BacktestResultSet {
  params: BacktestParams;
  full: BacktestRunOutput;
  in_sample: BacktestRunOutput;
  out_of_sample: BacktestRunOutput;
  survivorship_bias_note: string;
}

export async function runBacktest(env: Env, overrides: Partial<BacktestParams> = {}): Promise<BacktestResultSet> {
  const params = await resolveBacktestParams(env, overrides);

  const benchmarkSeries = await getPriceSeries(env, params.benchmark_ticker);
  const benchmarkIndex = new PriceIndex(benchmarkSeries);

  const watchlistTickers = await getScreenerTickers(env);
  const candidates: CandidateTicker[] = [];
  for (const t of watchlistTickers) {
    const series = await getPriceSeries(env, t.ticker);
    if (series.length > 0) candidates.push({ ticker: t.ticker, index: new PriceIndex(series) });
  }

  const allMonthEnds = findMonthEndDates(benchmarkIndex.allDates);

  // Skip leading month-ends until enough candidates have full lookback history.
  const minCandidates = Math.min(params.top_n, candidates.length);
  let startIdx = 0;
  while (startIdx < allMonthEnds.length) {
    const okCount = candidates.filter(
      (c) => computeMomentum(c.ticker, c.index, allMonthEnds[startIdx]!, params.lookback_months, params.skip_months).status === "ok",
    ).length;
    if (okCount >= minCandidates && minCandidates > 0) break;
    startIdx++;
  }
  const rebalanceDates = allMonthEnds.slice(startIdx);

  const full = runSegment("full", rebalanceDates, candidates, benchmarkIndex, params);

  const nPeriods = Math.max(0, rebalanceDates.length - 1);
  const splitPeriodIdx = Math.min(nPeriods, Math.max(1, Math.round(nPeriods * params.oos_split)));
  const inSampleDates = rebalanceDates.slice(0, splitPeriodIdx + 1);
  const outSampleDates = rebalanceDates.slice(splitPeriodIdx);

  const inSample = runSegment("in_sample", inSampleDates, candidates, benchmarkIndex, params);
  const outSample = runSegment("out_of_sample", outSampleDates, candidates, benchmarkIndex, params);

  return {
    params,
    full,
    in_sample: inSample,
    out_of_sample: outSample,
    survivorship_bias_note: SURVIVORSHIP_BIAS_NOTE,
  };
}
