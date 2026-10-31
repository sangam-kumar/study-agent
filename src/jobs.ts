// When the three daily jobs fire. Pure: the agent turns these instants into one-shot schedules and
// re-registers the next one after each run (and on every Durable Object start).
//
//   evening  21:30 IST  recap + tomorrow's draft
//   lock     23:00 IST  tomorrow locks itself if you said nothing
//   morning  fallback brief at 09:30 weekdays / 10:30 weekends, only if you haven't woken it up

import { addDays, calendarDate, dayKey, istWallToMs, weekdayIndex } from "./time.ts";

export type JobKind = "evening" | "lock" | "morning";
export const JOB_KINDS: readonly JobKind[] = ["evening", "lock", "morning"];
export const JOB_CALLBACK = { evening: "jobEvening", lock: "jobLock", morning: "jobMorning" } as const;

export interface JobTimes {
  evening: string;
  lock: string;
  morningWeekday: string;
  morningWeekend: string;
}

export const DEFAULT_TIMES: JobTimes = { evening: "21:30", lock: "23:00", morningWeekday: "09:30", morningWeekend: "10:30" };

/** Next daily occurrence of an IST wall-clock time strictly after nowMs. */
function nextDaily(nowMs: number, hhmm: string): number {
  const today = calendarDate(nowMs);
  const t = istWallToMs(today, hhmm);
  return t > nowMs ? t : istWallToMs(addDays(today, 1), hhmm);
}

function morningFor(date: string, t: JobTimes): number {
  return istWallToMs(date, weekdayIndex(date) >= 5 ? t.morningWeekend : t.morningWeekday);
}

/** ms since epoch of the next run. For "morning", pass whether today's brief already went out. */
export function nextRun(kind: JobKind, nowMs: number, t: JobTimes, briefSentToday = false): number {
  if (kind === "evening") return nextDaily(nowMs, t.evening);
  if (kind === "lock") return nextDaily(nowMs, t.lock);
  const today = dayKey(nowMs);
  const candidate = morningFor(today, t);
  return !briefSentToday && candidate > nowMs ? candidate : morningFor(addDays(today, 1), t);
}
