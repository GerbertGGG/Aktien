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
| **Twelve Data** | Kursdatenquelle (`time_series`, Free Tier — siehe Datenquelle-Abschnitt unten) |

```
src/
  index.ts          Worker-Entry: HTTP-Routing + scheduled()-Handler
  twelvedata.ts      Twelve-Data-Client (Fetch, Fehler-/Rate-Limit-Erkennung)
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
scripts/           Watchlist-Seed + manuell kuratierte Split-Historie
test/              Smoke-Tests der Backtest-/Momentum-/Split-/Datenquellen-Mathematik (`npm test`)
```

## Datenquelle: Twelve Data (und warum nicht Alpha Vantage)

Urspruenglich war [Alpha Vantage](https://www.alphavantage.co/) als
Datenquelle vorgesehen. In der Praxis hat sich das als zu unzuverlaessig fuer
den Free Tier erwiesen:

- `TIME_SERIES_DAILY_ADJUSTED` (split-/dividenden-bereinigt) war fuer den
  Test-Key hinter einen "premium endpoint"-Hinweis gelegt.
- `TIME_SERIES_DAILY` mit `outputsize=full` **ebenfalls** — nur die letzten
  ~100 Tage waren frei, ein Mehrjahres-Backfill war so gar nicht moeglich.
- Selbst nach Umstellung auf einen funktionierenden Endpunkt-Mix kam wiederholt,
  an mehreren Tagen in Folge, direkt beim allerersten Request des Tages eine
  Kontingent-Fehlermeldung zurueck — obwohl das eigene Tracking 0/25
  verbrauchte Requests zeigte. Alpha Vantage bietet fuer kostenlose Keys kein
  Nutzungs-Dashboard, um das von aussen nachzuvollziehen.

Deshalb laeuft das Projekt jetzt auf **[Twelve Data](https://twelvedata.com/)**:
offizielle, dokumentierte REST-API (kein Scraping), Free Tier mit
**800 Requests/Tag, 8 Requests/Minute** (Stand Registrierung — bitte bei
eurem eigenen Account unter https://twelvedata.com/pricing gegenpruefen und
`MAX_REQUESTS_PER_DAY`/`MAX_REQUESTS_PER_MINUTE` in `wrangler.toml`
anpassen, falls abweichend). Genutzt wird `time_series` (`interval=1day`,
unadjusted Tageskurse) — Free Tier dokumentiert bis zu 5000 Kerzen pro
Request, also ~20 Jahre Historie in **einem** Request statt Alpha Vantages
künstlicher 100-Tage-Deckelung.

> **Hinweis zur Verifikation:** Der Twelve-Data-Client (`src/twelvedata.ts`)
> wurde ohne Live-Netzwerkzugriff auf `api.twelvedata.com` gebaut (die
> Sandbox, in der das Projekt entstand, hatte keine Route dorthin) und folgt
> der oeffentlichen Dokumentation so genau wie moeglich. Der `time_series`-Teil
> ist inzwischen live gegen einen echten Key verifiziert (`function=daily`
> liefert korrekte Kursdaten). Bei Abweichungen bitte kurz Bescheid geben,
> das laesst sich schnell anpassen.

**Split-Historie kommt NICHT von einer API.** Twelve Data's `/splits`-Endpunkt
erfordert nachweislich einen bezahlten Plan (Fehlermeldung: "available
exclusively with grow or pro or ultra or venture or enterprise plans");
Alpha Vantages `SPLITS` funktionierte zwar inhaltlich, aber das
Gesamt-Kontingent des Test-Keys war zu unzuverlaessig, um sich darauf zu
verlassen (siehe oben). Da die Watchlist eine feste, kleine Liste sehr
bekannter Aktien ist, pflegt `scripts/seed-splits.sql` die bekannten Splits
stattdessen **manuell** — siehe die Kommentare dort fuer Quellen und
Vertrauens-Einschaetzung pro Eintrag (NVDAs Historie wurde waehrend der
Entwicklung tatsaechlich live gegen Alpha Vantage verifiziert, der Rest
stammt aus Trainingswissen und sollte bei Bedarf gegengeprueft werden). Ein
neuer Split laesst sich jederzeit ohne D1-Konsole eintragen:

```bash
curl -X POST "https://DEIN-WORKER.workers.dev/api/admin/splits" \
  -H "content-type: application/json" \
  -d '{"ticker":"AAPL","effective_date":"2030-01-01","split_factor":4}'
```

Das rechnet `adjusted_close` fuer den betroffenen Ticker sofort neu
(`applySplitAdjustment`, `src/splitAdjustment.ts`: jeder Kurs vor einem Split
wird durch den kumulierten Split-Faktor aller spaeteren Splits geteilt —
Standardmethode, per Unit-Test gegen NVDAs echte 4:1/10:1-Splits verifiziert,
siehe `test/splitAdjustment.smoke.test.ts`).

**Wichtige Einschraenkung:** das ist nur **split-bereinigt, nicht
dividenden-bereinigt**. Fuer die Mega-Cap-Watchlist bedeutet das eine
systematische Unterschaetzung des Total Return um grob 1-2 %/Jahr
(Dividendenrendite), UND zwar gleichermassen fuer Strategie- wie fuer
Benchmark-Ticker, was den relativen Vergleich (CAGR-Differenz) weniger
verzerrt als das absolute CAGR selbst. Momentum-Ranking (12-1-Return) ist
davon nur marginal betroffen, da Dividendenrenditen ueber alle
Watchlist-Ticker hinweg vergleichsweise aehnlich sind — anders als
Aktien-Splits, die ohne Bereinigung wie ein -90 %-Crash aussehen wuerden.

## Setup

### Voraussetzungen

- Node.js 20+, ein Cloudflare-Account, `wrangler` (per `npm install` als
  Dev-Dependency bereits enthalten)
- Ein Twelve-Data-API-Key (kostenlos, Account-Anmeldung noetig):
  https://twelvedata.com/pricing → "Free" → Registrieren → Key im Dashboard
  unter "API Keys" kopieren.

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

### 2. Twelve-Data-Key als Secret einrichten + Response verifizieren

```bash
npx wrangler secret put TWELVE_DATA_KEY
# Key einfuegen wenn danach gefragt wird. NIE im Code oder in wrangler.toml speichern.
```

Nach dem ersten `npm run deploy` (siehe unten) den Key gegen die echte
Twelve-Data-API testen, **ohne** dabei etwas in D1 zu schreiben:

```bash
curl "https://DEIN-WORKER.workers.dev/api/admin/test-fetch?ticker=AAPL&function=daily&outputsize=100"
```

Auf `row_count`/`sample_rows` schauen (sollten plausible Kurse enthalten).
(`?function=splits` funktioniert nur mit einem bezahlten Twelve-Data-Plan —
siehe Abschnitt "Datenquelle" oben, warum Splits stattdessen manuell
gepflegt werden.)

### 3. Watchlist + Split-Historie befuellen

```bash
npm run db:seed:remote
```

Fuehrt sowohl `scripts/seed-watchlist.sql` als auch `scripts/seed-splits.sql`
aus. Vorbelegte Startliste (20 grosse, liquide US-Werte über mehrere
Sektoren gestreut, siehe `scripts/seed-watchlist.sql`) plus SPY als
Benchmark:

AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, JPM, V, UNH, XOM, JNJ, PG, HD, MA,
COST, ABBV, AVGO, KO, WMT — **SPY** ist als `is_benchmark=1` markiert, wird
mit aktualisiert, aber nicht im Screener-Ranking gefuehrt.

> Berkshire Hathaway B wurde bewusst nicht aufgenommen: die
> Ticker-Schreibweise (`BRK.B` / `BRK-B` / `BRK/B`) ist je nach Datenanbieter
> uneinheitlich und liess sich ohne Live-Zugriff nicht verifizieren.
> Watchlist anpassen: `scripts/seed-watchlist.sql` editieren und erneut
> ausfuehren (idempotent dank `INSERT OR IGNORE`), oder direkt per SQL in
> `watchlist` pflegen.

> **Falls ihr Preis-Updates schon VOR diesem Schritt ausgeloest habt**
> (z.B. beim Debuggen): `adjusted_close` wird nur direkt nach einem
> Kurs-Fetch neu berechnet, nicht rueckwirkend, wenn Splits erst spaeter
> eingespielt werden. Symptom im Backtest: unrealistisch hohe Volatilitaet/
> CAGR und ein ploetzlicher Sprung in der Equity-Kurve (typischerweise genau
> am Datum eines nicht bereinigten Splits, z.B. NVDA/AVGO/WMT 2024). Fix:
> einmal `POST /api/admin/recompute-adjustments` aufrufen (Button "Split-
> Bereinigung neu berechnen" im Dashboard) — kostet keinen Twelve-Data-
> Request, rechnet nur aus bereits gespeicherten Rohdaten + der Split-
> Tabelle neu.

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

Das laedt fuer jeden Ticker ohne Historie bis zu 5000 Tageskurse (~20 Jahre,
**1 Request pro neuem Ticker**) — bei 21 Tickern (20 Watchlist + SPY) sind
das 21 Requests, locker innerhalb des 800er-Tagesbudgets, dauert dank 8/Min
auch nur ein paar Minuten. Danach ist sofort mehrjaehrige Historie fuer
Screener und Backtest da (Split-Bereinigung nutzt die in Schritt 3
eingespielte statische Tabelle, keine weiteren Requests noetig). Details
siehe `src/cron.ts`.

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
| `MAX_REQUESTS_PER_DAY` | 800 | Twelve-Data-Tagesbudget (Free Tier, ggf. anpassen) |
| `MAX_REQUESTS_PER_MINUTE` | 8 | Twelve-Data-Minutenbudget (Free Tier, ggf. anpassen) |
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

## Rate-Limiting (Twelve Data Free Tier: 8 Requests/Min, 800/Tag)

`src/cron.ts` haelt sich daran, auf Request- statt Ticker-Ebene budgetiert.
Pro Ticker entscheidet `buildWorkItems()` (D1-Lesezugriffe, keine
Netzwerk-Calls, direkt testbar gegen eine lokale D1-Instanz):

- Noch nie erfolgreich befuellt? -> einmaliger Backfill mit grossem
  `outputsize` (bis zu 5000 Tageskurse) — 1 Request, danach nie wieder.
- Sonst: taeglich ein kleiner `time_series`-Request (~100 Tage, 1 Request) —
  korrigiert nebenbei eventuelle nachtraegliche Kurskorrekturen.
- Nach jedem erfolgreichen Kurs-Fetch wird `adjusted_close` lokal aus
  `close` + der (statischen, manuell gepflegten) Split-Tabelle neu berechnet
  (`applySplitAdjustment`).
- Requests werden mit Abstand gestellt (Default 8s, bleibt unter 8/Min).
- Ein taegliches Budget (`MAX_REQUESTS_PER_DAY`) wird ueber die
  `fetch_log`-Tabelle nachverfolgt; ein Ticker, dessen Kosten nicht mehr ins
  verbleibende Budget passen, wird uebersprungen (nicht der ganze Lauf
  abgebrochen) — ein guenstigerer Ticker weiter hinten in der Liste bekommt
  so noch eine Chance. Am naechsten Tag geht es automatisch weiter.
- Meldet Twelve Data `rate_limited`, bricht der Lauf sofort ab (kein
  sinnloses Weiterprobieren).
- **Concurrent-Run-Schutz:** `runDailyUpdate()` holt sich zu Beginn einen
  Lock (`run_lock`-Tabelle, `migrations/0003_run_lock.sql`, atomares
  `UPDATE ... WHERE`). Laeuft bereits ein anderer Update-Vorgang (z.B.
  Dashboard-Button geklickt waehrend der Cron-Trigger laeuft, oder
  Doppelklick), bricht der zweite Aufruf sofort mit
  `skippedConcurrentRun: true` ab, statt Ticker doppelt abzufragen und das
  Minutenlimit zu sprengen (genau das ist in der Praxis einmal passiert —
  9 Ticker wurden doppelt abgerufen und ein zehnter lief prompt ins
  Rate-Limit). Ein haengengebliebener Lock (z.B. nach einem Absturz) gilt
  nach 10 Minuten automatisch wieder als frei.

## API

| Route | Methode | Zweck |
|---|---|---|
| `/api/screener` | GET | aktuelles 12-1-Momentum-Ranking |
| `/api/watchlist` | GET | Watchlist inkl. Datenstand pro Ticker |
| `/api/backtest/latest` | GET | letztes gespeichertes Backtest-Ergebnis (alle 3 Splits) |
| `/api/backtest/run` | POST | Backtest neu berechnen + speichern (Body: `Partial<BacktestParams>`, optional) |
| `/api/status` | GET | Rate-Limit-Budget, Fetch-Log, Watchlist-Zaehler, letztes Problem |
| `/api/admin/test-fetch` | GET | roher Twelve-Data-Testaufruf, `?function=daily\|splits` (schreibt nichts in D1; `splits` braucht einen bezahlten Plan) |
| `/api/admin/run-update` | POST | Preis-Update manuell ausloesen (= Cron-Logik) |
| `/api/admin/splits` | POST | Split manuell eintragen + `adjusted_close` fuer diesen Ticker sofort neu berechnen (Body: `{ticker, effective_date, split_factor}`) |
| `/api/admin/recompute-adjustments` | POST | `adjusted_close` fuer **alle** Watchlist-Ticker neu berechnen, ohne neue Kursdaten zu holen (kein Twelve-Data-Request) — auch als Button "Split-Bereinigung neu berechnen" im Dashboard. Wichtig, falls Ticker schon befuellt wurden, **bevor** `scripts/seed-splits.sql` eingespielt wurde: die Bereinigung wird sonst nicht rueckwirkend angewendet. |

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
npm test            # Smoke-Tests: Backtest-/Momentum-Mathematik + Split-Bereinigung + Fehlerklassifizierung
```

`npm test` prueft u.a.: korrekte Monats-Arithmetik (inkl. 31-Tage-Monats-
Randfaelle), dass die Engine bei eindeutig ueberlegenem Momentum immer den
richtigen Ticker waehlt, dass Transaktionskosten nur bei tatsaechlichem
Turnover anfallen, dass Benchmark-Equity unabhaengig von der Strategie ist,
Sharpe/CAGR/Max-Drawdown-Formeln gegen geschlossene Loesungen, die
Split-Bereinigung gegen NVDAs echte 4:1/10:1-Splits, dass der
Out-of-Sample-Split die Perioden ueberlappungsfrei aufteilt, und die
Twelve-Data-Fehlerklassifizierung (Rate-Limit vs. Auth vs. ungueltiges
Symbol) gegen das dokumentierte Antwortschema.

## Bewusst nicht gebaut

- Keine automatisierte Order-Ausfuehrung / Broker-Anbindung.
- Kein Scraping von Quellen, die es per robots.txt untersagen —
  ausschliesslich die offizielle, dokumentierte Twelve-Data-API.
- Keine LLM-generierten "Kauf/Verkauf mit Stop-Loss bei X"-Signale.
- Keine automatische Survivorship-Bias-Korrektur (fehlende Datengrundlage im
  Free-Tier-Setup) — stattdessen expliziter Hinweis in UI und API.

## Lizenz / Datenquelle

Kursdaten: [Twelve Data](https://twelvedata.com/) (Free Tier, `time_series`
+ `splits`, lokal split-bereinigt — siehe "Datenquelle"-Abschnitt oben).
Bitte die Nutzungsbedingungen von Twelve Data beachten, insbesondere bei
Weitergabe der Daten.
