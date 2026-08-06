// Pure computation for back-adjusting raw (unadjusted) close prices using a
// ticker's known split history — no D1/Workers dependency, so it's directly
// unit-testable (see test/splitAdjustment.smoke.test.ts).
//
// Convention: adjusted_close(date) = close(date) / (product of split_factor
// for every split with effective_date > date). A price dated BEFORE a split
// gets divided by that split's factor (and by every later split's factor
// too, cumulatively), so historical prices become comparable to today's
// post-split share count. Prices on/after the most recent split are
// unchanged (divisor 1).

export interface RawPricePoint {
  date: string;
  close: number | null;
}

export interface SplitEvent {
  effective_date: string;
  split_factor: number;
}

export interface AdjustedPricePoint {
  date: string;
  adjusted_close: number | null;
}

/**
 * `prices` must be sorted ascending by date. `splits` may be in any order.
 * Returns one entry per input price, same order, with adjusted_close set
 * (null iff the input close was null).
 */
export function computeAdjustedCloses(prices: RawPricePoint[], splits: SplitEvent[]): AdjustedPricePoint[] {
  const sortedSplits = [...splits].sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1));
  const out: AdjustedPricePoint[] = new Array(prices.length);

  let cumFactor = 1;
  let splitIdx = sortedSplits.length - 1; // walk splits newest-to-oldest as we walk prices backward
  for (let i = prices.length - 1; i >= 0; i--) {
    const row = prices[i]!;
    while (splitIdx >= 0 && sortedSplits[splitIdx]!.effective_date > row.date) {
      cumFactor *= sortedSplits[splitIdx]!.split_factor;
      splitIdx--;
    }
    out[i] = { date: row.date, adjusted_close: row.close !== null ? row.close / cumFactor : null };
  }

  return out;
}
