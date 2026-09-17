// Unofficial TimeTree export: login + calendar/event fetch + ICS conversion.
//
// TimeTree has no public API for personal calendar export. This talks to the
// same private endpoints TimeTree's own web app (timetreeapp.com) uses.
// Verified against the open-source reference implementation
// https://github.com/eoleedi/TimeTree-Exporter (Python) — in particular the
// login call must be PUT (not POST) to /api/v1/auth/email/signin with an
// "X-Timetreea" header, or TimeTree's gateway rejects it before it even
// reaches real auth logic (generic {"error":{"code":-401,...}}), which is
// the failure this route previously hit.
//
// Credentials are forwarded 1:1 to timetreeapp.com and never written to D1
// or logged. The resulting TimeTree session id is handed back to the
// browser and passed back in on the export call — this Worker keeps no
// server-side session store.

import { json, jsonError } from "../http";

const API_BASE = "https://timetreeapp.com/api/v1";
const TT_CLIENT = "web/2.1.0/en";

export class TimeTreeApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

interface TimeTreeCalendar {
  id: number;
  name: string;
}

interface TimeTreeLabel {
  name: string;
  color: string | null;
}

interface TimeTreeEventRaw {
  uuid: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  note: string | null;
  location: string | null;
  url: string | null;
  start_at: number;
  start_timezone: string;
  end_at: number;
  end_timezone: string;
  all_day: boolean;
  alerts: number[] | null;
  recurrences: string[] | null;
  type: number; // 0 = normal, 1 = birthday
  category: number; // 1 = normal, 2 = memo
  label_id: number | null;
}

function ttHeaders(sessionId?: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-timetreea": TT_CLIENT,
  };
  if (sessionId) headers["cookie"] = `_session_id=${sessionId}`;
  return headers;
}

async function extractErrorCode(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: number } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

export async function ttLogin(email: string, password: string): Promise<string> {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const res = await fetch(`${API_BASE}/auth/email/signin`, {
    method: "PUT",
    headers: ttHeaders(),
    body: JSON.stringify({ uid: email, password, uuid }),
  });

  if (res.status !== 200) {
    const code = await extractErrorCode(res);
    if (code === -702) throw new TimeTreeApiError("E-Mail oder Passwort falsch.", 401);
    if (code === -495) {
      throw new TimeTreeApiError("TimeTree hat zu viele Login-Versuche blockiert (Rate-Limit). Spaeter erneut versuchen.", 429);
    }
    throw new TimeTreeApiError(
      `TimeTree-Login fehlgeschlagen (HTTP ${res.status}${code !== undefined ? `, Code ${code}` : ""}).`,
      502,
    );
  }

  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /_session_id=([^;]+)/.exec(setCookie);
  if (!match) throw new TimeTreeApiError("TimeTree-Login lieferte keine Session-ID zurueck.", 502);
  return match[1]!;
}

export async function ttGetCalendars(sessionId: string): Promise<TimeTreeCalendar[]> {
  const res = await fetch(`${API_BASE}/calendars?since=0`, { headers: ttHeaders(sessionId) });
  if (!res.ok) throw new TimeTreeApiError("Kalenderliste konnte nicht geladen werden.", 502);
  const body = (await res.json()) as { calendars?: Array<{ id: number; name: string }> };
  return (body.calendars ?? []).map((c) => ({ id: c.id, name: c.name }));
}

function formatColor(color: string | number | undefined): string | null {
  if (color === undefined || color === null) return null;
  if (typeof color === "number") return `#${color.toString(16).padStart(6, "0")}`;
  return color;
}

async function ttGetLabels(sessionId: string, calendarId: number): Promise<Map<number, TimeTreeLabel>> {
  const labels = new Map<number, TimeTreeLabel>();
  const res = await fetch(`${API_BASE}/calendar/${calendarId}/labels`, { headers: ttHeaders(sessionId) });
  if (!res.ok) return labels; // labels are cosmetic only — never fail the export over this
  const body = (await res.json()) as {
    calendar_labels?: Array<{ id: number; name: string; color?: string | number }>;
  };
  for (const label of body.calendar_labels ?? []) {
    labels.set(label.id, { name: label.name, color: formatColor(label.color) });
  }
  return labels;
}

async function ttGetEvents(sessionId: string, calendarId: number, since = 0): Promise<TimeTreeEventRaw[]> {
  const res = await fetch(`${API_BASE}/calendar/${calendarId}/events/sync?since=${since}`, {
    headers: ttHeaders(sessionId),
  });
  if (!res.ok) throw new TimeTreeApiError("Termine konnten nicht geladen werden.", 502);
  const body = (await res.json()) as { events?: TimeTreeEventRaw[]; chunk?: boolean; since?: number };
  const events = body.events ?? [];
  if (body.chunk === true && body.since !== undefined) {
    events.push(...(await ttGetEvents(sessionId, calendarId, body.since)));
  }
  return events;
}

