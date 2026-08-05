// Daily price-update job. Triggered by the Cron Trigger (wrangler.toml,
// 22:00 UTC) via the `scheduled` handler in index.ts, and callable manually
// via POST /api/admin/run-update for local testing.
//
// Rate-limit strategy (Alpha Vantage free tier: 5 req/min, 25 req/day):
//  - A ticker with < ~1 trading year of stored history gets 'full'
//    outputsize (fetches the entire available history in ONE request).
//  - A ticker that already has enough history only needs 'compact'
//    (last ~100 days) to catch up — cheap, and self-corrects the last
//    few days in case Alpha Vantage restates adjusted values.
//  - Requests are spaced >12s apart (stays under 5/min) and capped at the
//    remaining daily budget (tracked via fetch_log, see db.ts).
//  - If the watchlist doesn't fully fit into a day's budget, the least
//    recently updated tickers go first, so the fetch cursor naturally
//    "walks" the list across multiple days.

import { fetchDailyAdjusted, sleep, type OutputSize } from "./alphavantage";
import {
  countRequestsToday,
  getPriceRowCount,
  getWatchlist,
  hasFetchedOkToday,
  getLatestPriceDate,
  logFetch,
  upsertPrices,
} from "./db";
import type { Env } from "./types";

const MIN_INTERVAL_MS = 13_000; // > 60s/5 = 12s, small safety margin
const FULL_BACKFILL_ROW_THRESHOLD = 260; // ~1 trading year

export interface UpdateRunSummary {
  budgetAtStart: number;
  attempted: number;
  ok: number;
  errors: number;
  rateLimited: boolean;
  premiumGated: boolean;
  details: Array<{ ticker: string; outputSize: OutputSize; status: string; message?: string; rows?: number }>;
}

interface Candidate {
  ticker: string;
  outputSize: OutputSize;
  latestDate: string | null;
}

export async function runDailyUpdate(env: Env): Promise<UpdateRunSummary> {
  const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 25;
  const alreadyUsed = await countRequestsToday(env);
  const budgetAtStart = Math.max(0, maxPerDay - alreadyUsed);

  const summary: UpdateRunSummary = {
    budgetAtStart,
    attempted: 0,
    ok: 0,
    errors: 0,
    rateLimited: false,
    premiumGated: false,
    details: [],
  };

  if (budgetAtStart <= 0) {
    return summary;
  }

  const watchlist = await getWatchlist(env, { activeOnly: true });

  const candidates: Candidate[] = [];
  for (const entry of watchlist) {
    if (await hasFetchedOkToday(env, entry.ticker)) continue;
    const rowCount = await getPriceRowCount(env, entry.ticker);
    const outputSize: OutputSize = rowCount < FULL_BACKFILL_ROW_THRESHOLD ? "full" : "compact";
    const latestDate = await getLatestPriceDate(env, entry.ticker);
    candidates.push({ ticker: entry.ticker, outputSize, latestDate });
  }

  // Full backfills first (highest value per request), then most-stale
  // incremental updates first.
  candidates.sort((a, b) => {
    if (a.outputSize !== b.outputSize) return a.outputSize === "full" ? -1 : 1;
    const ad = a.latestDate ?? "";
    const bd = b.latestDate ?? "";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });

  const selected = candidates.slice(0, budgetAtStart);

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    if (!item) continue;
    if (i > 0) await sleep(MIN_INTERVAL_MS);

    summary.attempted++;
    const outcome = await fetchDailyAdjusted(env.ALPHA_VANTAGE_KEY, item.ticker, item.outputSize);

    if (outcome.kind === "ok") {
      const rows = outcome.rows.map((r) => ({ ...r, ticker: item.ticker }));
      const upserted = await upsertPrices(env, rows);
      await logFetch(env, {
        ticker: item.ticker,
        output_size: item.outputSize,
        status: "ok",
        rows_upserted: upserted,
      });
      summary.ok++;
      summary.details.push({ ticker: item.ticker, outputSize: item.outputSize, status: "ok", rows: upserted });
      continue;
    }

    if (outcome.kind === "rate_limited") {
      await logFetch(env, {
        ticker: item.ticker,
        output_size: item.outputSize,
        status: "rate_limited",
        message: outcome.message,
      });
      summary.rateLimited = true;
      summary.details.push({ ticker: item.ticker, outputSize: item.outputSize, status: "rate_limited", message: outcome.message });
      // AV signalled we're out of quota — no point continuing this run.
      break;
    }

    if (outcome.kind === "premium_gated") {
      await logFetch(env, {
        ticker: item.ticker,
        output_size: item.outputSize,
        status: "error",
        message: `PREMIUM_GATED: ${outcome.message}`,
      });
      summary.errors++;
      summary.premiumGated = true;
      summary.details.push({ ticker: item.ticker, outputSize: item.outputSize, status: "premium_gated", message: outcome.message });
      // Every other ticker will hit the exact same wall — stop early.
      break;
    }

    // invalid_symbol | error
    await logFetch(env, {
      ticker: item.ticker,
      output_size: item.outputSize,
      status: "error",
      message: outcome.message,
    });
    summary.errors++;
    summary.details.push({ ticker: item.ticker, outputSize: item.outputSize, status: outcome.kind, message: outcome.message });
  }

  return summary;
}
