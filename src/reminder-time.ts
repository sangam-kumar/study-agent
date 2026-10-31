// Turns what the LLM extracted from "remind me ..." into a delay in minutes. The LLM only reports
// what the user said (a relative delay or a wall-clock time); the arithmetic happens here.

const IST_OFFSET_MS = 330 * 60_000; // India has no DST

export interface ReminderTiming {
  delay_minutes?: number;
  /** 24h "HH:MM" in IST, only when the user gave a clock time. */
  at_time?: string;
  /** "YYYY-MM-DD" in IST, only when the user named a date. */
  on_date?: string;
}

export class ReminderTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderTimeError";
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6:30 pm" in IST. */
function clock(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "today 6:30 pm", "tomorrow 7:00 am", "Fri 6 Nov, 4:00 pm" (IST calendar days). */
export function formatWhen(dueMs: number, nowMs: number): string {
  const dayOf = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / 86_400_000);
  const diff = dayOf(dueMs) - dayOf(nowMs);
  if (diff === 0) return `today ${clock(dueMs)}`;
  if (diff === 1) return `tomorrow ${clock(dueMs)}`;
  const d = new Date(dueMs + IST_OFFSET_MS);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${clock(dueMs)}`;
}

/** "in 45 min", "in 4 h 30 min", "in 3 days". */
export function formatIn(dueMs: number, nowMs: number): string {
  const min = Math.max(1, Math.round((dueMs - nowMs) / 60_000));
  if (min < 60) return `in ${min} min`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `in ${h} h${m ? ` ${m} min` : ""}`;
  }
  const days = Math.round(min / 1440);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** Current date and time in IST for the LLM prompt, e.g. "Friday, 2026-10-30 14:30 IST". */
export function istNowLabel(nowMs: number): string {
  const d = new Date(nowMs + IST_OFFSET_MS);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  return `${day}, ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} IST`;
}

/**
 * Minutes from nowMs until the reminder should fire. A clock time wins over delay_minutes.
 * With no date, a time that has already passed today means tomorrow.
 */
export function resolveDelayMinutes(t: ReminderTiming, nowMs: number): number {
  if (t.at_time) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t.at_time.trim());
    if (!m) throw new ReminderTimeError(`unreadable time "${t.at_time}"`);
    const minuteOfDay = Number(m[1]) * 60 + Number(m[2]);
    const nowIst = nowMs + IST_OFFSET_MS;
    let dayStartIst = nowIst - (((nowIst % 86_400_000) + 86_400_000) % 86_400_000);
    if (t.on_date) {
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.on_date.trim());
      if (!dm) throw new ReminderTimeError(`unreadable date "${t.on_date}"`);
      dayStartIst = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
    }
    let targetIst = dayStartIst + minuteOfDay * 60_000;
    if (!t.on_date && targetIst <= nowIst) targetIst += 86_400_000;
    const minutes = (targetIst - nowIst) / 60_000;
    if (minutes <= 0) throw new ReminderTimeError("that time has already passed");
    return minutes;
  }
  const d = t.delay_minutes;
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) throw new ReminderTimeError("no usable delay or time");
  return d;
}
