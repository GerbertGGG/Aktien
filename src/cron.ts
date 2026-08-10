// Daily price-update job. Triggered by the Cron Trigger (wrangler.toml,
// 22:00 UTC) via the `scheduled` handler in index.ts, and callable manually
// via POST /api/admin/run-update for local testing.
//
// Data source: Twelve Data (see README "Datenquelle"). `time_series`
// documents up to 5000 bars per request even on the free plan, so a single
// request can backfill years of daily history.
//
// Split adjustment: Twelve Data's plain `close` field is ALREADY
// split-adjusted (confirmed empirically 2026-08-10: NVDA's stored close for
// 2024-06-07, the last pre-split trading day, was 120.888 — exactly its
// real pre-split closing price of $1208.88 divided by the 10:1 split factor
// that took effect 2024-06-10). Earlier versions of this project applied a
// SECOND, manual split adjustment on top of that (see git history /
// scripts/seed-splits.sql), which double-adjusted every pre-split price and
// produced a wildly wrong backtest (~99% annualized volatility, a fake
// vertical jump in the equity curve right at each split date). `close` is
// used as `adjusted_close` directly now — no further adjustment applied.
// (Twelve Data's docs don't say this explicitly for the free `time_series`
// endpoint; if you ever see a similar artificial jump again for a ticker
// with a real split, re-verify with the same before/after-close check
// before reintroducing any adjustment logic.)
//
// Per-ticker strategy:
//   - One-time (gated by hasEverFetchedOk 'daily_full', not a row-count
//     heuristic): a single large-outputsize request (years of history).
//   - Every day after: a small outputsize request (~100 bars) to catch up
//     and self-correct recent data.
//
// Rate-limit strategy (Twelve Data free tier: 8 req/min, 800 req/day — see
// README for how to confirm/adjust these against your own account):
// every individual HTTP request is spaced apart and counted against the
// daily budget; items that don't fit the remaining budget this run are
// skipped (not aborted) so a cheaper item further down the list still gets
// a chance, and are retried on a later run/day, prioritizing backfills and
// then the most stale tickers.

import { fetchDaily, sleep } from "./twelvedata";
import {
  countRequestsToday,
  getLatestPriceDate,
  getWatchlist,
  hasEverFetchedOk,
  hasFetchedOkToday,
  logFetch,
  releaseRunLock,
  tryAcquireRunLock,
  upsertPrices,
} from "./db";
import type { Env } from "./types";

const MIN_INTERVAL_MS = 8_000; // 60s / 8req-per-min = 7.5s, small safety margin
const BACKFILL_OUTPUTSIZE = 5000; // Twelve Data max per request; ~20 years of daily bars
const INCREMENTAL_OUTPUTSIZE = 100; // last ~100 trading days, cheap daily catch-up

export interface UpdateRunSummary {
  budgetAtStart: number;
  attempted: number;
  ok: number;
  errors: number;
  rateLimited: boolean;
  /** True if this call bailed out immediately because another run was already in progress (see tryAcquireRunLock). */
  skippedConcurrentRun?: boolean;
  details: Array<{ ticker: string; requestKind: "daily_full" | "daily_compact"; status: string; message?: string; rows?: number }>;
}

export interface WorkItem {
  ticker: string;
  needsFullBackfill: boolean;
  cost: number; // number of HTTP requests this item will use (always 1 — kept for API stability / future extensions)
  latestDate: string | null;
}

/**
 * Decides which active, not-yet-updated-today tickers need a full backfill
 * vs. an incremental update, sorted with backfills first, then
 * most-stale-first. Pure D1 reads, no network calls — kept separate from
 * the fetch/write loop below so it can be exercised directly against a
 * real local D1 instance without needing to mock fetch().
 */
export async function buildWorkItems(env: Env): Promise<WorkItem[]> {
  const watchlist = await getWatchlist(env, { activeOnly: true });

  const items: WorkItem[] = [];
  for (const entry of watchlist) {
    if (await hasFetchedOkToday(env, entry.ticker)) continue;
    const needsFullBackfill = !(await hasEverFetchedOk(env, entry.ticker, "daily_full"));
    const latestDate = await getLatestPriceDate(env, entry.ticker);
    items.push({ ticker: entry.ticker, needsFullBackfill, cost: 1, latestDate });
  }

  // Backfills first (highest value per request), then most-stale incremental
  // updates first.
  items.sort((a, b) => {
    if (a.needsFullBackfill !== b.needsFullBackfill) return a.needsFullBackfill ? -1 : 1;
    const ad = a.latestDate ?? "";
    const bd = b.latestDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  return items;
}

export async function runDailyUpdate(env: Env): Promise<UpdateRunSummary> {
  const emptySummary = (): UpdateRunSummary => ({
    budgetAtStart: 0,
    attempted: 0,
    ok: 0,
    errors: 0,
    rateLimited: false,
    details: [],
  });

  // Guards against two overlapping calls (dashboard button + Cron Trigger,
  // or a double click) double-fetching the same tickers and blowing
  // through the per-minute rate limit — see migrations/0003_run_lock.sql.
  if (!(await tryAcquireRunLock(env))) {
    return { ...emptySummary(), skippedConcurrentRun: true };
  }

  try {
    const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 800;
    const alreadyUsed = await countRequestsToday(env);
    let budgetRemaining = Math.max(0, maxPerDay - alreadyUsed);

    const summary: UpdateRunSummary = { ...emptySummary(), budgetAtStart: budgetRemaining };

    if (budgetRemaining <= 0) return summary;

    const items = await buildWorkItems(env);

    let firstRequest = true;
    const spaceOut = async () => {
      if (!firstRequest) await sleep(MIN_INTERVAL_MS);
      firstRequest = false;
    };

    for (const item of items) {
      if (budgetRemaining < item.cost) continue;

      const requestKind: "daily_full" | "daily_compact" = item.needsFullBackfill ? "daily_full" : "daily_compact";

      await spaceOut();
      summary.attempted++;
      const outcome = await fetchDaily(
        env.TWELVE_DATA_KEY,
        item.ticker,
        item.needsFullBackfill ? BACKFILL_OUTPUTSIZE : INCREMENTAL_OUTPUTSIZE,
      );
      budgetRemaining--;

      if (outcome.kind === "rate_limited") {
        await logFetch(env, { ticker: item.ticker, output_size: requestKind, status: "rate_limited", message: outcome.message });
        summary.rateLimited = true;
        summary.details.push({ ticker: item.ticker, requestKind, status: "rate_limited", message: outcome.message });
        break;
      }
      if (outcome.kind !== "ok") {
        await logFetch(env, { ticker: item.ticker, output_size: requestKind, status: "error", message: outcome.message });
        summary.errors++;
        summary.details.push({ ticker: item.ticker, requestKind, status: outcome.kind, message: outcome.message });
        continue;
      }

      const rows = outcome.rows.map((r) => ({ ...r, ticker: item.ticker }));
      const upserted = await upsertPrices(env, rows);
      await logFetch(env, { ticker: item.ticker, output_size: requestKind, status: "ok", rows_upserted: upserted });
      summary.ok++;
      summary.details.push({ ticker: item.ticker, requestKind, status: "ok", rows: upserted });
    }

    return summary;
  } finally {
    await releaseRunLock(env);
  }
}
