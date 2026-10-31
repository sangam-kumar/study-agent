import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, undoLast, validateOp, OpError, VersionConflictError } from "../src/ops.ts";
import { runMigrations } from "../src/db/migrations.ts";
import { count, fixedNow, memoryDb, migratedDb } from "./helpers.ts";

const now = fixedNow();
const day = "2026-10-27";

test("migrations are idempotent and create the v2 tables", () => {
  const db = memoryDb();
  assert.deepEqual(runMigrations(db), [1, 2, 3, 4, 5]);
  assert.deepEqual(runMigrations(db), []);
  for (const t of ["event", "revision", "day_plan", "plan_item", "unit", "pointer", "override", "note", "processed_update", "reading_item"]) {
    assert.equal(count(db, t), 0, t);
  }
});

test("add_item creates day_plan + item + event + revision; undo removes them all", () => {
  const db = migratedDb();
  const r = applyOp(db, { type: "add_item", date: day, lane: "study", title: "Two Sum" }, { now });
  assert.equal(r.duplicate, false);
  assert.equal(count(db, "plan_item"), 1);
  assert.equal(count(db, "day_plan"), 1);
  assert.equal(count(db, "event", "type='add_item'"), 1);
  assert.equal(count(db, "revision"), 1);

  const u = undoLast(db, { now });
  assert.equal(u.undone, true);
  assert.equal(count(db, "plan_item"), 0);
  assert.equal(count(db, "day_plan"), 0);
  assert.equal(count(db, "event", "type='undo'"), 1);
  assert.equal(count(db, "event", "type='add_item'"), 1, "events are append-only; undo never deletes history");
});

test("same idempotency key applies once", () => {
  const db = migratedDb();
  const op = { type: "add_item", date: day, lane: "study", title: "Kadane" };
  const a = applyOp(db, op, { now, idempotencyKey: "1001#0" });
  const b = applyOp(db, op, { now, idempotencyKey: "1001#0" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.eventId, a.eventId);
  assert.equal(count(db, "plan_item"), 1);
});

test("set_item_status and undo restore the previous status", () => {
  const db = migratedDb();
  applyOp(db, { type: "add_item", date: day, lane: "fitness", title: "Legs" }, { now });
  applyOp(db, { type: "set_item_status", item_id: 1, status: "done" }, { now });
  assert.equal(db.all<{ status: string }>("SELECT status FROM plan_item")[0].status, "done");
  undoLast(db, { now });
  assert.equal(db.all<{ status: string }>("SELECT status FROM plan_item")[0].status, "planned");
});

test("version bumps on every edit to a day, and undo restores it", () => {
  const db = migratedDb();
  const version = () => db.all<{ version: number }>("SELECT version FROM day_plan WHERE date = ?", day)[0].version;
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "A" }, { now });
  assert.equal(version(), 1);
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "B" }, { now });
  assert.equal(version(), 2);
  undoLast(db, { now });
  assert.equal(version(), 1);
});

test("move_item touches both days; undo puts it back", () => {
  const db = migratedDb();
  applyOp(db, { type: "add_item", date: day, lane: "reading", title: "Chapter 3" }, { now });
  applyOp(db, { type: "move_item", item_id: 1, to_date: "2026-10-30" }, { now });
  assert.equal(db.all<{ date: string }>("SELECT date FROM plan_item")[0].date, "2026-10-30");
  assert.equal(count(db, "day_plan"), 2);
  undoLast(db, { now });
  assert.equal(db.all<{ date: string }>("SELECT date FROM plan_item")[0].date, day);
  assert.equal(count(db, "day_plan"), 1, "the day created by the move is removed again");
});

test("undo is stack-ordered and reports when empty", () => {
  const db = migratedDb();
  assert.deepEqual(undoLast(db, { now }), { undone: false, summary: "Nothing to undo." });
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "first" }, { now });
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "second" }, { now });
  assert.match(undoLast(db, { now }).summary, /second/);
  assert.match(undoLast(db, { now }).summary, /first/);
  assert.equal(undoLast(db, { now }).undone, false);
});

test("overrides: create, revoke, undo revoke", () => {
  const db = migratedDb();
  applyOp(db, { type: "set_override", override_type: "TRAVEL", start_date: "2026-10-30", end_date: "2026-11-02" }, { now });
  assert.equal(count(db, "override", "revoked_at IS NULL"), 1);
  applyOp(db, { type: "revoke_override", override_id: 1 }, { now });
  assert.equal(count(db, "override", "revoked_at IS NULL"), 0);
  assert.throws(() => applyOp(db, { type: "revoke_override", override_id: 1 }, { now }), OpError);
  undoLast(db, { now });
  assert.equal(count(db, "override", "revoked_at IS NULL"), 1);
});

