import { computeScreener } from "../screener";
import { DISCLAIMER, json } from "../http";
import type { Env } from "../types";

export async function handleScreener(env: Env, url: URL): Promise<Response> {
  const topN = url.searchParams.has("topN") ? Number(url.searchParams.get("topN")) : undefined;
  const lookbackMonths = url.searchParams.has("lookbackMonths")
    ? Number(url.searchParams.get("lookbackMonths"))
    : undefined;
  const skipMonths = url.searchParams.has("skipMonths") ? Number(url.searchParams.get("skipMonths")) : undefined;

  const result = await computeScreener(env, { topN, lookbackMonths, skipMonths });

  return json({
    ...result,
    disclaimer: DISCLAIMER,
    label_note:
      "Dies ist ein Ranking nach historischem 12-1-Momentum, KEIN Kaufsignal und keine Anlageempfehlung.",
  });
}
