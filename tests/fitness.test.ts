import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { applyOp, undoLast } from "../src/ops.ts";
import { loadConfigSeed } from "../src/seed-config.ts";
import { ensureDraft, getConfig, loadItems, renderEvening } from "../src/day.ts";
import { renderDailyBlock } from "../src/mirror.ts";
import { findExercise, matchExercise, loadCatalog, normalizeName } from "../src/exercises.ts";
import {
  closeOpenSessions, findRepeat, importGymLog, loadSession, migrateV1Workouts,
  renderGymWeek, renderLiftHistory, weekFitness, weeklyFitnessParts,
} from "../src/fitness.ts";
import type { LogWorkoutOp } from "../src/fitness.ts";
import { istWallToMs } from "../src/time.ts";
import { count, migratedDb, parseChatWorkout } from "./helpers.ts";

const MON = "2026-11-02"; // a GYM day in the seeded pattern
const TUE = "2026-11-03";
const THU = "2026-11-05"; // REST
const SUN = "2026-11-08"; // REST, never upgraded
const at = (date: string, hhmm: string) => istWallToMs(date, hhmm);
const nowAt = (date: string, hhmm = "09:00") => () => new Date(at(date, hhmm));

function world() {
  const db = migratedDb();
  loadConfigSeed(db, {
    config: { gym_wake_by: "07:00" },
    lanes: [{ name: "fitness", status: "active" }],
    targets: [
      { lane: "fitness", metric: "lift_sessions", period: "week", floor: 2, goal: 3 },
      { lane: "fitness", metric: "mobility_sessions", period: "week", floor: 1, goal: 2 },
      { lane: "fitness", metric: "protein_g_avg", period: "week", floor: 90, goal: 120 },
    ],
    pattern: [
      { weekday: 0, kind: "GYM" }, { weekday: 1, kind: "MOBILITY" }, { weekday: 2, kind: "GYM" }, { weekday: 3, kind: "REST" },
      { weekday: 4, kind: "GYM" }, { weekday: 5, kind: "MOBILITY" }, { weekday: 6, kind: "REST" },
    ],
    rotation: [
      { lane: "fitness", ordinal: 1, label: "Chest / Triceps" },
      { lane: "fitness", ordinal: 2, label: "Back / Biceps" },
      { lane: "fitness", ordinal: 3, label: "Legs / Shoulders" },
    ],
  }, nowAt(MON, "08:00"));
  return db;
}

const chat = (db: ReturnType<typeof world>, text: string, date = MON) => parseChatWorkout(db, text, at(date, "09:00"));
const log = (db: ReturnType<typeof world>, op: LogWorkoutOp | null, date = MON, hhmm = "09:00") => {
  assert.ok(op, "expected the message to read as sets");
  return applyOp(db, op, { now: nowAt(date, hhmm), source: "telegram" });
};
const gymItem = (db: ReturnType<typeof world>, date: string) => loadItems(db, date).find((i) => i.ref?.startsWith("rotation:"));

// ------------------------------------------------------------------ catalog

test("the catalog is seeded by the migration and knows the names from the gym log", () => {
  const db = world();
  assert.ok(count(db, "exercise_catalog") >= 40);
  const rows = loadCatalog(db);
  const is = (typed: string, canonical: string) => assert.equal(matchExercise(rows, typed)?.canonical_name, canonical, typed);
  is("Lat Pull Up", "Lat Pulldown");
  is("lat pulldown", "Lat Pulldown");
  is("At a Time Hammer Curls DB", "Hammer Curl");
  is("Hammer Dumbbell Curls", "Hammer Curl");
  is("Inclined Flies (DB)", "Incline Dumbbell Fly");
  is("bench", "Flat Dumbbell Bench Press");
  is("Peck/Deck Flies", "Pec Deck Fly");
  is("tricep pushdown", "Triceps Pushdown");
  is("90–90 Hip Rotation", "90-90 Hip Rotation");
  is("Reverse Prone Curls", "Prone Leg Curl");
  assert.equal(matchExercise(rows, "cable crossover"), null);
  assert.equal(normalizeName("Inclined Flies (DB)"), "incline fly dumbbell");
});

// --------------------------------------------------------------- chat input