test("notes always expire", () => {
  const db = migratedDb();
  applyOp(db, { type: "add_note", lane: "fitness", text: "left shoulder sore", ttl_days: 7 }, { now });
  const n = db.all<{ expires_at: string }>("SELECT expires_at FROM note")[0];
  assert.equal(n.expires_at, "2026-11-02T12:00:00.000Z");
  assert.throws(() => validateOp({ type: "add_note", text: "forever" }), OpError);
  assert.throws(() => validateOp({ type: "add_note", text: "too long", ttl_days: 365 }), OpError);
});

test("advance_pointer walks a list, clamps at finished, and undoes", () => {
  const db = migratedDb();
  db.run("INSERT INTO track (id, title, lane) VALUES ('t', 'T', 'study')");
  db.run("INSERT INTO unit_list (id, track_id, title) VALUES ('dsa', 't', 'DSA')");
  for (let i = 1; i <= 3; i++) db.run("INSERT INTO unit (list_id, ordinal, title) VALUES ('dsa', ?, ?)", i, `u${i}`);

  const at = () => db.all<{ ordinal: number }>("SELECT ordinal FROM pointer WHERE list_id = 'dsa'")[0]?.ordinal;
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  assert.equal(at(), 2, "first advance creates the pointer at 1 then moves to 2");
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  assert.equal(at(), 4, "3 units: ordinal 4 means finished");
  const r = applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  assert.equal(at(), 4, "never runs past finished");
  assert.match(r.summary, /finished/);
  undoLast(db, { now });
  undoLast(db, { now });
  assert.equal(at(), 3);
  assert.throws(() => applyOp(db, { type: "advance_pointer", list_id: "nope" }, { now }), OpError);
});

test("set_config inserts then updates; undo reverts to the earlier value", () => {
  const db = migratedDb();
  applyOp(db, { type: "set_config", key: "lock_time", value: "23:00" }, { now });
  applyOp(db, { type: "set_config", key: "lock_time", value: "22:30" }, { now });
  undoLast(db, { now });
  assert.equal(db.all<{ value: string }>("SELECT value FROM config WHERE key = 'lock_time'")[0].value, "23:00");
  undoLast(db, { now });
  assert.equal(count(db, "config"), 0);
});

test("invalid ops are rejected before anything is written", () => {
  const db = migratedDb();
  const bad: unknown[] = [
    null,
    [],
    { type: "nope" },
    { type: "add_item", date: "2026-02-30", lane: "study", title: "x" },
    { type: "add_item", date: day, lane: "cooking", title: "x" },
    { type: "add_item", date: day, lane: "study", title: "   " },
    { type: "set_override", override_type: "TRAVEL", start_date: "2026-11-02", end_date: "2026-10-30" },
    { type: "set_override", override_type: "VACATION", start_date: day, end_date: day },
    { type: "set_item_status", item_id: 1, status: "moved" },
  ];
  for (const b of bad) assert.throws(() => applyOp(db, b), OpError, JSON.stringify(b));
  assert.equal(count(db, "event"), 0);
});

test("a failing handler rolls back everything, including the day_plan it created", () => {
  const db = migratedDb();
  assert.throws(() => applyOp(db, { type: "add_item", date: day, lane: "study", title: "x", unit_id: 999 }, { now }), OpError);
  assert.equal(count(db, "day_plan"), 0);
  assert.equal(count(db, "event"), 0);
});

test("stale expected version is a conflict and writes nothing", () => {
  const db = migratedDb();
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "A" }, { now });
  const key = `day_plan:${day}`;
  applyOp(db, { type: "add_item", date: day, lane: "study", title: "B" }, { now, expectVersions: { [key]: 1 } });
  assert.throws(
    () => applyOp(db, { type: "add_item", date: day, lane: "study", title: "C" }, { now, expectVersions: { [key]: 1 } }),
    VersionConflictError,
  );
  assert.equal(count(db, "plan_item"), 2);
  // A day that does not exist yet has version 0.
  applyOp(db, { type: "add_item", date: "2026-11-05", lane: "study", title: "D" }, { now, expectVersions: { "day_plan:2026-11-05": 0 } });
});

test("note op writes an event and a no-op revision", () => {
  const db = migratedDb();
  const r = applyOp(db, { type: "note", text: "felt great today" }, { now, raw: "felt great today", source: "telegram" });
  assert.equal(r.summary, "Note: felt great today");
  assert.equal(count(db, "event", "source='telegram' AND raw IS NOT NULL"), 1);
  assert.equal(undoLast(db, { now }).undone, true);
});
