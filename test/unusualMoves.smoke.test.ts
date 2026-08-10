// Smoke test for the statistical "notable price behavior" detector
// (src/unusualMoves.ts). No D1 needed — pure function. Run via `npm test`.

import { computeUnusualMove, DEFAULT_UNUSUAL_MOVE_OPTIONS } from "../src/unusualMoves";
import type { DailyBar } from "../src/unusualMoves";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok:   ${msg}`);
  }
}

function makeDate(i: number): string {
  // Fake sequential labels — the function never parses these as real
  // calendar dates, only uses array order, so validity doesn't matter.
  return `day-${String(i).padStart(4, "0")}`;
}

/** Deterministic pseudo-random small daily noise, so runs are reproducible. */
function noise(i: number, amplitude: number): number {
  return Math.sin(i * 12.9898) * amplitude;
}

function buildStableBars(n: number, opts: { dailyReturn?: number; volume?: number; volumeNoise?: number } = {}): DailyBar[] {
  const { dailyReturn = 0.0005, volume = 1_000_000, volumeNoise = 0.05 } = opts;
  const bars: DailyBar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    if (i > 0) price *= 1 + dailyReturn + noise(i, 0.002);
    const vol = Math.round(volume * (1 + noise(i, volumeNoise)));
    bars.push({ date: makeDate(i), adjusted_close: price, volume: vol });
  }
  return bars;
}

// --- 1. Insufficient history -------------------------------------------
const short = computeUnusualMove("XYZ", buildStableBars(10));
assert(short.status === "insufficient_history", "too few bars -> insufficient_history, no crash");
assert(short.label === null && !short.is_unusual_move && !short.is_unusual_volume, "insufficient_history -> no flags");

// --- 2. Stable series, normal last day -> nothing flagged ---------------
const stable = buildStableBars(90);
const stableResult = computeUnusualMove("STABLE", stable);
assert(stableResult.status === "ok", "enough history -> status ok");
assert(!stableResult.is_unusual_move, "small, in-line daily return -> not flagged as unusual move");
assert(!stableResult.is_unusual_volume, "normal volume -> not flagged as unusual volume");
assert(stableResult.label === null, "nothing notable -> label is null");

// --- 3. Big one-day jump on top of a low-volatility history --------------
const jumpBars = buildStableBars(90, { dailyReturn: 0.0002 }); // very low daily drift/noise -> tight distribution
const last = jumpBars[jumpBars.length - 1]!;
jumpBars[jumpBars.length - 1] = { ...last, adjusted_close: last.adjusted_close * 1.15 }; // +15% today
const jumpResult = computeUnusualMove("JUMPY", jumpBars);
assert(jumpResult.is_unusual_move, `+15% on a low-volatility history is flagged as unusual (z=${jumpResult.return_zscore})`);
assert(jumpResult.return_zscore !== null && jumpResult.return_zscore > DEFAULT_UNUSUAL_MOVE_OPTIONS.returnZThreshold, "z-score exceeds threshold");
assert(jumpResult.label !== null && jumpResult.label.includes("Standardabweichungen"), "label mentions standard deviations, no interpretation of cause");
assert(!/kaufen|verkaufen|buy|sell/i.test(jumpResult.label ?? ""), "label contains no buy/sell language");

// --- 4. Volume spike, normal price move ----------------------------------
const volumeBars = buildStableBars(90);
const lastVol = volumeBars[volumeBars.length - 1]!;
volumeBars[volumeBars.length - 1] = { ...lastVol, volume: (lastVol.volume ?? 0) * 5 }; // 5x volume
const volumeResult = computeUnusualMove("VOLUMY", volumeBars);
assert(volumeResult.is_unusual_volume, `5x average volume is flagged (ratio=${volumeResult.volume_ratio})`);
assert(!volumeResult.is_unusual_move, "volume spike alone, with a normal-sized price move, doesn't trigger the move flag");
assert(volumeResult.label !== null && volumeResult.label.includes("Volumen"), "label mentions volume");

// --- 5. Both flagged simultaneously -> combined label ---------------------
const bothBars = buildStableBars(90, { dailyReturn: 0.0002 });
const lastBoth = bothBars[bothBars.length - 1]!;
bothBars[bothBars.length - 1] = { ...lastBoth, adjusted_close: lastBoth.adjusted_close * 1.2, volume: (lastBoth.volume ?? 0) * 6 };
const bothResult = computeUnusualMove("BOTH", bothBars);
assert(bothResult.is_unusual_move && bothResult.is_unusual_volume, "both move and volume flagged simultaneously");
assert(bothResult.label !== null && bothResult.label.includes("Kursbewegung") && bothResult.label.includes("Volumen"), "combined label mentions both");

// --- 6. Zero volatility history (all identical returns) doesn't crash ----
const flatBars: DailyBar[] = Array.from({ length: 90 }, (_, i) => ({ date: makeDate(i), adjusted_close: 100, volume: 1_000_000 }));
const flatResult = computeUnusualMove("FLAT", flatBars);
assert(flatResult.status === "ok" && !flatResult.is_unusual_move, "zero-stddev history -> no crash, no false-positive move flag (z-score undefined -> null)");
assert(flatResult.return_zscore === null, "zero stddev -> z-score is null, not Infinity/NaN");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