test("typed sets are read in code; ordinary messages are not mistaken for sets", () => {
  const db = world();
  const op = chat(db, "bench 20x15, 22.5x12, 25x8F");
  assert.equal(op?.exercises[0].name, "bench");
  assert.deepEqual(op?.exercises[0].sets.map((s) => [s.weight_kg, s.reps, s.kind]), [[20, 15, "working"], [22.5, 12, "working"], [25, 8, "failure"]]);

  const multi = chat(db, "lat pulldown\n- 25x15\n- 25x12\nseated row 25x12 25x15");
  assert.deepEqual(multi?.exercises.map((e) => [e.name, e.sets.length]), [["lat pulldown", 2], ["seated row", 2]]);

  assert.equal(chat(db, "yesterday\nleg press 40x15")?.date, "2026-11-01");
  assert.ok(chat(db, "cable crossover 15x12"), "an unknown name with weight x reps is still a workout");
  for (const t of ["call mom 2", "remind me in 10 min", "leg day done", "done with gym", "skip reading today", "did 3 DSA problems", "office tue thu", "plank"]) {
    assert.equal(chat(db, t), null, t);
  }
});


// ----------------------------------------------------------------- sessions

test("two chunks make one session for the day; undo removes only the last chunk", () => {
  const db = world();
  log(db, chat(db, "bench 20x15, 22.5x12"), MON, "08:10");
  log(db, chat(db, "bench 25x8F\nincline press 7x12, 7x12"), MON, "08:20");
  const s = loadSession(db, MON)!;
  assert.equal(count(db, "workout_session"), 1);
  assert.deepEqual(s.exercises.map((e) => [e.name, e.sets.map((x) => x.set_no)]), [["Flat Dumbbell Bench Press", [1, 2, 3]], ["Incline Dumbbell Press", [1, 2]]]);
  assert.equal(s.title, "Chest / Triceps");

  undoLast(db);
  const after = loadSession(db, MON)!;
  assert.deepEqual(after.exercises.map((e) => [e.name, e.sets.length]), [["Flat Dumbbell Bench Press", 2]]);
  undoLast(db);
  assert.equal(loadSession(db, MON), null, "the first chunk's undo removes the session too");
});

test("a correction replaces that exercise's sets", () => {
  const db = world();
  log(db, chat(db, "bench 20x15, 22.5x12, 25x8"));
  const fix = chat(db, "bench 20x15, 22.5x10")!;
  log(db, { ...fix, mode: "replace" });
  assert.deepEqual(loadSession(db, MON)!.exercises[0].sets.map((s) => [s.set_no, s.weight_kg, s.reps]), [[1, 20, 15], [2, 22.5, 10]]);
  undoLast(db);
  assert.equal(loadSession(db, MON)!.exercises[0].sets.length, 3, "undo brings the original sets back");
});

test("a logged lift ticks off the gym item and moves the rotation on, in one undoable change", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  assert.equal(gymItem(db, MON)?.title, "Gym: Chest / Triceps");
  log(db, chat(db, "bench 20x15"));
  assert.equal(gymItem(db, MON)?.status, "done");
  assert.equal(getConfig(db, "rotation.fitness", "1"), "2");
  undoLast(db);
  assert.equal(gymItem(db, MON)?.status, "planned");
  assert.equal(getConfig(db, "rotation.fitness", "1"), "1");
});

test("the split you actually did wins over the one planned", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  log(db, chat(db, "lat pulldown 25x15, 25x15\nhammer curls 7x12"));
  const item = gymItem(db, MON)!;
  assert.equal(item.title, "Gym: Back / Biceps");
  assert.equal(item.status, "done");
  assert.equal(getConfig(db, "rotation.fitness", "1"), "3", "next is Legs / Shoulders");
});

test("lifting on a rest day counts and moves the rotation; a second chunk does not count twice", () => {
  const db = world();
  // Sunday is always rest (Thursday would be upgraded to a gym day here, the floor being at risk).
  ensureDraft(db, SUN, at(SUN, "07:00"));
  assert.equal(gymItem(db, SUN), undefined);
  log(db, chat(db, "leg press 40x15, 40x15", SUN), SUN);
  log(db, chat(db, "leg extension 30x15", SUN), SUN, "09:30");
  const done = loadItems(db, SUN).filter((i) => i.ref?.startsWith("rotation:"));
  assert.equal(done.length, 1);
  assert.equal(done[0].title, "Gym: Legs / Shoulders");
  assert.equal(weekFitness(db, SUN).lifts, 1);
  assert.equal(getConfig(db, "rotation.fitness", "1"), "1", "after Legs / Shoulders the rotation wraps to Chest / Triceps");
});

