import { test } from "node:test";
import assert from "node:assert/strict";
import { ReminderTimeError, istNowLabel, resolveDelayMinutes } from "../src/reminder-time.ts";

// 2026-10-30 14:30 IST = 09:00 UTC
const now = Date.UTC(2026, 9, 30, 9, 0, 0);

test("clock time later today: 6:30 pm is 240 minutes away, not 390", () => {
  assert.equal(resolveDelayMinutes({ at_time: "18:30", delay_minutes: 390 }, now), 240);
});

test("clock time already passed rolls to tomorrow", () => {
  assert.equal(resolveDelayMinutes({ at_time: "09:00" }, now), 18 * 60 + 30);
});

test("explicit date, including a later day", () => {
  assert.equal(resolveDelayMinutes({ at_time: "14:30", on_date: "2026-10-31" }, now), 24 * 60);
  assert.throws(() => resolveDelayMinutes({ at_time: "09:00", on_date: "2026-10-30" }, now), ReminderTimeError);
});

test("relative delay passes through; junk is rejected", () => {
  assert.equal(resolveDelayMinutes({ delay_minutes: 2 }, now), 2);
  assert.throws(() => resolveDelayMinutes({ delay_minutes: 0 }, now), ReminderTimeError);
  assert.throws(() => resolveDelayMinutes({ at_time: "25:99" }, now), ReminderTimeError);
  assert.throws(() => resolveDelayMinutes({}, now), ReminderTimeError);
});

test("IST label", () => {
  assert.equal(istNowLabel(now), "Friday, 2026-10-30 14:30 IST");
});

test("confirmations read like times, not minute counts", async () => {
  const { formatIn, formatWhen } = await import("../src/reminder-time.ts");
  // now = Fri 30 Oct 14:30 IST
  const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000;
  assert.equal(formatWhen(at(2026, 10, 30, 18, 30), now), "today 6:30 pm");
  assert.equal(formatWhen(at(2026, 10, 31, 7, 0), now), "tomorrow 7:00 am");
  assert.equal(formatWhen(at(2026, 11, 6, 16, 0), now), "Fri 6 Nov, 4:00 pm");
  assert.equal(formatWhen(at(2026, 10, 31, 0, 5), now), "tomorrow 12:05 am");
  assert.equal(formatWhen(at(2026, 10, 30, 12, 0), now), "today 12:00 pm");
  assert.equal(formatIn(now + 45 * 60_000, now), "in 45 min");
  assert.equal(formatIn(now + 270 * 60_000, now), "in 4 h 30 min");
  assert.equal(formatIn(now + 120 * 60_000, now), "in 2 h");
  assert.equal(formatIn(now + 3 * 1440 * 60_000, now), "in 3 days");
  assert.equal(formatIn(now + 1440 * 60_000, now), "in 1 day");
  assert.equal(formatIn(now + 10_000, now), "in 1 min");
});
