import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, undoLast } from "../src/ops.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { ensureDraft, loadItems } from "../src/day.ts";
import {
  booksWithJots, findBook, jotKind, normalizeLocator, notesPath, renderJots, renderNotesMarkdown, soleCurrentBook,
} from "../src/jots.ts";
import { mirrorDays } from "../src/mirror.ts";
import { resetData, parseScopes } from "../src/reset.ts";
import { understand } from "../src/understand.ts";
import type { InferBackend } from "../src/infer.ts";
import { istWallToMs } from "../src/time.ts";
import { count, migratedDb } from "./helpers.ts";

const DAY = "2026-11-02";
const nowMs = istWallToMs(DAY, "21:00");
const now = () => new Date(nowMs);

function world(start: string[] = ["l1"]) {
  const db = migratedDb();
  loadReadingSeed(db, {
    items: [
      { key: "l1", title: "Designing Data-Intensive Applications", author: "Martin Kleppmann", source: "library", state: "backlog", slot: "technical", shortlist: true, ordinal: 1 },
      { key: "l2", title: "Shoe Dog", source: "library", state: "backlog", slot: "narrative", shortlist: true, ordinal: 2 },
      { key: "l3", title: "Structure and Interpretation of Computer Programs (SICP)", source: "library", state: "backlog", slot: "technical", ordinal: 3 },
    ],
  }, now);
  for (const key of start) {
    const id = db.all<{ id: number }>("SELECT id FROM reading_item WHERE seed_key = ?", key)[0].id;
    applyOp(db, { type: "start_reading", reading_id: id }, { now });
  }
  return db;
}
const id = (db: ReturnType<typeof world>, key: string) => db.all<{ id: number }>("SELECT id FROM reading_item WHERE seed_key = ?", key)[0].id;

test("locators and jot kinds", () => {
  assert.equal(normalizeLocator("Chapter 12"), "ch12");
  assert.equal(jotKind('"Data outlives code"'), "quote");
  assert.equal(jotKind("why does Raft need a leader?"), "question");
  assert.equal(jotKind("todo look up CRDTs"), "todo");
  assert.equal(jotKind("reminds me of the Notion sync design"), "connection");
});

test("the book: the one being read, or by name; two on the go needs a name", () => {
  const one = world();
  assert.equal(soleCurrentBook(one)?.title, "Designing Data-Intensive Applications");
  const two = world(["l1", "l2"]);
  assert.equal(soleCurrentBook(two), null);
  const sicp = findBook(two, "sicp");
  assert.ok("id" in sicp && sicp.title.startsWith("Structure"));
  assert.ok("reply" in findBook(two, "harry potter"));
});

test("a jot and a progress update are undoable ops; progress ticks off the day's reading", () => {
  const db = world();
  const ddia = id(db, "l1");
  ensureDraft(db, DAY, istWallToMs(DAY, "07:00"));
  const reading = loadItems(db, DAY).find((i) => i.ref === `reading:${ddia}`);
  assert.ok(reading, "the draft has a reading item for the current book");

  const j = applyOp(db, { type: "add_jot", reading_id: ddia, text: "lag breaks read-your-writes", locator: "ch5", kind: "point" }, { now });
  assert.match(j.summary, /Jot on Designing Data-Intensive Applications \(ch5\)/);
  applyOp(db, { type: "set_progress", reading_id: ddia, locator: "ch5 done", date: DAY }, { now });
  assert.equal(db.all<{ progress: string }>("SELECT progress FROM reading_item WHERE id = ?", ddia)[0].progress, "ch5 done");
  assert.equal(loadItems(db, DAY).find((i) => i.id === reading!.id)?.status, "done");

  undoLast(db);
  assert.equal(db.all<{ progress: string | null }>("SELECT progress FROM reading_item WHERE id = ?", ddia)[0].progress, null);
  assert.equal(loadItems(db, DAY).find((i) => i.id === reading!.id)?.status, "planned");
  undoLast(db);
  assert.equal(count(db, "jot"), 0);
});

