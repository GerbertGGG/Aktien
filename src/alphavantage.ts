// Alpha Vantage client.
//
// IMPORTANT / verifiziert am 2026-08-05 mit einem echten Free-Tier-Key:
// TIME_SERIES_DAILY_ADJUSTED ist fuer diesen Key hinter einen "premium
// endpoint"-Hinweis gelegt (siehe premium_gated unten). Der Client faellt
// deshalb standardmaessig auf eine Kombination aus zwei Endpunkten zurueck,
// die auf dem Free Tier bestaetigt funktionieren:
//   - TIME_SERIES_DAILY   (unadjusted Tageskurse)
//   - SPLITS               (offizielle Split-Historie)
// Daraus wird adjusted_close selbst rueckwirkend berechnet (siehe
// applySplitAdjustment in db.ts). Das ist NUR split-, nicht
// dividenden-bereinigt — siehe README fuer die Konsequenzen.
//
// fetchDailyAdjusted() bleibt erhalten (fuer /api/admin/test-fetch und
// falls Alpha Vantage die Sperre fuer euren Key irgendwann aufhebt).

import type { PriceRow } from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

export type OutputSize = "compact" | "full";

export type FetchOutcome =
  | { kind: "ok"; rows: PriceRow[] }
  | { kind: "rate_limited"; message: string }
  | { kind: "premium_gated"; message: string }
  | { kind: "invalid_symbol"; message: string }
  | { kind: "error"; message: string };

export type SplitsOutcome =
  | { kind: "ok"; splits: Array<{ effective_date: string; split_factor: number }> }
  | { kind: "rate_limited"; message: string }
  | { kind: "premium_gated"; message: string }
  | { kind: "invalid_symbol"; message: string }
  | { kind: "error"; message: string };

interface RawDailyPointAdjusted {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. adjusted close": string;
  "6. volume": string;
  "7. dividend amount": string;
  "8. split coefficient": string;
}

interface RawDailyPointUnadjusted {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. volume": string;
}

interface RawTimeSeriesResponse<T> {
  "Meta Data"?: Record<string, string>;
  "Time Series (Daily)"?: Record<string, T>;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

interface RawMonthlyResponse {
  "Meta Data"?: Record<string, string>;
  "Monthly Time Series"?: Record<string, RawDailyPointUnadjusted>;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

interface RawSplitsResponse {
  symbol?: string;
  data?: Array<{ effective_date: string; split_factor: string }>;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Shared classification of Alpha Vantage's error/rate-limit/premium wrapper
 * fields.
 *
 * IMPORTANT: virtually EVERY Alpha Vantage "Note"/"Information" message ends
 * with a "you may subscribe to any of the premium plans..." upsell footer —
 * including plain daily/per-minute rate-limit notices that have nothing to
 * do with a specific endpoint or parameter being feature-gated. An earlier
 * version of this function classified anything containing "premium" as
 * `premium_gated`, which misdiagnosed ordinary quota exhaustion (confirmed
 * 2026-08-08: "our standard API rate limit is 25 requests per day... you may
 * subscribe to premium plans to remove all daily rate limits") as if the
 * endpoint itself were gated. Only messages that explicitly call out a
 * specific feature/parameter/endpoint as premium-only (e.g. "The
 * outputsize=full parameter value is a premium feature", confirmed genuinely
 * gated) are classified as `premium_gated`; everything else that smells like
 * a quota/volume message is `rate_limited`.
 */
export function classifyError(data: {
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}): { kind: "invalid_symbol" | "rate_limited" | "premium_gated"; message: string } | null {
  if (data["Error Message"]) {
    return { kind: "invalid_symbol", message: data["Error Message"] };
  }

  const noteOrInfo = data.Note ?? data.Information;
  if (!noteOrInfo) return null;

  const lower = noteOrInfo.toLowerCase();

  const looksLikeQuota =
    lower.includes("requests per day") ||
    lower.includes("requests per minute") ||
    lower.includes("request per second") ||
    lower.includes("rate limit") ||
    lower.includes("call frequency") ||
    lower.includes("call volume") ||
    lower.includes("spreading out") ||
    lower.includes("detected your api key");

  const looksLikeFeatureGating =
    lower.includes("is a premium feature") ||
    lower.includes("premium endpoint") ||
    lower.includes("premium-only");

  if (looksLikeFeatureGating && !looksLikeQuota) {
    return { kind: "premium_gated", message: noteOrInfo };
  }
  return { kind: "rate_limited", message: noteOrInfo };
}

async function fetchJson<T>(params: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": "momentum-screener-worker (analysis tool, non-trading)" },
    });
  } catch (err) {
    return { ok: false, message: `Netzwerkfehler beim Alpha-Vantage-Request: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status} von Alpha Vantage` };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, message: `Antwort von Alpha Vantage war kein valides JSON: ${String(err)}` };
  }
}

