-- NICHT MEHR VERWENDET (seit 2026-08-10) — nicht mehr Teil von `npm run
-- db:seed:*`. Live verifiziert: Twelve Data's `time_series` liefert die
-- Kurse bereits split-bereinigt (NVDAs gespeicherter close am 2024-06-07,
-- dem letzten Handelstag vor dem 10:1-Split, war 120.888 — exakt der echte
-- Schlusskurs von $1208.88 geteilt durch 10). Diese Tabelle hier auf
-- adjusted_close anzuwenden wuerde also DOPPELT bereinigen (siehe
-- src/cron.ts, src/db.ts resetAdjustedCloseToRaw fuer die Story). Datei
-- bleibt nur als Referenz/fuer den Fall stehen, dass ein kuenftiger
-- Datenanbieter tatsaechlich unadjusted Kurse liefert.
--
-- Manuell kuratierte Split-Historie fuer die Watchlist-Ticker.
--
-- Hintergrund: sowohl Alpha Vantage (SPLITS) als auch Twelve Data (/splits)
-- wurden fuer dieses Projekt getestet — Alpha Vantage lieferte Splits zwar
-- korrekt, aber das Gesamt-Kontingent des Keys war wiederholt unzuverlaessig
-- erschoepft; Twelve Data's /splits-Endpunkt erfordert nachweislich einen
-- bezahlten Plan (bestaetigte Fehlermeldung: "available exclusively with
-- grow or pro or ultra or venture or enterprise plans"). Da die Watchlist
-- eine feste, kleine Liste sehr bekannter Aktien ist, ist eine manuell
-- gepflegte Tabelle hier pragmatischer als eine dritte kostenlose API zu
-- suchen, die denselben Endpunkt frei anbietet.
--
-- WICHTIG: Diese Daten stammen aus dem Trainingswissen von Claude, NICHT
-- aus einem live abgefragten Datenanbieter (Ausnahme: NVDA, dessen
-- Split-Historie waehrend der Entwicklung tatsaechlich live gegen Alpha
-- Vantages SPLITS-Endpunkt verifiziert wurde und exakt mit den hier
-- eingetragenen Werten uebereinstimmt). Vor produktivem Vertrauen in
-- Backtest-Ergebnisse fuer Ticker mit grossen Splits (v.a. AVGO, WMT, MA,
-- GOOGL, AMZN) bitte gegen eine zuverlaessige Quelle gegenpruefen, z.B.
-- die Investor-Relations-Seite des jeweiligen Unternehmens oder
-- https://www.marketbeat.com/stocks/<TICKER>/stock-splits/ .
--
-- Ticker OHNE Eintrag hier bedeutet: entweder nie gesplittet (z.B. META, V,
-- SPY) oder schlicht nicht mit ausreichender Sicherheit bekannt (z.B. JPM,
-- UNH, XOM, JNJ, PG, HD, COST, ABBV) — in beiden Faellen bleibt
-- adjusted_close = close (unbereinigt) fuer diese Ticker. Bei neuen Splits
-- in der Zukunft: Zeile hier ergaenzen und dieses Skript erneut ausfuehren
-- (idempotent dank INSERT OR IGNORE), oder direkt per SQL in `splits`
-- pflegen — applySplitAdjustment() rechnet beim naechsten Preis-Update
-- automatisch neu.

INSERT OR IGNORE INTO splits (ticker, effective_date, split_factor) VALUES
  -- AAPL
  ('AAPL', '2020-08-31', 4.0),
  ('AAPL', '2014-06-09', 7.0),
  -- GOOGL (Alphabet)
  ('GOOGL', '2022-07-18', 20.0),
  -- AMZN
  ('AMZN', '2022-06-06', 20.0),
  -- NVDA (live gegen Alpha Vantage SPLITS verifiziert, siehe Kommentar oben)
  ('NVDA', '2024-06-10', 10.0),
  ('NVDA', '2021-07-20', 4.0),
  ('NVDA', '2007-09-11', 1.5),
  ('NVDA', '2006-04-07', 2.0),
  ('NVDA', '2001-09-17', 2.0),
  ('NVDA', '2000-06-27', 2.0),
  -- TSLA
  ('TSLA', '2022-08-25', 3.0),
  ('TSLA', '2020-08-31', 5.0),
  -- MA (Mastercard)
  ('MA', '2014-01-22', 10.0),
  -- AVGO (Broadcom)
  ('AVGO', '2024-07-15', 10.0),
  -- KO (Coca-Cola)
  ('KO', '2012-08-13', 2.0),
  -- WMT (Walmart)
  ('WMT', '2024-02-26', 3.0),
  -- MSFT (aeltester Split, ausserhalb der ueblichen ~20-Jahre-Backfill-Historie,
  -- aber schadet nicht, falls doch relevant)
  ('MSFT', '2003-02-18', 2.0);
