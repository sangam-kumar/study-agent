import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, undoLast } from "../src/ops.ts";
import type { Op } from "../src/ops.ts";
import { editDistance, findExercise, loadCatalog, suggestExercise } from "../src/exercises.ts";
import { diffSessions, loadSession, parseExerciseEdit, reconcileWorkout, renameInOp, setsText, unsureNames } from "../src/fitness.ts";
import type { LogWorkoutOp } from "../src/fitness.ts";
import { count, migratedDb } from "./helpers.ts";

const DAY = "2026-11-05";
const BENCH = "Flat Dumbbell Bench Press"; // the catalog name "Bench Press" resolves to
const now = () => new Date("2026-11-05T05:00:00.000Z");

type Ex = LogWorkoutOp["exercises"][number];
const S = (weight: number | null, reps: number | null) => ({
  weight_kg: weight, reps, duration_s: null, rest_s: null, kind: "working" as const, bw: false, notes: null, incomplete: false,
});
const ex = (name: string, ...sets: [number, number][]): Ex => ({ name, sets: sets.map(([w, r]) => S(w, r)) });
const op = (mode: "append" | "replace", ...exercises: Ex[]): LogWorkoutOp => ({ type: "log_workout", date: DAY, mode, exercises, ...{} });

const apply = (db: ReturnType<typeof migratedDb>, o: Op) => applyOp(db, o, { now, source: "telegram" });
const sets = (db: ReturnType<typeof migratedDb>, name: string) => setsText(loadSession(db, DAY)!.exercises.find((e) => e.name === name)!.sets, true);

function logged() {
  const db = migratedDb();
  apply(db, op("append", ex("Bench Press", [20, 15], [20, 15], [20, 15]), ex("Seated Row", [30, 12], [30, 12])));
  return db;
}

test("the same log sent again is recognised and nothing is added", () => {
  const db = logged();
  const r = reconcileWorkout(db, op("append", ex("Bench Press", [20, 15], [20, 15], [20, 15]), ex("Seated Row", [30, 12], [30, 12])));
  assert.equal(r.op, null);
  assert.deepEqual(r.unchanged, [BENCH, "Seated Row"]);
  assert.equal(count(db, "session_set"), 5);
});

test("earlier sets repeated plus new ones: only the new sets are added", () => {
  const db = logged();
  const r = reconcileWorkout(db, op("append", ex("Seated Row", [30, 12], [30, 12], [32.5, 10])));
  assert.deepEqual(r.extended, [{ name: "Seated Row", added: 1 }]);
  assert.equal(r.op?.exercises[0].sets.length, 1);
  apply(db, r.op!);
  assert.equal(sets(db, "Seated Row"), "30x12, 30x12, 32.5x10");
});

test("the whole log restated with one set changed: only that set changes, nothing is doubled", () => {
  const db = logged();
  const restated = op("append", ex("Bench Press", [20, 15], [20, 15], [20, 12]), ex("Seated Row", [30, 12], [30, 12]));
  const before = loadSession(db, DAY);
  const r = reconcileWorkout(db, restated);
  assert.deepEqual(r.unchanged, ["Seated Row"]);
  assert.deepEqual(r.restated, [BENCH]);
  assert.equal(r.op?.exercises.length, 1);
  assert.equal(r.op?.exercises[0].mode, "replace");
  apply(db, r.op!);
  assert.equal(count(db, "session_set"), 5, "still five sets");
  assert.equal(sets(db, BENCH), "20x15, 20x15, 20x12");

  const diff = diffSessions(before, loadSession(db, DAY));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.lines, [`${BENCH}: set 3 20×15 → 20×12`]);
});

