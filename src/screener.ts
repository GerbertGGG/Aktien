// Live screener: ranks the current (non-benchmark) watchlist by the 12-1
// momentum score, as of the most recent date for which ALL tickers have
// confirmed data (the minimum of each ticker's latest stored date) — this
// keeps the ranking apples-to-apples even if the free-tier rate limit
// caused some tickers to be updated on a different day than others.
//
// Output is explicitly a RANKING, not a buy/sell recommendation — see the
// disclaimer wired into the /api/screener response and the dashboard.

import { getPriceSeries, getScreenerTickers } from "./db";
import { computeMomentum } from "./momentum";
import { PriceIndex } from "./priceIndex";
import type { Env, MomentumScoreResult, ScreenerResult } from "./types";

export interface ScreenerOptions {
  topN?: number;
  lookbackMonths?: number;
  skipMonths?: number;
  asOfDate?: string; // override, mainly for testing; normally auto-derived
}

export async function computeScreener(env: Env, opts: ScreenerOptions = {}): Promise<ScreenerResult> {
  const topN = opts.topN ?? (Number(env.DEFAULT_TOP_N) || 5);
  const lookbackMonths = opts.lookbackMonths ?? (Number(env.DEFAULT_LOOKBACK_MONTHS) || 12);
  const skipMonths = opts.skipMonths ?? (Number(env.DEFAULT_SKIP_MONTHS) || 1);

  const tickers = await getScreenerTickers(env);

  const indices = new Map<string, PriceIndex>();
  const lastDates: string[] = [];
  for (const t of tickers) {
    const series = await getPriceSeries(env, t.ticker);
    if (series.length === 0) continue;
    const idx = new PriceIndex(series);
    indices.set(t.ticker, idx);
    if (idx.lastDate) lastDates.push(idx.lastDate);
  }

  const asOfDate = opts.asOfDate ?? (lastDates.length > 0 ? lastDates.reduce((a, b) => (a < b ? a : b)) : null);

  const ranked: MomentumScoreResult[] = tickers.map((t) => {
    const idx = indices.get(t.ticker);
    if (!idx || !asOfDate) {
      return {
        ticker: t.ticker,
        as_of_date: asOfDate ?? "",
        status: "insufficient_history",
        momentum_12_1: null,
        price_t_minus_1m: null,
        price_t_minus_12m: null,
        date_t_minus_1m: null,
        date_t_minus_12m: null,
      };
    }
    return computeMomentum(t.ticker, idx, asOfDate, lookbackMonths, skipMonths);
  });

  ranked.sort((a, b) => {
    if (a.status === "ok" && b.status !== "ok") return -1;
    if (a.status !== "ok" && b.status === "ok") return 1;
    if (a.status !== "ok" && b.status !== "ok") return a.ticker.localeCompare(b.ticker);
    return (b.momentum_12_1 ?? -Infinity) - (a.momentum_12_1 ?? -Infinity);
  });

  return {
    as_of_date: asOfDate,
    lookback_months: lookbackMonths,
    skip_months: skipMonths,
    top_n: topN,
    ranked,
    top: ranked.filter((r) => r.status === "ok").slice(0, topN),
  };
}
