// Vanilla JS dashboard controller — no build step, no external dependencies
// (keeps the Worker's static assets self-contained).

const state = {
  backtest: null, // last /api/backtest/latest or /api/backtest/run response
  activeSplit: "full",
};

function $(id) {
  return document.getElementById(id);
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function pct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return `${(x * 100).toFixed(digits)}%`;
}

function pctClass(x) {
  if (x === null || x === undefined) return "";
  return x >= 0 ? "pos" : "neg";
}

function num(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  return x.toFixed(digits);
}

function adminHeaders() {
  const token = $("admin-token").value.trim();
  return token ? { "x-admin-token": token } : {};
}

// ---------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------

async function loadScreener() {
  const body = $("screener-body");
  try {
    const data = await fetchJSON("/api/screener");
    $("screener-hint").textContent =
      `${data.label_note} Stand: ${data.as_of_date ?? "–"} ` +
      `(Lookback ${data.lookback_months}M, letzter Monat ausgeschlossen).`;

    if (!data.ranked || data.ranked.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="muted">Noch keine Daten. Preis-Update ausloesen.</td></tr>';
      return;
    }

    const topTickers = new Set((data.top || []).map((t) => t.ticker));
    body.innerHTML = data.ranked
      .map((r, i) => {
        const isTop = topTickers.has(r.ticker);
        const rank = r.status === "ok" ? i + 1 - data.ranked.slice(0, i).filter((x) => x.status !== "ok").length : "–";
        return `<tr class="${isTop ? "top-rank" : ""}">
          <td>${r.status === "ok" ? rank : "–"}</td>
          <td>${r.ticker}</td>
          <td class="${pctClass(r.momentum_12_1)}">${r.status === "ok" ? pct(r.momentum_12_1) : "–"}</td>
          <td>${r.price_t_minus_1m !== null ? num(r.price_t_minus_1m) : "–"}</td>
          <td>${r.price_t_minus_12m !== null ? num(r.price_t_minus_12m) : "–"}</td>
          <td class="muted">${r.status === "ok" ? "ok" : "zu wenig Historie"}</td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="neg">Fehler: ${String(err.message || err)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------
// Auffaellige Kursbewegungen
// ---------------------------------------------------------------------

async function loadUnusualMoves() {
  const body = $("unusual-moves-body");
  try {
    const data = await fetchJSON("/api/unusual-moves");
    $("unusual-moves-hint").textContent = `${data.disclaimer} Stand: ${data.as_of_date ?? "–"}.`;

    if (!data.notable || data.notable.length === 0) {
      body.innerHTML = '<p class="hint">Keine auffaelligen Bewegungen heute.</p>';
      return;
    }

    body.innerHTML =
      '<div class="unusual-move-list">' +
      data.notable
        .map(
          (m) =>
            `<div class="unusual-move-item">
              <span class="ticker">${m.ticker}</span>
              <span class="${pctClass(m.daily_return)}">${pct(m.daily_return)}</span>
              <span class="label">${m.label}</span>
            </div>`,
        )
        .join("") +
      "</div>";
  } catch (err) {
    body.innerHTML = `<p class="neg">Fehler: ${String(err.message || err)}</p>`;
  }
}

// ---------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------

async function loadBacktest() {
  try {
    const data = await fetchJSON("/api/backtest/latest");
    if (data.survivorship_bias_note) {
      $("survivorship-text").textContent = data.survivorship_bias_note;
    }
    if (!data.computed) {
      $("backtest-status").textContent = data.message || "Noch kein Backtest vorhanden.";
      return;
    }
    state.backtest = data.runs;
    renderSplit(state.activeSplit);
  } catch (err) {
    $("backtest-status").textContent = `Fehler: ${String(err.message || err)}`;
  }
}

function renderSplit(splitKey) {
  state.activeSplit = splitKey;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.split === splitKey);
  });

  const run = state.backtest && state.backtest[splitKey];
  if (!run) {
    $("backtest-meta").textContent = "Fuer diesen Zeitraum liegt noch kein Ergebnis vor.";
    drawEquityChart([]);
    return;
  }

  $("kpi-cagr-strategy").textContent = pct(run.cagr);
  $("kpi-cagr-strategy").className = `value ${pctClass(run.cagr)}`;
  $("kpi-cagr-benchmark").textContent = pct(run.benchmark_cagr);
  $("kpi-cagr-benchmark").className = `value ${pctClass(run.benchmark_cagr)}`;

  $("kpi-sharpe-strategy").textContent = num(run.sharpe);
  $("kpi-sharpe-benchmark").textContent = num(run.benchmark_sharpe);

  $("kpi-mdd-strategy").textContent = pct(run.max_drawdown);
  $("kpi-mdd-strategy").className = "value neg";
  $("kpi-mdd-benchmark").textContent = pct(run.benchmark_max_drawdown);
  $("kpi-mdd-benchmark").className = "value neg";

  $("kpi-vol-strategy").textContent = pct(run.volatility);
  $("kpi-vol-benchmark").textContent = pct(run.benchmark_volatility);

  const n = run.n_rebalances ?? (run.equity_curve ? run.equity_curve.length - 1 : 0);
  const topN = run.params ? run.params.top_n : "?";
  $("backtest-meta").textContent =
    `Zeitraum: ${run.start_date ?? "–"} bis ${run.end_date ?? "–"} · ${n} monatliche Rebalancing-Perioden · Top-${topN}.`;

  drawEquityChart(run.equity_curve || []);
}

function drawEquityChart(curve) {
  const svg = $("equity-chart");
  const W = 900;
  const H = 320;
  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 24;

  if (!curve || curve.length < 2) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="currentColor" opacity="0.5" font-size="14">Keine Equity-Kurve verfuegbar</text>';
    return;
  }

  const allValues = curve.flatMap((p) => [p.strategy_equity, p.benchmark_equity]);
  const minV = Math.min(...allValues, 1);
  const maxV = Math.max(...allValues, 1);
  const range = maxV - minV || 1;

  const x = (i) => padL + (i / (curve.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - minV) / range) * (H - padT - padB);

  const strategyPath = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.strategy_equity).toFixed(1)}`).join(" ");
  const benchmarkPath = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.benchmark_equity).toFixed(1)}`).join(" ");

  const gridLines = [];
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = minV + (range * s) / steps;
    const yy = y(v).toFixed(1);
    gridLines.push(
      `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="currentColor" stroke-opacity="0.12" />` +
        `<text x="${padL - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="currentColor" opacity="0.6">${v.toFixed(2)}</text>`,
    );
  }

  const firstDate = curve[0].date;
  const lastDate = curve[curve.length - 1].date;

  svg.innerHTML = `
    ${gridLines.join("")}
    <path d="${benchmarkPath}" fill="none" stroke="var(--benchmark-line, #8b93a1)" stroke-width="2" />
    <path d="${strategyPath}" fill="none" stroke="var(--strategy-line, #2456e6)" stroke-width="2.2" />
    <text x="${padL}" y="${H - 4}" font-size="11" fill="currentColor" opacity="0.6">${firstDate}</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="11" fill="currentColor" opacity="0.6">${lastDate}</text>
  `;
}