test("new sets with different values are appended, as before", () => {
  const db = logged();
  const next = op("append", ex("Bench Press", [25, 10]));
  assert.deepEqual(reconcileWorkout(db, next).op, next);
  const oneMore = op("append", ex("Bench Press", [20, 15]));
  const r = reconcileWorkout(db, oneMore);
  assert.deepEqual(r.op, oneMore, "one more set like the earlier ones is a new set, not a repeat");
  assert.deepEqual(r.unchanged, []);
});

test("an exercise not in the session yet, or a model-set replace, passes through untouched", () => {
  const db = logged();
  const fresh = op("append", ex("Lat Pulldown", [25, 15]));
  assert.deepEqual(reconcileWorkout(db, fresh).op, fresh);
  const replace = op("replace", ex("Bench Press", [22.5, 10]));
  const r = reconcileWorkout(db, replace);
  assert.deepEqual(r.op, replace);
  apply(db, r.op!);
  assert.equal(sets(db, BENCH), "22.5x10");
});

test("an unchanged log with a pain note keeps the note", () => {
  const db = logged();
  const r = reconcileWorkout(db, { ...op("append", ex("Seated Row", [30, 12], [30, 12])), pain: "left shoulder" });
  assert.ok(r.op, "kept so the pain note is stored");
  apply(db, r.op!);
  assert.equal(sets(db, "Seated Row"), "30x12, 30x12");
  assert.equal(loadSession(db, DAY)!.pain_notes, "left shoulder");
});

test("a per-exercise mode wins over the op's mode", () => {
  const db = logged();
  apply(db, op("append", { ...ex("Bench Press", [22.5, 8]), mode: "replace" }, ex("Seated Row", [35, 10])));
  assert.equal(sets(db, BENCH), "22.5x8");
  assert.equal(sets(db, "Seated Row"), "30x12, 30x12, 35x10");
});

test("the corrected verb is used only when something was replaced", () => {
  const db = logged();
  assert.match(apply(db, op("append", ex("Lat Pulldown", [25, 15]))).summary, /^Logged /);
  assert.match(apply(db, op("append", { ...ex("Lat Pulldown", [25, 12]), mode: "replace" })).summary, /^Corrected /);
});

test("learn: a confirmed spelling becomes an alias, in the same undoable step", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));
  assert.equal(findExercise(db, "face full"), null);
  apply(db, op("append", { ...ex("Face Pull", [15, 12]), learn: "face full" }));
  assert.equal(findExercise(db, "face full")?.canonical_name, "Face Pull");
  apply(db, op("append", { ...ex("face full", [15, 10]), learn: "face full" })); // learning twice adds nothing
  assert.deepEqual(JSON.parse(findExercise(db, "Face Pull")!.aliases_json), ["face full"]);
  undoLast(db);
  undoLast(db);
  assert.equal(findExercise(db, "face full"), null, "undo removes the alias with the sets");
});

test("diffSessions: added sets are not a 'change', removals and edits are", () => {
  const db = logged();
  const before = loadSession(db, DAY);
  apply(db, op("append", ex("Lat Pulldown", [25, 15]), ex("Seated Row", [35, 10])));
  const added = diffSessions(before, loadSession(db, DAY));
  assert.equal(added.changed, false);
  assert.deepEqual(added.lines, ["Seated Row: + set 3 35×10", "+ Lat Pulldown: 25×15"]);
  assert.deepEqual(diffSessions(loadSession(db, DAY), before).lines.slice(-1), ["− Lat Pulldown removed"]);
  assert.equal(diffSessions(loadSession(db, DAY), before).changed, true);
  assert.deepEqual(diffSessions(null, null), { lines: [], changed: false });
});

// ------------------------------------------------- near-matches for exercise names (16.3)

test("editDistance counts a swapped pair of letters as one change", () => {
  assert.equal(editDistance("pull", "full"), 1);
  assert.equal(editDistance("press", "prses"), 1);
  assert.equal(editDistance("row", "row"), 0);
  assert.equal(editDistance("", "abc"), 3);
});

