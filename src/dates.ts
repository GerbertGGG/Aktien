// Minimal calendar-date helpers, operating on ISO "yyyy-mm-dd" strings and
// UTC internally so results don't depend on the Worker's runtime timezone
// (Workers always run in UTC, but being explicit avoids surprises in tests).

// Adds `months` (may be negative) to an ISO date, clamping the day to the
// last valid day of the target month (e.g. 2021-03-31 minus 1 month must
// land on 2021-02-28, not overflow into 2021-03-03 as plain
// `Date.UTC(y, m-1+months, d)` arithmetic would do whenever the target
// month is shorter than the source day-of-month).
export function addMonthsISO(iso: string, months: number): string {
  const parts = iso.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;

  const totalMonths = y * 12 + (m - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths - targetYear * 12; // 0-11

  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, daysInTargetMonth);

  const dt = new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay));
  return dt.toISOString().slice(0, 10);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True if `iso` is the last calendar day present for its (year, month) within `allDatesAsc`. */
export function isMonthEnd(iso: string, index: number, allDatesAsc: readonly string[]): boolean {
  const next = allDatesAsc[index + 1];
  if (!next) return true; // last known trading day overall counts as a month-end
  return iso.slice(0, 7) !== next.slice(0, 7);
}

export function yearsBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO + "T00:00:00Z").getTime();
  const to = new Date(toISO + "T00:00:00Z").getTime();
  return (to - from) / (365.25 * 24 * 3600 * 1000);
}
