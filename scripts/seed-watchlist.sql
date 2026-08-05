-- Startliste: 20 grosse, liquide US-Werte ueber verschiedene Sektoren
-- gestreut, plus SPY als Benchmark (is_benchmark = 1, wird nicht im
-- Screener-Ranking gefuehrt, aber fuer den Backtest-Vergleich abgerufen).
--
-- Hinweis: Berkshire Hathaway B wurde bewusst NICHT aufgenommen, da dessen
-- Ticker-Schreibweise je nach Datenanbieter variiert (BRK.B / BRK-B / BRK/B)
-- und Alpha Vantage's Symbol-Konvention ohne Live-Test nicht sicher zu
-- verifizieren war. WMT (Walmart) schliesst stattdessen die Konsumgueter-
-- /Retail-Abdeckung.
--
-- Anpassbar: einfach Zeilen hinzufuegen/entfernen und dieses Skript erneut
-- ausfuehren (INSERT OR IGNORE ist idempotent).

INSERT OR IGNORE INTO watchlist (ticker, name, is_benchmark, active) VALUES
  ('AAPL', 'Apple Inc.', 0, 1),
  ('MSFT', 'Microsoft Corp.', 0, 1),
  ('GOOGL', 'Alphabet Inc. Class A', 0, 1),
  ('AMZN', 'Amazon.com Inc.', 0, 1),
  ('NVDA', 'NVIDIA Corp.', 0, 1),
  ('META', 'Meta Platforms Inc.', 0, 1),
  ('TSLA', 'Tesla Inc.', 0, 1),
  ('JPM', 'JPMorgan Chase & Co.', 0, 1),
  ('V', 'Visa Inc.', 0, 1),
  ('UNH', 'UnitedHealth Group Inc.', 0, 1),
  ('XOM', 'Exxon Mobil Corp.', 0, 1),
  ('JNJ', 'Johnson & Johnson', 0, 1),
  ('PG', 'Procter & Gamble Co.', 0, 1),
  ('HD', 'Home Depot Inc.', 0, 1),
  ('MA', 'Mastercard Inc.', 0, 1),
  ('COST', 'Costco Wholesale Corp.', 0, 1),
  ('ABBV', 'AbbVie Inc.', 0, 1),
  ('AVGO', 'Broadcom Inc.', 0, 1),
  ('KO', 'Coca-Cola Co.', 0, 1),
  ('WMT', 'Walmart Inc.', 0, 1),
  ('SPY', 'SPDR S&P 500 ETF Trust (Benchmark)', 1, 1);