test("a misspelling is suggested; a known name, a new exercise and a short word are not", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));
  const rows = loadCatalog(db);
  assert.equal(suggestExercise(rows, "face full")?.canonical_name, "Face Pull");
  assert.equal(suggestExercise(rows, "Face Pul")?.canonical_name, "Face Pull");
  assert.equal(suggestExercise(rows, "lat pulldwn")?.canonical_name, "Lat Pulldown");
  assert.equal(suggestExercise(rows, "pec dek")?.canonical_name, "Pec Deck Fly");
  assert.equal(suggestExercise(rows, "Face Pull"), null, "already resolves");
  assert.equal(suggestExercise(rows, "lat pull down"), null, "already resolves through the alias rules");
  assert.equal(suggestExercise(rows, "Cable Crossover"), null, "genuinely new");
  assert.equal(suggestExercise(rows, "Incline Dumbbell Curl"), null, "close in words, far in letters");
  assert.equal(suggestExercise(rows, "dip"), null, "too short to guess");
});

test("the 'face full' story: asked once, confirmed, and remembered", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));

  const typed = op("append", ex("face full", [15, 12], [15, 10]));
  const asked = unsureNames(db, typed);
  assert.deepEqual(asked, [{ typed: "face full", suggestion: "Face Pull" }]);
  assert.equal(count(db, "exercise_catalog", "canonical_name LIKE 'Face%'"), 1, "nothing was created while asking");

  apply(db, renameInOp(typed, { "face full": "Face Pull" }));
  assert.equal(count(db, "exercise_catalog", "canonical_name LIKE 'Face%'"), 1, "no second exercise");
  assert.equal(sets(db, "Face Pull"), "15x12, 15x12, 15x10");

  assert.deepEqual(unsureNames(db, op("append", ex("face full", [15, 8]))), [], "next time it resolves by itself");
  assert.equal(findExercise(db, "face full")?.canonical_name, "Face Pull");
});

test("choosing 'new' keeps the typed name as a new exercise", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));
  apply(db, op("append", ex("face full", [10, 10])));
  assert.equal(count(db, "exercise_catalog", "canonical_name LIKE 'Face%'"), 2);
});

test("only unknown names are asked about; several are collected once", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));
  const asked = unsureNames(db, op("append", ex("Lat Pulldown", [25, 15]), ex("face full", [15, 12]), ex("Face Full", [15, 10]), ex("lat pulldwn", [25, 12])));
  assert.deepEqual(asked.map((a) => a.suggestion), ["Face Pull", "Lat Pulldown"]);
});

// ------------------------------------------------------ edits after the fact (16.4)

const names = (db: ReturnType<typeof migratedDb>) => loadSession(db, DAY)?.exercises.map((e) => e.name) ?? [];
const catalogNames = (db: ReturnType<typeof migratedDb>, like: string) =>
  db.all<{ canonical_name: string }>("SELECT canonical_name FROM exercise_catalog WHERE canonical_name LIKE ?", like).map((r) => r.canonical_name);

function withTypo() {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12]), ex("Seated Row", [30, 12])));
  apply(db, op("append", ex("face full", [15, 10], [15, 10]))); // the typo became its own exercise
  return db;
}

test("rename: the typo's sets are merged into the right exercise and the typo is forgotten", () => {
  const db = withTypo();
  assert.deepEqual(names(db), ["Face Pull", "Seated Row", "Face Full"]);
  const res = apply(db, { type: "rename_exercise", date: DAY, from: "face full", to: "face pull" });
  assert.equal(res.summary, "Merged Face Full into Face Pull");
  assert.deepEqual(names(db), ["Face Pull", "Seated Row"]);
  assert.equal(sets(db, "Face Pull"), "15x12, 15x10, 15x10");
  assert.deepEqual(catalogNames(db, "Face%"), ["Face Pull"], "the wrong catalog entry is gone");
  assert.equal(findExercise(db, "face full")?.canonical_name, "Face Pull", "and the spelling is an alias");

  undoLast(db);
  assert.deepEqual(names(db), ["Face Pull", "Seated Row", "Face Full"], "undo restores both exercises");
  assert.deepEqual(catalogNames(db, "Face%").sort(), ["Face Full", "Face Pull"]);
  assert.equal(sets(db, "Face Full"), "15x10, 15x10");
  assert.equal(sets(db, "Face Pull"), "15x12");
});

