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
| **Alpha Vantage** | Kursdatenquelle (`TIME_SERIES_DAILY` + `SPLITS`, Free Tier — siehe Datenquelle-Abschnitt unten) |

```
src/
  index.ts          Worker-Entry: HTTP-Routing + scheduled()-Handler
  alphavantage.ts    Alpha-Vantage-Client (Fetch, Fehler-/Rate-Limit-Erkennung)
  cron.ts            Tages-Update-Logik (Backfill + Rate-Limit-Budget)
  db.ts              Alle D1-Zugriffe (Lesen/Schreiben) an einem Ort
  dates.ts           Kalender-Arithmetik (Monats-Offsets, Monatsende)
  priceIndex.ts      Binaersuche "Kurs am/vor Datum X" pro Ticker
  momentum.ts        12-1-Momentum-Formel (pure function)
  splitAdjustment.ts Split-Bereinigung aus rohen Kursen + Split-Historie (pure function)
  screener.ts        Live-Ranking der Watchlist
  stats.ts           CAGR / Sharpe / Max Drawdown / Volatilitaet (pure functions)
  backtest.ts        Backtest-Engine (Rebalancing, Kosten, Out-of-Sample-Split)
  api/*.ts           HTTP-Handler pro Route
public/            Dashboard (index.html, app.js, style.css)
migrations/        D1-Schema
scripts/           Watchlist-Seed
test/              Smoke-Tests der Backtest-/Momentum-/Split-Mathematik (`npm test`)
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
curl "https://DEIN-WORKER.workers.dev/api/admin/test-fetch?ticker=AAPL&function=daily&outputsize=compact"
curl "https://DEIN-WORKER.workers.dev/api/admin/test-fetch?ticker=NVDA&function=splits"
```

**Bekannte Einschraenkung, bereits eingebaut:** Alpha Vantage legt den
Endpunkt `TIME_SERIES_DAILY_ADJUSTED` (split-/dividenden-bereinigte Kurse in
einem Request) fuer manche Free-Tier-Keys hinter einen "premium
endpoint"-Hinweis — verifiziert am 2026-08-05 mit einem echten Key. Deshalb
nutzt der Cron-Job standardmaessig **nicht** diesen Endpunkt, sondern eine
Kombination aus zwei bestaetigt frei zugaenglichen Endpunkten:

- `TIME_SERIES_DAILY` — unadjusted Tageskurse
- `SPLITS` — offizielle Split-Historie pro Ticker

Daraus berechnet der Worker `adjusted_close` selbst rueckwirkend
(`src/splitAdjustment.ts`: jeder Kurs vor einem Split wird durch den
kumulierten Split-Faktor aller spaeteren Splits geteilt — Standardmethode,
per Unit-Test gegen NVDAs echte 4:1/10:1-Splits verifiziert). **Wichtige
Einschraenkung:** das ist nur **split-bereinigt, nicht dividenden-bereinigt**
— im Gegensatz zu `TIME_SERIES_DAILY_ADJUSTED`. Fuer die Mega-Cap-Watchlist
bedeutet das eine systematische Unterschaetzung des Total Return um grob
1-2 %/Jahr (Dividendenrendite), UND zwar gleichermassen fuer Strategie- wie
fuer Benchmark-Ticker, was den relativen Vergleich (CAGR-Differenz) weniger
verzerrt als das absolute CAGR selbst. Momentum-Ranking (12-1-Return) ist
davon nur marginal betroffen, da Dividendenrenditen ueber alle Watchlist-
Ticker hinweg vergleichsweise aehnlich sind — anders als Aktien-Splits, die
ohne Bereinigung wie ein -90 %-Crash aussehen wuerden.

Falls Alpha Vantage die Sperre fuer euren Key irgendwann aufhebt: mit
`function=adjusted` im Test-Call pruefen; `fetchDailyAdjusted()` in
`src/alphavantage.ts` ist weiterhin vorhanden, wird vom Cron-Job aber aktuell
nicht mehr automatisch genutzt (muesste in `src/cron.ts` wieder verdrahtet
werden).

