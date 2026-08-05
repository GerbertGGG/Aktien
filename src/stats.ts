// Pure performance-metric math, independent of D1/Workers so it's easy to
// reason about (and unit-test) in isolation from data access.

import { yearsBetween } from "./dates";
import type { BacktestMetrics } from "./types";

export function cagrFromEquity(
  startEquity: number,
  endEquity: number,
  startDate: string,
  endDate: string,
): number | null {
  const years = yearsBetween(startDate, endDate);
  if (years <= 0 || startEquity <= 0 || endEquity <= 0) return null;
  return Math.pow(endEquity / startEquity, 1 / years) - 1;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1 denominator). */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Annualized Sharpe ratio from a series of PERIODIC returns (e.g. monthly).
 * The annual risk-free rate is converted to the same periodicity before
 * subtracting, so the result is comparable across different rebalancing
 * frequencies.
 */
export function sharpeRatio(
  periodicReturns: number[],
  periodsPerYear: number,
  riskFreeRateAnnual: number,
): number | null {
  if (periodicReturns.length < 2) return null;
  const rfPeriodic = Math.pow(1 + riskFreeRateAnnual, 1 / periodsPerYear) - 1;
  const excess = periodicReturns.map((r) => r - rfPeriodic);
  const sd = stdDev(excess);
  if (sd === 0) return null;
  return (mean(excess) / sd) * Math.sqrt(periodsPerYear);
}

export function annualizedVolatility(periodicReturns: number[], periodsPerYear: number): number | null {
  if (periodicReturns.length < 2) return null;
  return stdDev(periodicReturns) * Math.sqrt(periodsPerYear);
}

/** Max drawdown as a negative fraction (e.g. -0.35 = -35%) over an equity curve. */
export function maxDrawdown(equityCurve: number[]): number | null {
  if (equityCurve.length === 0) return null;
  let peak = equityCurve[0]!;
  let worst = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < worst) worst = dd;
  }
  return worst;
}

export function computeMetrics(
  equityCurve: number[],
  periodicReturns: number[],
  periodsPerYear: number,
  startDate: string,
  endDate: string,
  riskFreeRateAnnual: number,
): BacktestMetrics {
  const start = equityCurve[0];
  const end = equityCurve[equityCurve.length - 1];
  return {
    cagr: start !== undefined && end !== undefined ? cagrFromEquity(start, end, startDate, endDate) : null,
    sharpe: sharpeRatio(periodicReturns, periodsPerYear, riskFreeRateAnnual),
    max_drawdown: maxDrawdown(equityCurve),
    volatility: annualizedVolatility(periodicReturns, periodsPerYear),
  };
}
