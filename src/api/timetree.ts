// Backend for the TimeTree ICS export form (public/timetree.html).
//
// Two-step flow, mirroring TimeTree's own web app session:
//   1. POST /api/timetree/login  {email, password}
//        -> logs in, returns {sessionId, csrfToken, calendars}. The password
//           is used once to obtain a session and is never stored or logged.
//           Both sessionId (cookie jar) and csrfToken are required on every
//           later authenticated TimeTree call, not just login.
//   2. POST /api/timetree/export {sessionId, csrfToken, calendarId, splitByLabel?, includeComments?}
//        -> fetches labels + events with that session and returns one or
//           more .ics file contents as JSON for the browser to download.
//
// Unofficial, reverse-engineered TimeTree API (see src/timetree/). No
// images here (that needs a filesystem to stage downloads to) - use the
// tools/timetree-exporter/ CLI for that.

import { AuthenticationError, InvalidCredentialsError, RateLimitAuthenticationError, login } from "../timetree/auth";
import { TimeTreeApi, type CalendarMetadata, type LabelMap } from "../timetree/api";
import { parseEvent, type RawEvent } from "../timetree/event";
import { buildCalendar, buildVEvent } from "../timetree/ics";
import { json, jsonError } from "../http";

const COMMENT_FETCH_CONCURRENCY = 6;

interface LoginRequestBody {
  email?: unknown;
  password?: unknown;
}

interface ExportRequestBody {
  sessionId?: unknown;
  csrfToken?: unknown;
  calendarId?: unknown;
  splitByLabel?: unknown;
  includeComments?: unknown;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w-]/g, "_").replace(/^_+|_+$/g, "");
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      await fn(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
}

function calendarUserNames(metadata: CalendarMetadata): Map<number, string> {
  const names = new Map<number, string>();
  for (const user of metadata.calendar_users ?? []) {
    const id = user.user_id ?? user.id;
    if (id != null && user.name) names.set(id, user.name);
  }
  return names;
}

export async function handleTimetreeLogin(request: Request): Promise<Response> {
  let body: LoginRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return jsonError("email and password are required", 400);

  try {
    const { cookieJar, csrfToken } = await login(email, password);
    const api = new TimeTreeApi(cookieJar, csrfToken);
    const calendars = await api.getMetadata();
    return json({
      sessionId: cookieJar,
      csrfToken,
      calendars: calendars.map((c) => ({ id: c.id, name: c.name, aliasCode: c.alias_code ?? null })),
    });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return jsonError("Wrong email or password", 401);
    if (err instanceof RateLimitAuthenticationError) {
      return jsonError("Rate limited by TimeTree, please try again later", 429);
    }
    if (err instanceof AuthenticationError) return jsonError(err.message, 502);
    throw err;
  }
}

export async function handleTimetreeExport(request: Request): Promise<Response> {
  let body: ExportRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : "";
  const calendarId = Number(body.calendarId);
  if (!sessionId || !csrfToken || !Number.isFinite(calendarId)) {
    return jsonError("sessionId, csrfToken and calendarId are required", 400);
  }
  const splitByLabel = body.splitByLabel === true;
  const includeComments = body.includeComments === true;

  const api = new TimeTreeApi(sessionId, csrfToken);

  let metadata: CalendarMetadata[];
  let rawEvents: RawEvent[];
  let labels: LabelMap;
  try {
    [metadata, rawEvents, labels] = await Promise.all([
      api.getMetadata(),
      api.getEvents(calendarId),
      api.getLabels(calendarId),
    ]);
  } catch (err) {
    return jsonError(`Failed to fetch calendar data: ${(err as Error).message}`, 502);
  }

  const calendar = metadata.find((c) => c.id === calendarId);
  const events = rawEvents.map(parseEvent);

  if (includeComments && calendar) {
    const userNames = calendarUserNames(calendar);
    await mapLimit(events, COMMENT_FETCH_CONCURRENCY, async (event) => {
      event.comments = await api.getEventComments(calendarId, event.uuid, userNames);
    });
  }

  const baseName = sanitizeFilename(calendar?.name || "timetree") || "timetree";

  if (splitByLabel) {
    const groups = new Map<number | null, string[][]>();
    for (const event of events) {
      const label = event.labelId != null ? labels.get(event.labelId) : undefined;
      const vevent = buildVEvent(event, label);
      if (!vevent) continue;
      const key = label ? event.labelId : null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(vevent);
    }
    const files = Array.from(groups.entries()).map(([key, veventLines]) => {
      const suffix = key == null ? "unlabeled" : sanitizeFilename(labels.get(key)?.name || `label_${key}`);
      return { filename: `${baseName}_${suffix}.ics`, content: buildCalendar(veventLines) };
    });
    return json({ files });
  }

  const veventLines: string[][] = [];
  for (const event of events) {
    const label = event.labelId != null ? labels.get(event.labelId) : undefined;
    const vevent = buildVEvent(event, label);
    if (vevent) veventLines.push(vevent);
  }
  return json({ files: [{ filename: `${baseName}.ics`, content: buildCalendar(veventLines) }] });
}
