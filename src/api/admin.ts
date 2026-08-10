// Admin/debug routes.
//  - GET  /api/admin/test-fetch : one-off raw Twelve Data call, used to
//    verify the API key + response structure after `wrangler secret put`
//    (see README "Setup Schritt 2"). Does NOT write to D1. Supports
//    ?function=daily|splits and ?outputsize=N (daily only). Note: /splits
//    requires a paid Twelve Data plan (confirmed) and isn't used to adjust
//    prices anyway — Twelve Data's plain `close` is already split-adjusted
//    (see src/twelvedata.ts, src/cron.ts) — kept only for diagnostics.
//  - POST /api/admin/run-update : manually trigger the same logic the daily
//    Cron Trigger runs, useful for local testing without waiting for 22:00 UTC.
//  - POST /api/admin/reset-adjusted-close : repair tool — resets
//    adjusted_close back to the raw close for every watchlist ticker. No
//    Twelve Data calls, free and instant. Needed if adjusted_close was ever
//    double-adjusted (see src/db.ts resetAdjustedCloseToRaw for the story).
//
// All three are gated behind ADMIN_TOKEN if that secret is set (see types.ts).

import { fetchDaily, fetchSplits } from "../twelvedata";
import { runDailyUpdate } from "../cron";
import { getWatchlist, resetAdjustedCloseToRaw } from "../db";
import { json, jsonError } from "../http";
import type { Env } from "../types";

export function isAuthorized(env: Env, request: Request): boolean {
  if (!env.ADMIN_TOKEN) return true; // no token configured -> open (single-user default)
  return request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
}

export async function handleTestFetch(env: Env, url: URL): Promise<Response> {
  const ticker = url.searchParams.get("ticker") ?? "AAPL";
  const outputsize = Number(url.searchParams.get("outputsize")) || 100;
  const fn = url.searchParams.get("function") ?? "daily"; // "daily" | "splits"

  if (!env.TWELVE_DATA_KEY) {
    return jsonError(
      "TWELVE_DATA_KEY ist nicht gesetzt. `wrangler secret put TWELVE_DATA_KEY` ausfuehren.",
      500,
    );
  }

  if (fn === "splits") {
    const outcome = await fetchSplits(env.TWELVE_DATA_KEY, ticker);
    if (outcome.kind === "ok") {
      return json({ kind: outcome.kind, ticker, function: "splits", split_count: outcome.splits.length, splits: outcome.splits });
    }
    return json({ kind: outcome.kind, ticker, function: "splits", message: outcome.message }, { status: 502 });
  }

  const outcome = await fetchDaily(env.TWELVE_DATA_KEY, ticker, outputsize);
  if (outcome.kind === "ok") {
    return json({
      kind: outcome.kind,
      ticker,
      function: "daily",
      outputsize,
      row_count: outcome.rows.length,
      sample_rows: outcome.rows.slice(0, 3),
    });
  }
  return json({ kind: outcome.kind, ticker, function: "daily", outputsize, message: outcome.message }, { status: 502 });
}

export async function handleRunUpdate(env: Env): Promise<Response> {
  const summary = await runDailyUpdate(env);
  return json(summary);
}

export async function handleResetAdjustedClose(env: Env): Promise<Response> {
  const watchlist = await getWatchlist(env);
  const results: Array<{ ticker: string; rows_reset: number }> = [];
  for (const entry of watchlist) {
    const rows = await resetAdjustedCloseToRaw(env, entry.ticker);
    results.push({ ticker: entry.ticker, rows_reset: rows });
  }
  return json({ ok: true, tickers_processed: results.length, results });
}
