# Momentum-Screener mit Backtest

Analyse-Tool auf Cloudflare Workers + D1: sammelt taeglich Kursdaten fuer eine
feste Watchlist, rankt sie nach dem klassischen **12-1-Momentum-Faktor** und
backtestet dieses Signal historisch gegen einen Buy-&-Hold-Benchmark (SPY).

> **Kein Anlageberatung.** Das Tool gibt keine Kauf-/Verkaufsempfehlungen aus
> und fuehrt keine Orders aus. Es ist ein Entscheidungs-Hilfsmittel, keine
> automatisierte Anlageberatung. Historische Backtest-Ergebnisse sind keine
> Garantie fuer zukuenftige Wertentwicklung.

## Architektur

| Baustein | Zweck |
|---|---|
| **Cloudflare Worker** (`src/`) | HTTP-API + Cron-Handler (TypeScript) |
| **D1 (SQLite)** | Watchlist, Kursdaten, Backtest-Ergebnisse |
| **Cron Trigger** | taegliches Preis-Update, 22:00 UTC |
| **Worker Static Assets** (`public/`) | Dashboard (Vanilla HTML/CSS/JS, keine externen Abhaengigkeiten) |
| **Alpha Vantage** | Kursdatenquelle (`TIME_SERIES_DAILY_ADJUSTED`, Free Tier) |

```
src/
  index.ts        Worker-Entry: HTTP-Routing + scheduled()-Handler
  alphavantage.ts  Alpha-Vantage-Client (Fetch, Fehler-/Rate-Limit-Erkennung)
  cron.ts          Tages-Update-Logik (Backfill + Rate-Limit-Budget)
  db.ts            Alle D1-Zugriffe (Lesen/Schreiben) an einem Ort
  dates.ts         Kalender-Arithmetik (Monats-Offsets, Monatsende)
  priceIndex.ts    Binaersuche "Kurs am/vor Datum X" pro Ticker
  momentum.ts      12-1-Momentum-Formel (pure function)
  screener.ts       Live-Ranking der Watchlist
  stats.ts         CAGR / Sharpe / Max Drawdown / Volatilitaet (pure functions)
  backtest.ts      Backtest-Engine (Rebalancing, Kosten, Out-of-Sample-Split)
  api/*.ts         HTTP-Handler pro Route
public/            Dashboard (index.html, app.js, style.css)
migrations/        D1-Schema
scripts/           Watchlist-Seed
test/              Smoke-Test der Backtest-/Momentum-Mathematik (`npm test`)
```

## Setup

### Voraussetzungen

- Node.js 20+, ein Cloudflare-Account, `wrangler` (per `npm install` als
  Dev-Dependency bereits enthalten)
- Ein Alpha-Vantage-API-Key (kostenlos): https://www.alphavantage.co/support/#api-key

```bash
npm install
npx wrangler login
```

### 1. D1-Datenbank anlegen + Schema migrieren

```bash
npm run db:create
# -> Ausgabe enthaelt "database_id": "xxxxxxxx-...". Diese ID in wrangler.toml
#    unter [[d1_databases]] -> database_id eintragen (ersetzt den Platzhalter
#    REPLACE_WITH_D1_DATABASE_ID).

npm run db:migrate:remote     # Schema auf die echte D1-Instanz anwenden
npm run db:migrate:local      # optional: fuer lokale Entwicklung (wrangler dev)
```

### 2. Alpha-Vantage-Key als Secret einrichten + Response verifizieren

```bash
npx wrangler secret put ALPHA_VANTAGE_KEY
# Key einfuegen wenn danach gefragt wird. NIE im Code oder in wrangler.toml speichern.
```

Nach dem ersten `npm run deploy` (siehe unten) den Key gegen die echte
Alpha-Vantage-API testen, **ohne** dabei etwas in D1 zu schreiben:

```bash
curl "https://DEIN-WORKER.workers.dev/api/admin/test-fetch?ticker=AAPL&outputsize=compact"
```

**Wichtig, bitte hier wirklich pruefen:** Alpha Vantage hat die
`*_ADJUSTED`-Endpunkte (inkl. `TIME_SERIES_DAILY_ADJUSTED`, den dieses Projekt
fuer split-/dividenden-bereinigte Kurse braucht) zeitweise auch fuer
Free-Tier-Keys hinter einen "premium endpoint"-Hinweis gelegt. Der obige
Test-Call zeigt das sofort: Antwort `"kind": "premium_gated"` bedeutet, euer
Key liefert keine adjusted-Daten. In dem Fall:
- Prueft auf https://www.alphavantage.co/premium/, ob der Free Tier aktuell
  noch adjusted-Daten enthaelt (aendert sich laut Community-Berichten
  gelegentlich),
- oder stellt den Client auf den unadjusted Endpoint `TIME_SERIES_DAILY` um
  (Anpassung in `src/alphavantage.ts` + `src/cron.ts`) — dann fehlt aber die
  Split-/Dividenden-Bereinigung, was Backtest-Ergebnisse rund um
  Aktien-Splits verzerrt (klare Sprünge im Kurs, die keine echte Kursbewegung
  sind).