test("the notes file groups jots by where you were, quotes as quotes", () => {
  const db = world();
  const ddia = id(db, "l1");
  applyOp(db, { type: "add_jot", reading_id: ddia, text: "lag breaks read-your-writes", locator: "ch5", kind: "point" }, { now });
  applyOp(db, { type: "add_jot", reading_id: ddia, text: "Data outlives code", locator: "ch5", kind: "quote" }, { now });
  applyOp(db, { type: "add_jot", reading_id: ddia, text: "why a single leader?", locator: "ch6", kind: "question" }, { now });
  applyOp(db, { type: "set_progress", reading_id: ddia, locator: "ch6", date: DAY }, { now });
  const md = renderNotesMarkdown(db, ddia)!;
  assert.match(md, /^# Designing Data-Intensive Applications\n\n_Martin Kleppmann · sampling · ch6_/);
  assert.match(md, /## ch5\n\n- lag breaks read-your-writes _\(Mon 2 Nov\)_\n> Data outlives code/);
  assert.match(md, /## ch6\n\n- ❓ why a single leader\?/);
  assert.equal(notesPath("Designing Data-Intensive Applications"), "study/notes/designing-data-intensive-applications.md");
  assert.match(renderJots(db, ddia), /<b>ch5<\/b> 💬 Data outlives code/);
  assert.deepEqual(booksWithJots(db).map((b) => b.id), [ddia]);
  assert.equal(renderNotesMarkdown(db, id(db, "l2")), null, "no jots, no file");
});

test("notes files go in the same commit as the daily notes, only when changed", async () => {
  const db = world();
  const ddia = id(db, "l1");
  applyOp(db, { type: "add_jot", reading_id: ddia, text: "a point", locator: "ch1" }, { now });
  const commits: { message: string; paths: string[] }[] = [];
  const gh = {
    async commit(build: (read: (p: string) => Promise<string | null>) => Promise<{ message: string; files: { path: string; content: string }[] }>) {
      const r = await build(async () => null);
      commits.push({ message: r.message, paths: r.files.map((f) => f.path) });
      return { committed: true, paths: r.files.map((f) => f.path), sha: "x" };
    },
  };
  const whole = () => [{ path: notesPath("Designing Data-Intensive Applications"), label: "DDIA", content: renderNotesMarkdown(db, ddia)! }];
  await mirrorDays(db, gh as never, [], nowMs, whole());
  assert.deepEqual(commits[0], { message: "notes: DDIA [study-agent]", paths: ["study/notes/designing-data-intensive-applications.md"] });
  await mirrorDays(db, gh as never, [], nowMs, whole());
  assert.equal(commits.length, 1, "unchanged: no commit");
});

test("resetting the shelf clears jots and progress first", () => {
  const db = world();
  applyOp(db, { type: "add_reading", title: "My own book" }, { now });
  const mine = db.all<{ id: number }>("SELECT id FROM reading_item WHERE title = 'My own book'")[0].id;
  applyOp(db, { type: "add_jot", reading_id: mine, text: "x y z" }, { now });
  applyOp(db, { type: "set_progress", reading_id: id(db, "l1"), locator: "p40", date: DAY }, { now });
  resetData(db, parseScopes("shelf"), false);
  assert.equal(count(db, "jot"), 0);
  assert.equal(count(db, "reading_item", "progress IS NOT NULL"), 0);
  assert.equal(count(db, "reading_item", "seed_key IS NULL"), 0);
});

// ------------------------------------------------------------ model path

function model(intent: string, extraction: unknown): InferBackend {
  return {
    name: "fake",
    async json(req: { system: string }) {
      return req.system.includes("Classify the message") ? { intent, confidence: 0.9 } : extraction;
    },
  };
}
const run = (db: ReturnType<typeof world>, intent: string, extraction: unknown, text: string) =>
  understand({ db, backends: [model(intent, extraction)], nowMs, log: () => {} }, text);

test("model path: a named book is found in code; no name and two books asks", async () => {
  const db = world(["l1", "l2"]);
  const named = await run(db, "jot", { book: "DDIA", locator: "chapter 5", text: "quorums" }, "DDIA chapter 5 quorums");
  assert.deepEqual(named, { kind: "ops", ops: [{ type: "add_jot", reading_id: id(db, "l1"), text: "quorums", locator: "ch5", kind: "point" }] });
  const unnamed = await run(db, "jot", { text: "quorums" }, "interesting bit on quorums");
  assert.equal(unnamed.kind, "reply");
  const prog = await run(db, "progress", { book: "shoe dog", locator: "Chapter 4 done" }, "finished chapter 4 of shoe dog");
  assert.deepEqual(prog, { kind: "ops", ops: [{ type: "set_progress", reading_id: id(db, "l2"), locator: "ch4 done", date: DAY }] });
  const fin = await run(db, "progress", { book: "shoe dog", locator: "end", finished_book: true }, "finished shoe dog");
  assert.deepEqual(fin, { kind: "ops", ops: [{ type: "finish_reading", reading_id: id(db, "l2") }] });
});
