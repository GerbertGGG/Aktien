import { countRequestsToday, getRecentFetchLog, getWatchlist } from "../db";
import { json } from "../http";
import type { Env } from "../types";

export async function handleStatus(env: Env): Promise<Response> {
  const [watchlist, recentLog, usedToday] = await Promise.all([
    getWatchlist(env),
    getRecentFetchLog(env, 40),
    countRequestsToday(env),
  ]);

  const maxPerDay = Number(env.MAX_REQUESTS_PER_DAY) || 25;
  const premiumGatedRecently = (recentLog as Array<Record<string, unknown>>).some(
    (r) => typeof r.message === "string" && r.message.includes("PREMIUM_GATED"),
  );

  return json({
    watchlist_count: watchlist.length,
    active_count: watchlist.filter((w) => w.active === 1).length,
    requests_used_today: usedToday,
    requests_budget_per_day: maxPerDay,
    requests_remaining_today: Math.max(0, maxPerDay - usedToday),
    data_mode:
      "split_adjusted_only: Kurse via TIME_SERIES_DAILY (unadjusted) + SPLITS, adjusted_close selbst rueckwirkend berechnet. NICHT dividenden-bereinigt (TIME_SERIES_DAILY_ADJUSTED ist fuer diesen Key premium-gated, siehe README).",
    premium_gated_warning: premiumGatedRecently
      ? "Alpha Vantage hat kuerzlich einen 'premium endpoint'-Hinweis zurueckgegeben (siehe recent_fetch_log). Betroffenen Request pruefen."
      : null,
    recent_fetch_log: recentLog,
  });
}
