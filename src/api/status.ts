import { countRequestsToday, getRecentFetchLog, getWatchlist } from "../db";
import { json } from "../http";
import type { Env } from "../types";

export async function handleStatus(env: Env): Promise<Response> {
  const [watchlist, recentLog, usedToday] = await Promise.all([
    getWatchlist(env),
    getRecentFetchLog(env, 40),
    countRequestsToday(env),
  ]);

  const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 800;
  const log = recentLog as Array<Record<string, unknown>>;
  const mostRecent = log[0];
  const recentProblem =
    mostRecent && (mostRecent.status === "rate_limited" || mostRecent.status === "error")
      ? { status: mostRecent.status, ticker: mostRecent.ticker, message: mostRecent.message, fetched_at: mostRecent.fetched_at }
      : null;

  return json({
    watchlist_count: watchlist.length,
    active_count: watchlist.filter((w) => w.active === 1).length,
    requests_used_today: usedToday,
    requests_budget_per_day: maxPerDay,
    requests_remaining_today: Math.max(0, maxPerDay - usedToday),
    data_mode:
      "split_adjusted_only: Kurse von Twelve Data (unadjusted TIME_SERIES daily) + SPLITS, adjusted_close selbst rueckwirkend berechnet. NICHT dividenden-bereinigt.",
    recent_problem: recentProblem,
    recent_fetch_log: recentLog,
  });
}
