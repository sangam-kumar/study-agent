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
