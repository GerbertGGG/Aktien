// Admin/debug routes.
//  - GET  /api/admin/test-fetch : one-off raw Twelve Data call, used to
//    verify the API key + response structure after `wrangler secret put`
//    (see README "Setup Schritt 2"). Does NOT write to D1. Supports
//    ?function=daily|splits and ?outputsize=N (daily only). Note: /splits
//    requires a paid Twelve Data plan (confirmed) — kept here mainly so you
//    can re-check if you ever upgrade; splits are otherwise maintained
//    manually, see scripts/seed-splits.sql.
//  - POST /api/admin/run-update : manually trigger the same logic the daily
//    Cron Trigger runs, useful for local testing without waiting for 22:00 UTC.
//  - POST /api/admin/splits : add/update one split entry by hand (since
//    Twelve Data's /splits needs a paid plan) and immediately recompute
//    adjusted_close for that ticker — the no-D1-console way to record a
//    newly-announced split. Body: {"ticker":"AAPL","effective_date":"2030-01-01","split_factor":4}
//
// All three are gated behind ADMIN_TOKEN if that secret is set (see types.ts).

import { fetchDaily, fetchSplits } from "../twelvedata";
import { runDailyUpdate } from "../cron";
import { applySplitAdjustment, upsertSplit } from "../db";
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

export async function handleAddSplit(env: Env, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request-Body ist kein valides JSON.");
  }

  const { ticker, effective_date, split_factor } = (body ?? {}) as Record<string, unknown>;
  if (typeof ticker !== "string" || !ticker) return jsonError("'ticker' fehlt oder ist kein String.");
  if (typeof effective_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
    return jsonError("'effective_date' fehlt oder ist kein ISO-Datum (yyyy-mm-dd).");
  }
  const factor = Number(split_factor);
  if (!Number.isFinite(factor) || factor <= 0) return jsonError("'split_factor' fehlt oder ist keine positive Zahl.");

  const normalizedTicker = ticker.toUpperCase();
  await upsertSplit(env, normalizedTicker, effective_date, factor);
  const rowsRecomputed = await applySplitAdjustment(env, normalizedTicker);

  return json({ ok: true, ticker: normalizedTicker, effective_date, split_factor: factor, rows_recomputed: rowsRecomputed });
}
