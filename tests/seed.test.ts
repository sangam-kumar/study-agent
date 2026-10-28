import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { applyOp } from "../src/ops.ts";
import { SeedError, loadStudySeed, parseStudySeed, queryPlan } from "../src/seed.ts";
import { count, fixedNow, migratedDb } from "./helpers.ts";

const now = fixedNow();

function fixture() {
  return {
    tracks: [
      {
        id: "interview", title: "Interview prep", lane: "study", alternate: ["dsa", "sd"],
        lists: [
          {
            id: "dsa", title: "DSA",
            units: [
              { ordinal: 1, title: "Two Sum", group: "Hashing", size: "fragment", est_min: 30, tier: "Basic", ref: null, needs_split: false, prior_solution: null },
              { ordinal: 2, title: "Next Permutation", group: "Arrays", size: "fragment", est_min: 45, tier: "Core", ref: null, needs_split: false, prior_solution: { path: "problems/two-pointer/next_permutation.py", match: "exact" } },
              { ordinal: 3, title: "Trapping Rainwater", group: "Arrays", size: "fragment", est_min: 60, tier: "Pro", ref: null, needs_split: false, prior_solution: null },
            ],
          },
          { id: "sd", title: "System design", units: [{ ordinal: 1, title: "Learn: Scalability", group: "Core", size: "block", est_min: null, tier: null, ref: null, needs_split: true, prior_solution: null }] },
        ],
      },
      { id: "frontier", title: "Frontier lab", lane: "study", lists: [{ id: "frontier", title: "Frontier lab path", units: [] }] },
    ],
  };
}

test("loads tracks, lists, units and starts every pointer at 1", () => {
  const db = migratedDb();
  const r = loadStudySeed(db, fixture(), now);
  assert.deepEqual(r, { tracks: 2, lists: 3, units: { inserted: 4, updated: 0, unchanged: 0 }, pointersCreated: 3, orphanUnits: 0 });
  assert.equal(count(db, "unit"), 4);
  assert.equal(count(db, "pointer", "ordinal = 1"), 3);
  assert.equal(count(db, "event", "type = 'seed'"), 1);
  assert.equal(count(db, "plan_item"), 0, "nothing is planned or done by seeding");
});

test("loading twice changes nothing", () => {
  const db = migratedDb();
  loadStudySeed(db, fixture(), now);
  const r = loadStudySeed(db, fixture(), now);
  assert.deepEqual(r.units, { inserted: 0, updated: 0, unchanged: 4 });
  assert.equal(r.pointersCreated, 0);
  assert.equal(count(db, "unit"), 4);
});

test("a reload never moves a pointer and applies edited unit fields", () => {
  const db = migratedDb();
  loadStudySeed(db, fixture(), now);
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });

  const edited = fixture();
  edited.tracks[0].lists[0].units[2].title = "Trapping Rain Water";
  const r = loadStudySeed(db, edited, now);
  assert.equal(r.units.updated, 1);
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer WHERE list_id = 'dsa'")[0].ordinal, 3);
  assert.equal(db.all<{ title: string }>("SELECT title FROM unit WHERE list_id = 'dsa' AND ordinal = 3")[0].title, "Trapping Rain Water");
});

test("units dropped from the file are reported, not deleted", () => {
  const db = migratedDb();
  loadStudySeed(db, fixture(), now);
  const shrunk = fixture();
  shrunk.tracks[0].lists[0].units.pop();
  const r = loadStudySeed(db, shrunk, now);
  assert.equal(r.orphanUnits, 1);
  assert.equal(count(db, "unit", "list_id = 'dsa'"), 3);
});

test("prior solutions are stored as references and decode back", () => {
  const db = migratedDb();
  loadStudySeed(db, fixture(), now);
  const row = db.all<{ prior_solution: string }>("SELECT prior_solution FROM unit WHERE title = 'Next Permutation'")[0];
  assert.deepEqual(JSON.parse(row.prior_solution), { path: "problems/two-pointer/next_permutation.py", match: "exact" });
});

test("queryPlan reports the next unit per list; an empty list has none; finished is detected", () => {
  const db = migratedDb();
  loadStudySeed(db, fixture(), now);
  let plan = queryPlan(db);
  assert.deepEqual(plan.map((p) => [p.listId, p.ordinal, p.total, p.next?.title ?? null, p.finished]), [
    ["dsa", 1, 3, "Two Sum", false],
    ["sd", 1, 1, "Learn: Scalability", false],
    ["frontier", 1, 0, null, false],
  ]);
  for (let i = 0; i < 3; i++) applyOp(db, { type: "advance_pointer", list_id: "dsa" }, { now });
  plan = queryPlan(db);
  assert.equal(plan[0].finished, true);
  assert.equal(plan[0].next, null);
});

test("invalid seeds are rejected and write nothing", () => {
  const db = migratedDb();
  const bad: Array<[string, (s: ReturnType<typeof fixture>) => unknown]> = [
    ["no tracks", () => ({ tracks: [] })],
    ["not an object", () => []],
    ["duplicate ordinal", (s) => { s.tracks[0].lists[0].units[1].ordinal = 1; return s; }],
    ["bad size", (s) => { (s.tracks[0].lists[0].units[0] as { size: string }).size = "huge"; return s; }],
    ["empty title", (s) => { s.tracks[0].lists[0].units[0].title = " "; return s; }],
    ["zero ordinal", (s) => { s.tracks[0].lists[0].units[0].ordinal = 0; return s; }],
    ["duplicate list id", (s) => { s.tracks[1].lists[0].id = "dsa"; return s; }],
  ];
  for (const [name, mutate] of bad) {
    assert.throws(() => loadStudySeed(db, mutate(fixture()), now), SeedError, name);
  }
  assert.equal(count(db, "track"), 0);
  assert.equal(count(db, "event"), 0);
});

test("a failure midway rolls the whole load back", () => {
  const db = migratedDb();
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON unit WHEN NEW.title = 'Trapping Rainwater' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => loadStudySeed(db, fixture(), now), /boom/);
  assert.equal(count(db, "track"), 0);
  assert.equal(count(db, "unit"), 0);
  assert.equal(count(db, "pointer"), 0);
});

// The real file produced by study-repo/scripts/seed_study.py, when it is next door.
const real = new URL("../../study-repo/seed/study.json", import.meta.url);
test("the real seed/study.json parses and loads (skipped if not present)", { skip: !existsSync(real) }, () => {
  const json = JSON.parse(readFileSync(real, "utf-8"));
  parseStudySeed(json);
  const db = migratedDb();
  const r = loadStudySeed(db, json, now);
  assert.equal(r.tracks, 2);
  assert.equal(r.lists, 3);
  assert.equal(r.pointersCreated, 3);
  assert.equal(r.units.updated, 0);
  const plan = queryPlan(db);
  assert.ok(plan.every((p) => p.ordinal === 1 && !p.finished && p.next), "every list starts at unit 1 with a next unit");
  assert.equal(count(db, "unit"), r.units.inserted);
  assert.equal(count(db, "plan_item"), 0);
});