test("mobility work ticks off the mobility item and counts as mobility, not a lift", () => {
  const db = world();
  ensureDraft(db, TUE, at(TUE, "07:00"));
  log(db, chat(db, "deep squats hold 30s x 3", TUE), TUE);
  assert.equal(loadSession(db, TUE)!.kind, "mobility");
  assert.equal(loadItems(db, TUE).find((i) => /^Mobility/.test(i.title))?.status, "done");
  const w = weekFitness(db, TUE);
  assert.deepEqual([w.lifts, w.mobility], [0, 1]);
});

test("a late chunk reopens the day's closed session instead of starting another", () => {
  const db = world();
  log(db, chat(db, "bench 20x15"));
  closeOpenSessions(db, MON, at(MON, "23:00"));
  assert.equal(loadSession(db, MON)!.status, "closed");
  log(db, chat(db, "triceps pushdown 15x15"), MON, "23:30");
  assert.equal(loadSession(db, MON)!.status, "open");
  assert.equal(count(db, "workout_session"), 1);
});

test("a name never seen before joins the catalog; undo takes it out again", () => {
  const db = world();
  const before = count(db, "exercise_catalog");
  const res = log(db, chat(db, "cable crossover 15x12"));
  assert.match(res.summary, /new: Cable Crossover/);
  assert.equal(count(db, "exercise_catalog"), before + 1);
  assert.equal(findExercise(db, "Cable Crossovers")?.canonical_name, "Cable Crossover");
  undoLast(db);
  assert.equal(count(db, "exercise_catalog"), before);
});

test("pain is kept on the session and as a note that expires in a week", () => {
  const db = world();
  log(db, { ...chat(db, "leg press 40x15")!, pain: "left knee" });
  assert.equal(loadSession(db, MON)!.pain_notes, "left knee");
  const note = db.all<{ text: string; expires_at: string }>("SELECT text, expires_at FROM note")[0];
  assert.equal(note.text, "Pain: left knee");
  assert.ok(note.expires_at.startsWith("2026-11-09"));
});

test("the same sets sent twice within 15 minutes are recognised as a repeat", () => {
  const db = world();
  const op = chat(db, "bench 20x15, 22.5x12")!;
  log(db, op, MON, "08:00");
  assert.ok(findRepeat(db, op, at(MON, "08:05")));
  assert.equal(findRepeat(db, chat(db, "bench 25x8")!, at(MON, "08:05")), null, "different sets are not a repeat");
  assert.equal(findRepeat(db, op, at(MON, "08:30")), null, "after 15 minutes it is a new set");
  undoLast(db);
  assert.equal(findRepeat(db, op, at(MON, "08:05")), null, "an undone chunk is not a repeat");
});

// ---------------------------------------------------------- protein + weekly

test("protein: one number a day, a second one replaces it, undo restores it", () => {
  const db = world();
  applyOp(db, { type: "log_metric", date: MON, metric: "protein_g", value: 80 }, { now: nowAt(MON, "21:00") });
  applyOp(db, { type: "log_metric", date: MON, metric: "protein_g", value: 95 }, { now: nowAt(MON, "21:05") });
  assert.equal(count(db, "metric_log"), 1);
  assert.equal(weekFitness(db, MON).proteinAvg, 95);
  undoLast(db);
  assert.equal(weekFitness(db, MON).proteinAvg, 80);
});

test("the evening line names only what is below its floor; the recap asks for protein until it is logged", () => {
  const db = world();
  applyOp(db, { type: "log_metric", date: MON, metric: "protein_g", value: 70 }, { now: nowAt(MON) });
  applyOp(db, { type: "log_metric", date: TUE, metric: "protein_g", value: 80 }, { now: nowAt(TUE) });
  const parts = weeklyFitnessParts(db, THU);
  assert.ok(parts.includes("lifts 0/2"));
  assert.ok(parts.includes("mobility 0/1"));
  assert.ok(parts.some((p) => p.startsWith("protein 75 g")));
  assert.match(renderEvening(db, "2026-11-04"), /Protein 0 \/ 90 g\. Add with/);
  assert.match(renderEvening(db, MON), /Protein 70 \/ 90 g/);
});

