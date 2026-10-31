import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { applyOp, undoLast } from "../src/ops.ts";
import { ensureDraft, getConfig, loadDayRow, loadItems, lockDay, renderEvening, renderMorning } from "../src/day.ts";
import { DEFAULT_TIMES, nextRun } from "../src/jobs.ts";
import { loadConfigSeed } from "../src/seed-config.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { loadStudySeed } from "../src/seed.ts";
import { istWallToMs } from "../src/time.ts";
import { count, migratedDb } from "./helpers.ts";

const MON = "2026-10-26";
const TUE = "2026-10-27";
const WED = "2026-10-28";
const at = (date: string, hhmm: string) => istWallToMs(date, hhmm);

function world() {
  const db = migratedDb();
  const now = () => new Date(at(MON, "08:00"));
  loadConfigSeed(db, {
    config: { gym_wake_by: "07:00" },
    targets: [
      { lane: "fitness", metric: "lift_sessions", period: "week", floor: 2, goal: 3 },
      { lane: "fitness", metric: "sleep_h_avg", period: "week", floor: 7, goal: 8 },
    ],
    pattern: [
      { weekday: 0, kind: "GYM" }, { weekday: 1, kind: "MOBILITY", note: "lower mobility" }, { weekday: 2, kind: "GYM" },
      { weekday: 3, kind: "REST" }, { weekday: 4, kind: "GYM" }, { weekday: 5, kind: "MOBILITY" }, { weekday: 6, kind: "REST" },
    ],
    rotation: [
      { lane: "fitness", ordinal: 1, label: "Chest / Triceps" },
      { lane: "fitness", ordinal: 2, label: "Back / Biceps" },
      { lane: "fitness", ordinal: 3, label: "Legs / Shoulders" },
    ],
  }, now);
  loadStudySeed(db, {
    tracks: [
      { id: "interview", title: "Interview prep", lane: "study", lists: [
        { id: "dsa", title: "DSA", units: [{ ordinal: 1, title: "Two Sum" }, { ordinal: 2, title: "Valid Anagram" }] },
        { id: "system-design", title: "System design", units: [{ ordinal: 1, title: "Scalability", size: "block" }] },
      ] },
      { id: "frontier", title: "Frontier lab", lane: "study", lists: [{ id: "frontier", title: "Frontier", units: [{ ordinal: 1, title: "Main post", size: "block" }] }] },
    ],
  }, now);
  loadReadingSeed(db, { items: [{ key: "q1", title: "Borges - Library of Babel", source: "queue", state: "queued", ordinal: 1 }] }, now);
  return db;
}
const titles = (db: ReturnType<typeof world>, d: string) => loadItems(db, d).map((i) => i.title);

test("a Monday draft: rotation split, wake_by, one DSA fragment, the next queue article", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  assert.deepEqual(titles(db, MON), ["Gym: Chest / Triceps", "DSA: Two Sum", "Read: Borges - Library of Babel"]);
  assert.equal(loadDayRow(db, MON)!.wake_by, "07:00");
  assert.equal(loadItems(db, MON)[2].optional, 1);
});

test("re-drafting is idempotent and keeps what you added yourself", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  applyOp(db, { type: "add_item", date: MON, lane: "study", title: "Call mom" });
  ensureDraft(db, MON, at(MON, "07:05"));
  ensureDraft(db, MON, at(MON, "07:10"));
  assert.equal(loadItems(db, MON).length, 4);
  assert.ok(titles(db, MON).includes("Call mom"));
});

test("a locked day is never redrafted; locking twice is a no-op", () => {
  const db = world();
  assert.equal(lockDay(db, MON, "auto", at(MON, "23:00")), true, "drafts first when needed");
  const before = titles(db, MON);
  db.run("UPDATE config SET value = '3' WHERE key = 'rotation.fitness'");
  assert.deepEqual(ensureDraft(db, MON, at(MON, "23:30")), { locked: true });
  assert.deepEqual(titles(db, MON), before);
  assert.equal(lockDay(db, MON, "user", at(MON, "23:31")), false);
  assert.equal(loadDayRow(db, MON)!.locked_by, "auto");
});

