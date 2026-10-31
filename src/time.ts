// Calendar helpers for a user in India (IST, UTC+5:30, no DST) whose "day" turns over at 03:00,
// so a late evening still belongs to the day that started that morning.

export const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const BOUNDARY_MS = 3 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of the user's current day (IST, day starts at 03:00). */
export function dayKey(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS - BOUNDARY_MS).toISOString().slice(0, 10);
}

/** Midnight-based IST calendar date. */
export function calendarDate(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parts(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function dayNumber(date: string): number {
  const [y, m, d] = parts(date);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date((dayNumber(date) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Monday = 0 ... Sunday = 6. */
export function weekdayIndex(date: string): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((dayNumber(date) + 3) % 7) + 7) % 7;
}

export function weekStart(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

/** The instant (ms since epoch) of an IST wall-clock time on a date, e.g. istWallToMs("2026-10-30", "21:30"). */
export function istWallToMs(date: string, hhmm: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  const [y, mo, d] = parts(date);
  return Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2])) - IST_OFFSET_MS;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 27 Oct" */
export function dateLabel(date: string): string {
  const [, m, d] = parts(date);
  return `${DAYS[weekdayIndex(date)]} ${d} ${MONTHS[m - 1]}`;
}

export const WEEKDAY_NAMES = DAYS;

/** "HH:MM" minus whole minutes, wrapping past midnight. */
export function minusMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (((h * 60 + m - minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
