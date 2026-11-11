import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMIT, MAX_LIMIT, VIEWS, ViewError, listViews, readView, toCsv } from "../src/views.ts";
import { istWallToMs } from "../src/time.ts";
import { migratedDb } from "./helpers.ts";
import type { Db } from "../src/db/db.ts";

const NOW = istWallToMs("2026-11-06", "12:00");

/** One row in every table a view reads, so the declared columns can be checked against real output. */
function seeded(): Db {
  const db = migratedDb();
  db.run("INSERT INTO event (ts, type, lane, source, raw) VALUES ('2026-11-05T05:00:00.000Z', 'note', 'fitness', 'telegram', 'hello')");
  db.run("INSERT INTO revision (ts, event_id, summary, op_json, diff_json) VALUES ('2026-11-05T05:00:00.000Z', 1, 'Logged 3 sets', '{}', '[]')");
  db.run("INSERT INTO interaction_logs (source, raw_content, parsed_json, created_at) VALUES ('telegram_text', 'bench 20x15', '{}', '2026-11-05 05:00:00')");
  db.run("INSERT INTO chat_log (ts, dir, tg_message_id, text, tag) VALUES ('2026-11-05T05:00:00.000Z', 'out', 11, 'Tomorrow: Gym', 'evening_recap')");
  db.run("INSERT INTO feedback (ts, date, kind, text, status) VALUES ('2026-11-05T05:00:00.000Z', '2026-11-05', 'bug', 'duplicated sets', 'open')");
  db.run("INSERT INTO inbox (raw, ts) VALUES ('???', '2026-11-05T05:00:00.000Z')");
  db.run("INSERT INTO day_plan (date, status, locked_by) VALUES ('2026-11-05', 'locked', 'auto')");
  db.run("INSERT INTO plan_item (date, lane, title, source, status) VALUES ('2026-11-05', 'fitness', 'Gym: Back', 'pattern', 'done')");
  db.run("INSERT INTO workout_session (date, title, created_at) VALUES ('2026-11-05', 'Back', '2026-11-05T05:00:00.000Z')");
  db.run("INSERT INTO session_exercise (session_id, ordinal, display_name) VALUES (1, 2, 'Seated Row')");
  db.run("INSERT INTO session_exercise (session_id, ordinal, display_name) VALUES (1, 1, 'Lat Pulldown')");
  db.run("INSERT INTO session_set (session_exercise_id, set_no, reps, weight_kg) VALUES (1, 2, 12, 40)");
  db.run("INSERT INTO session_set (session_exercise_id, set_no, reps, weight_kg) VALUES (1, 1, 15, 35)");
  db.run("INSERT INTO session_set (session_exercise_id, set_no, reps, weight_kg) VALUES (2, 1, 10, 30)");
  db.run("INSERT INTO metric_log (date, metric, value, ts) VALUES ('2026-11-05', 'protein_g', 96, '2026-11-05T15:00:00.000Z')");
  db.run("INSERT INTO reminders (reminder_type, trigger_at, status, text) VALUES ('custom', ?, 'pending', 'call the bank')", Date.UTC(2026, 10, 7, 10, 30));
  db.run("INSERT INTO reading_item (title, state) VALUES ('Shoe Dog', 'active')");
  db.run("INSERT INTO jot (reading_id, text, created_at) VALUES (1, 'a thought', '2026-11-05T05:00:00.000Z')");
  db.run("INSERT INTO track (id, title, lane) VALUES ('t1', 'DSA', 'study')");
  db.run("INSERT INTO unit_list (id, track_id, title) VALUES ('l1', 't1', 'Arrays')");
  db.run("INSERT INTO unit (list_id, ordinal, title) VALUES ('l1', 1, 'Two Sum')");
  db.run("INSERT INTO unit (list_id, ordinal, title) VALUES ('l1', 2, 'Majority Element')");
  db.run("INSERT INTO pointer (list_id, ordinal, updated_at) VALUES ('l1', 2, '2026-11-05T05:00:00.000Z')");
  db.run("INSERT INTO override (type, start_date, end_date, created_at) VALUES ('TRAVEL', '2026-11-08', '2026-11-10', '2026-11-05T05:00:00.000Z')");
  db.run("INSERT INTO note (lane, text, created_at, expires_at) VALUES ('fitness', 'shoulder', '2026-11-05T05:00:00.000Z', '2026-11-12T05:00:00.000Z')");
  return db;
}