test("/gym and /lift read the history", () => {
  const db = world();
  log(db, chat(db, "bench 20x15, 25x8", "2026-10-26"), "2026-10-26");
  log(db, chat(db, "bench 22.5x12"));
  assert.match(renderGymWeek(db, MON), /Lifts: <b>1<\/b>/);
  const h = renderLiftHistory(db, "flat bench");
  assert.match(h, /Mon 2 Nov — 22.5×12/);
  assert.match(h, /Best: <b>25×8<\/b> \(Mon 26 Oct\)/);
  assert.match(renderLiftHistory(db, "zercher squat"), /don't know/);
});

test("the daily note gets the workout under the plan", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  log(db, chat(db, "bench 20x15, 25x8F"));
  const block = renderDailyBlock(db, MON)!;
  assert.match(block, /\*\*Workout — Chest \/ Triceps\*\* · 1 exercises · 2 sets/);
  assert.match(block, /- Flat Dumbbell Bench Press: 20×15, 25×8 F/);
});

// ------------------------------------------------------------- import + v1

const SAMPLE = `Workout Schedule:
MON- CHEST/TRICEP

## 05/10 — Chest & Triceps

Flat Bench Press DB

- 5 × 15 (1m)
- 7 × 8 (Failed out set)

Peck Machine Flies

## 06/10 — Rest / Lower Mobility

Deep Squats

\\- Hold 30 seconds × 3

Lunge and Stretch

\\- 3 × 8

## 07/10 — Back / Biceps

V-Drop Pull Down

- 20 ×
- 25 ×

Reverse Fly

\\- Crossed out
`;

test("the gym log imports as closed sessions; re-running replaces the import and never a chat session", () => {
  const db = world();
  const nowMs = at(MON, "12:00");
  const r = importGymLog(db, SAMPLE, nowMs);
  assert.deepEqual([r.sessions, r.replaced, r.unreadLines.length], [3, 0, 0]);
  const chest = loadSession(db, "2026-10-05")!;
  assert.equal(chest.title, "Chest & Triceps");
  assert.equal(chest.status, "closed");
  assert.deepEqual(chest.exercises.map((e) => [e.name, e.status, e.sets.length]), [["Flat Dumbbell Bench Press", "done", 2], ["Pec Deck Fly", "partial", 0]]);
  assert.equal(chest.exercises[0].sets[0].rest_s, 60);
  assert.equal(chest.exercises[0].sets[1].kind, "failure");
  const mob = loadSession(db, "2026-10-06")!;
  assert.equal(mob.kind, "mobility");
  assert.deepEqual(mob.exercises.map((e) => e.sets.length), [3, 3]);
  const back = loadSession(db, "2026-10-07")!;
  assert.deepEqual(back.exercises.map((e) => e.status), ["done", "skipped"]);
  assert.equal(r.incomplete.length, 1);
  assert.equal(count(db, "inbox"), 1, "missing reps go to the inbox once");

  log(db, chat(db, "bench 20x15", "2026-10-07"), "2026-10-07");
  db.run("UPDATE workout_session SET source = 'telegram' WHERE date = '2026-10-07'");
  const again = importGymLog(db, SAMPLE, nowMs);
  assert.deepEqual([again.sessions, again.replaced, again.skippedDates], [2, 2, ["2026-10-07"]]);
  assert.equal(count(db, "inbox"), 1);
  assert.equal(count(db, "workout_session"), 3);
});

test("dates after today belong to last year", () => {
  const db = world();
  importGymLog(db, "## 20/12 — Legs\n\nLeg Press\n\n- 40 × 15\n", at(MON, "12:00"));
  assert.ok(loadSession(db, "2025-12-20"));
});

const REAL = "../study-repo/life/gym-tracking.md";
test("the real gym log reads completely", { skip: !existsSync(REAL) && "life/gym-tracking.md not found" }, () => {
  const db = world();
  const r = importGymLog(db, readFileSync(REAL, "utf8"), at(MON, "12:00"));
  assert.deepEqual(r.unreadLines, []);
  assert.equal(r.sessions, 14);
  assert.ok(r.sets > 200, `${r.sets} sets`);
});

