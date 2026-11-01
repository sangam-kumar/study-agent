import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clockOf, describeRepeat, eveningOpenLines, findDuplicate, firstOccurrence, getReminder, insertReminder, markDone, markFired,
  morningTaskLine, nextOccurrence, parseRepeat, renderReminderList, reschedule, resolveReminder, tasksDue, tomorrowAt, unanswered,
} from "../src/reminders.ts";
import { understand } from "../src/understand.ts";
import type { InferBackend } from "../src/infer.ts";
import { renderEvening, renderMorning } from "../src/day.ts";
import { istWallToMs } from "../src/time.ts";
import { migratedDb } from "./helpers.ts";

// Friday 30 Oct 2026, 14:30 IST
const nowMs = istWallToMs("2026-10-30", "14:30");

// ------------------------------------------------------------------ repeats

test("repeat phrases", () => {
  assert.equal(parseRepeat("daily"), "daily");
  assert.equal(parseRepeat("every day"), "daily");
  assert.equal(parseRepeat("weekdays"), "weekdays");
  assert.equal(parseRepeat("mon"), "weekly:0");
  assert.equal(parseRepeat("every Monday and Thursday"), "weekly:0,3");
  assert.equal(parseRepeat("mondays"), "weekly:0");
  assert.equal(parseRepeat("weekends"), "weekly:5,6");
  assert.equal(parseRepeat("sometimes"), null);
  assert.equal(parseRepeat(""), null);
  assert.equal(describeRepeat("weekly:0,3"), "every Mon, Thu");
});

test("first and next occurrence keep the clock time and skip non-matching days", () => {
  // Friday 14:30: "every Monday 9am" first fires Mon 2 Nov 09:00.
  assert.equal(firstOccurrence("weekly:0", "09:00", nowMs), istWallToMs("2026-11-02", "09:00"));
  // Daily 20:00 from 14:30 is today.
  assert.equal(firstOccurrence("daily", "20:00", nowMs), istWallToMs("2026-10-30", "20:00"));
  // Weekdays 07:00 from Friday afternoon is Monday.
  assert.equal(firstOccurrence("weekdays", "07:00", nowMs), istWallToMs("2026-11-02", "07:00"));
  const mon = istWallToMs("2026-11-02", "09:00");
  assert.equal(nextOccurrence("weekly:0", mon, mon), istWallToMs("2026-11-09", "09:00"));
  assert.equal(nextOccurrence("weekly:0,3", mon, mon), istWallToMs("2026-11-05", "09:00"));
  // Fired late (after a restart): never schedules into the past.
  assert.ok(nextOccurrence("daily", istWallToMs("2026-10-28", "08:00"), nowMs) > nowMs);
  assert.equal(clockOf(mon), "09:00");
});

// ------------------------------------------------------------------- rows

test("duplicates: same text at the same time, or the same task on the same day", () => {
  const db = migratedDb();
  const due = istWallToMs("2026-11-06", "16:00");
  insertReminder(db, { text: "Call the bank", dueMs: due }, nowMs);
  assert.ok(findDuplicate(db, "call the bank!", { dueMs: due + 30_000 }));
  assert.equal(findDuplicate(db, "call the bank", { dueMs: due + 3600_000 }), null);
  insertReminder(db, { text: "submit the form", dueDate: "2026-11-06" }, nowMs);
  assert.ok(findDuplicate(db, "Submit the form", { dueDate: "2026-11-06" }));
  assert.equal(findDuplicate(db, "submit the form", { dueDate: "2026-11-07" }), null);
});

test("cancel by words or id; several matches ask which", () => {
  const db = migratedDb();
  const a = insertReminder(db, { text: "call the bank about the card", dueMs: nowMs + 3600_000 }, nowMs);
  insertReminder(db, { text: "call mom", dueMs: nowMs + 7200_000 }, nowMs);
  const hit = resolveReminder(db, "the bank reminder");
  assert.ok("reminder" in hit && hit.reminder.id === a);
  const byId = resolveReminder(db, `#${a}`);
  assert.ok("reminder" in byId && byId.reminder.id === a);
  const many = resolveReminder(db, "call");
  assert.ok("reply" in many && /Which one/.test(many.reply));
  const none = resolveReminder(db, "dentist");
  assert.ok("reply" in none && /No open reminder/.test(none.reply));
});

