import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, undoLast, OpError } from "../src/ops.ts";
import { currentReading, droppedBooks, parseBookCommand, pickCandidates, renderShelf } from "../src/reading.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { parseScopes, resetData } from "../src/reset.ts";
import { count, fixedNow, migratedDb } from "./helpers.ts";

const now = fixedNow();
const book = (key: string, title: string, slot: string, rank: number, extra: object = {}) =>
  ({ key, title, source: "library", state: "backlog", slot, shortlist: true, ordinal: rank, ...extra });

function shelf() {
  const db = migratedDb();
  loadReadingSeed(db, {
    items: [
      book("l1", "DDIA", "technical", 1),
      book("l2", "SICP", "technical", 2),
      { key: "u1", title: "Mom Test", source: "user", state: "backlog", slot: "narrative", shortlist: true, ordinal: 1 },
      { key: "u2", title: "Soul", source: "user", state: "backlog", slot: "narrative", shortlist: true, ordinal: 2 },
      { key: "w1", title: "Wild A", source: "library", state: "backlog", priority: "High", slot: "technical", ordinal: 50 },
      { key: "w2", title: "Wild B", source: "library", state: "backlog", priority: "High", slot: "technical", ordinal: 51 },
    ],
  }, now);
  return db;
}
type Db = ReturnType<typeof shelf>;
const id = (db: Db, title: string) => db.all<{ id: number }>("SELECT id FROM reading_item WHERE title = ?", title)[0].id;
const state = (db: Db, title: string) => db.all<{ state: string }>("SELECT state FROM reading_item WHERE title = ?", title)[0].state;

test("picker: one per free slot in shortlist order, plus a wildcard that rotates by day", () => {
  const db = shelf();
  const a = pickCandidates(db, 0);
  assert.deepEqual(a.map((c) => c.title), ["DDIA", "Mom Test", "Wild A"]);
  assert.deepEqual(a.map((c) => c.why), ["technical", "narrative", "wildcard"]);
  assert.equal(pickCandidates(db, 1)[2].title, "Wild B");
  assert.equal(pickCandidates(db, 2)[2].title, "Wild A");
});

test("start -> keep -> finish, and a busy slot is not offered again", () => {
  const db = shelf();
  applyOp(db, { type: "start_reading", reading_id: id(db, "DDIA") }, { now });
  assert.equal(state(db, "DDIA"), "sampling");
  assert.deepEqual(pickCandidates(db, 0).map((c) => c.title), ["Mom Test", "Wild A"], "technical slot is busy");
  applyOp(db, { type: "keep_reading", reading_id: id(db, "DDIA") }, { now });
  assert.equal(state(db, "DDIA"), "active");
  applyOp(db, { type: "finish_reading", reading_id: id(db, "DDIA") }, { now });
  assert.equal(state(db, "DDIA"), "done");
  assert.equal(pickCandidates(db, 0)[0].title, "SICP");
});

test("one book per slot at a time", () => {
  const db = shelf();
  applyOp(db, { type: "start_reading", reading_id: id(db, "DDIA") }, { now });
  assert.throws(() => applyOp(db, { type: "start_reading", reading_id: id(db, "SICP") }, { now }), /one technical book at a time/);
  applyOp(db, { type: "start_reading", reading_id: id(db, "Mom Test") }, { now });
  assert.equal(currentReading(db).length, 2, "a narrative book can run alongside");
});

test("drop keeps the reason, frees the slot, can be revived, and undoes", () => {
  const db = shelf();
  const ddia = id(db, "DDIA");
  applyOp(db, { type: "start_reading", reading_id: ddia }, { now });
  applyOp(db, { type: "drop_reading", reading_id: ddia, reason: "too dense right now" }, { now });
  assert.equal(state(db, "DDIA"), "dropped");
  const dropped = droppedBooks(db);
  assert.equal(dropped[0].title, "DDIA");
  assert.equal(dropped[0].reason, "too dense right now");
  assert.equal(pickCandidates(db, 0)[0].title, "SICP", "dropped books are not re-offered");
  assert.throws(() => applyOp(db, { type: "drop_reading", reading_id: ddia }, { now }), OpError);
  applyOp(db, { type: "start_reading", reading_id: ddia }, { now }); // revive
  assert.equal(state(db, "DDIA"), "sampling");
  undoLast(db, { now });
  assert.equal(state(db, "DDIA"), "dropped");
  undoLast(db, { now });
  assert.equal(state(db, "DDIA"), "sampling");
});

test("add_reading lands in the backlog, rejects duplicates, and undoes", () => {
  const db = shelf();
  applyOp(db, { type: "add_reading", title: "Deep Work", author: "Cal Newport" }, { now });
  assert.equal(state(db, "Deep Work"), "backlog");
  assert.throws(() => applyOp(db, { type: "add_reading", title: "deep work" }, { now }), /already on the shelf/);
  undoLast(db, { now });
  assert.equal(count(db, "reading_item", "title = 'Deep Work'"), 0);
});

test("ops reject bad transitions and bad input", () => {
  const db = shelf();
  const ddia = id(db, "DDIA");
  assert.throws(() => applyOp(db, { type: "keep_reading", reading_id: ddia }, { now }), /not sampling/);
  assert.throws(() => applyOp(db, { type: "hold_reading", reading_id: ddia }, { now }), /only a book being read/);
  assert.throws(() => applyOp(db, { type: "start_reading", reading_id: 9999 }, { now }), /not found/);
  assert.throws(() => applyOp(db, { type: "add_reading", title: "x", slot: "weird" }, { now }), OpError);
});

