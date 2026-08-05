// Alpha Vantage client for TIME_SERIES_DAILY_ADJUSTED.
//
// IMPORTANT / bitte beim Setup verifizieren (siehe README "Setup Schritt 2"
// und GET /api/admin/test-fetch): Alpha Vantage hat die *_ADJUSTED-Endpunkte
// zeitweise hinter einen "premium"-Hinweis gelegt, auch fuer Free-Tier-Keys.
// Ob euer Key adjusted-Daten liefert, laesst sich nur mit einem echten Key
// pruefen (dieses Sandbox-Environment hat keinen Netzwerkzugriff auf
// alphavantage.co). Der Client erkennt diesen Fall (isPremiumGated) und
// meldet ihn explizit, statt still falsche Daten zu verarbeiten.

import type { PriceRow } from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

export type OutputSize = "compact" | "full";

export type FetchOutcome =
  | { kind: "ok"; rows: PriceRow[] }
  | { kind: "rate_limited"; message: string }
  | { kind: "premium_gated"; message: string }
  | { kind: "invalid_symbol"; message: string }
  | { kind: "error"; message: string };

interface RawDailyPoint {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. adjusted close": string;
  "6. volume": string;
  "7. dividend amount": string;
  "8. split coefficient": string;
}

interface RawResponse {
  "Meta Data"?: Record<string, string>;
  "Time Series (Daily)"?: Record<string, RawDailyPoint>;
  "Error Message"?: string;
  Note?: string;
  Information?: string;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchDailyAdjusted(
  apiKey: string,
  ticker: string,
  outputSize: OutputSize,
): Promise<FetchOutcome> {
  const url = new URL(BASE_URL);
  url.searchParams.set("function", "TIME_SERIES_DAILY_ADJUSTED");
  url.searchParams.set("symbol", ticker);
  url.searchParams.set("outputsize", outputSize);
  url.searchParams.set("datatype", "json");
  url.searchParams.set("apikey", apiKey);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { "User-Agent": "momentum-screener-worker (analysis tool, non-trading)" },
    });
  } catch (err) {
    return { kind: "error", message: `Netzwerkfehler beim Alpha-Vantage-Request: ${String(err)}` };
  }

  if (!res.ok) {
    return { kind: "error", message: `HTTP ${res.status} von Alpha Vantage fuer ${ticker}` };
  }

  let data: RawResponse;
  try {
    data = (await res.json()) as RawResponse;
  } catch (err) {
    return { kind: "error", message: `Antwort von Alpha Vantage war kein valides JSON: ${String(err)}` };
  }

  if (data["Error Message"]) {
    return { kind: "invalid_symbol", message: data["Error Message"] };
  }

  // Free-tier rate limit hit (classic wording: "Note").
  if (data.Note) {
    return { kind: "rate_limited", message: data.Note };
  }

  // Newer Alpha Vantage responses use "Information" both for rate limits
  // *and* for "this is a premium endpoint" notices — disambiguate by text.
  if (data.Information) {
    const lower = data.Information.toLowerCase();
    if (lower.includes("premium")) {
      return { kind: "premium_gated", message: data.Information };
    }
    return { kind: "rate_limited", message: data.Information };
  }

  const series = data["Time Series (Daily)"];
  if (!series) {
    return {
      kind: "error",
      message: "Unerwartete Antwortstruktur: kein 'Time Series (Daily)'-Feld vorhanden.",
    };
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

/** Simple sleep helper for spacing requests to respect the 5 req/min free-tier limit. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
