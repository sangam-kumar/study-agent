import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSet, parseExerciseLines, parseSetEntry, parseSets, splitNameAndSets } from "../src/sets.ts";
import type { ExerciseKind, SetEntry } from "../src/sets.ts";

const brief = (sets: SetEntry[] | null) =>
  sets?.map((s) => [s.weight_kg, s.reps, s.duration_s, s.kind, s.bw, s.rest_s, s.incomplete]) ?? null;

test("weight x reps, in every way it gets written", () => {
  for (const t of ["20x15", "20 × 15", "20 X 15", "20kg x 15", "20 kgs x 15 reps", "20*15"]) {
    assert.deepEqual(brief(parseSetEntry(t)), [[20, 15, null, "working", false, null, false]], t);
  }
  assert.deepEqual(brief(parseSetEntry("12.5 × 15")), [[12.5, 15, null, "working", false, null, false]]);
});

test("failure, rest and warm-up markers", () => {
  assert.equal(parseSetEntry("25x8F")![0].kind, "failure");
  assert.equal(parseSetEntry("25x8 F")![0].kind, "failure");
  assert.equal(parseSetEntry("7 × 8 (Failed out set)")![0].kind, "failure");
  assert.equal(parseSetEntry("5 × 15 (1m)")![0].rest_s, 60);
  assert.equal(parseSetEntry("2 × 15 (45s)")![0].rest_s, 45);
  assert.equal(parseSetEntry("w 10x15")![0].kind, "warmup");
  assert.equal(parseSetEntry("20x15 (felt easy)")![0].notes, "felt easy");
});

test("activity entries: weight only, reps only, bodyweight, holds", () => {
  assert.deepEqual(brief(parseSetEntry("7 kg", "activity")), [[7, null, null, "working", false, null, false]]);
  assert.deepEqual(brief(parseSetEntry("30", "activity")), [[30, null, null, "working", false, null, false]]);
  assert.deepEqual(brief(parseSetEntry("15 reps", "activity")), [[null, 15, null, "working", false, null, false]]);
  assert.deepEqual(brief(parseSetEntry("BW × 20")), [[null, 20, null, "working", true, null, false]]);
  assert.deepEqual(brief(parseSetEntry("20", "bodyweight")), [[null, 20, null, "working", false, null, false]]);
  assert.equal(parseSetEntry("Hold 30 seconds × 3", "mobility")!.length, 3);
  assert.equal(parseSetEntry("30s × 3", "mobility")![2].duration_s, 30);
  assert.equal(parseSetEntry("1m")![0].duration_s, 60);
});

test("sets x reps forms expand to one entry per set", () => {
  assert.deepEqual(brief(parseSetEntry("3x15 @ 20")), Array(3).fill([20, 15, null, "working", false, null, false]));
  assert.deepEqual(brief(parseSetEntry("3 sets of 12 at 20kg")), Array(3).fill([20, 12, null, "working", false, null, false]));
  // For a mobility move "3 x 8" is 3 sets of 8, not 3 kg.
  assert.deepEqual(brief(parseSetEntry("3 × 8", "mobility")), Array(3).fill([null, 8, null, "working", false, null, false]));
});

test("missing reps are kept and flagged, not dropped", () => {
  assert.deepEqual(brief(parseSetEntry("20 ×")), [[20, null, null, "working", false, null, true]]);
  assert.equal(formatSet(parseSetEntry("20 ×")![0]), "20×?");
});

test("not a set", () => {
  for (const t of ["", "call mom", "tomorrow", "x", "3 problems", "chapter 2"]) assert.equal(parseSetEntry(t), null, t);
});

test("lists: commas, or spaces between entries", () => {
  assert.equal(parseSets("20x15, 22.5x12, 25x8F")!.length, 3);
  assert.equal(parseSets("25x15 25x15 25x12")!.length, 3);
  assert.deepEqual(parseSets("20 x 15 22 x 12")!.map((s) => [s.weight_kg, s.reps]), [[20, 15], [22, 12]]);
  assert.equal(parseSets("20x15, banana"), null);
});

test("a line splits into the exercise name and its sets", () => {
  const kind = (): ExerciseKind => "weighted";
  assert.deepEqual(splitNameAndSets("flat bench 20x15, 22.5x12", kind)?.name, "flat bench");
  assert.deepEqual(splitNameAndSets("leg press 3 sets of 15 at 40kg", kind)?.sets.length, 3);
  assert.equal(splitNameAndSets("Lat Pull Down", kind), null);
  assert.equal(splitNameAndSets("Mobility Squats (Kettlebell)", kind), null);
});

test("name lines followed by set lines, the way the gym log is written", () => {
  const kinds: Record<string, ExerciseKind> = { "Deep Squats": "mobility", "Calf Raise": "activity" };
  const { exercises, bad } = parseExerciseLines(
    ["Lat Pull Down", "", "- 15 × 15", "- 20 × 15", "Deep Squats", "\\- Hold 30 seconds × 3", "Calf Raise", "- 15 reps", "- 30", "Reverse Fly", "\\- Crossed out", "Peck Machine Flies", "bench 20x15"],
    (n) => kinds[n] ?? "weighted",
  );
  assert.deepEqual(bad, []);
  assert.deepEqual(exercises.map((e) => [e.name, e.sets.length, e.skipped]), [
    ["Lat Pull Down", 2, false], ["Deep Squats", 3, false], ["Calf Raise", 2, false], ["Reverse Fly", 0, true], ["Peck Machine Flies", 0, false], ["bench", 1, false],
  ]);
});

test("formatSet writes sets back the way you'd type them", () => {
  const f = (t: string, k: ExerciseKind = "weighted") => parseSetEntry(t, k)!.map((s) => formatSet(s)).join(", ");
  assert.equal(f("20x15"), "20×15");
  assert.equal(f("25x8F"), "25×8 F");
  assert.equal(f("BW x 20"), "BW×20");
  assert.equal(f("7 kg", "activity"), "7 kg");
  assert.equal(f("15 reps"), "15 reps");
  assert.equal(f("90s"), "1m30s");
  assert.equal(formatSet(parseSetEntry("12.5x15")![0], true), "12.5x15");
});