test("every view is listed with a description, and every view runs on an empty database", () => {
  const listed = listViews();
  assert.deepEqual(listed.map((v) => v.name).sort(), Object.keys(VIEWS).sort());
  const db = migratedDb();
  for (const v of listed) {
    assert.ok(v.description.length > 10, `${v.name} has a description`);
    assert.ok(v.params.includes("limit"));
    const r = readView(db, v.name, {}, NOW);
    assert.equal(r.count, 0, v.name);
    assert.equal(r.truncated, false);
  }
});

test("each view returns exactly the columns it declares", () => {
  const db = seeded();
  for (const name of Object.keys(VIEWS)) {
    const r = readView(db, name, {}, NOW);
    assert.ok(r.rows.length >= 1, `${name} returned a seeded row`);
    assert.deepEqual(Object.keys(r.rows[0]), r.columns, name);
  }
});

test("tables that are not views cannot be read", () => {
  const db = seeded();
  for (const name of ["bot_state", "config", "processed_update", "mirror_state", "sqlite_master", "event; DROP TABLE event", "constructor", "__proto__"]) {
    assert.throws(() => readView(db, name, {}, NOW), ViewError, name);
  }
});

test("a date range follows the user's day, which turns over at 03:00 IST", () => {
  const db = migratedDb();
  // The 5th runs from 21:30Z on the 4th to 21:30Z on the 5th.
  db.run("INSERT INTO event (ts, type, source) VALUES ('2026-11-04T21:00:00.000Z', 'x', 'system')"); // 02:30 IST on the 5th: still the 4th
  db.run("INSERT INTO event (ts, type, source) VALUES ('2026-11-04T22:00:00.000Z', 'x', 'system')"); // 03:30 IST on the 5th
  db.run("INSERT INTO event (ts, type, source) VALUES ('2026-11-05T21:00:00.000Z', 'x', 'system')"); // 02:30 IST on the 6th: still the 5th
  db.run("INSERT INTO event (ts, type, source) VALUES ('2026-11-05T22:00:00.000Z', 'x', 'system')"); // 03:30 IST on the 6th
  const fifth = readView(db, "events", { from: "2026-11-05", to: "2026-11-05" }, NOW);
  assert.deepEqual(fifth.rows.map((r) => r.ts), ["2026-11-05T21:00:00.000Z", "2026-11-04T22:00:00.000Z"]);
  assert.equal(readView(db, "events", { from: "2026-11-06" }, NOW).count, 1, "from alone is open-ended");
  assert.equal(readView(db, "events", { to: "2026-11-04" }, NOW).count, 1, "to alone is open-ended");
});

test("messages filter on the SQLite UTC timestamp format", () => {
  const db = migratedDb();
  db.run("INSERT INTO interaction_logs (source, raw_content, created_at) VALUES ('telegram_text', 'in', '2026-11-05 10:00:00')");
  db.run("INSERT INTO interaction_logs (source, raw_content, created_at) VALUES ('telegram_text', 'out', '2026-11-06 10:00:00')");
  const r = readView(db, "messages", { from: "2026-11-05", to: "2026-11-05" }, NOW);
  assert.deepEqual(r.rows.map((x) => x.raw_content), ["in"]);
});

test("filters: event type, metric, inbox status, reading state, reminder status", () => {
  const db = seeded();
  db.run("INSERT INTO event (ts, type, source) VALUES ('2026-11-05T06:00:00.000Z', 'nudge.sent', 'system')");
  assert.deepEqual(readView(db, "events", { type: "nudge.sent" }, NOW).rows.map((r) => r.type), ["nudge.sent"]);
  db.run("INSERT INTO metric_log (date, metric, value, ts) VALUES ('2026-11-05', 'sleep_h', 7, '2026-11-05T15:00:00.000Z')");
  assert.deepEqual(readView(db, "metrics", { metric: "sleep_h" }, NOW).rows.map((r) => r.value), [7]);
  assert.equal(readView(db, "inbox", {}, NOW).count, 1);
  assert.equal(readView(db, "inbox", { status: "resolved" }, NOW).count, 0);
  assert.equal(readView(db, "reading", { state: "done" }, NOW).count, 0);
  assert.equal(readView(db, "reading", { state: "active" }, NOW).count, 1);
  assert.equal(readView(db, "reminders", { status: "cancelled" }, NOW).count, 0);
});