Der Status-Endpoint (`/api/status`, auch im Dashboard sichtbar) zeigt eine
Warnung, sobald der Cron-Job einen `premium_gated`-Fehler geloggt hat.

### 3. Watchlist befuellen

```bash
npm run db:seed:remote
```

Vorbelegte Startliste (20 grosse, liquide US-Werte über mehrere Sektoren
gestreut, siehe `scripts/seed-watchlist.sql`) plus SPY als Benchmark:

AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, JPM, V, UNH, XOM, JNJ, PG, HD, MA,
COST, ABBV, AVGO, KO, WMT — **SPY** ist als `is_benchmark=1` markiert, wird
mit aktualisiert, aber nicht im Screener-Ranking gefuehrt.

> Berkshire Hathaway B wurde bewusst nicht aufgenommen: die
> Ticker-Schreibweise (`BRK.B` / `BRK-B` / `BRK/B`) ist je nach Datenanbieter
> uneinheitlich und liess sich ohne Live-Zugriff auf Alpha Vantage nicht
> verifizieren. Watchlist anpassen: `scripts/seed-watchlist.sql` editieren
> und erneut ausfuehren (idempotent dank `INSERT OR IGNORE`), oder direkt per
> SQL in `watchlist` pflegen. Maximal ~24 aktive Ticker (+SPY), sonst reicht
> das taegliche Rate-Limit-Budget nicht mehr fuer ein vollstaendiges Update
> (siehe unten).

### 4. Deploy

```bash
npm run deploy
```

Das deployt den Worker inkl. Cron Trigger (22:00 UTC) und Dashboard
(Static Assets aus `public/`).

### 5. Erstes Preis-Update anstossen

Der Cron-Job laeuft erst um 22:00 UTC automatisch. Fuer einen sofortigen
ersten Backfill:

```bash
curl -X POST "https://DEIN-WORKER.workers.dev/api/admin/run-update"
```

Das laedt fuer jeden Ticker ohne Historie die komplette verfuegbare
Kurshistorie (`outputsize=full`, ein Request pro Ticker) — bei 21 Tickern
(20 Watchlist + SPY) passt das in ein einzelnes Tagesbudget von 25
Requests, dauert wegen der Drosselung auf 5 Requests/Minute aber ca. 4-5
Minuten. Details siehe `src/cron.ts`.

### 6. Backtest berechnen

```bash
curl -X POST "https://DEIN-WORKER.workers.dev/api/backtest/run" -d '{}'
```

(Oder Button "Backtest neu berechnen" im Dashboard.) Braucht mindestens
~13 Monate Kurshistorie (12 Monate Lookback + 1 Monat Skip) fuer den ersten
Rebalancing-Termin.

### Optional: Admin-Routen absichern

`/api/admin/*` und `POST /api/backtest/run` sind standardmaessig offen
(einfacher Einzelnutzer-Deploy). Um sie zu schuetzen:

```bash
npx wrangler secret put ADMIN_TOKEN
```

Danach muss jeder Request an diese Routen den Header `x-admin-token: <token>`
mitschicken (das Dashboard hat dafuer ein Eingabefeld).

## Konfiguration

Alle Strategie-Defaults liegen in `wrangler.toml` unter `[vars]` und sind pro
Backtest-Lauf per `POST /api/backtest/run`-Body ueberschreibbar:

| Parameter | Default | Bedeutung |
|---|---|---|
| `DEFAULT_TOP_N` | 5 | Anzahl gehaltener Aktien pro Rebalancing |
| `DEFAULT_LOOKBACK_MONTHS` | 12 | Momentum-Lookback |
| `DEFAULT_SKIP_MONTHS` | 1 | ausgeschlossener juengster Monat (Short-Term-Reversal) |
| `DEFAULT_TX_COST_BPS` | 10 (= 0,10 %) | Transaktionskosten pro gehandeltem Anteil Turnover |
| `DEFAULT_RISK_FREE_RATE` | 0,04 (4 % p.a.) | fuer Sharpe Ratio, entspricht grob aktuellem US-3M-T-Bill-Niveau |
| `DEFAULT_OOS_SPLIT` | 0,7 | Anteil der Rebalancing-Perioden als "In-Sample" |
| `MAX_REQUESTS_PER_DAY` | 25 | Alpha-Vantage-Tagesbudget (Free Tier) |
| `BENCHMARK_TICKER` | SPY | Fallback, falls kein `is_benchmark=1`-Eintrag in `watchlist` existiert |

## Wichtige methodische Hinweise

- **Kein Kaufsignal.** `/api/screener` liefert explizit ein *Ranking nach
  historischem 12-1-Momentum*, keine Kauf-/Verkaufsempfehlung — so auch im
  Dashboard beschriftet.
- **Survivorship Bias.** Die Watchlist enthaelt nur heute existierende
  Aktien. Historische Backtest-Ergebnisse koennen dadurch optimistisch
  verzerrt sein (Aktien, die im Zeitraum insolvent gingen/delisted wurden,
  fehlen). Wird im Dashboard und in jeder Backtest-API-Antwort als
  `survivorship_bias_note` mitgeliefert. Eine echte Korrektur würde
  historische Index-Mitgliedschaftsdaten voraussetzen, die im Free-Tier-Setup
  nicht verfuegbar sind.
