import { EVENT_CATEGORY, EVENT_TYPE, type CalendarLabel, type TimeTreeEvent } from "./event";

const CRLF = "\r\n";

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Folds a content line to <=75 octets per line, per RFC 5545 section 3.1. */
export function foldLine(line: string): string {
  const bytes = utf8Encoder.encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const limit = first ? 75 : 74; // continuation lines carry a leading space
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1; // don't split UTF-8 sequences
    parts.push(utf8Decoder.decode(bytes.subarray(start, end)));
    start = end;
    first = false;
  }
  return parts.join(CRLF + " ");
}

function pad(n: number, l = 2): string {
  return String(n).padStart(l, "0");
}

function formatUtc(msTimestamp: number): string {
  const d = new Date(msTimestamp);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function localDateParts(msTimestamp: number, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(msTimestamp).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Local calendar date (YYYYMMDD) that a UTC instant falls on in `timeZone`. */
function formatLocalDate(msTimestamp: number, timeZone: string, dayOffset = 0): string {
  const { year, month, day } = localDateParts(msTimestamp, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - date.getTime();
}

/** 23:59:59 local wall-clock time on an 8-digit YYYYMMDD date, converted to UTC. */
function zonedEndOfDayToUtcMs(dateStr8: string, timeZone: string): number {
  const year = Number(dateStr8.slice(0, 4));
  const month = Number(dateStr8.slice(4, 6));
  const day = Number(dateStr8.slice(6, 8));
  const guessUtc = Date.UTC(year, month - 1, day, 23, 59, 59);
  const offset = timeZoneOffsetMs(new Date(guessUtc), timeZone);
  return guessUtc - offset;
}

/**
 * TimeTree ships RRULE/EXDATE/RDATE lines already in RFC 5545 form. The one
 * fixup needed: an RRULE with a bare date UNTIL (no time) is only valid when
 * DTSTART is also a DATE value. Our non-all-day events use UTC DATE-TIME
 * DTSTART/DTEND (see buildVEvent), so a date-only UNTIL there must become a
 * UTC date-time, taken as end-of-day in the event's own start time zone.
 */
function adjustRecurrenceLine(line: string, event: TimeTreeEvent): string {
  const match = /^RRULE:(.*)$/i.exec(line.trim());
  if (!match || event.allDay) return line;
  const untilMatch = /UNTIL=(\d{8})(?![\dT])/i.exec(match[1]!);
  if (!untilMatch) return line;
  const utcMs = zonedEndOfDayToUtcMs(untilMatch[1]!, event.startTimezone);
  return line.replace(untilMatch[0], `UNTIL=${formatUtc(utcMs)}`);
}

function isValidHexColor(color: string | null | undefined): color is string {
  if (!color) return false;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color.trim());
}

/**
 * Builds one VEVENT's content lines, or null if TimeTree marks the event as
 * a birthday or a memo (both are skipped by the upstream exporter too).
 */
export function buildVEvent(event: TimeTreeEvent, label: CalendarLabel | undefined): string[] | null {
  if (event.eventType === EVENT_TYPE.BIRTHDAY) return null;
  if (event.category === EVENT_CATEGORY.MEMO) return null;

  const lines: string[] = [];
  const push = (name: string, value: string, params: Record<string, string> = {}): void => {
    const paramStr = Object.entries(params)
      .map(([k, v]) => `;${k}=${v}`)
      .join("");
    lines.push(foldLine(`${name}${paramStr}:${value}`));
  };

  lines.push("BEGIN:VEVENT");
  push("UID", escapeText(event.uuid));
  push("SUMMARY", escapeText(event.title ?? ""));
  push("DTSTAMP", formatUtc(Date.now()));
  push("CREATED", formatUtc(event.createdAt));
  push("LAST-MODIFIED", formatUtc(event.updatedAt));

  if (event.allDay) {
    // RFC 5545 all-day DTEND is exclusive, so it's shifted one day forward.
    push("DTSTART", formatLocalDate(event.startAt, event.startTimezone), { VALUE: "DATE" });
    push("DTEND", formatLocalDate(event.endAt, event.endTimezone, 1), { VALUE: "DATE" });
  } else {
    // Emitted as absolute UTC instants (no VTIMEZONE block needed) since
    // start_at/end_at from TimeTree already are UTC timestamps. Trade-off:
    // a recurring non-all-day event keeps a fixed UTC time rather than a
    // floating local time, so its wall-clock time can shift by the DST
    // offset across a recurrence that spans a clock change.
    push("DTSTART", formatUtc(event.startAt));
    push("DTEND", formatUtc(event.endAt));
  }

  if (event.location) push("LOCATION", escapeText(event.location));
  if (event.locationLat && event.locationLon) {
    lines.push(foldLine(`GEO:${event.locationLat};${event.locationLon}`));
  }
  if (event.url) push("URL", event.url);
  if (event.note) push("DESCRIPTION", escapeText(event.note));
  for (const comment of event.comments) push("COMMENT", escapeText(comment));

  const relatedTo = event.recurringUuid || event.parentId;
  if (relatedTo) push("RELATED-TO", escapeText(relatedTo));

  if (label?.name) push("CATEGORIES", escapeText(label.name));
  if (isValidHexColor(label?.color)) push("COLOR", label!.color!);

  for (const alertMinutes of event.alerts) {
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push("DESCRIPTION:Reminder");
    lines.push(foldLine(`TRIGGER:-PT${Math.max(0, Math.round(alertMinutes))}M`));
    lines.push("END:VALARM");
  }

  for (const recurrence of event.recurrences) {
    lines.push(foldLine(adjustRecurrenceLine(recurrence, event)));
  }

  lines.push("END:VEVENT");
  return lines;
}

export function buildCalendar(veventLines: string[][]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//TimeTree Exporter (Worker reimplementation)//EN",
    "VERSION:2.0",
    ...veventLines.flat(),
    "END:VCALENDAR",
  ];
  return lines.join(CRLF) + CRLF;
}
