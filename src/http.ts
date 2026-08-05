// Tiny response helpers to avoid repeating JSON boilerplate across routes.

export const DISCLAIMER =
  "Analyse-Tool, keine Anlageberatung. Kein Kauf-/Verkaufssignal, keine automatisierte " +
  "Order-Ausfuehrung. Historische Ergebnisse (Backtest) sind keine Garantie fuer " +
  "zukuenftige Wertentwicklung.";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

export function jsonError(message: string, status = 400): Response {
  return json({ error: message }, { status });
}