// --- ICS formatting -------------------------------------------------------

function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// RFC 5545 line folding: continuation lines start with a single space.
// Folds on UTF-16 code units, not octets — fine for the short, mostly-ASCII
// lines this generates; a very long multi-byte SUMMARY/DESCRIPTION could in
// theory split a surrogate pair, which is a cosmetic risk, not a correctness
// one (readers still reassemble the same text).
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return chunks.join("\r\n ");
}

function toUtcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function zoneDateStamp(epochMs: number, timeZone: string, addDays = 0): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.format(new Date(epochMs)).split("-").map(Number);
  const [y, m, d] = parts as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + addDays));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function buildEventLines(ev: TimeTreeEventRaw, label: TimeTreeLabel | undefined): string[] | null {
  if (ev.type === 1) return null; // birthday — TimeTree derives these from contacts, not real events
  if (ev.category === 2) return null; // memo — not a calendar event

  const lines: string[] = ["BEGIN:VEVENT", `UID:${ev.uuid}@timetreeapp.com`];
  lines.push(`SUMMARY:${icsEscape(ev.title ?? "")}`);
  lines.push(`DTSTAMP:${toUtcStamp(Date.now())}`);
  if (ev.created_at) lines.push(`CREATED:${toUtcStamp(ev.created_at)}`);
  if (ev.updated_at) lines.push(`LAST-MODIFIED:${toUtcStamp(ev.updated_at)}`);

  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${zoneDateStamp(ev.start_at, ev.start_timezone)}`);
    // RFC 5545 all-day DTEND is exclusive — add a day.
    lines.push(`DTEND;VALUE=DATE:${zoneDateStamp(ev.end_at, ev.end_timezone, 1)}`);
  } else {
    lines.push(`DTSTART:${toUtcStamp(ev.start_at)}`);
    lines.push(`DTEND:${toUtcStamp(ev.end_at)}`);
  }

  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.note) lines.push(`DESCRIPTION:${icsEscape(ev.note)}`);
  if (label?.name) lines.push(`CATEGORIES:${icsEscape(label.name)}`);
  if (label?.color) lines.push(`COLOR:${label.color}`);

  for (const minutesBefore of ev.alerts ?? []) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", `TRIGGER:-PT${minutesBefore}M`, "END:VALARM");
  }

  // TimeTree returns recurrences pre-formatted as iCal content lines
  // (e.g. "RRULE:FREQ=WEEKLY;...", "EXDATE:...") — pass them through as-is.
  for (const recurrenceLine of ev.recurrences ?? []) {
    lines.push(recurrenceLine);
  }

  lines.push("END:VEVENT");
  return lines;
}

async function buildIcs(sessionId: string, calendarId: number, calendarName: string): Promise<string> {
  const [events, labels] = await Promise.all([
    ttGetEvents(sessionId, calendarId),
    ttGetLabels(sessionId, calendarId),
  ]);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//aktien.gerbert.workers.dev//TimeTree ICS Exporter//DE",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];

  for (const ev of events) {
    const label = ev.label_id != null ? labels.get(ev.label_id) : undefined;
    const eventLines = buildEventLines(ev, label);
    if (eventLines) lines.push(...eventLines);
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "timetree";
}

// --- Route handlers ---------------------------------------------------------

export async function handleTimetreeLogin(request: Request): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError("Ungueltiger Request-Body.", 400);
  }

  const email = body.email?.trim();
  const password = body.password;
  if (!email || !password) return jsonError("E-Mail und Passwort erforderlich.", 400);

  try {
    const sessionId = await ttLogin(email, password);
    const calendars = await ttGetCalendars(sessionId);
    return json({ ok: true, session_id: sessionId, calendars });
  } catch (err) {
    if (err instanceof TimeTreeApiError) return jsonError(err.message, err.status);
    return jsonError(`Unerwarteter Fehler: ${String(err)}`, 500);
  }
}

export async function handleTimetreeExport(request: Request): Promise<Response> {
  let body: { session_id?: string; calendar_id?: number; calendar_name?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError("Ungueltiger Request-Body.", 400);
  }

  const { session_id, calendar_id, calendar_name } = body;
  if (!session_id || calendar_id === undefined) {
    return jsonError("session_id und calendar_id erforderlich.", 400);
  }

  try {
    const name = calendar_name ?? "TimeTree";
    const ics = await buildIcs(session_id, calendar_id, name);
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="${sanitizeFilename(name)}.ics"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof TimeTreeApiError) return jsonError(err.message, err.status);
    return jsonError(`Unerwarteter Fehler: ${String(err)}`, 500);
  }
}