test("reseeding never touches the user's state, slot or shortlist", () => {
  const db = shelf();
  applyOp(db, { type: "start_reading", reading_id: id(db, "DDIA") }, { now });
  loadReadingSeed(db, { items: [book("l1", "DDIA (2nd ed)", "narrative", 9, { shortlist: false })] }, now);
  const r = db.all<{ title: string; state: string; slot: string; shortlist: number }>(
    "SELECT title, state, slot, shortlist FROM reading_item WHERE seed_key = 'l1'",
  )[0];
  assert.equal(r.title, "DDIA (2nd ed)");
  assert.equal(r.state, "sampling");
  assert.equal(r.slot, "technical");
  assert.equal(r.shortlist, 1);
});

test("shelf reset restores seeded states and removes hand-added books", () => {
  const db = shelf();
  applyOp(db, { type: "start_reading", reading_id: id(db, "DDIA") }, { now });
  applyOp(db, { type: "add_reading", title: "Hand added" }, { now });
  assert.equal(resetData(db, parseScopes("shelf"), true).shelf, 2);
  assert.equal(count(db, "reading_item"), 7, "dry run changes nothing");
  resetData(db, parseScopes("shelf"), false);
  assert.equal(state(db, "DDIA"), "backlog");
  assert.equal(count(db, "reading_item", "title = 'Hand added'"), 0);
  assert.equal(resetData(db, parseScopes("shelf"), true).shelf, 0);
});

test("renderShelf escapes titles and lists ids", () => {
  const db = shelf();
  applyOp(db, { type: "add_reading", title: "A <b> & C" }, { now });
  const out = renderShelf(db, 0);
  assert.match(out, /Nothing in progress/);
  assert.match(out, /#\d+/);
  applyOp(db, { type: "start_reading", reading_id: id(db, "A <b> & C") }, { now });
  assert.match(renderShelf(db, 0), /A &lt;b&gt; &amp; C/);
});

test("a book read before it was ever started can be marked done, and is no longer offered", () => {
  const db = shelf();
  applyOp(db, { type: "finish_reading", reading_id: id(db, "DDIA") }, { now });
  assert.equal(state(db, "DDIA"), "done");
  assert.equal(pickCandidates(db, 0)[0].title, "SICP");
  assert.throws(() => applyOp(db, { type: "finish_reading", reading_id: id(db, "DDIA") }, { now }), /already marked done/);
  undoLast(db, { now });
  assert.equal(state(db, "DDIA"), "backlog");
});

test("hold frees the slot, keeps the book, and start resumes it", () => {
  const db = shelf();
  const ddia = id(db, "DDIA");
  applyOp(db, { type: "start_reading", reading_id: ddia }, { now });
  applyOp(db, { type: "hold_reading", reading_id: ddia }, { now });
  assert.equal(state(db, "DDIA"), "paused");
  applyOp(db, { type: "start_reading", reading_id: id(db, "SICP") }, { now }); // slot is free now
  assert.throws(() => applyOp(db, { type: "start_reading", reading_id: ddia }, { now }), /one technical book at a time/);
  assert.match(renderShelf(db, 0), /On hold[\s\S]*DDIA/);
  applyOp(db, { type: "hold_reading", reading_id: id(db, "SICP") }, { now });
  applyOp(db, { type: "start_reading", reading_id: ddia }, { now });
  assert.equal(state(db, "DDIA"), "sampling");
});

test("queue items (no slot) can be marked done and the next one surfaces", () => {
  const db = migratedDb();
  loadReadingSeed(db, { items: [1, 2, 3, 4].map((n) => ({ key: `q${n}`, title: `Article ${n}`, source: "queue", state: "queued", ordinal: n })) }, now);
  assert.match(renderShelf(db, 0), /Article 1[\s\S]*Article 2[\s\S]*Article 3/);
  assert.doesNotMatch(renderShelf(db, 0), /Article 4/);
  applyOp(db, { type: "finish_reading", reading_id: id(db, "Article 1") }, { now });
  assert.doesNotMatch(renderShelf(db, 0), /Article 1/);
  assert.match(renderShelf(db, 0), /Article 4/);
});

test("/book command: id or title fragment, ambiguity, drop reasons, usage", () => {
  const db = shelf();
  const ddia = id(db, "DDIA");
  assert.deepEqual(parseBookCommand(db, ["done", "ddia"]), { op: { type: "finish_reading", reading_id: ddia } });
  assert.deepEqual(parseBookCommand(db, ["start", `#${ddia}`]), { op: { type: "start_reading", reading_id: ddia } });
  assert.deepEqual(parseBookCommand(db, ["drop", String(ddia), "too", "dense"]), { op: { type: "drop_reading", reading_id: ddia, reason: "too dense" } });
  assert.deepEqual(parseBookCommand(db, ["drop", "mom", "test", "|", "boring"]), {
    op: { type: "drop_reading", reading_id: id(db, "Mom Test"), reason: "boring" },
  });
  assert.deepEqual(parseBookCommand(db, ["hold", "sicp"]), { op: { type: "hold_reading", reading_id: id(db, "SICP") } });
  const many = parseBookCommand(db, ["done", "wild"]);
  assert.ok("reply" in many && /Several match/.test(many.reply) && /Wild A/.test(many.reply) && /Wild B/.test(many.reply));
  assert.ok("reply" in parseBookCommand(db, ["done", "nonexistent"]));
  assert.ok("reply" in parseBookCommand(db, ["done", "9999"]));
  assert.ok("reply" in parseBookCommand(db, []));
  assert.ok("reply" in parseBookCommand(db, ["add"]));
  assert.deepEqual(parseBookCommand(db, ["add", "Deep", "Work", "|", "Cal", "Newport"]), {
    op: { type: "add_reading", title: "Deep Work", author: "Cal Newport" },
  });
});
