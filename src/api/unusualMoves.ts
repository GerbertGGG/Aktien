import { getPriceSeriesWithVolume, getWatchlist } from "../db";
import { json } from "../http";
import { computeUnusualMove, DEFAULT_UNUSUAL_MOVE_OPTIONS } from "../unusualMoves";
import type { Env } from "../types";

export const UNUSUAL_MOVES_DISCLAIMER =
  "Rein statistische Auffaelligkeit aus Kurs-/Volumendaten (Z-Score der Tagesbewegung, Volumen-Verhaeltnis). " +
  "Keine Nachrichten- oder Fundamentaldaten angebunden, keine Aussage ueber Ursache oder weitere Entwicklung. " +
  "Kein Kauf-/Verkaufssignal.";

export async function handleUnusualMoves(env: Env): Promise<Response> {
  const watchlist = await getWatchlist(env, { activeOnly: true });

  const results = [];
  for (const entry of watchlist) {
    const bars = await getPriceSeriesWithVolume(env, entry.ticker);
    const result = computeUnusualMove(entry.ticker, bars, DEFAULT_UNUSUAL_MOVE_OPTIONS);
    results.push(result);
  }

  const notable = results.filter((r) => r.status === "ok" && (r.is_unusual_move || r.is_unusual_volume));

  return json({
    as_of_date: notable[0]?.as_of_date ?? results.find((r) => r.status === "ok")?.as_of_date ?? null,
    params: DEFAULT_UNUSUAL_MOVE_OPTIONS,
    notable,
    all: results,
    disclaimer: UNUSUAL_MOVES_DISCLAIMER,
  });
}
