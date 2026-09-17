// TimeTree ICS Exporter — talks to /api/timetree/login and /api/timetree/export.
// Keeps the TimeTree session id only in memory (this variable), never in
// localStorage/cookies, and never sends it anywhere but back to this same
// Worker.

const state = { sessionId: null, calendars: [], adminToken: "" };

function el(id) {
  return document.getElementById(id);
}

async function login() {
  const email = el("tt-email").value.trim();
  const password = el("tt-password").value;
  const adminToken = el("tt-admin-token").value.trim();
  const statusEl = el("login-status");
  const btn = el("login-btn");

  if (!email || !password) {
    statusEl.textContent = "E-Mail und Passwort ausfuellen.";
    return;
  }

  statusEl.textContent = "Melde an...";
  btn.disabled = true;
  try {
    const res = await fetch("/api/timetree/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(adminToken ? { "x-admin-token": adminToken } : {}),
      },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    state.sessionId = data.session_id;
    state.calendars = data.calendars;
    state.adminToken = adminToken;

    renderCalendars();
    el("export-section").hidden = false;
    statusEl.textContent = `Angemeldet. ${data.calendars.length} Kalender gefunden.`;
  } catch (err) {
    statusEl.textContent = `Fehler: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderCalendars() {
  const list = el("calendar-list");
  list.innerHTML = "";
  state.calendars.forEach((cal, i) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "calendar";
    input.value = String(cal.id);
    if (i === 0) input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${cal.name}`));
    list.appendChild(label);
  });
}

async function exportIcs() {
  const statusEl = el("export-status");
  const btn = el("export-btn");
  const selected = document.querySelector('input[name="calendar"]:checked');
  if (!selected) {
    statusEl.textContent = "Kalender waehlen.";
    return;
  }
  const calendar = state.calendars.find((c) => String(c.id) === selected.value);

  statusEl.textContent = "Exportiere...";
  btn.disabled = true;
  try {
    const res = await fetch("/api/timetree/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(state.adminToken ? { "x-admin-token": state.adminToken } : {}),
      },
      body: JSON.stringify({
        session_id: state.sessionId,
        calendar_id: calendar.id,
        calendar_name: calendar.name,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${calendar.name.replace(/[^\w-]+/g, "_")}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    statusEl.textContent = "Fertig, Download gestartet.";
  } catch (err) {
    statusEl.textContent = `Fehler: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

el("login-btn").addEventListener("click", login);
el("export-btn").addEventListener("click", exportIcs);