test("finishing the gym item advances the rotation; undo puts it back", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  const gym = loadItems(db, MON).find((i) => i.lane === "fitness")!;
  applyOp(db, { type: "set_item_status", item_id: gym.id, status: "done" });
  assert.equal(getConfig(db, "rotation.fitness", "1"), "2");
  ensureDraft(db, WED, at(TUE, "21:30"));
  assert.equal(titles(db, WED)[0], "Gym: Back / Biceps");
  undoLast(db);
  assert.equal(getConfig(db, "rotation.fitness", "?"), "?", "the config row created by the op is removed again");
});

test("finishing a DSA item advances its pointer, a skip does not, and undo reverses", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  const dsa = loadItems(db, MON).find((i) => i.lane === "study")!;
  applyOp(db, { type: "set_item_status", item_id: dsa.id, status: "skipped" });
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer WHERE list_id = 'dsa'")[0].ordinal, 1);
  ensureDraft(db, TUE, at(MON, "21:30"));
  assert.ok(titles(db, TUE).includes("DSA: Two Sum"), "a skipped unit is offered again tomorrow");

  applyOp(db, { type: "set_item_status", item_id: dsa.id, status: "done" });
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer WHERE list_id = 'dsa'")[0].ordinal, 2);
  ensureDraft(db, TUE, at(MON, "21:31"));
  assert.ok(titles(db, TUE).includes("DSA: Valid Anagram"));
  undoLast(db);
  assert.equal(db.all<{ ordinal: number }>("SELECT ordinal FROM pointer WHERE list_id = 'dsa'")[0].ordinal, 1);
});

test("finishing a queue article marks it read so the next one comes up", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  const read = loadItems(db, MON).find((i) => i.lane === "reading")!;
  applyOp(db, { type: "set_item_status", item_id: read.id, status: "done" });
  assert.equal(db.all<{ state: string }>("SELECT state FROM reading_item WHERE seed_key = 'q1'")[0].state, "done");
});

test("office day and remote day route study differently", () => {
  const db = world();
  applyOp(db, { type: "set_place", dates: [TUE], place: "OFFICE" });
  ensureDraft(db, TUE, at(MON, "21:30"));
  assert.equal(loadItems(db, TUE).filter((i) => i.lane === "study").length, 1);
  applyOp(db, { type: "set_place", dates: [TUE], place: "REMOTE" });
  ensureDraft(db, TUE, at(MON, "21:31"));
  const study = loadItems(db, TUE).filter((i) => i.lane === "study");
  assert.equal(study.length, 2);
  assert.equal(study[1].optional, 1);
  assert.equal(loadDayRow(db, TUE)!.place, "REMOTE");
});

test("a SICK override plans nothing", () => {
  const db = world();
  applyOp(db, { type: "set_override", override_type: "SICK", start_date: TUE, end_date: TUE });
  ensureDraft(db, TUE, at(MON, "21:30"));
  assert.equal(count(db, "plan_item", `date = '${TUE}'`), 0);
});

test("evening message: today's recap, tomorrow's plan, the bedtime line, how to lock", () => {
  const db = world();
  ensureDraft(db, MON, at(MON, "07:00"));
  const gym = loadItems(db, MON).find((i) => i.lane === "fitness")!;
  applyOp(db, { type: "set_item_status", item_id: gym.id, status: "done" });
  ensureDraft(db, TUE, at(MON, "21:30"));
  ensureDraft(db, WED, at(MON, "21:30"));
  const tue = renderEvening(db, MON);
  assert.match(tue, /✅ Gym: Chest \/ Triceps/);
  assert.match(tue, /⬜ DSA: Two Sum/);
  assert.match(tue, /Tomorrow — Tue 27 Oct/);
  assert.match(tue, /Mobility \(lower\)/);
  assert.match(tue, /say <b>ok<\/b> to lock/);
  assert.doesNotMatch(tue, /lights out/, "no gym tomorrow, no bedtime line");
  const wed = renderEvening(db, TUE);
  assert.match(wed, /Back \/ Biceps tomorrow, up by 07:00 → lights out ~23:00/);
});

