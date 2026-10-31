import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp } from "../src/ops.ts";
import { ResetError, parseScopes, resetData } from "../src/reset.ts";
import { loadStudySeed } from "../src/seed.ts";
import { count, fixedNow, migratedDb } from "./helpers.ts";

const now = fixedNow();

function dirtyDb() {
  const db = migratedDb();
  loadStudySeed(db, {
    tracks: [{ id: "t", title: "T", lane: "study", lists: [{ id: "dsa", title: "DSA", units: [
      { ordinal: 1, title: "a" }, { ordinal: 2, title: "b" }, { ordinal: 3, title: "c" },
    ] }] }],
  }, now);
  // v1 test data
  db.run("INSERT INTO interaction_logs (source, raw_content) VALUES ('telegram_text', 'hello')");
  db.run("INSERT INTO workout_logs (date, workout_type, exercises_json) VALUES ('2026-10-20', 'Chest', '[]')");
  db.run("INSERT INTO reminders (reminder_type, trigger_at, status) VALUES ('adhoc', 1, 'pending')");
  db.run("INSERT INTO reading_queue (url) VALUES ('https://example.com/a')");
  db.run("INSERT INTO bot_state (key, value) VALUES ('snooze_until', '999'), ('snooze_reason', 'x'), ('keep_me', 'y')");
  db.run("INSERT INTO processed_update (update_id, ts) VALUES (1, 't')");
  // v2 state
  applyOp(db, { type: "add_item", date: "2026-10-27", lane: "study", title: "x" }, { now });
  applyOp(db, { type: "set_override", override_type: "SICK", start_date: "2026-10-28", end_date: "2026-10-28" }, { now });
  applyOp(db, { type: "add_note", text: "n", ttl_days: 3 }, { now });
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  return db;
}

test("dry run counts and deletes nothing", () => {
  const db = dirtyDb();
  const r = resetData(db, parseScopes("all"), true);
  assert.equal(r.logs, 2);
  assert.equal(r.workouts, 1);
  assert.equal(r.reminders, 1);
  assert.equal(r.reading, 1);
  assert.equal(r.snooze, 2);
  assert.equal(r.pointers, 1);
  assert.ok(r.plan >= 6);
  assert.equal(count(db, "interaction_logs"), 1);
  assert.equal(count(db, "event"), 5 + 1, "4 ops + seed + ... all events still there");
});

test("all clears test data but keeps seed content, config and unrelated state", () => {
  const db = dirtyDb();
  resetData(db, parseScopes("all"), false);
  for (const t of ["interaction_logs", "workout_logs", "reminders", "reading_queue", "processed_update", "event", "revision", "plan_item", "day_plan", "override", "note"]) {
    assert.equal(count(db, t), 0, t);
  }
  assert.equal(count(db, "bot_state", "key = 'keep_me'"), 1, "unrelated bot_state survives");
  assert.equal(count(db, "bot_state", "key LIKE 'snooze%'"), 0);
  assert.equal(count(db, "unit"), 3, "seeded units survive");
  assert.equal(count(db, "track"), 1);
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer")[0].ordinal, 1, "pointer back to unit 1");
  assert.equal(count(db, "schema_migrations"), 4);
});

test("scopes are independent", () => {
  const db = dirtyDb();
  resetData(db, parseScopes("workouts,reminders"), false);
  assert.equal(count(db, "workout_logs"), 0);
  assert.equal(count(db, "reminders"), 0);
  assert.equal(count(db, "reading_queue"), 1, "reading was not in scope");
  assert.equal(count(db, "interaction_logs"), 1);
  assert.ok(count(db, "event") > 0, "plan state untouched");
});

test("only pointers: resets position but keeps the plan history", () => {
  const db = dirtyDb();
  resetData(db, parseScopes("pointers"), false);
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer")[0].ordinal, 1);
  assert.equal(count(db, "plan_item"), 1);
});

test("scope parsing is strict", () => {
  assert.deepEqual(parseScopes("snooze, logs"), ["logs", "snooze"]);
  assert.throws(() => parseScopes(""), ResetError);
  assert.throws(() => parseScopes("logs,everything"), ResetError);
  assert.equal(parseScopes("all").length, 8);
});