Der Status-Endpoint (`/api/status`, auch im Dashboard als Banner sichtbar)
zeigt permanent den aktiven `data_mode` sowie eine zusaetzliche Warnung,
sobald der Cron-Job einen `premium_gated`-Fehler loggt (z.B. falls auch
`TIME_SERIES_DAILY` oder `SPLITS` fuer einen anderen Key gesperrt sein
sollte).

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
Kurshistorie plus dessen Split-Historie (`outputsize=full` + `SPLITS`, **2
Requests pro neuem Ticker**) — bei 21 Tickern (20 Watchlist + SPY) sind das
42 Requests, was das Tagesbudget von 25 ueberschreitet. Der Cron-Job bedient
die wertvollsten Posten zuerst (Backfills vor Updates) und macht am
naechsten Tag automatisch weiter, wo er aufgehoert hat — der vollstaendige
Erst-Backfill dauert also **~2 Tage**. Details siehe `src/cron.ts`.

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

`src/cron.ts` haelt sich daran, jetzt auf Request- statt Ticker-Ebene
budgetiert (jeder Ticker kostet 1 oder 2 Requests, siehe oben):
- Tickers ohne (ausreichende) Historie bekommen einmalig `TIME_SERIES_DAILY`
  mit `outputsize=full` (komplette Historie) **plus** die volle
  `SPLITS`-Historie — 2 Requests.
- Tickers mit ausreichender Historie bekommen taeglich nur
  `outputsize=compact` (letzte ~100 Tage, 1 Request) — korrigiert nebenbei
  eventuelle nachtraegliche Kurskorrekturen von Alpha Vantage. Ihre
  Split-Historie wird nur alle ~30 Tage neu abgefragt (Splits sind selten),
  an diesen Tagen kostet der Ticker dann ebenfalls 2 Requests.
- Nach jedem erfolgreichen Kurs-Fetch wird `adjusted_close` lokal aus
  `close` + der zuletzt bekannten Split-Historie neu berechnet
  (`applySplitAdjustment`) — auch an Tagen ohne Splits-Refresh.
- Requests werden mit >12 Sekunden Abstand gestellt (bleibt unter 5/Min).
- Ein taegliches Budget (`MAX_REQUESTS_PER_DAY`, Default 25) wird ueber die
  `fetch_log`-Tabelle nachverfolgt; ein Ticker, dessen Kosten nicht mehr ins
  verbleibende Budget passen, wird uebersprungen (nicht der ganze Lauf
  abgebrochen) — ein guenstigerer Ticker weiter hinten in der Liste bekommt
  so noch eine Chance. Am naechsten Tag geht es automatisch weiter.
- Meldet Alpha Vantage `rate_limited` oder `premium_gated`, bricht der Lauf
  sofort ab (kein sinnloses Weiterprobieren).

## API

| Route | Methode | Zweck |
|---|---|---|
| `/api/screener` | GET | aktuelles 12-1-Momentum-Ranking |
| `/api/watchlist` | GET | Watchlist inkl. Datenstand pro Ticker |
| `/api/backtest/latest` | GET | letztes gespeichertes Backtest-Ergebnis (alle 3 Splits) |
| `/api/backtest/run` | POST | Backtest neu berechnen + speichern (Body: `Partial<BacktestParams>`, optional) |
| `/api/status` | GET | Rate-Limit-Budget, Fetch-Log, Watchlist-Zaehler |
| `/api/admin/test-fetch` | GET | roher Alpha-Vantage-Testaufruf, `?function=daily\|splits\|adjusted` (schreibt nichts in D1) |
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
npm test            # Smoke-Tests: Backtest-/Momentum-Mathematik + Split-Bereinigung
```

`npm test` prueft u.a.: korrekte Monats-Arithmetik (inkl. 31-Tage-Monats-
Randfaelle), dass die Engine bei eindeutig ueberlegenem Momentum immer den
richtigen Ticker waehlt, dass Transaktionskosten nur bei tatsaechlichem
Turnover anfallen, dass Benchmark-Equity unabhaengig von der Strategie ist,
Sharpe/CAGR/Max-Drawdown-Formeln gegen geschlossene Loesungen, die
Split-Bereinigung gegen NVDAs echte 4:1/10:1-Splits (live per
`/api/admin/test-fetch?function=splits` verifiziert), und dass der
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
`TIME_SERIES_DAILY` + `SPLITS`, lokal split-bereinigt — siehe "Setup Schritt
2" fuer den Hintergrund). Bitte die Nutzungsbedingungen von Alpha Vantage
beachten, insbesondere bei Weitergabe der Daten.
