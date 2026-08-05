// Classic 12-1 momentum factor (Jegadeesh & Titman): total return from
// 12 months ago to 1 month ago, deliberately EXCLUDING the most recent
// month to reduce the short-term-reversal effect. Pure function, no D1
// access, so it's usable both by the live screener (as-of "today") and by
// the backtest engine (as-of each historical rebalance date) without
// look-ahead risk — the caller controls `asOfDate` and the PriceIndex only
// ever looks at data on or before it.

import { addMonthsISO } from "./dates";
import type { PriceIndex } from "./priceIndex";
import type { MomentumScoreResult } from "./types";

export function computeMomentum(
  ticker: string,
  index: PriceIndex,
  asOfDate: string,
  lookbackMonths: number,
  skipMonths: number,
): MomentumScoreResult {
  const target1m = addMonthsISO(asOfDate, -skipMonths);
  const target12m = addMonthsISO(asOfDate, -lookbackMonths);

  const p1 = index.onOrBefore(target1m);
  const p12 = index.onOrBefore(target12m);

  if (!p1 || !p12 || p12.price <= 0) {
    return {
      ticker,
      as_of_date: asOfDate,
      status: "insufficient_history",
      momentum_12_1: null,
      price_t_minus_1m: null,
      price_t_minus_12m: null,
      date_t_minus_1m: null,
      date_t_minus_12m: null,
    };
  }

  return {
    ticker,
    as_of_date: asOfDate,
    status: "ok",
    momentum_12_1: p1.price / p12.price - 1,
    price_t_minus_1m: p1.price,
    price_t_minus_12m: p12.price,
    date_t_minus_1m: p1.date,
    date_t_minus_12m: p12.date,
  };
}
