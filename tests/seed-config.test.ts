import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { loadConfigSeed } from "../src/seed-config.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { SeedError } from "../src/seed.ts";
import { count, fixedNow, migratedDb } from "./helpers.ts";

const now = fixedNow();

const config = {
  config: { nudge_cap_per_day: "3", auto_lock: "23:00" },
  lanes: [{ name: "fitness" }, { name: "guitar", status: "paused", resume_rule: "later" }],
  targets: [{ lane: "fitness", metric: "lift_sessions", period: "week", floor: 2, goal: 3 }],
  pattern: [{ weekday: 0, kind: "GYM" }, { weekday: 6, kind: "REST", note: "full rest" }],
  rotation: [{ lane: "fitness", ordinal: 1, label: "Chest / Triceps" }],
};

test("config seed: first load inserts, second load changes nothing", () => {
  const db = migratedDb();
  const a = loadConfigSeed(db, config, now);
  assert.deepEqual(a.config, { inserted: 2, kept: 0 });
  assert.equal(a.lanes.inserted, 2);
  assert.equal(a.targets.inserted, 1);
  assert.equal(a.pattern.inserted, 2);
  assert.equal(a.rotation.inserted, 1);
  const b = loadConfigSeed(db, config, now);
  assert.deepEqual(b.config, { inserted: 0, kept: 2 });
  assert.equal(b.pattern.unchanged, 2);
  assert.equal(count(db, "config"), 2);
  assert.equal(count(db, "lane", "status = 'paused'"), 1);
});

test("config, lanes and targets the user changed are never overwritten; pattern and rotation are", () => {
  const db = migratedDb();
  loadConfigSeed(db, config, now);
  db.run("UPDATE config SET value = '5' WHERE key = 'nudge_cap_per_day'");
  db.run("UPDATE lane SET status = 'active' WHERE name = 'guitar'");
  db.run("UPDATE target SET floor = 1 WHERE metric = 'lift_sessions'");
  db.run("UPDATE pattern SET kind = 'REST' WHERE weekday = 0");
  db.run("UPDATE rotation SET label = 'x' WHERE ordinal = 1");
  const r = loadConfigSeed(db, config, now);
  assert.equal(db.all<{ value: string }>("SELECT value FROM config WHERE key = 'nudge_cap_per_day'")[0].value, "5");
  assert.equal(db.all<{ status: string }>("SELECT status FROM lane WHERE name = 'guitar'")[0].status, "active");
  assert.equal(db.all<{ floor: number }>("SELECT floor FROM target")[0].floor, 1);
  assert.equal(db.all<{ kind: string }>("SELECT kind FROM pattern WHERE weekday = 0")[0].kind, "GYM");
  assert.equal(db.all<{ label: string }>("SELECT label FROM rotation")[0].label, "Chest / Triceps");
  assert.equal(r.pattern.updated, 1);
  assert.equal(r.rotation.updated, 1);
});

test("invalid config seeds write nothing", () => {
  const db = migratedDb();
  const bad = [
    { ...config, pattern: [{ weekday: 7, kind: "GYM" }] },
    { ...config, pattern: [{ weekday: 1, kind: "RUN" }] },
    { ...config, targets: [{ lane: "f", metric: "m", period: "week", floor: 5, goal: 3 }] },
    { ...config, lanes: [{ name: "a" }, { name: "a" }] },
    { ...config, config: { k: "" } },
  ];
  for (const b of bad) assert.throws(() => loadConfigSeed(db, b, now), SeedError);
  assert.equal(count(db, "config"), 0);
  assert.equal(count(db, "event"), 0);
});

test("the real seed/config.json loads", { skip: !existsSync("../study-repo/seed/config.json") }, () => {
  const db = migratedDb();
  const r = loadConfigSeed(db, JSON.parse(readFileSync("../study-repo/seed/config.json", "utf8")), now);
  assert.equal(r.pattern.inserted, 7);
  assert.equal(r.rotation.inserted, 3);
  assert.equal(db.all<{ status: string }>("SELECT status FROM lane WHERE name = 'guitar'")[0].status, "paused");
  assert.equal(count(db, "pattern", "kind = 'GYM'"), 3);
});

const item = (key: string, extra: object = {}) => ({ key, title: `T ${key}`, source: "queue", state: "queued", ...extra });

test("reading seed: idempotent, metadata refreshes, user state is never touched", () => {
  const db = migratedDb();
  const a = loadReadingSeed(db, { items: [item("a"), item("b", { kind: "book" })] }, now);
  assert.deepEqual(a.items, { inserted: 2, updated: 0, unchanged: 0 });
  db.run("UPDATE reading_item SET state = 'done' WHERE seed_key = 'a'");
  const b = loadReadingSeed(db, { items: [item("a", { title: "renamed" }), item("b", { kind: "book" })] }, now);
  assert.deepEqual(b.items, { inserted: 0, updated: 1, unchanged: 1 });
  const row = db.all<{ title: string; state: string }>("SELECT title, state FROM reading_item WHERE seed_key = 'a'")[0];
  assert.equal(row.title, "renamed");
  assert.equal(row.state, "done");
});

test("reading seed: orphans are reported not deleted; invalid input writes nothing", () => {
  const db = migratedDb();
  loadReadingSeed(db, { items: [item("a"), item("b")] }, now);
  const r = loadReadingSeed(db, { items: [item("a")] }, now);
  assert.equal(r.orphans, 1);
  assert.equal(count(db, "reading_item"), 2);
  for (const bad of [{ items: [] }, { items: [item("x"), item("x")] }, { items: [item("y", { source: "nope" })] }, { items: [item("z", { state: "lost" })] }]) {
    assert.throws(() => loadReadingSeed(db, bad, now), SeedError);
  }
  assert.equal(count(db, "reading_item"), 2);
});

test("the real seed/reading.json loads: 30 queued, the rest backlog", { skip: !existsSync("../study-repo/seed/reading.json") }, () => {
  const db = migratedDb();
  loadReadingSeed(db, JSON.parse(readFileSync("../study-repo/seed/reading.json", "utf8")), now);
  assert.equal(count(db, "reading_item", "state = 'queued'"), 30);
  assert.equal(count(db, "reading_item", "source = 'library' AND state = 'backlog'"), 423);
});
