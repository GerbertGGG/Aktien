import { runBacktest, SURVIVORSHIP_BIAS_NOTE } from "../backtest";
import { getEquityCurve, getHoldings, getLatestBacktestRuns, saveBacktestRun } from "../db";
import { DISCLAIMER, json, jsonError } from "../http";
import type { BacktestParams, BacktestRunOutput, Env } from "../types";

// Both endpoints below return the SAME flattened per-split shape (metrics
// as top-level fields with a `benchmark_` prefix for the benchmark leg,
// mirroring the backtest_runs table columns) so the dashboard can render
// either response identically.
function toFlatRunView(runId: number, params: BacktestParams, output: BacktestRunOutput) {
  return {
    id: runId,
    strategy: "momentum_12_1",
    params,
    split: output.split,
    start_date: output.start_date,
    end_date: output.end_date,
    n_rebalances: output.n_rebalances,
    cagr: output.strategy.cagr,
    sharpe: output.strategy.sharpe,
    max_drawdown: output.strategy.max_drawdown,
    volatility: output.strategy.volatility,
    benchmark_cagr: output.benchmark.cagr,
    benchmark_sharpe: output.benchmark.sharpe,
    benchmark_max_drawdown: output.benchmark.max_drawdown,
    benchmark_volatility: output.benchmark.volatility,
    equity_curve: output.equity_curve,
    holdings: output.holdings,
  };
}

export async function handleBacktestLatest(env: Env): Promise<Response> {
  const runs = await getLatestBacktestRuns(env);
  if (runs.length === 0) {
    return json({
      computed: false,
      message:
        "Noch kein Backtest berechnet. POST /api/backtest/run ausloesen (oder Button im Dashboard), sobald genug Kurshistorie vorliegt.",
      disclaimer: DISCLAIMER,
      survivorship_bias_note: SURVIVORSHIP_BIAS_NOTE,
    });
  }

  const bySplit: Record<string, unknown> = {};
  let params: unknown = null;
  for (const run of runs as Array<Record<string, unknown>>) {
    const runId = run.id as number;
    const equityCurve = await getEquityCurve(env, runId);
    const holdings = await getHoldings(env, runId);
    params = params ?? JSON.parse(run.params as string);
    bySplit[run.split as string] = {
      ...run,
      params: JSON.parse(run.params as string),
      equity_curve: equityCurve,
      holdings,
    };
  }

  return json({
    computed: true,
    params,
    runs: bySplit,
    disclaimer: DISCLAIMER,
    survivorship_bias_note: SURVIVORSHIP_BIAS_NOTE,
  });
}

export async function handleBacktestRun(env: Env, request: Request): Promise<Response> {
  let overrides: Partial<BacktestParams> = {};
  const bodyText = await request.text();
  if (bodyText) {
    try {
      overrides = JSON.parse(bodyText) as Partial<BacktestParams>;
    } catch {
      return jsonError("Request-Body ist kein valides JSON.");
    }
  }

  const result = await runBacktest(env, overrides);

  if (result.full.n_rebalances === 0) {
    return jsonError(
      "Nicht genug Kurshistorie fuer einen Backtest-Lauf (mind. 2 monatliche Rebalancing-Termine mit ausreichender Momentum-Historie noetig). Erst den Cron-Update laufen lassen bzw. Backfill abwarten.",
      409,
    );
  }

  const fullId = await saveBacktestRun(env, result.params, result.full);
  const inSampleId = await saveBacktestRun(env, result.params, result.in_sample);
  const outSampleId = await saveBacktestRun(env, result.params, result.out_of_sample);

  return json({
    computed: true,
    params: result.params,
    runs: {
      full: toFlatRunView(fullId, result.params, result.full),
      in_sample: toFlatRunView(inSampleId, result.params, result.in_sample),
      out_of_sample: toFlatRunView(outSampleId, result.params, result.out_of_sample),
    },
    disclaimer: DISCLAIMER,
    survivorship_bias_note: result.survivorship_bias_note,
  });
}