async function runBacktestNow() {
  const btn = $("run-backtest-btn");
  btn.disabled = true;
  $("backtest-status").textContent = "Berechne...";
  try {
    const data = await fetchJSON("/api/backtest/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...adminHeaders() },
      body: "{}",
    });
    state.backtest = data.runs;
    renderSplit(state.activeSplit);
    $("backtest-status").textContent = "Fertig.";
  } catch (err) {
    $("backtest-status").textContent = `Fehler: ${String(err.message || err)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Status / Admin
// ---------------------------------------------------------------------

async function loadStatus() {
  try {
    const data = await fetchJSON("/api/status");
    $("status-summary").textContent =
      `Watchlist: ${data.active_count}/${data.watchlist_count} aktiv · ` +
      `Twelve-Data-Budget heute: ${data.requests_used_today}/${data.requests_budget_per_day} verbraucht ` +
      `(${data.requests_remaining_today} verbleibend).`;

    const modeEl = $("data-mode-banner");
    if (data.recent_problem) {
      const p = data.recent_problem;
      modeEl.textContent = `${data.data_mode} Letztes Problem (${p.ticker}, ${p.status}, ${p.fetched_at}): ${p.message}`;
      modeEl.classList.add("alert");
    } else if (data.data_mode) {
      modeEl.textContent = data.data_mode;
      modeEl.classList.remove("alert");
    } else {
      modeEl.textContent = "";
      modeEl.style.display = "none";
    }

    $("fetch-log").textContent = JSON.stringify(data.recent_fetch_log, null, 2);
  } catch (err) {
    $("status-summary").textContent = `Fehler: ${String(err.message || err)}`;
  }
}

async function runUpdateNow() {
  const btn = $("run-update-btn");
  btn.disabled = true;
  $("update-status").textContent = "Update laeuft (kann wegen Rate-Limit einige Minuten dauern)...";
  try {
    const data = await fetchJSON("/api/admin/run-update", {
      method: "POST",
      headers: { ...adminHeaders() },
    });
    if (data.skippedConcurrentRun) {
      $("update-status").textContent = "Es laeuft bereits ein anderes Preis-Update — bitte kurz warten und nicht mehrfach klicken.";
    } else {
      $("update-status").textContent = `Fertig: ${data.ok} ok, ${data.errors} Fehler, ${data.attempted} versucht.`;
    }
    await loadStatus();
    await loadScreener();
  } catch (err) {
    $("update-status").textContent = `Fehler: ${String(err.message || err)}`;
  } finally {
    btn.disabled = false;
  }
}

async function recomputeAdjustmentsNow() {
  const btn = $("recompute-btn");
  btn.disabled = true;
  $("update-status").textContent = "Adjusted-Close wird zurueckgesetzt...";
  try {
    const data = await fetchJSON("/api/admin/reset-adjusted-close", {
      method: "POST",
      headers: { ...adminHeaders() },
    });
    $("update-status").textContent = `Fertig: ${data.tickers_processed} Ticker zurueckgesetzt.`;
    await loadScreener();
  } catch (err) {
    $("update-status").textContent = `Fehler: ${String(err.message || err)}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => renderSplit(btn.dataset.split));
});
$("run-backtest-btn").addEventListener("click", runBacktestNow);
$("run-update-btn").addEventListener("click", runUpdateNow);
$("recompute-btn").addEventListener("click", recomputeAdjustmentsNow);

loadScreener();
loadUnusualMoves();
loadBacktest();
loadStatus();
