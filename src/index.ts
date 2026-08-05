// Worker entry point: HTTP routing (dashboard API) + Cron Trigger handler
// (daily price update). Static dashboard assets (public/) are served
// automatically by the Assets binding for any path that isn't handled here
// (see wrangler.toml [assets]).

import { handleRunUpdate, handleTestFetch, isAuthorized } from "./api/admin";
import { handleBacktestLatest, handleBacktestRun } from "./api/backtest";
import { handleScreener } from "./api/screener";
import { handleStatus } from "./api/status";
import { handleWatchlist } from "./api/watchlist";
import { runDailyUpdate } from "./cron";
import { jsonError } from "./http";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/screener" && request.method === "GET") {
        return await handleScreener(env, url);
      }
      if (pathname === "/api/watchlist" && request.method === "GET") {
        return await handleWatchlist(env);
      }
      if (pathname === "/api/status" && request.method === "GET") {
        return await handleStatus(env);
      }
      if (pathname === "/api/backtest/latest" && request.method === "GET") {
        return await handleBacktestLatest(env);
      }
      if (pathname === "/api/backtest/run" && request.method === "POST") {
        if (!isAuthorized(env, request)) return jsonError("Unauthorized", 401);
        return await handleBacktestRun(env, request);
      }
      if (pathname === "/api/admin/test-fetch" && request.method === "GET") {
        if (!isAuthorized(env, request)) return jsonError("Unauthorized", 401);
        return await handleTestFetch(env, url);
      }
      if (pathname === "/api/admin/run-update" && request.method === "POST") {
        if (!isAuthorized(env, request)) return jsonError("Unauthorized", 401);
        return await handleRunUpdate(env);
      }

      if (pathname.startsWith("/api/")) {
        return jsonError("Not found", 404);
      }

      // Everything else: static dashboard (public/), including SPA fallback.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error("Unhandled error:", err);
      return jsonError(`Interner Fehler: ${String(err)}`, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDailyUpdate(env).then((summary) => {
        console.log("Daily update summary:", JSON.stringify(summary));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