test("v1 workout logs move into sessions", () => {
  const db = world();
  db.run(
    "INSERT INTO workout_logs (date, workout_type, exercises_json, notes) VALUES (?, ?, ?, ?)",
    "2026-10-28", "Chest", JSON.stringify([{ name: "Flat Bench", sets: 3, reps: 12, weight_kg: 20 }, { name: "Plank", sets: 1, reps: 0 }]), null,
  );
  assert.equal(migrateV1Workouts(db, at(MON, "12:00")), 1);
  const s = loadSession(db, "2026-10-28")!;
  assert.equal(s.source, "v1");
  assert.deepEqual(s.exercises.map((e) => [e.name, e.sets.length]), [["Flat Dumbbell Bench Press", 3], ["Plank", 0]]);
  assert.equal(migrateV1Workouts(db, at(MON, "12:00")), 0, "running again moves nothing");
});

// ------------------------------------------------------------------ protein as additions (Phase 17)

import { proteinBand, proteinEntries, proteinFor } from "../src/fitness.ts";

test("protein: add accumulates, set corrects, each change is an entry, undo reverses both", () => {
  const db = migratedDb();
  const op = (value: number, mode?: "add" | "set", label?: string) =>
    applyOp(db, { type: "log_metric", date: "2026-11-10", metric: "protein_g", value, ...(mode ? { mode } : {}), ...(label ? { label } : {}) }, { now: () => new Date("2026-11-10T05:00:00Z") });

  assert.match(op(26, "add", "whey").summary, /^whey \+26 → 26 \/ 90 g$/);
  assert.match(op(26, "add", "whey").summary, /^whey \+26 → 52 \/ 90 g$/);
  assert.equal(proteinFor(db, "2026-11-10"), 52);
  assert.match(op(90, "set").summary, /^protein total → 90 g ✓$/);
  assert.deepEqual(proteinEntries(db, "2026-11-10"), [{ label: "whey", grams: 26 }, { label: "whey", grams: 26 }, { label: "total set", grams: 38 }]);
  assert.match(op(40, "add", "soy chunks").summary, /soy chunks \+40 → 130 g, above your 120 g ceiling/);

  undoLast(db);
  assert.equal(proteinFor(db, "2026-11-10"), 90);
  assert.equal(proteinEntries(db, "2026-11-10").length, 3, "the undone entry is gone too");
});

test("protein: a plain set (the old behaviour) still works, and a day from before entries shows the remainder", () => {
  const db = migratedDb();
  db.run("INSERT INTO metric_log (date, metric, value, ts) VALUES ('2026-11-01', 'protein_g', 100, '2026-11-01T15:00:00Z')");
  assert.deepEqual(proteinEntries(db, "2026-11-01"), [{ label: "earlier total", grams: 100 }]);
  applyOp(db, { type: "log_metric", date: "2026-11-01", metric: "protein_g", value: 110, mode: "add", label: "whey" }, { now: () => new Date("2026-11-01T16:00:00Z") });
  assert.equal(proteinFor(db, "2026-11-01"), 210);
  assert.deepEqual(proteinEntries(db, "2026-11-01"), [{ label: "earlier total", grams: 100 }, { label: "whey", grams: 110 }]);
  assert.deepEqual(proteinBand(db), { floor: 90, ceiling: 120 }, "defaults when no target is seeded");
});

test("evening: a prompt only below the floor; in the band one quiet line", () => {
  const db = world();
  const set = (v: number) => applyOp(db, { type: "log_metric", date: MON, metric: "protein_g", value: v, mode: "set" }, { now: () => new Date("2026-11-02T15:00:00Z") });
  set(52);
  assert.match(renderEvening(db, MON), /🥩 Protein 52 \/ 90 g\. Add with e\.g\. <b>whey<\/b>/);
  set(96);
  const ok = renderEvening(db, MON);
  assert.match(ok, /🥩 Protein 96 g ✓/);
  assert.doesNotMatch(ok, /Add with/);
  set(130);
  assert.match(renderEvening(db, MON), /Protein 130 g \(above your 120 g ceiling\)/);
});
