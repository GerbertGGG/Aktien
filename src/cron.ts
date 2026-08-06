// Daily price-update job. Triggered by the Cron Trigger (wrangler.toml,
// 22:00 UTC) via the `scheduled` handler in index.ts, and callable manually
// via POST /api/admin/run-update for local testing.
//
// Data source (verified 2026-08-05/06 against a real free-tier key):
//   - TIME_SERIES_DAILY_ADJUSTED           -> premium-gated
//   - TIME_SERIES_DAILY, outputsize=full   -> ALSO premium-gated
//     ("The outputsize=full parameter value is a premium feature")
//   - TIME_SERIES_DAILY, outputsize=compact -> free (last ~100 trading days)
//   - TIME_SERIES_MONTHLY                   -> free, and always returns the
//     FULL available history (no outputsize param) — confirmed going back
//     years for AAPL.
//   - SPLITS                                -> free
//
// So a one-shot "give me 20 years of daily data" backfill isn't available
// on this tier at all. Instead:
//   - Once per ticker: TIME_SERIES_MONTHLY (years of history, 1 request)
//     + SPLITS (1 request) = 2 requests, never repeated.
//   - Every day after that: TIME_SERIES_DAILY compact (1 request) layers
//     precise recent data on top of the monthly backbone; SPLITS is
//     re-checked only every ~30 days (splits are rare).
// One monthly close per calendar month is exactly what the momentum signal
// (12-1, monthly-sampled) and the monthly-rebalancing backtest need, so
// PriceIndex/momentum/backtest required NO changes for this — they already
// do point-in-time "closest date on-or-before" lookups over whatever mix of
// monthly/daily rows happens to be stored.
//
// Rate-limit strategy (Alpha Vantage free tier: 5 req/min, 25 req/day):
// every individual HTTP request is spaced >12s apart and counted against
// the daily budget; items that don't fit the remaining budget this run are
// skipped (not aborted) so a cheaper item further down the list still gets
// a chance, and are retried on a later run/day, prioritizing backfills and
// then the most stale tickers.

import { fetchDaily, fetchMonthly, fetchSplits, sleep } from "./alphavantage";
import {
  applySplitAdjustment,
  countRequestsToday,
  getLastSplitsFetchAt,
  getLatestPriceDate,
  getWatchlist,
  hasEverFetchedOk,
  hasFetchedOkToday,
  logFetch,
  replaceSplits,
  upsertPrices,
} from "./db";
import type { Env } from "./types";

const MIN_INTERVAL_MS = 13_000; // > 60s/5 = 12s, small safety margin
const SPLITS_REFRESH_DAYS = 30; // splits are rare; no need to re-check daily

export interface UpdateRunSummary {
  budgetAtStart: number;
  attempted: number;
  ok: number;
  errors: number;
  rateLimited: boolean;
  premiumGated: boolean;
  details: Array<{ ticker: string; requestKind: "monthly" | "compact" | "splits"; status: string; message?: string; rows?: number }>;
}

export interface WorkItem {
  ticker: string;
  needsMonthlyBackfill: boolean;
  needsSplitsRefresh: boolean;
  cost: number; // number of HTTP requests this item will use
  latestDate: string | null;
}

