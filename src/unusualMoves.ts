// Statistical "notable price behavior" detection — purely descriptive, no
// news/fundamentals data involved (see README "Auffaellige Kursbewegungen"
// for the scope decision behind that). Flags two independent things using
// only price/volume data already stored in D1:
//
//  1. An unusually large daily return, measured relative to the TICKER'S
//     OWN recent volatility (a z-score against its trailing daily-return
//     distribution) rather than a fixed percentage — a 4% move is routine
//     for a volatile stock and notable for a low-volatility one.
//  2. Unusually high trading volume relative to its own trailing average.
//
// Output is deliberately limited to facts + a neutral statistical label
// ("N standard deviations", "Nx average volume") with NO interpretation of
// cause or likely future direction — this is descriptive statistics, not a
// signal, consistent with the rest of the project's disclaimers.

export interface DailyBar {
  date: string;
  adjusted_close: number;
  volume: number | null;
}

export interface UnusualMoveResult {
  ticker: string;
  as_of_date: string;
  daily_return: number | null;
  return_zscore: number | null;
  is_unusual_move: boolean;
  volume: number | null;
  avg_volume: number | null;
  volume_ratio: number | null;
  is_unusual_volume: boolean;
  status: "insufficient_history" | "ok";
  label: string | null; // neutral, facts-only summary; null if nothing notable
}

export interface UnusualMoveOptions {
  /** How many prior trading days' returns to build the "normal" distribution from. */
  returnLookbackDays: number;
  /** |z-score| above this is flagged as an unusual move. */
  returnZThreshold: number;
  /** How many prior trading days' volume to average. */
  volumeLookbackDays: number;
  /** volume / average above this is flagged as unusual. */
  volumeRatioThreshold: number;
}

export const DEFAULT_UNUSUAL_MOVE_OPTIONS: UnusualMoveOptions = {
  returnLookbackDays: 60,
  returnZThreshold: 2.5,
  volumeLookbackDays: 20,
  volumeRatioThreshold: 2.5,
};

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * `bars` must be sorted ascending by date and represent one ticker's full
 * (or at least recent) history; the LAST entry is treated as "today".
 */
export function computeUnusualMove(
  ticker: string,
  bars: DailyBar[],
  opts: UnusualMoveOptions = DEFAULT_UNUSUAL_MOVE_OPTIONS,
): UnusualMoveResult {
  const n = bars.length;
  const minBars = Math.max(opts.returnLookbackDays, opts.volumeLookbackDays) + 2;

  if (n < minBars) {
    return {
      ticker,
      as_of_date: bars[n - 1]?.date ?? "",
      daily_return: null,
      return_zscore: null,
      is_unusual_move: false,
      volume: null,
      avg_volume: null,
      volume_ratio: null,
      is_unusual_volume: false,
      status: "insufficient_history",
      label: null,
    };
  }

  const today = bars[n - 1]!;
  const yesterday = bars[n - 2]!;
  const asOfDate = today.date;

  // --- Return z-score -------------------------------------------------
  const returns: number[] = [];
  for (let i = n - 1 - opts.returnLookbackDays; i < n - 1; i++) {
    const prev = bars[i]!;
    const cur = bars[i + 1]!;
    if (prev.adjusted_close > 0) returns.push(cur.adjusted_close / prev.adjusted_close - 1);
  }
  const todayReturn = yesterday.adjusted_close > 0 ? today.adjusted_close / yesterday.adjusted_close - 1 : null;

  const histReturns = returns.slice(0, -1); // "normal" distribution excludes today's own return
  const returnMean = mean(histReturns);
  const returnSd = stdDev(histReturns);
  const returnZ = todayReturn !== null && returnSd > 0 ? (todayReturn - returnMean) / returnSd : null;
  const isUnusualMove = returnZ !== null && Math.abs(returnZ) >= opts.returnZThreshold;

  // --- Volume ratio -----------------------------------------------------
  const volumeWindow = bars.slice(n - 1 - opts.volumeLookbackDays, n - 1).map((b) => b.volume ?? 0);
  const avgVolume = volumeWindow.length > 0 ? mean(volumeWindow) : null;
  const volumeRatio = today.volume !== null && avgVolume && avgVolume > 0 ? today.volume / avgVolume : null;
  const isUnusualVolume = volumeRatio !== null && volumeRatio >= opts.volumeRatioThreshold;

  // --- Neutral, facts-only label ----------------------------------------
  let label: string | null = null;
  const moveText =
    isUnusualMove && todayReturn !== null && returnZ !== null
      ? `Ungewoehnliche Kursbewegung: ${(todayReturn * 100).toFixed(1)}% (${returnZ.toFixed(1)} Standardabweichungen ggue. den letzten ${opts.returnLookbackDays} Handelstagen)`
      : null;
  const volumeText =
    isUnusualVolume && volumeRatio !== null
      ? `ungewoehnlich hohes Volumen (${volumeRatio.toFixed(1)}x Durchschnitt der letzten ${opts.volumeLookbackDays} Tage)`
      : null;

  if (moveText && volumeText) label = `${moveText}, ${volumeText}`;
  else if (moveText) label = moveText;
  else if (volumeText) label = `Ungewoehnlich hohes Volumen (${volumeRatio!.toFixed(1)}x Durchschnitt der letzten ${opts.volumeLookbackDays} Tage)`;

  return {
    ticker,
    as_of_date: asOfDate,
    daily_return: todayReturn,
    return_zscore: returnZ,
    is_unusual_move: isUnusualMove,
    volume: today.volume,
    avg_volume: avgVolume,
    volume_ratio: volumeRatio,
    is_unusual_volume: isUnusualVolume,
    status: "ok",
    label,
  };
}