test("morning message shows the locked plan and says when it locked itself", () => {
  const db = world();
  lockDay(db, TUE, "auto", at(MON, "23:00"));
  const m = renderMorning(db, TUE);
  assert.match(m, /Tue 27 Oct.*locked last night/);
  assert.match(m, /Mobility \(lower\)/);
});

test("job times: evening and lock daily, morning fallback skips once the brief went out", () => {
  // Fri 30 Oct, 14:30 IST
  const now = at("2026-10-30", "14:30");
  assert.equal(nextRun("evening", now, DEFAULT_TIMES), at("2026-10-30", "21:30"));
  assert.equal(nextRun("lock", at("2026-10-30", "23:30"), DEFAULT_TIMES), at("2026-10-31", "23:00"));
  // morning: 08:00 Friday, nothing sent yet -> 09:30 today; already sent -> Sat 10:30
  assert.equal(nextRun("morning", at("2026-10-30", "08:00"), DEFAULT_TIMES, false), at("2026-10-30", "09:30"));
  assert.equal(nextRun("morning", at("2026-10-30", "08:00"), DEFAULT_TIMES, true), at("2026-10-31", "10:30"));
  // 01:00 on Saturday still belongs to Friday's day: next fallback is Saturday 10:30
  assert.equal(nextRun("morning", at("2026-10-31", "01:00"), DEFAULT_TIMES, true), at("2026-10-31", "10:30"));
});

test("the real seeds produce a sensible week", { skip: !existsSync("../study-repo/seed/config.json") }, () => {
  const db = migratedDb();
  const now = () => new Date(at(MON, "08:00"));
  loadConfigSeed(db, JSON.parse(readFileSync("../study-repo/seed/config.json", "utf8")), now);
  loadStudySeed(db, JSON.parse(readFileSync("../study-repo/seed/study.json", "utf8")), now);
  loadReadingSeed(db, JSON.parse(readFileSync("../study-repo/seed/reading.json", "utf8")), now);
  for (let i = 0; i < 7; i++) {
    const date = i < 6 ? `2026-10-${26 + i}` : "2026-11-01";
    ensureDraft(db, date, at(MON, "08:00"));
    const items = loadItems(db, date);
    assert.ok(items.length <= 4, `${date}: ${items.length} items`);
  }
  assert.equal(loadItems(db, MON)[0].title, "Gym: Chest / Triceps");
  assert.equal(loadItems(db, "2026-11-01").some((i) => i.lane === "fitness"), false, "Sunday rest");
});

test("moving an item to a later day neither duplicates it nor loses it on re-draft", () => {
  const db = world();
  ensureDraft(db, TUE, at(MON, "21:30"));
  const dsa = loadItems(db, TUE).find((i) => i.lane === "study" && !i.optional)!;
  applyOp(db, { type: "move_item", item_id: dsa.id, to_date: "2026-10-31" });
  ensureDraft(db, TUE, at(MON, "21:40"));
  assert.equal(titles(db, TUE).includes("DSA: Two Sum"), false, "not regenerated on the day it left");
  ensureDraft(db, "2026-10-31", at(MON, "21:41"));
  assert.equal(titles(db, "2026-10-31").filter((t) => t === "DSA: Two Sum").length, 1, "kept once on the day it went to");
});

test("locking a day that only has a place set drafts it first", () => {
  const db = world();
  applyOp(db, { type: "set_place", dates: [TUE], place: "OFFICE" });
  assert.equal(loadItems(db, TUE).length, 0);
  lockDay(db, TUE, "auto", at(MON, "23:00"));
  assert.ok(loadItems(db, TUE).length > 0);
  assert.equal(loadDayRow(db, TUE)!.place, "OFFICE");
});