- **Kein Overfitting-Theater.** Alle drei Backtest-Segmente (`full`,
  `in_sample`, `out_of_sample`) laufen mit **identischen, fest hinterlegten**
  Parametern — es findet keine Parameteroptimierung auf dem Datensatz statt,
  der auch zur "Validierung" dient. Der Split dient nur der Konsistenzpruefung
  ("haelt die Strategie auch in den letzten 30 % noch, was sie in den ersten
  70 % gezeigt hat?").
- **Transaktionskosten** werden ueber das Turnover berechnet: Summe der
  absoluten Gewichtsaenderungen ueber alle Ticker bei jedem Rebalancing,
  multipliziert mit `tx_cost_bps`. Ein Ticker, der ununterbrochen gehalten
  wird, verursacht nach dem initialen Kauf keine weiteren Kosten.
- **Punkt-in-Zeit-Korrektheit:** Jede Rangfolge-Entscheidung zum Zeitpunkt T
  verwendet ausschliesslich Kursdaten mit Datum <= T (kein Lookahead) —
  sowohl im Live-Screener als auch in jeder einzelnen Rebalancing-Periode des
  Backtests.

## Rate-Limiting (Alpha Vantage Free Tier: 5 Requests/Min, 25/Tag)

`src/cron.ts` haelt sich daran:
- Tickers ohne (ausreichende) Historie bekommen einmalig `outputsize=full`
  (komplette Historie in einem Request).
- Tickers mit ausreichender Historie bekommen taeglich nur `outputsize=compact`
  (letzte ~100 Tage) — korrigiert nebenbei eventuelle nachtraegliche
  Kurskorrekturen von Alpha Vantage.
- Requests werden mit >12 Sekunden Abstand gestellt (bleibt unter 5/Min).
- Ein taegliches Budget (`MAX_REQUESTS_PER_DAY`, Default 25) wird ueber die
  `fetch_log`-Tabelle nachverfolgt; reicht das Budget nicht fuer alle
  faelligen Ticker, werden die am laengsten nicht aktualisierten zuerst
  bedient — der Rest folgt am naechsten Tag automatisch.
- Meldet Alpha Vantage `rate_limited`, bricht der Lauf sofort ab (kein
  sinnloses Weiterprobieren).

## API

| Route | Methode | Zweck |
|---|---|---|
| `/api/screener` | GET | aktuelles 12-1-Momentum-Ranking |
| `/api/watchlist` | GET | Watchlist inkl. Datenstand pro Ticker |
| `/api/backtest/latest` | GET | letztes gespeichertes Backtest-Ergebnis (alle 3 Splits) |
| `/api/backtest/run` | POST | Backtest neu berechnen + speichern (Body: `Partial<BacktestParams>`, optional) |
| `/api/status` | GET | Rate-Limit-Budget, Fetch-Log, Watchlist-Zaehler |
| `/api/admin/test-fetch` | GET | roher Alpha-Vantage-Testaufruf (schreibt nichts in D1) |
| `/api/admin/run-update` | POST | Preis-Update manuell ausloesen (= Cron-Logik) |

## Lokale Entwicklung

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev              # startet wrangler dev mit lokaler D1-Instanz
```

`wrangler dev` triggert den Cron-Handler nicht automatisch; manuell testen
via `curl http://localhost:8787/api/admin/run-update` (POST) oder
`curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # Smoke-Test der Backtest-/Momentum-Mathematik (synthetische Kursreihen)
```

`npm test` prueft u.a.: korrekte Monats-Arithmetik (inkl. 31-Tage-Monats-
Randfaelle), dass die Engine bei eindeutig ueberlegenem Momentum immer den
richtigen Ticker waehlt, dass Transaktionskosten nur bei tatsaechlichem
Turnover anfallen, dass Benchmark-Equity unabhaengig von der Strategie ist,
Sharpe/CAGR/Max-Drawdown-Formeln gegen geschlossene Loesungen, und dass der
Out-of-Sample-Split die Perioden ueberlappungsfrei aufteilt.

## Bewusst nicht gebaut

- Keine automatisierte Order-Ausfuehrung / Broker-Anbindung.
- Kein Scraping von Quellen, die es per robots.txt untersagen — ausschliesslich
  die offizielle, dokumentierte Alpha-Vantage-API.
- Keine LLM-generierten "Kauf/Verkauf mit Stop-Loss bei X"-Signale.
- Keine automatische Survivorship-Bias-Korrektur (fehlende Datengrundlage im
  Free-Tier-Setup) — stattdessen expliziter Hinweis in UI und API.

## Lizenz / Datenquelle

Kursdaten: [Alpha Vantage](https://www.alphavantage.co/) (Free Tier,
`TIME_SERIES_DAILY_ADJUSTED`). Bitte die Nutzungsbedingungen von Alpha
Vantage beachten, insbesondere bei Weitergabe der Daten.
