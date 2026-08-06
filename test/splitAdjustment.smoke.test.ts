// Smoke test for the split back-adjustment math (src/splitAdjustment.ts).
// No D1 needed — pure function. Run via `npm test` (see package.json).

import { computeAdjustedCloses } from "../src/splitAdjustment";

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

// --- 1. No splits -> adjusted_close === close -------------------------------
const noSplits = computeAdjustedCloses(
  [
    { date: "2023-01-01", close: 100 },
    { date: "2023-02-01", close: 110 },
  ],
  [],
);
assert(noSplits[0]!.adjusted_close === 100 && noSplits[1]!.adjusted_close === 110, "no splits -> adjusted_close unchanged");

// --- 2. Single split: prices before it are divided, prices after are not --
// Real NVDA case: 4:1 split effective 2021-07-20. A pre-split raw close of
// 740 should adjust down to 185; a post-split close of 185 stays 185.
const single = computeAdjustedCloses(
  [
    { date: "2021-07-19", close: 740 }, // day before split
    { date: "2021-07-20", close: 185 }, // split-effective day (already post-split scale)
    { date: "2021-07-21", close: 190 },
  ],
  [{ effective_date: "2021-07-20", split_factor: 4 }],
);
assert(approx(single[0]!.adjusted_close!, 185, 1e-9), `pre-split close 740 -> adjusted 185 (740/4), got ${single[0]!.adjusted_close}`);
assert(approx(single[1]!.adjusted_close!, 185, 1e-9), "on-split-date close unchanged (already post-split scale)");
assert(approx(single[2]!.adjusted_close!, 190, 1e-9), "post-split close unchanged");

// --- 3. Two splits (real NVDA history): 2021-07-20 4:1, then 2024-06-10 10:1
// A price from 2020 (before BOTH splits) must be divided by 4*10=40.
// A price from 2022 (after the first split, before the second) divided by 10 only.
// A price from 2025 (after both) unchanged.
const nvda = computeAdjustedCloses(
  [
    { date: "2020-01-15", close: 2000 },
    { date: "2022-03-01", close: 250 },
    { date: "2025-01-01", close: 130 },
  ],
  [
    { effective_date: "2021-07-20", split_factor: 4 },
    { effective_date: "2024-06-10", split_factor: 10 },
  ],
);
assert(approx(nvda[0]!.adjusted_close!, 2000 / 40, 1e-9), `pre-both-splits: 2000/40 = ${2000 / 40}, got ${nvda[0]!.adjusted_close}`);
assert(approx(nvda[1]!.adjusted_close!, 250 / 10, 1e-9), `between splits: 250/10 = ${250 / 10}, got ${nvda[1]!.adjusted_close}`);
assert(approx(nvda[2]!.adjusted_close!, 130, 1e-9), `after both splits: unchanged, got ${nvda[2]!.adjusted_close}`);

// --- 4. Splits array order doesn't matter (function sorts internally) -----
const reordered = computeAdjustedCloses(
  [{ date: "2020-01-15", close: 2000 }],
  [
    { effective_date: "2024-06-10", split_factor: 10 },
    { effective_date: "2021-07-20", split_factor: 4 },
  ],
);
assert(approx(reordered[0]!.adjusted_close!, 2000 / 40, 1e-9), "split input order doesn't affect result");

// --- 5. Null close passes through as null, doesn't break the walk ---------
const withNull = computeAdjustedCloses(
  [
    { date: "2021-07-19", close: 740 },
    { date: "2021-07-19.5", close: null },
    { date: "2021-07-21", close: 190 },
  ],
  [{ effective_date: "2021-07-20", split_factor: 4 }],
);
assert(withNull[1]!.adjusted_close === null, "null close stays null");
assert(approx(withNull[0]!.adjusted_close!, 185, 1e-9), "null row doesn't disrupt neighboring adjustment");

// --- 6. Output preserves input order and length ----------------------------
assert(nvda.length === 3 && nvda[0]!.date === "2020-01-15" && nvda[2]!.date === "2025-01-01", "output order/length matches input");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
