-- Split-Historie pro Ticker, von Alpha Vantage's SPLITS-Endpoint.
--
-- Hintergrund: TIME_SERIES_DAILY_ADJUSTED ist fuer manche Free-Tier-Keys
-- hinter einen "premium endpoint"-Hinweis gelegt (siehe README). Als
-- Fallback holt der Cron-Job unadjusted Tageskurse (TIME_SERIES_DAILY) plus
-- die offizielle Split-Historie (SPLITS, auf dem Free Tier bestaetigt
-- funktionsfaehig) und berechnet adjusted_close selbst rueckwirkend
-- (prices.close / kumulierter Split-Faktor aller spaeteren Splits).
--
-- Wichtig: das ist NUR split-bereinigt, NICHT dividenden-bereinigt (im
-- Gegensatz zu Alpha Vantage's eigenem TIME_SERIES_DAILY_ADJUSTED). Fuer
-- Mega-Cap-Dividendenzahler ein kleinerer, aber realer Unterschied
-- (~1-2 %/Jahr Total-Return-Untererfassung) — siehe README.

CREATE TABLE IF NOT EXISTS splits (
  ticker         TEXT NOT NULL,
  effective_date TEXT NOT NULL,   -- ISO yyyy-mm-dd, Tag an dem der Split wirksam wird
  split_factor   REAL NOT NULL,   -- z.B. 10.0 fuer einen 10:1-Split
  fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, effective_date)
);
