import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, undoLast } from "../src/ops.ts";
import { loadConfigSeed } from "../src/seed-config.ts";
import { loadStudySeed } from "../src/seed.ts";
import { ensureDraft, loadItems, recordEvent } from "../src/day.ts";
import {
  agentMessagesToday, closeIgnoredNudge, nudgeGate, nudgesStoppedThisWeek, pickNudge, recordAgentMessage, recordNudgeAnswer,
  recordNudgeSent, shouldAskPause,
} from "../src/nudge.ts";
import { renderWeekly, unitsAdvanced, weeklyLines } from "../src/weekly.ts";
import { renderDailyBlock } from "../src/mirror.ts";
import { insertReminder } from "../src/reminders.ts";
import { DEFAULT_TIMES, nextRun } from "../src/jobs.ts";
import { istWallToMs } from "../src/time.ts";
import { migratedDb } from "./helpers.ts";

const MON = "2026-11-02";
const at = (date: string, hhmm: string) => istWallToMs(date, hhmm);
const now = (date: string, hhmm: string) => () => new Date(at(date, hhmm));

function world() {
  const db = migratedDb();
  loadConfigSeed(db, {
    config: {},
    lanes: [{ name: "fitness", status: "active" }, { name: "study", status: "active" }],
    targets: [
      { lane: "fitness", metric: "lift_sessions", period: "week", floor: 2, goal: 3 },
      { lane: "fitness", metric: "mobility_sessions", period: "week", floor: 1, goal: 2 },
    ],
    pattern: [
      { weekday: 0, kind: "GYM" }, { weekday: 1, kind: "MOBILITY" }, { weekday: 2, kind: "GYM" }, { weekday: 3, kind: "REST" },
      { weekday: 4, kind: "GYM" }, { weekday: 5, kind: "MOBILITY" }, { weekday: 6, kind: "REST" },
    ],
    rotation: [{ lane: "fitness", ordinal: 1, label: "Chest / Triceps" }, { lane: "fitness", ordinal: 2, label: "Back / Biceps" }],
  }, now(MON, "07:00"));
  loadStudySeed(db, {
    tracks: [{ id: "t", title: "Prep", lane: "study", lists: [{ id: "dsa", title: "DSA", units: [
      { ordinal: 1, title: "Two Sum" }, { ordinal: 2, title: "Valid Anagram" }, { ordinal: 3, title: "Group Anagrams" },
    ] }] }],
  }, now(MON, "07:00"));
  ensureDraft(db, MON, at(MON, "07:00"));
  recordEvent(db, "wake", MON, { trigger: "wake_word" }, at(MON, "07:00"));
  return db;
}

// ------------------------------------------------------------------- gate

test("a nudge goes out when you're up, nothing else went out lately, and an item is open", () => {
  const db = world();
  assert.deepEqual(nudgeGate(db, at(MON, "18:00")), { ok: true });
  assert.match(pickNudge(db, MON)!.title, /^Gym: Chest/);
});

test("never before you're up, nor in quiet hours", () => {
  const db = world();
  db.run("DELETE FROM event WHERE type = 'wake'");
  assert.equal(nudgeGate(db, at(MON, "18:00")).ok, false);
  recordEvent(db, "wake", MON, { trigger: "wake_word" }, at(MON, "07:00"));
  assert.equal(nudgeGate(db, at(MON, "22:45")).ok, false);
});

test("the budget keeps a slot for the evening; no two within 90 minutes", () => {
  const db = world();
  recordAgentMessage(db, "morning", at(MON, "09:30"));
  assert.equal(nudgeGate(db, at(MON, "18:00")).ok, true, "morning fallback + nudge + evening = 3");
  recordAgentMessage(db, "nudge", at(MON, "12:00"));
  const g = nudgeGate(db, at(MON, "18:00"));
  assert.ok(!g.ok && /messages are used/.test(g.reason));

  const db2 = world();
  recordAgentMessage(db2, "morning", at(MON, "17:00"));
  const g2 = nudgeGate(db2, at(MON, "18:00"));
  assert.ok(!g2.ok && /90 minutes/.test(g2.reason));
  assert.equal(agentMessagesToday(db2, at(MON, "18:00")).count, 1);
});

test("an override, a pause, or nudges switched off: none", () => {
  const db = world();
  applyOp(db, { type: "set_override", override_type: "SICK", start_date: MON, end_date: MON }, { now: now(MON, "08:00") });
  assert.equal(nudgeGate(db, at(MON, "18:00")).ok, false);
  undoLast(db);
  applyOp(db, { type: "set_config", key: "mute", value: JSON.stringify({ until: at(MON, "20:00") }) }, { now: now(MON, "08:00") });
  assert.equal(nudgeGate(db, at(MON, "18:00")).ok, false);
  undoLast(db);
  applyOp(db, { type: "set_config", key: "nudges", value: "off" }, { now: now(MON, "08:00") });
  assert.equal(nudgeGate(db, at(MON, "18:00")).ok, false);
});

