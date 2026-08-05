// Lightweight smoke test for the pure backtest/screener math — no D1, no
// Workers runtime, no test framework dependency. Run with `npm test`.
//
// Uses synthetic deterministic price series for a handful of tickers, per
// the project brief's "erst an 2-3 Tickern testen, bevor auf die ganze
// Watchlist skaliert wird" guidance. Exercises: momentum ranking, monthly
// rebalancing + turnover-based transaction costs, benchmark buy&hold,
// CAGR/Sharpe/MaxDrawdown formulas, and the in-sample/out-of-sample split.

import { addMonthsISO } from "../src/dates";
import { PriceIndex } from "../src/priceIndex";
import { runSegment } from "../src/backtest";
import { computeMomentum } from "../src/momentum";
import { maxDrawdown, sharpeRatio } from "../src/stats";
import type { BacktestParams } from "../src/types";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok:   ${msg}`);
  }
}
function approx(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

// --- 1. addMonthsISO clamping (31st-of-month edge cases) --------------------
assert(addMonthsISO("2021-03-31", -1) === "2021-02-28", "31.Mar -1M clamps to 28.Feb (2021 not leap)");
assert(addMonthsISO("2020-03-31", -1) === "2020-02-29", "31.Mar -1M clamps to 29.Feb (2020 leap)");
assert(addMonthsISO("2021-05-31", -1) === "2021-04-30", "31.May -1M clamps to 30.Apr");
assert(addMonthsISO("2021-01-31", -12) === "2020-01-31", "31.Jan -12M -> 31.Jan prior year (both 31-day months)");
assert(addMonthsISO("2021-06-15", 1) === "2021-07-15", "simple +1 month, no clamping needed");

// --- 2. Synthetic monthly calendar (108 months), each derived from the
//        anchor directly (not chained) so real calendar month-end days come out.
const N = 108;
const anchor = "2015-01-31";
const dates: string[] = Array.from({ length: N }, (_, i) => addMonthsISO(anchor, i));
assert(dates.length === N, `generated ${N} monthly dates`);
assert(dates[1] === "2015-02-28", `2nd date is 2015-02-28, got ${dates[1]}`);
assert(dates[2] === "2015-03-31", `3rd date is 2015-03-31, got ${dates[2]}`);

function series(monthlyRate: number, wiggle = false) {
  const pts = dates.map((d) => ({ date: d, adjusted_close: 0 }));
  let v = 100;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const rate = wiggle ? monthlyRate + (i % 2 === 0 ? 0.01 : -0.01) : monthlyRate;
      v *= 1 + rate;
    }
    pts[i]!.adjusted_close = v;
  }
  return pts;
}

const winnerIdx = new PriceIndex(series(0.02)); // ~2%/month, dominant momentum leader
const loserIdx = new PriceIndex(series(-0.005)); // slight decline
const medIdx = new PriceIndex(series(0.005, true)); // modest growth WITH noise -> nonzero variance
const benchIdx = new PriceIndex(series(0.007)); // benchmark, steady ~0.7%/month

const candidates = [
  { ticker: "WINNER", index: winnerIdx },
  { ticker: "LOSER", index: loserIdx },
  { ticker: "MED", index: medIdx },
];

// --- 3. Momentum ranking sanity ---------------------------------------------
const asOf = dates[50]!;
const mWinner = computeMomentum("WINNER", winnerIdx, asOf, 12, 1);
const mLoser = computeMomentum("LOSER", loserIdx, asOf, 12, 1);
const mMed = computeMomentum("MED", medIdx, asOf, 12, 1);
assert(mWinner.status === "ok" && mLoser.status === "ok" && mMed.status === "ok", "momentum computable for all 3 at month 50");
assert(mWinner.momentum_12_1! > mMed.momentum_12_1!, "WINNER momentum > MED momentum");
assert(mMed.momentum_12_1! > mLoser.momentum_12_1!, "MED momentum > LOSER momentum");
assert(approx(mWinner.momentum_12_1!, Math.pow(1.02, 11) - 1, 1e-9), "WINNER momentum matches closed-form 1.02^11-1");

// --- 4. runSegment: topN=1, zero cost -> always picks WINNER ---------------
const baseParams: BacktestParams = {
  top_n: 1,
  lookback_months: 12,
  skip_months: 1,
  tx_cost_bps: 0,
  risk_free_rate: 0.04,
  oos_split: 0.7,
  benchmark_ticker: "BENCH",
};

// Only month 13 onward has full 12-1 lookback history for all candidates.
const rebalanceDates = dates.slice(13);

const zeroCostRun = runSegment("full", rebalanceDates, candidates, benchIdx, baseParams);
assert(zeroCostRun.n_rebalances === rebalanceDates.length - 1, "n_rebalances matches period count");
assert(
  zeroCostRun.holdings.every((h) => h.ticker === "WINNER"),
  "WINNER selected at every single rebalance (deterministic dominant momentum)",
);
const expectedEquity = Math.pow(1.02, zeroCostRun.n_rebalances);
const finalEquity = zeroCostRun.equity_curve.at(-1)!.strategy_equity;
assert(
  approx(finalEquity, expectedEquity, expectedEquity * 1e-6),
  `zero-cost final equity ${finalEquity.toFixed(4)} ~= 1.02^${zeroCostRun.n_rebalances} = ${expectedEquity.toFixed(4)}`,
);
assert(maxDrawdown(zeroCostRun.equity_curve.map((p) => p.strategy_equity)) === 0, "monotonically increasing equity -> max drawdown 0");

const expectedCagr = Math.pow(1.02, 12) - 1;
assert(approx(zeroCostRun.strategy.cagr!, expectedCagr, 0.005), `CAGR ${zeroCostRun.strategy.cagr!.toFixed(4)} ~= 1.02^12-1 = ${expectedCagr.toFixed(4)}`);

// --- 5. Transaction costs: same ticker held every period -> cost applies ONCE
const costBps = 50; // 0.50%
const costedRun = runSegment("full", rebalanceDates, candidates, benchIdx, { ...baseParams, tx_cost_bps: costBps });
const costRate = costBps / 10_000;
const expectedCostedEquity = (1 - costRate) * expectedEquity; // turnover=1 only at first rebalance
const finalCostedEquity = costedRun.equity_curve.at(-1)!.strategy_equity;
assert(
  approx(finalCostedEquity, expectedCostedEquity, expectedCostedEquity * 1e-6),
  `costed final equity ${finalCostedEquity.toFixed(4)} ~= (1-${costRate})*${expectedEquity.toFixed(4)} (cost charged once, not every period)`,
);
assert(finalCostedEquity < finalEquity, "transaction costs strictly reduce final equity vs zero-cost run");

// --- 6. Benchmark leg: buy & hold, unaffected by strategy selection --------
const benchStartPrice = benchIdx.onOrBefore(rebalanceDates[0]!)!.price;
const benchEndPrice = benchIdx.onOrBefore(rebalanceDates.at(-1)!)!.price;
const expectedBenchEquity = benchEndPrice / benchStartPrice;
const finalBenchEquity = zeroCostRun.equity_curve.at(-1)!.benchmark_equity;
assert(approx(finalBenchEquity, expectedBenchEquity, 1e-9), "benchmark equity = simple buy&hold ratio, independent of tx costs/strategy");

// --- 7. Sharpe: MED has genuine variance -> finite, sign-correct Sharpe ----
const medRun = runSegment("full", rebalanceDates, [{ ticker: "MED", index: medIdx }], benchIdx, { ...baseParams, top_n: 1 });
assert(medRun.strategy.sharpe !== null, "MED (noisy positive-return series) has a finite Sharpe ratio");
assert(medRun.strategy.sharpe! > 0, `MED Sharpe is positive (mean return > risk-free), got ${medRun.strategy.sharpe}`);
assert(sharpeRatio([0.01, 0.01, 0.01, 0.01], 12, 0.04) === null, "zero-variance return series -> Sharpe is null, not Infinity/NaN");

// --- 8. Out-of-sample split partitions periods without gap or overlap -----
const splitIdx = Math.min(
  rebalanceDates.length - 1,
  Math.max(1, Math.round((rebalanceDates.length - 1) * baseParams.oos_split)),
);
const inSampleRun = runSegment("in_sample", rebalanceDates.slice(0, splitIdx + 1), candidates, benchIdx, baseParams);
const outSampleRun = runSegment("out_of_sample", rebalanceDates.slice(splitIdx), candidates, benchIdx, baseParams);
assert(
  inSampleRun.n_rebalances + outSampleRun.n_rebalances === zeroCostRun.n_rebalances,
  `in_sample (${inSampleRun.n_rebalances}) + out_of_sample (${outSampleRun.n_rebalances}) periods == full (${zeroCostRun.n_rebalances})`,
);
assert(inSampleRun.end_date === outSampleRun.start_date, "in_sample end date and out_of_sample start date share the same rebalance boundary");

// --- 9. Insufficient-history guard ------------------------------------------
const tooShort = runSegment("full", [dates[0]!], candidates, benchIdx, baseParams);
assert(tooShort.n_rebalances === 0 && tooShort.equity_curve.length === 0, "single rebalance date -> 0 periods, empty curve, no crash");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