function isOlderThanDays(sqliteTimestamp: string, days: number): boolean {
  // fetch_log.fetched_at is SQLite CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" (UTC, no 'Z').
  const then = new Date(sqliteTimestamp.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return true;
  return Date.now() - then > days * 24 * 3600 * 1000;
}

/**
 * Decides what each active, not-yet-updated-today ticker needs this run
 * (monthly backfill? splits refresh?) and its request cost, sorted with
 * backfills first, then most-stale-first. Pure D1 reads, no network calls —
 * kept separate from the fetch/write loop below so it can be exercised
 * directly against a real local D1 instance without needing to mock fetch().
 */
export async function buildWorkItems(env: Env): Promise<WorkItem[]> {
  const watchlist = await getWatchlist(env, { activeOnly: true });

  const items: WorkItem[] = [];
  for (const entry of watchlist) {
    if (await hasFetchedOkToday(env, entry.ticker)) continue;
    const needsMonthlyBackfill = !(await hasEverFetchedOk(env, entry.ticker, "monthly"));
    const lastSplitsFetch = await getLastSplitsFetchAt(env, entry.ticker);
    const needsSplitsRefresh = needsMonthlyBackfill || lastSplitsFetch === null || isOlderThanDays(lastSplitsFetch, SPLITS_REFRESH_DAYS);
    const latestDate = await getLatestPriceDate(env, entry.ticker);
    items.push({
      ticker: entry.ticker,
      needsMonthlyBackfill,
      needsSplitsRefresh,
      cost: 1 + (needsSplitsRefresh ? 1 : 0),
      latestDate,
    });
  }

  // Backfills first (highest value per request), then most-stale incremental
  // updates first.
  items.sort((a, b) => {
    if (a.needsMonthlyBackfill !== b.needsMonthlyBackfill) return a.needsMonthlyBackfill ? -1 : 1;
    const ad = a.latestDate ?? "";
    const bd = b.latestDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  return items;
}

export async function runDailyUpdate(env: Env): Promise<UpdateRunSummary> {
  const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 25;
  const alreadyUsed = await countRequestsToday(env);
  let budgetRemaining = Math.max(0, maxPerDay - alreadyUsed);

  const summary: UpdateRunSummary = {
    budgetAtStart: budgetRemaining,
    attempted: 0,
    ok: 0,
    errors: 0,
    rateLimited: false,
    premiumGated: false,
    details: [],
  };

  if (budgetRemaining <= 0) return summary;

  const items = await buildWorkItems(env);

  let firstRequest = true;
  const spaceOut = async () => {
    if (!firstRequest) await sleep(MIN_INTERVAL_MS);
    firstRequest = false;
  };

  for (const item of items) {
    // Skip (not "stop") items that don't fit the remaining budget this run —
    // a cheaper item further down the list might still fit.
    if (budgetRemaining < item.cost) continue;

    const priceRequestKind: "monthly" | "compact" = item.needsMonthlyBackfill ? "monthly" : "compact";

    await spaceOut();
    summary.attempted++;
    const priceOutcome = item.needsMonthlyBackfill
      ? await fetchMonthly(env.ALPHA_VANTAGE_KEY, item.ticker)
      : await fetchDaily(env.ALPHA_VANTAGE_KEY, item.ticker, "compact");
    budgetRemaining--;

    if (priceOutcome.kind === "rate_limited") {
      await logFetch(env, { ticker: item.ticker, output_size: priceRequestKind, status: "rate_limited", message: priceOutcome.message });
      summary.rateLimited = true;
      summary.details.push({ ticker: item.ticker, requestKind: priceRequestKind, status: "rate_limited", message: priceOutcome.message });
      break;
    }
    if (priceOutcome.kind === "premium_gated") {
      await logFetch(env, { ticker: item.ticker, output_size: priceRequestKind, status: "error", message: `PREMIUM_GATED: ${priceOutcome.message}` });
      summary.errors++;
      summary.premiumGated = true;
      summary.details.push({ ticker: item.ticker, requestKind: priceRequestKind, status: "premium_gated", message: priceOutcome.message });
      break;
    }
    if (priceOutcome.kind !== "ok") {
      await logFetch(env, { ticker: item.ticker, output_size: priceRequestKind, status: "error", message: priceOutcome.message });
      summary.errors++;
      summary.details.push({ ticker: item.ticker, requestKind: priceRequestKind, status: priceOutcome.kind, message: priceOutcome.message });
      continue; // no price data to adjust; move on to the next ticker
    }

    const rows = priceOutcome.rows.map((r) => ({ ...r, ticker: item.ticker }));
    const upserted = await upsertPrices(env, rows);
    await logFetch(env, { ticker: item.ticker, output_size: priceRequestKind, status: "ok", rows_upserted: upserted });
    summary.ok++;
    summary.details.push({ ticker: item.ticker, requestKind: priceRequestKind, status: "ok", rows: upserted });

    let stopAfterThisItem = false;
    if (item.needsSplitsRefresh) {
      await spaceOut();
      summary.attempted++;
      const splitsOutcome = await fetchSplits(env.ALPHA_VANTAGE_KEY, item.ticker);
      budgetRemaining--;

      if (splitsOutcome.kind === "ok") {
        await replaceSplits(env, item.ticker, splitsOutcome.splits);
        await logFetch(env, { ticker: item.ticker, output_size: "splits", status: "ok", rows_upserted: splitsOutcome.splits.length });
        summary.details.push({ ticker: item.ticker, requestKind: "splits", status: "ok", rows: splitsOutcome.splits.length });
      } else if (splitsOutcome.kind === "rate_limited") {
        await logFetch(env, { ticker: item.ticker, output_size: "splits", status: "rate_limited", message: splitsOutcome.message });
        summary.rateLimited = true;
        summary.details.push({ ticker: item.ticker, requestKind: "splits", status: "rate_limited", message: splitsOutcome.message });
        stopAfterThisItem = true;
      } else if (splitsOutcome.kind === "premium_gated") {
        await logFetch(env, { ticker: item.ticker, output_size: "splits", status: "error", message: `PREMIUM_GATED: ${splitsOutcome.message}` });
        summary.errors++;
        summary.premiumGated = true;
        summary.details.push({ ticker: item.ticker, requestKind: "splits", status: "premium_gated", message: splitsOutcome.message });
        stopAfterThisItem = true;
      } else {
        await logFetch(env, { ticker: item.ticker, output_size: "splits", status: "error", message: splitsOutcome.message });
        summary.errors++;
        summary.details.push({ ticker: item.ticker, requestKind: "splits", status: splitsOutcome.kind, message: splitsOutcome.message });
        // fall through: recompute with whatever splits we already had stored
      }
    }

    // Recompute adjusted_close from raw close + currently-known splits,
    // whether or not splits were refreshed this run.
    await applySplitAdjustment(env, item.ticker);

    if (stopAfterThisItem) break;
  }

  return summary;
}
