// Twelve Data client — replaces Alpha Vantage (see README "Datenquelle:
// warum Twelve Data statt Alpha Vantage" for the full story). Alpha
// Vantage's free tier turned out to gate outputsize=full on TIME_SERIES_DAILY
// and repeatedly rate-limited even the very first request of a fresh day,
// several days in a row, with no way for us to inspect or reset the key's
// actual server-side quota state.
//
// NOT YET LIVE-VERIFIED from the environment this was built in (no network
// route to api.twelvedata.com from that sandbox) — field names below follow
// Twelve Data's public documentation as closely as possible, but please run
// the verification step in README "Setup Schritt 2" once you have a key
// (GET /api/admin/test-fetch?provider=twelvedata&function=daily) and share
// the raw response if anything looks off; the parsing here is easy to patch.

import type { PriceRow } from "./types";

const BASE_URL = "https://api.twelvedata.com";

export type FetchOutcome =
  | { kind: "ok"; rows: PriceRow[] }
  | { kind: "rate_limited"; message: string }
  | { kind: "invalid_symbol"; message: string }
  | { kind: "error"; message: string };

export type SplitsOutcome =
  | { kind: "ok"; splits: Array<{ effective_date: string; split_factor: number }> }
  | { kind: "rate_limited"; message: string }
  | { kind: "invalid_symbol"; message: string }
  | { kind: "error"; message: string };

interface RawTimeSeriesValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface RawStatusFields {
  status?: string; // "ok" | "error"
  code?: number; // HTTP-style status embedded in the JSON body, e.g. 429, 401, 400
  message?: string;
}

interface RawTimeSeriesResponse extends RawStatusFields {
  meta?: { symbol?: string; interval?: string };
  values?: RawTimeSeriesValue[];
}

interface RawSplitEntry {
  date?: string;
  split_date?: string;
  from_factor?: number | string;
  to_factor?: number | string;
}

interface RawSplitsResponse extends RawStatusFields {
  symbol?: string;
  splits?: RawSplitEntry[];
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Twelve Data mixes real HTTP status codes with an embedded `status`/`code`
 * field in an otherwise-200 JSON body — check both. Exported for testing.
 */
export function classifyStatus(
  httpStatus: number,
  data: RawStatusFields,
): { kind: "rate_limited" | "invalid_symbol" | "error"; message: string } | null {
  const code = data.code ?? httpStatus;
  const message = data.message ?? `HTTP ${httpStatus} von Twelve Data ohne Detailmeldung.`;

  if (data.status !== "error" && httpStatus < 400) return null;

  if (code === 429) return { kind: "rate_limited", message };
  if (code === 401 || code === 403) return { kind: "error", message: `Auth-Fehler, TWELVE_DATA_KEY pruefen: ${message}` };
  if (code === 400 && /symbol/i.test(message)) return { kind: "invalid_symbol", message };
  return { kind: "error", message };
}

async function fetchJson<T extends RawStatusFields>(
  path: string,
  params: Record<string, string>,
): Promise<{ ok: true; httpStatus: number; data: T } | { ok: false; message: string }> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": "momentum-screener-worker (analysis tool, non-trading)" },
    });
  } catch (err) {
    return { ok: false, message: `Netzwerkfehler beim Twelve-Data-Request: ${String(err)}` };
  }

  try {
    const data = (await res.json()) as T;
    return { ok: true, httpStatus: res.status, data };
  } catch (err) {
    return { ok: false, message: `Antwort war kein valides JSON (HTTP ${res.status}): ${String(err)}` };
  }
}

/** `outputsize`: number of most-recent daily bars, ascending-ordered. Twelve Data documents up to 5000 per request even on the free plan. */
export async function fetchDaily(apiKey: string, ticker: string, outputsize: number): Promise<FetchOutcome> {
  const result = await fetchJson<RawTimeSeriesResponse>("/time_series", {
    symbol: ticker,
    interval: "1day",
    outputsize: String(outputsize),
    order: "ASC",
    apikey: apiKey,
  });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyStatus(result.httpStatus, result.data);
  if (err) return err;

  const values = result.data.values;
  if (!values) {
    return { kind: "error", message: "Unerwartete Antwortstruktur: kein 'values'-Feld vorhanden." };
  }

  const rows: PriceRow[] = values.map((v) => {
    const close = num(v.close) ?? 0;
    return {
      ticker,
      date: v.datetime.slice(0, 10),
      open: num(v.open),
      high: num(v.high),
      low: num(v.low),
      close,
      adjusted_close: close, // placeholder; overwritten by db.applySplitAdjustment
      volume: v.volume ? Math.trunc(Number(v.volume)) : null,
      dividend_amount: null,
      split_coefficient: null,
    };
  });

  return { kind: "ok", rows };
}

/** Official split history, used to back-adjust the unadjusted daily closes (src/splitAdjustment.ts). */
export async function fetchSplits(apiKey: string, ticker: string): Promise<SplitsOutcome> {
  const result = await fetchJson<RawSplitsResponse>("/splits", { symbol: ticker, apikey: apiKey });
  if (!result.ok) return { kind: "error", message: result.message };

  const err = classifyStatus(result.httpStatus, result.data);
  if (err) return err;

  const raw = result.data.splits ?? [];
  const splits = raw
    .map((s) => {
      const date = s.date ?? s.split_date;
      const from = Number(s.from_factor ?? 1);
      const to = Number(s.to_factor ?? 1);
      const factor = from > 0 ? to / from : NaN;
      return date && Number.isFinite(factor) && factor > 0 ? { effective_date: date, split_factor: factor } : null;
    })
    .filter((s): s is { effective_date: string; split_factor: number } => s !== null);

  return { kind: "ok", splits };
}

/** Simple sleep helper for spacing requests to respect the free-tier per-minute limit. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