test("fired and unanswered shows once in the evening; snoozing resets it; done removes it", () => {
  const db = migratedDb();
  const id = insertReminder(db, { text: "stretch", dueMs: nowMs - 60_000 }, nowMs - 3600_000);
  markFired(db, id, nowMs, 42);
  assert.deepEqual(unanswered(db, nowMs + 3600_000).map((r) => r.id), [id]);
  assert.match(eveningOpenLines(db, "2026-10-30", nowMs + 3600_000).join(" "), /Still open: stretch/);
  assert.equal(unanswered(db, nowMs + 25 * 3600_000).length, 0, "only the day after it fired");

  reschedule(db, id, nowMs + 3600_000);
  const r = getReminder(db, id)!;
  assert.deepEqual([r.status, r.repeats, r.fired_at], ["pending", 0, null]);
  markDone(db, id, nowMs);
  assert.equal(getReminder(db, id)!.status, "done");
});

test("Tomorrow keeps the clock time", () => {
  const db = migratedDb();
  const id = insertReminder(db, { text: "x", dueMs: istWallToMs("2026-10-30", "18:30") }, nowMs);
  assert.equal(tomorrowAt(getReminder(db, id)!, istWallToMs("2026-10-30", "18:31")), istWallToMs("2026-10-31", "18:30"));
});

test("date-only tasks show in the morning brief and the evening recap, overdue ones too", () => {
  const db = migratedDb();
  insertReminder(db, { text: "submit the form", dueDate: "2026-10-30" }, nowMs);
  insertReminder(db, { text: "pay rent", dueDate: "2026-10-29" }, nowMs);
  insertReminder(db, { text: "renew passport", dueDate: "2026-11-20" }, nowMs);
  assert.deepEqual(tasksDue(db, "2026-10-30").map((t) => t.text), ["pay rent", "submit the form"]);
  const morning = morningTaskLine(db, "2026-10-30");
  assert.match(morning, /pay rent <i>\(overdue\)<\/i>/);
  assert.match(morning, /submit the form <i>\(today\)<\/i>/);
  assert.doesNotMatch(morning, /passport/);
  assert.match(renderMorning(db, "2026-10-30"), /submit the form/);
  assert.match(renderEvening(db, "2026-10-30", nowMs), /📌 Due: pay rent/);
  assert.match(renderReminderList(db, nowMs), /To do by a date[\s\S]*renew passport — by Fri 20 Nov/);
});

// ----------------------------------------------------------- understanding

function model(extraction: unknown): InferBackend {
  return {
    name: "fake",
    async json(req: { system: string }) {
      if (req.system.includes("Classify the message")) return { intent: "reminder", confidence: 0.95 };
      return extraction;
    },
  };
}
const run = (db: ReturnType<typeof migratedDb>, extraction: unknown, text: string) =>
  understand({ db, backends: [model(extraction)], nowMs, log: () => {} }, text);

test("a day without a time becomes a task, not a ping", async () => {
  const out = await run(migratedDb(), { action: "set", reminder_text: "submit the form", no_time: true, on_date: "2026-11-06", delay_minutes: 0 }, "submit the form by next Friday");
  assert.deepEqual(out, { kind: "task", text: "submit the form", dueDate: "2026-11-06" });
});

test("a repeating reminder gets its first firing in code", async () => {
  const out = await run(migratedDb(), { action: "set", reminder_text: "review the week", repeat: "mon", at_time: "09:00", delay_minutes: 0 }, "every Monday 9am review the week");
  assert.deepEqual(out, { kind: "reminder", text: "review the week", dueMs: istWallToMs("2026-11-02", "09:00"), repeat: "weekly:0" });
});

test("a repeat without a time is retried, then inboxed", async () => {
  const out = await run(migratedDb(), { action: "set", reminder_text: "x", repeat: "daily", delay_minutes: 0 }, "remind me daily");
  assert.equal(out.kind, "inbox");
});

test("cancel and done are resolved against open reminders in code", async () => {
  const db = migratedDb();
  const id = insertReminder(db, { text: "call the bank", dueMs: nowMs + 3600_000 }, nowMs);
  assert.deepEqual(await run(db, { action: "cancel", ref: "bank" }, "cancel the bank reminder"), { kind: "reminder_action", action: "cancel", id });
  const none = await run(db, { action: "done", ref: "dentist" }, "I went to the dentist");
  assert.equal(none.kind, "reply");
});
