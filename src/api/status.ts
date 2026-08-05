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
    premium_gated_warning: premiumGatedRecently
      ? "Alpha Vantage hat kuerzlich einen 'premium endpoint'-Hinweis fuer TIME_SERIES_DAILY_ADJUSTED zurueckgegeben. Bitte pruefen, ob euer Free-Tier-Key adjusted-Daten liefert (siehe README)."
      : null,
    recent_fetch_log: recentLog,
  });
}