test("rename: an exercise alone in the session is renamed in place", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Face Pull", [15, 12])));
  db.run("DELETE FROM session_set");
  db.run("DELETE FROM session_exercise");
  db.run("DELETE FROM workout_session");
  apply(db, op("append", ex("face full", [15, 10])));
  const res = apply(db, { type: "rename_exercise", date: DAY, from: "face full", to: "Face Pull" });
  assert.equal(res.summary, "Renamed Face Full to Face Pull");
  assert.deepEqual(names(db), ["Face Pull"]);
  assert.equal(sets(db, "Face Pull"), "15x10");
  assert.deepEqual(catalogNames(db, "Face%"), ["Face Pull"]);
});

test("rename: a seeded exercise is never deleted, and a brand-new target is created", () => {
  const db = migratedDb();
  apply(db, op("append", ex("Lat Pulldown", [25, 15])));
  apply(db, { type: "rename_exercise", date: DAY, from: "lat pulldown", to: "Cable Crossover" });
  assert.deepEqual(names(db), ["Cable Crossover"]);
  assert.equal(catalogNames(db, "Lat Pulldown").length, 1, "the seeded Lat Pulldown stays in the catalog");
});

test("edits explain themselves when they cannot act", () => {
  const db = withTypo();
  assert.throws(() => apply(db, { type: "rename_exercise", date: DAY, from: "squat", to: "Face Pull" }), /can't find "squat" .*Face Pull, Seated Row, Face Full/);
  assert.throws(() => apply(db, { type: "rename_exercise", date: DAY, from: "Seated Row", to: "seated rowing" }), /already Seated Row/);
  assert.throws(() => apply(db, { type: "rename_exercise", date: "2026-11-04", from: "x", to: "y" }), /No workout is logged for 2026-11-04/);
  assert.throws(() => apply(db, { type: "amend_set", date: DAY, exercise: "Seated Row", set_no: 4, reps: 8 }), /no set 4/);
  assert.throws(() => apply(db, { type: "amend_set", date: DAY, exercise: "Seated Row", set_no: 1 } as never), /new weight, reps or duration/);
});

test("amend_set changes one set and undo puts it back", () => {
  const db = logged();
  const res = apply(db, { type: "amend_set", date: DAY, exercise: "bench", set_no: 2, reps: 10 });
  assert.equal(res.summary, `${BENCH} set 2: 20×15 → 20×10`);
  assert.equal(sets(db, BENCH), "20x15, 20x10, 20x15");
  apply(db, { type: "amend_set", date: DAY, exercise: "bench", set_no: 3, weight_kg: 22.5, reps: 8 });
  assert.equal(sets(db, BENCH), "20x15, 20x10, 22.5x8");
  undoLast(db);
  undoLast(db);
  assert.equal(sets(db, BENCH), "20x15, 20x15, 20x15");
});

test("remove_exercise removes the sets; removing the last exercise removes the session; undo brings it back", () => {
  const db = logged();
  assert.equal(apply(db, { type: "remove_exercise", date: DAY, exercise: "seated row" }).summary, "Removed Seated Row (2 sets)");
  assert.deepEqual(names(db), [BENCH]);
  assert.equal(count(db, "session_set"), 3);
  apply(db, { type: "remove_exercise", date: DAY, exercise: "bench" });
  assert.equal(loadSession(db, DAY), null, "no exercises left, so no workout that day");
  undoLast(db);
  assert.deepEqual(names(db), [BENCH]);
  assert.equal(sets(db, BENCH), "20x15, 20x15, 20x15");
  undoLast(db);
  assert.deepEqual(names(db), [BENCH, "Seated Row"]);
});

test("edit phrases are read in plain words, only when the exercise is in today's session", () => {
  const db = withTypo();
  const edit = (t: string, last: string[] = []) => parseExerciseEdit(db, t, DAY, last);

  assert.deepEqual(edit("face full should be face pull"), { type: "rename_exercise", date: DAY, from: "face full", to: "face pull" });
  assert.deepEqual(edit("Face full is actually face pull."), { type: "rename_exercise", date: DAY, from: "Face full", to: "face pull" });
  assert.deepEqual(edit("it was face pull, not face full"), { type: "rename_exercise", date: DAY, from: "face full", to: "face pull" });
  assert.deepEqual(edit("no, it was face pull not face full"), { type: "rename_exercise", date: DAY, from: "face full", to: "face pull" });

  // "no, face pull" refers to the one exercise the last log touched
  assert.deepEqual(edit("no, face pull", ["Face Full"]), { type: "rename_exercise", date: DAY, from: "Face Full", to: "Face Pull" });
  assert.equal(edit("no, face pull", []), null, "nothing to refer to");
  assert.equal(edit("no, face pull", ["Face Full", "Seated Row"]), null, "two exercises: ambiguous");
  assert.equal(edit("no, face pull", ["Face Pull"]), null, "already that exercise");
  assert.equal(edit("no thanks", ["Face Full"]), null);

  assert.deepEqual(edit("set 2 of seated row was 10 reps"), { type: "amend_set", date: DAY, exercise: "seated row", set_no: 2, reps: 10 });
  assert.deepEqual(edit("seated row set 1 was 32.5x10"), { type: "amend_set", date: DAY, exercise: "seated row", set_no: 1, weight_kg: 32.5, reps: 10 });
  assert.deepEqual(edit("2nd set of face pull is 20 kg"), { type: "amend_set", date: DAY, exercise: "face pull", set_no: 2, weight_kg: 20 });
  assert.deepEqual(edit("seated row set 2 was 10 not 12"), { type: "amend_set", date: DAY, exercise: "seated row", set_no: 2, reps: 10 });

  assert.deepEqual(edit("remove seated row"), { type: "remove_exercise", date: DAY, exercise: "seated row" });
  assert.deepEqual(edit("delete face full from today's workout"), { type: "remove_exercise", date: DAY, exercise: "face full" });
});

test("ordinary sentences are not edits", () => {
  const db = withTypo();
  for (const t of [
    "bench should be 22.5x10", // a value, not a name
    "squat should be face pull", // not in the session
    "remove the reminder",
    "drop Sapiens",
    "delete squat",
    "set 2 of squat was 10 reps",
    "what should be my protein today",
    "the gym was actually fun",
    "",
    "x".repeat(200),
  ]) assert.equal(parseExerciseEdit(db, t, DAY, ["Face Full"]), null, t);
  assert.equal(parseExerciseEdit(db, "set 2 of seated row was 10 reps", "2026-11-04"), null, "no session that day");
});

test("workout announcement without sets is recognised", async () => {
  const { parseWorkoutAnnouncement } = await import("../src/fitness.ts");
  assert.equal(parseWorkoutAnnouncement("Today's workout\nLegs/Shoulders"), "Legs/Shoulders");
  assert.equal(parseWorkoutAnnouncement("workout today: back and biceps."), "back and biceps");
  assert.equal(parseWorkoutAnnouncement("todays gym - chest"), "chest");
  assert.equal(parseWorkoutAnnouncement("Today's workout\nbench 20x12"), null);
  assert.equal(parseWorkoutAnnouncement("today's workout"), null);
  assert.equal(parseWorkoutAnnouncement("how was today's workout going to be"), null);
});
