// Daily price-update job. Triggered by the Cron Trigger (wrangler.toml,
// 22:00 UTC) via the `scheduled` handler in index.ts, and callable manually
// via POST /api/admin/run-update for local testing.
//
// Data source (verified 2026-08-05 against a real free-tier key):
// TIME_SERIES_DAILY_ADJUSTED is premium-gated for this key, so the default
// path combines two endpoints that DO work on the free tier:
//   - TIME_SERIES_DAILY (unadjusted daily close)
//   - SPLITS             (official split history)
// and computes `adjusted_close` locally (db.applySplitAdjustment). This is
// split-adjustment only, not dividend-adjustment — see README.
//
// Rate-limit strategy (Alpha Vantage free tier: 5 req/min, 25 req/day):
//  - A ticker with < ~1 trading year of stored history gets a 'full' daily
//    fetch (entire available history in one request) plus its full split
//    history (2 requests total for a brand-new ticker).
//  - A ticker with enough history only needs a 'compact' daily fetch (last
//    ~100 days, 1 request) most days; its split history is only re-checked
//    every ~30 days (splits are rare), adding a 2nd request on those days.
//  - Every individual HTTP request (daily OR splits) is spaced >12s apart
//    (stays under 5/min) and counted against the daily budget — items that
//    don't fit the remaining budget this run are skipped and retried on a
//    later run/day, prioritizing backfills and then the most stale tickers.

import { fetchDaily, fetchSplits, sleep } from "./alphavantage";
import {
  applySplitAdjustment,
  countRequestsToday,
  getLastSplitsFetchAt,
  getLatestPriceDate,
  getPriceRowCount,
  getWatchlist,
  hasFetchedOkToday,
  logFetch,
  replaceSplits,
  upsertPrices,
} from "./db";
import type { Env } from "./types";

const MIN_INTERVAL_MS = 13_000; // > 60s/5 = 12s, small safety margin
const FULL_BACKFILL_ROW_THRESHOLD = 260; // ~1 trading year
const SPLITS_REFRESH_DAYS = 30; // splits are rare; no need to re-check daily

export interface UpdateRunSummary {
  budgetAtStart: number;
  attempted: number;
  ok: number;
  errors: number;
  rateLimited: boolean;
  premiumGated: boolean;
  details: Array<{ ticker: string; requestKind: "full" | "compact" | "splits"; status: string; message?: string; rows?: number }>;
}

interface WorkItem {
  ticker: string;
  needsBackfill: boolean;
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

  const watchlist = await getWatchlist(env, { activeOnly: true });

  const items: WorkItem[] = [];
  for (const entry of watchlist) {
    if (await hasFetchedOkToday(env, entry.ticker)) continue;
    const rowCount = await getPriceRowCount(env, entry.ticker);
    const needsBackfill = rowCount < FULL_BACKFILL_ROW_THRESHOLD;
    const lastSplitsFetch = await getLastSplitsFetchAt(env, entry.ticker);
    const needsSplitsRefresh = needsBackfill || lastSplitsFetch === null || isOlderThanDays(lastSplitsFetch, SPLITS_REFRESH_DAYS);
    const latestDate = await getLatestPriceDate(env, entry.ticker);
    items.push({
      ticker: entry.ticker,
      needsBackfill,
      needsSplitsRefresh,
      cost: 1 + (needsSplitsRefresh ? 1 : 0),
      latestDate,
    });
  }

  // Backfills first (highest value per request), then most-stale incremental
  // updates first.
  items.sort((a, b) => {
    if (a.needsBackfill !== b.needsBackfill) return a.needsBackfill ? -1 : 1;
    const ad = a.latestDate ?? "";
    const bd = b.latestDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  let firstRequest = true;
  const spaceOut = async () => {
    if (!firstRequest) await sleep(MIN_INTERVAL_MS);
    firstRequest = false;
  };

  for (const item of items) {
    // Skip (not "stop") items that don't fit the remaining budget this run —
    // a cheaper item further down the list might still fit.
    if (budgetRemaining < item.cost) continue;

    const dailyOutputSize = item.needsBackfill ? "full" : "compact";

    await spaceOut();
    summary.attempted++;
    const dailyOutcome = await fetchDaily(env.ALPHA_VANTAGE_KEY, item.ticker, dailyOutputSize);
    budgetRemaining--;

    if (dailyOutcome.kind === "rate_limited") {
      await logFetch(env, { ticker: item.ticker, output_size: dailyOutputSize, status: "rate_limited", message: dailyOutcome.message });
      summary.rateLimited = true;
      summary.details.push({ ticker: item.ticker, requestKind: dailyOutputSize, status: "rate_limited", message: dailyOutcome.message });
      break;
    }
    if (dailyOutcome.kind === "premium_gated") {
      await logFetch(env, { ticker: item.ticker, output_size: dailyOutputSize, status: "error", message: `PREMIUM_GATED: ${dailyOutcome.message}` });
      summary.errors++;
      summary.premiumGated = true;
      summary.details.push({ ticker: item.ticker, requestKind: dailyOutputSize, status: "premium_gated", message: dailyOutcome.message });
      break;
    }
    if (dailyOutcome.kind !== "ok") {
      await logFetch(env, { ticker: item.ticker, output_size: dailyOutputSize, status: "error", message: dailyOutcome.message });
      summary.errors++;
      summary.details.push({ ticker: item.ticker, requestKind: dailyOutputSize, status: dailyOutcome.kind, message: dailyOutcome.message });
      continue; // no price data to adjust; move on to the next ticker
    }

    const rows = dailyOutcome.rows.map((r) => ({ ...r, ticker: item.ticker }));
    const upserted = await upsertPrices(env, rows);
    await logFetch(env, { ticker: item.ticker, output_size: dailyOutputSize, status: "ok", rows_upserted: upserted });
    summary.ok++;
    summary.details.push({ ticker: item.ticker, requestKind: dailyOutputSize, status: "ok", rows: upserted });

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