test("one nudge a day; two ignored in a row stop them until next week", () => {
  const db = world();
  const item = pickNudge(db, MON)!;
  recordNudgeSent(db, item, at(MON, "18:00"));
  assert.equal(nudgeGate(db, at(MON, "20:00")).ok, false, "already sent today");
  assert.equal(closeIgnoredNudge(db, MON, at(MON, "21:30")), true);

  // Tuesday: ignored again -> stopped.
  const TUE = "2026-11-03";
  recordEvent(db, "nudge_sent", TUE, {}, at(TUE, "18:00"));
  closeIgnoredNudge(db, TUE, at(TUE, "21:30"));
  assert.equal(nudgesStoppedThisWeek(db, at("2026-11-04", "18:00")), true);
  assert.equal(nudgesStoppedThisWeek(db, at("2026-11-09", "18:00")), false, "a new week starts fresh");
});

test("an answered nudge is not ignored, and an answer resets the streak", () => {
  const db = world();
  const item = pickNudge(db, MON)!;
  recordNudgeSent(db, item, at(MON, "18:00"));
  recordNudgeAnswer(db, at(MON, "18:05"), "done", item.id);
  assert.equal(closeIgnoredNudge(db, MON, at(MON, "21:30")), false);
  assert.equal(nudgesStoppedThisWeek(db, at(MON, "21:30")), false);
});

test("nothing to nudge about when only optional items are open", () => {
  const db = world();
  for (const i of loadItems(db, MON).filter((x) => !x.optional)) applyOp(db, { type: "set_item_status", item_id: i.id, status: "done" }, { now: now(MON, "12:00") });
  assert.equal(pickNudge(db, MON), null);
});

test("two days of silence: ask once, not again until you've written", () => {
  const db = world();
  db.run("INSERT INTO processed_update (update_id, ts) VALUES (1, ?)", new Date(at(MON, "09:00")).toISOString());
  assert.equal(shouldAskPause(db, at("2026-11-03", "21:30")), false, "one day is fine");
  assert.equal(shouldAskPause(db, at("2026-11-04", "21:30")), true);
  recordAgentMessage(db, "pause_check", at("2026-11-04", "21:30"));
  assert.equal(shouldAskPause(db, at("2026-11-06", "21:30")), false, "asked once, then quiet");
  db.run("INSERT INTO processed_update (update_id, ts) VALUES (2, ?)", new Date(at("2026-11-07", "09:00")).toISOString());
  assert.equal(shouldAskPause(db, at("2026-11-09", "21:30")), true, "silent again after writing: may ask again");
});

test("the nudge job runs at 18:00", () => {
  assert.equal(nextRun("nudge", at(MON, "12:00"), DEFAULT_TIMES), at(MON, "18:00"));
  assert.equal(nextRun("nudge", at(MON, "18:30"), DEFAULT_TIMES), at("2026-11-03", "18:00"));
});

// ----------------------------------------------------------------- weekly

test("the weekly summary counts the week from the database", () => {
  const db = world();
  const SUN = "2026-11-08";
  const dsa = loadItems(db, MON).find((i) => i.lane === "study")!;
  applyOp(db, { type: "set_item_status", item_id: dsa.id, status: "done" }, { now: now(MON, "20:00") });
  applyOp(db, { type: "advance_pointer", list_id: "dsa", to_ordinal: 3 }, { now: now("2026-11-04", "20:00") });
  // An undone change doesn't count.
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now: now("2026-11-05", "20:00") });
  undoLast(db);
  const units = unitsAdvanced(db, at(MON, "03:00"), at("2026-11-09", "03:00"));
  assert.equal(units.get("dsa"), 2);

  const r = insertReminder(db, { text: "call the bank", dueMs: at(MON, "16:00") }, at(MON, "08:00"));
  db.run("UPDATE reminders SET done_at = ?, status = 'done' WHERE id = ?", new Date(at(MON, "16:05")).toISOString(), r);

  const lines = weeklyLines(db, SUN);
  assert.equal(lines[0], "Week of Mon 2 Nov – Sun 8 Nov");
  assert.ok(lines.some((l) => l === "📚 2 study units: DSA +2"), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("🏋️ lifts 0/3 · mobility 0/2")));
  assert.ok(lines.some((l) => l === "⏰ reminders: 1 done"));
  assert.ok(!lines.some((l) => l.startsWith("🗓")), "not the first Sunday of a month");
  assert.match(renderWeekly(db, SUN), /^📊 <b>Week of/);
});

test("the first Sunday of a month adds the month just gone; Sunday's daily note carries the week", () => {
  const db = world();
  const lines = weeklyLines(db, "2026-11-01");
  assert.ok(lines.some((l) => l.startsWith("🗓 October:")), lines.join("\n"));
  ensureDraft(db, "2026-11-08", at("2026-11-07", "21:30"));
  assert.match(renderDailyBlock(db, "2026-11-08")!, /\*\*Week of Mon 2 Nov – Sun 8 Nov\*\*/);
  assert.doesNotMatch(renderDailyBlock(db, MON)!, /Week of/);
});
