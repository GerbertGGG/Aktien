// Fast point-in-time lookups over a ticker's adjusted-close series.
// Screener and backtest both need "what was the price on-or-before date X"
// a lot, so we build one binary-searchable index per ticker per request
// instead of scanning D1 results repeatedly.

import type { PricePoint } from "./types";

export class PriceIndex {
  private readonly dates: string[];
  private readonly prices: number[];

  /** `series` must already be sorted ascending by date (as returned by db.getPriceSeries). */
  constructor(series: PricePoint[]) {
    this.dates = series.map((p) => p.date);
    this.prices = series.map((p) => p.adjusted_close);
  }

  get length(): number {
    return this.dates.length;
  }

  get firstDate(): string | undefined {
    return this.dates[0];
  }

  get lastDate(): string | undefined {
    return this.dates[this.dates.length - 1];
  }

  get allDates(): readonly string[] {
    return this.dates;
  }

  /** Most recent (date, price) with date <= targetDate. Returns null if no such point exists. */
  onOrBefore(targetDate: string): { date: string; price: number } | null {
    let lo = 0;
    let hi = this.dates.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const midDate = this.dates[mid]!;
      if (midDate <= targetDate) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans === -1) return null;
    return { date: this.dates[ans]!, price: this.prices[ans]! };
  }

  /** Exact price on `date`, or null if that date isn't in the series. */
  priceOn(date: string): number | null {
    const hit = this.onOrBefore(date);
    return hit && hit.date === date ? hit.price : null;
  }
}
