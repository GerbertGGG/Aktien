// Admin/debug routes.
//  - GET  /api/admin/test-fetch : one-off raw Alpha Vantage call, used to
//    verify the API key + response structure after `wrangler secret put`
//    (see README "Setup Schritt 2"). Does NOT write to D1. Supports
//    ?function=adjusted|daily|splits to probe each endpoint independently.
//  - POST /api/admin/run-update : manually trigger the same logic the daily
//    Cron Trigger runs, useful for local testing without waiting for 22:00 UTC.
//
// Both are gated behind ADMIN_TOKEN if that secret is set (see types.ts).

import { fetchDaily, fetchDailyAdjusted, fetchSplits } from "../alphavantage";
import { runDailyUpdate } from "../cron";
import { json, jsonError } from "../http";
import type { Env } from "../types";

export function isAuthorized(env: Env, request: Request): boolean {
  if (!env.ADMIN_TOKEN) return true; // no token configured -> open (single-user default)
  return request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
}

export async function handleTestFetch(env: Env, url: URL): Promise<Response> {
  const ticker = url.searchParams.get("ticker") ?? "AAPL";
  const outputsize = (url.searchParams.get("outputsize") === "full" ? "full" : "compact") as "full" | "compact";
  const fn = url.searchParams.get("function") ?? "daily"; // "adjusted" | "daily" | "splits" — "daily" is what the cron job actually uses by default

  if (!env.ALPHA_VANTAGE_KEY) {
    return jsonError(
      "ALPHA_VANTAGE_KEY ist nicht gesetzt. `wrangler secret put ALPHA_VANTAGE_KEY` ausfuehren.",
      500,
    );
  }

  if (fn === "splits") {
    const outcome = await fetchSplits(env.ALPHA_VANTAGE_KEY, ticker);
    if (outcome.kind === "ok") {
      return json({ kind: outcome.kind, ticker, function: "splits", split_count: outcome.splits.length, splits: outcome.splits });
    }
    return json({ kind: outcome.kind, ticker, function: "splits", message: outcome.message }, { status: 502 });
  }

  const outcome =
    fn === "adjusted"
      ? await fetchDailyAdjusted(env.ALPHA_VANTAGE_KEY, ticker, outputsize)
      : await fetchDaily(env.ALPHA_VANTAGE_KEY, ticker, outputsize);

  if (outcome.kind === "ok") {
    return json({
      kind: outcome.kind,
      ticker,
      function: fn === "adjusted" ? "adjusted" : "daily",
      outputsize,
      row_count: outcome.rows.length,
      sample_rows: outcome.rows.slice(0, 3),
    });
  }
  return json({ kind: outcome.kind, ticker, function: fn, outputsize, message: outcome.message }, { status: 502 });
}

export async function handleRunUpdate(env: Env): Promise<Response> {
  const summary = await runDailyUpdate(env);
  return json(summary);
}
