// Daily price-update job. Triggered by the Cron Trigger (wrangler.toml,
// 22:00 UTC) via the `scheduled` handler in index.ts, and callable manually
// via POST /api/admin/run-update for local testing.
//
// Data source: Twelve Data (see README "Datenquelle" for why we moved off
// Alpha Vantage). Twelve Data's `time_series` endpoint documents up to 5000
// bars per request even on the free plan, so — unlike Alpha Vantage, where
// only the last ~100 days were free and a full-history request was
// premium-only — a single request can backfill years of daily history.
//
// Per-ticker strategy:
//   - One-time (gated by hasEverFetchedOk 'daily_full', not a row-count
//     heuristic): TIME_SERIES daily with a large outputsize (years of
//     history) + SPLITS — 2 requests, never repeated.
//   - Every day after: a small daily outputsize (~100 bars) — 1 request —
//     to catch up and self-correct recent data; SPLITS is only re-checked
//     every ~30 days (splits are rare).
//
// Rate-limit strategy (Twelve Data free tier: 8 req/min, 800 req/day — see
// README for how to confirm/adjust these against your own account):
// every individual HTTP request is spaced apart and counted against the
// daily budget; items that don't fit the remaining budget this run are
// skipped (not aborted) so a cheaper item further down the list still gets
// a chance, and are retried on a later run/day, prioritizing backfills and
// then the most stale tickers.

import { fetchDaily, fetchSplits, sleep } from "./twelvedata";
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

const MIN_INTERVAL_MS = 8_000; // 60s / 8req-per-min = 7.5s, small safety margin
const SPLITS_REFRESH_DAYS = 30; // splits are rare; no need to re-check daily
const BACKFILL_OUTPUTSIZE = 5000; // Twelve Data max per request; ~20 years of daily bars
const INCREMENTAL_OUTPUTSIZE = 100; // last ~100 trading days, cheap daily catch-up

export interface UpdateRunSummary {
  budgetAtStart: number;
  attempted: number;
  ok: number;
  errors: number;
  rateLimited: boolean;
  details: Array<{ ticker: string; requestKind: "daily_full" | "daily_compact" | "splits"; status: string; message?: string; rows?: number }>;
}

export interface WorkItem {
  ticker: string;
  needsFullBackfill: boolean;
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
 * (full backfill? splits refresh?) and its request cost, sorted with
 * backfills first, then most-stale-first. Pure D1 reads, no network calls —
 * kept separate from the fetch/write loop below so it can be exercised
 * directly against a real local D1 instance without needing to mock fetch().
 */
export async function buildWorkItems(env: Env): Promise<WorkItem[]> {
  const watchlist = await getWatchlist(env, { activeOnly: true });

  const items: WorkItem[] = [];
  for (const entry of watchlist) {
    if (await hasFetchedOkToday(env, entry.ticker)) continue;
    const needsFullBackfill = !(await hasEverFetchedOk(env, entry.ticker, "daily_full"));
    const lastSplitsFetch = await getLastSplitsFetchAt(env, entry.ticker);
    const needsSplitsRefresh = needsFullBackfill || lastSplitsFetch === null || isOlderThanDays(lastSplitsFetch, SPLITS_REFRESH_DAYS);
    const latestDate = await getLatestPriceDate(env, entry.ticker);
    items.push({
      ticker: entry.ticker,
      needsFullBackfill,
      needsSplitsRefresh,
      cost: 1 + (needsSplitsRefresh ? 1 : 0),
      latestDate,
    });
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
  const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 800;
  const alreadyUsed = await countRequestsToday(env);
  let budgetRemaining = Math.max(0, maxPerDay - alreadyUsed);

  const summary: UpdateRunSummary = {
    budgetAtStart: budgetRemaining,
    attempted: 0,
    ok: 0,
    errors: 0,
    rateLimited: false,
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

    const priceRequestKind: "daily_full" | "daily_compact" = item.needsFullBackfill ? "daily_full" : "daily_compact";

    await spaceOut();
    summary.attempted++;
    const priceOutcome = await fetchDaily(
      env.TWELVE_DATA_KEY,
      item.ticker,
      item.needsFullBackfill ? BACKFILL_OUTPUTSIZE : INCREMENTAL_OUTPUTSIZE,
    );
    budgetRemaining--;

    if (priceOutcome.kind === "rate_limited") {
      await logFetch(env, { ticker: item.ticker, output_size: priceRequestKind, status: "rate_limited", message: priceOutcome.message });
      summary.rateLimited = true;
      summary.details.push({ ticker: item.ticker, requestKind: priceRequestKind, status: "rate_limited", message: priceOutcome.message });
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
      const splitsOutcome = await fetchSplits(env.TWELVE_DATA_KEY, item.ticker);
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