/** TIME_SERIES_DAILY_ADJUSTED — kept for /api/admin/test-fetch and in case the key's access changes. */
export async function fetchDailyAdjusted(apiKey: string, ticker: string, outputSize: OutputSize): Promise<FetchOutcome> {
  const result = await fetchJson<RawTimeSeriesResponse<RawDailyPointAdjusted>>({
    function: "TIME_SERIES_DAILY_ADJUSTED",
    symbol: ticker,
    outputsize: outputSize,
    datatype: "json",
    apikey: apiKey,
  });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyError(result.data);
  if (err) return err;

  const series = result.data["Time Series (Daily)"];
  if (!series) {
    return { kind: "error", message: "Unerwartete Antwortstruktur: kein 'Time Series (Daily)'-Feld vorhanden." };
  }

  const rows: PriceRow[] = Object.entries(series).map(([date, p]) => ({
    ticker,
    date,
    open: num(p["1. open"]),
    high: num(p["2. high"]),
    low: num(p["3. low"]),
    close: num(p["4. close"]),
    adjusted_close: num(p["5. adjusted close"]) ?? num(p["4. close"]) ?? 0,
    volume: p["6. volume"] ? Math.trunc(Number(p["6. volume"])) : null,
    dividend_amount: num(p["7. dividend amount"]),
    split_coefficient: num(p["8. split coefficient"]),
  }));

  return { kind: "ok", rows };
}

/**
 * TIME_SERIES_DAILY (unadjusted) — the free-tier fallback used by default.
 * `adjusted_close` is set equal to `close` here; the caller (db.ts /
 * applySplitAdjustment) overwrites it once splits are known.
 */
export async function fetchDaily(apiKey: string, ticker: string, outputSize: OutputSize): Promise<FetchOutcome> {
  const result = await fetchJson<RawTimeSeriesResponse<RawDailyPointUnadjusted>>({
    function: "TIME_SERIES_DAILY",
    symbol: ticker,
    outputsize: outputSize,
    datatype: "json",
    apikey: apiKey,
  });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyError(result.data);
  if (err) return err;

  const series = result.data["Time Series (Daily)"];
  if (!series) {
    return { kind: "error", message: "Unerwartete Antwortstruktur: kein 'Time Series (Daily)'-Feld vorhanden." };
  }

  const rows: PriceRow[] = Object.entries(series).map(([date, p]) => {
    const close = num(p["4. close"]) ?? 0;
    return {
      ticker,
      date,
      open: num(p["1. open"]),
      high: num(p["2. high"]),
      low: num(p["3. low"]),
      close,
      adjusted_close: close, // placeholder; overwritten by applySplitAdjustment
      volume: p["5. volume"] ? Math.trunc(Number(p["5. volume"])) : null,
      dividend_amount: null,
      split_coefficient: null,
    };
  });

  return { kind: "ok", rows };
}

/**
 * TIME_SERIES_MONTHLY — unadjusted monthly close, ALWAYS full history, and
 * confirmed free-tier accessible (unlike DAILY's outputsize=full, which is
 * premium-gated). Used once per ticker to backfill years of history in a
 * single request; `src/cron.ts` layers daily-compact data on top for the
 * most recent ~100 days. One monthly close per calendar month is exactly
 * what the monthly-rebalancing backtest needs, so no daily granularity is
 * lost where it matters.
 */
export async function fetchMonthly(apiKey: string, ticker: string): Promise<FetchOutcome> {
  const result = await fetchJson<RawMonthlyResponse>({
    function: "TIME_SERIES_MONTHLY",
    symbol: ticker,
    datatype: "json",
    apikey: apiKey,
  });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyError(result.data);
  if (err) return err;

  const series = result.data["Monthly Time Series"];
  if (!series) {
    return { kind: "error", message: "Unerwartete Antwortstruktur: kein 'Monthly Time Series'-Feld vorhanden." };
  }

  const rows: PriceRow[] = Object.entries(series).map(([date, p]) => {
    const close = num(p["4. close"]) ?? 0;
    return {
      ticker,
      date,
      open: num(p["1. open"]),
      high: num(p["2. high"]),
      low: num(p["3. low"]),
      close,
      adjusted_close: close, // placeholder; overwritten by applySplitAdjustment
      volume: p["5. volume"] ? Math.trunc(Number(p["5. volume"])) : null,
      dividend_amount: null,
      split_coefficient: null,
    };
  });

  return { kind: "ok", rows };
}

/** SPLITS — official split history, used to back-adjust the unadjusted daily closes. */
export async function fetchSplits(apiKey: string, ticker: string): Promise<SplitsOutcome> {
  const result = await fetchJson<RawSplitsResponse>({
    function: "SPLITS",
    symbol: ticker,
    apikey: apiKey,
  });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyError(result.data);
  if (err) return err;

  if (!Array.isArray(result.data.data)) {
    return { kind: "error", message: "Unerwartete Antwortstruktur: kein 'data'-Feld vorhanden." };
  }

  const splits = result.data.data
    .map((s) => ({ effective_date: s.effective_date, split_factor: Number(s.split_factor) }))
    .filter((s) => s.effective_date && Number.isFinite(s.split_factor) && s.split_factor > 0);

  return { kind: "ok", splits };
}

/** Simple sleep helper for spacing requests to respect the 5 req/min free-tier limit. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