test("date-column views default to a recent window and honour from / to", () => {
  const db = seeded(); // data on the 5th, "today" is the 6th
  assert.equal(readView(db, "plan", {}, NOW).count, 1);
  assert.equal(readView(db, "sessions", {}, NOW).count, 3);
  assert.equal(readView(db, "plan", { from: "2026-11-06" }, NOW).count, 0);
  assert.equal(readView(db, "plan", { from: "2026-11-05", to: "2026-11-05" }, NOW).count, 1);
  const later = istWallToMs("2026-12-20", "12:00");
  assert.equal(readView(db, "plan", {}, later).count, 0, "the 7-day window has moved on");
  assert.equal(readView(db, "metrics", {}, istWallToMs("2026-11-30", "12:00")).count, 1, "the 30-day window still reaches the 5th");
  assert.deepEqual(readView(db, "plan", {}, NOW).params, { to: "2026-11-06", from: "2026-10-31", limit: DEFAULT_LIMIT });
});

test("sessions is one row per set, in exercise then set order, and keeps exercises with no sets", () => {
  const db = seeded();
  db.run("INSERT INTO session_exercise (session_id, ordinal, display_name) VALUES (1, 3, 'Face Pull')");
  const rows = readView(db, "sessions", {}, NOW).rows;
  assert.deepEqual(rows.map((r) => [r.exercise, r.set_no]), [["Lat Pulldown", 1], ["Seated Row", 1], ["Seated Row", 2], ["Face Pull", null]]);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.reps, r.weight_kg]), [[10, 30], [15, 35], [12, 40]]);
});

test("reminders show their due time as an ISO instant", () => {
  const r = readView(seeded(), "reminders", {}, NOW).rows[0];
  assert.equal(r.due_at, "2026-11-07T10:30:00.000Z");
  assert.equal(r.text, "call the bank");
  assert.ok(!("trigger_at" in r));
});

test("pointers say where each list stands", () => {
  assert.deepEqual(readView(seeded(), "pointers", {}, NOW).rows.map((r) => ({ ...r })), [
    { list_id: "l1", list: "Arrays", ordinal: 2, total: 2, current: "Majority Element" },
  ]);
});

test("limit: default, cap, truncation flag and bad values", () => {
  const db = migratedDb();
  for (let i = 0; i < 5; i++) db.run("INSERT INTO event (ts, type, source) VALUES (?, 'x', 'system')", `2026-11-05T0${i}:00:00.000Z`);
  const two = readView(db, "events", { limit: "2" }, NOW);
  assert.equal(two.count, 2);
  assert.equal(two.truncated, true);
  assert.deepEqual(two.rows.map((r) => r.id), [5, 4], "newest first");
  assert.equal(readView(db, "events", { limit: "5" }, NOW).truncated, false);
  assert.equal(readView(db, "events", { limit: "99999" }, NOW).params.limit, MAX_LIMIT);
  assert.equal(readView(db, "events", {}, NOW).params.limit, DEFAULT_LIMIT);
  for (const bad of ["0", "-1", "abc", "1.5", ""]) assert.throws(() => readView(db, "events", { limit: bad }, NOW), /limit/, bad);
});

test("bad parameters are errors, not guesses", () => {
  const db = migratedDb();
  assert.throws(() => readView(db, "events", { colour: "red" }, NOW), /unknown parameter "colour"/);
  assert.throws(() => readView(db, "jots", { from: "2026-11-05" }, NOW), /unknown parameter "from"/);
  assert.throws(() => readView(db, "events", { from: "5 Nov" }, NOW), /date like/);
  assert.throws(() => readView(db, "events", { from: "2026-02-31" }, NOW), /date like/);
  assert.throws(() => readView(db, "events", { from: "2026-11-06", to: "2026-11-05" }, NOW), /not be after/);
  assert.throws(() => readView(db, "inbox", { status: "bogus" }, NOW), /status must be one of/);
  assert.throws(() => readView(db, "reading", { state: "x' OR '1'='1" }, NOW), /state must be one of/);
});

test("a value that looks like SQL is only ever a bound value", () => {
  const db = seeded();
  const r = readView(db, "events", { type: "note' OR '1'='1" }, NOW);
  assert.equal(r.count, 0);
  assert.equal(readView(db, "events", {}, NOW).count, 1, "the table is intact");
});

test("CSV: header first, quoting, empty cells, and a guard against spreadsheet formulas", () => {
  const cols = ["id", "text", "n"];
  assert.equal(toCsv(cols, []), "id,text,n\r\n");
  const csv = toCsv(cols, [
    { id: 1, text: 'say "hi", then\nleave', n: null },
    { id: 2, text: "=SUM(A1:A9)", n: -3 },
    { id: 3, text: "plain", n: 0.5 },
  ]);
  assert.equal(csv, 'id,text,n\r\n1,"say ""hi"", then\nleave",\r\n2,\'=SUM(A1:A9),-3\r\n3,plain,0.5\r\n');
});
