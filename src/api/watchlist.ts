import { getLatestPriceDate, getPriceRowCount, getWatchlist } from "../db";
import { json } from "../http";
import type { Env } from "../types";

export async function handleWatchlist(env: Env): Promise<Response> {
  const entries = await getWatchlist(env);
  const withStats = await Promise.all(
    entries.map(async (e) => ({
      ...e,
      latest_price_date: await getLatestPriceDate(env, e.ticker),
      price_rows: await getPriceRowCount(env, e.ticker),
    })),
  );
  return json({ watchlist: withStats });
}
