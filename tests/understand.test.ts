import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { applyOp } from "../src/ops.ts";
import { INTENTS } from "../src/cards.ts";
import type { Intent } from "../src/cards.ts";
import type { InferBackend } from "../src/infer.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { loadStudySeed } from "../src/seed.ts";
import { addToInbox, contextPacket, understand } from "../src/understand.ts";
import type { Outcome } from "../src/understand.ts";
import { count, fixedNow, migratedDb } from "./helpers.ts";

const now = fixedNow();
// 2026-10-30 14:30 IST
const nowMs = Date.UTC(2026, 9, 30, 9, 0, 0);
const quiet = () => {};

/** Scripted model: answers the classify call, then the extractor call. */
function model(intent: string, confidence: number, extraction: unknown | Error | (() => unknown)): InferBackend & { extractCalls: number } {
  const b = {
    name: "fake",
    extractCalls: 0,
    async json(req: { system: string }) {
      if (req.system.includes("Classify the message")) return { intent, confidence };
      b.extractCalls++;
      const a = typeof extraction === "function" ? (extraction as () => unknown)() : extraction;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return b;
}

function world() {
  const db = migratedDb();
  loadReadingSeed(db, {
    items: [
      { key: "l1", title: "The Hundred-Page Machine Learning Book", source: "library", state: "backlog", slot: "technical", shortlist: true, ordinal: 1 },
      { key: "l2", title: "Designing Data-Intensive Applications", source: "library", state: "backlog", slot: "technical", shortlist: true, ordinal: 2 },
      { key: "l3", title: "Hands-On Machine Learning", source: "library", state: "backlog", slot: "technical", ordinal: 3 },
    ],
  }, now);
  loadStudySeed(db, {
    tracks: [{ id: "t", title: "Interview prep", lane: "study", lists: [{ id: "dsa", title: "DSA", units: [
      { ordinal: 1, title: "Two Sum" }, { ordinal: 2, title: "Valid Anagram" }, { ordinal: 3, title: "Group Anagrams" }, { ordinal: 4, title: "Top K" },
    ] }] }],
  }, now);
  return db;
}

const run = (db: ReturnType<typeof world>, m: InferBackend, text: string): Promise<Outcome> =>
  understand({ db, backends: [m], nowMs, log: quiet }, text);

test("reading: 'done with the ML book' resolves to the right book in code", async () => {
  const db = world();
  const out = await run(db, model("reading", 0.95, { action: "done", ref: "hundred-page" }), "finished the 100 page ml book");
  assert.equal(out.kind, "ops");
  if (out.kind !== "ops") return;
  const id = db.all<{ id: number }>("SELECT id FROM reading_item WHERE seed_key = 'l1'")[0].id;
  assert.deepEqual(out.ops, [{ type: "finish_reading", reading_id: id }]);
  applyOp(db, out.ops[0], { now });
  assert.equal(db.all<{ state: string }>("SELECT state FROM reading_item WHERE id = ?", id)[0].state, "done");
});

test("reading: drop with a reason, and a multi-word title is not split", async () => {
  const db = world();
  const out = await run(db, model("reading", 0.9, { action: "drop", ref: "Designing Data-Intensive", reason: "too dense" }), "drop DDIA too dense");
  assert.equal(out.kind, "ops");
  if (out.kind === "ops") assert.equal(out.ops[0].reason, "too dense");
});

test("reading: an ambiguous reference becomes a question, not a guess", async () => {
  const out = await run(world(), model("reading", 0.9, { action: "done", ref: "machine learning" }), "done with machine learning");
  assert.equal(out.kind, "reply");
  if (out.kind === "reply") assert.match(out.html, /Several match[\s\S]*Hands-On/);
});

test("reading: add carries the author", async () => {
  const out = await run(world(), model("reading", 0.9, { action: "add", ref: "Deep Work", author: "Cal Newport" }), "add Deep Work by Cal Newport");
  assert.deepEqual(out, { kind: "ops", ops: [{ type: "add_reading", title: "Deep Work", author: "Cal Newport" }] });
});

test("reminder: '6:30 pm today' is resolved to 18:30 in code, whatever delay the model guessed", async () => {
  const out = await run(world(), model("reminder", 0.95, { reminder_text: "play ball", delay_minutes: 390, at_time: "18:30", on_date: "2026-10-30" }), "remind me to play ball at 6:30 pm today");
  assert.deepEqual(out, { kind: "reminder", text: "play ball", dueMs: nowMs + 240 * 60_000 });
});

test("reminder: relative delay passes through", async () => {
  const out = await run(world(), model("reminder", 0.95, { reminder_text: "stretch", delay_minutes: 45, at_time: "", on_date: "" }), "remind me in 45 minutes to stretch");
  assert.deepEqual(out, { kind: "reminder", text: "stretch", dueMs: nowMs + 45 * 60_000 });
});

test("reminder: a time in the past is rejected, retried, then saved to the inbox", async () => {
  const m = model("reminder", 0.95, { reminder_text: "x", delay_minutes: 0, at_time: "09:00", on_date: "2026-10-30" });
  const out = await run(world(), m, "remind me at 9 am today");
  assert.equal(m.extractCalls, 2, "one retry");
  assert.deepEqual(out, { kind: "inbox", reason: "I couldn't make sense of that" });
});

test("study: finishing three units moves the pointer by three, in code", async () => {
  const db = world();
  const out = await run(db, model("study_done", 0.9, { list_id: "dsa", count: 3 }), "did three dsa problems");
  assert.deepEqual(out, { kind: "ops", ops: [{ type: "advance_pointer", list_id: "dsa", to_ordinal: 4 }] });
  applyOp(db, (out as { ops: Record<string, unknown>[] }).ops[0], { now });
  // asking for more than remain clamps to 'finished'
  const again = await run(db, model("study_done", 0.9, { list_id: "dsa", count: 20 }), "did twenty");
  assert.deepEqual(again, { kind: "ops", ops: [{ type: "advance_pointer", list_id: "dsa", to_ordinal: 5 }] });
});

test("study: an invented list id is rejected", async () => {
  const m = model("study_done", 0.9, { list_id: "made-up" });
  assert.equal((await run(world(), m, "did a problem")).kind, "inbox");
  assert.equal(m.extractCalls, 2);
});

test("note: ttl is clamped to 1..30 days", async () => {
  const out = await run(world(), model("note", 0.9, { text: "knee hurts", ttl_days: 90 }), "knee hurts, go easy");
  assert.deepEqual(out, { kind: "ops", ops: [{ type: "add_note", text: "knee hurts", ttl_days: 30 }] });
});

test("workout and snooze go to the legacy handlers with validated fields", async () => {
  const w = await run(world(), model("workout", 0.9, { workout_type: "Chest", exercises: [{ name: "Flat Bench", sets: 3, reps: 12, weight_kg: 20 }] }), "chest day");
  assert.equal(w.kind, "workout");
  const s = await run(world(), model("snooze", 0.9, { reason: "busy" }), "quiet for a bit");
  assert.deepEqual(s, { kind: "snooze", hours: 2, reason: "busy" });
});

test("chat replies are HTML-escaped", async () => {
  const out = await run(world(), model("chat", 0.9, { reply: "a <b> & c" }), "hello");
  assert.deepEqual(out, { kind: "reply", html: "a &lt;b&gt; &amp; c" });
});

test("low confidence does not call an extractor and goes to the inbox", async () => {
  const m = model("reading", 0.3, { action: "done", ref: "x" });
  const out = await run(world(), m, "hmm the thing");
  assert.equal(out.kind, "inbox");
  assert.equal(m.extractCalls, 0);
});

test("when every backend is down the message goes to the inbox with an honest reason", async () => {
  const down: InferBackend = { name: "down", async json() { throw new Error("HTTP 429"); } };
  const db = world();
  const out = await understand({ db, backends: [down], nowMs, log: quiet }, "done with the ml book");
  assert.deepEqual(out, { kind: "inbox", reason: "the AI is unavailable right now" });
  addToInbox(db, "done with the ml book", nowMs);
  assert.equal(count(db, "inbox"), 1);
});

test("context packet stays small for every intent, with the real seeds", { skip: !existsSync("../study-repo/seed/study.json") }, () => {
  const db = migratedDb();
  loadStudySeed(db, JSON.parse(readFileSync("../study-repo/seed/study.json", "utf8")), now);
  loadReadingSeed(db, JSON.parse(readFileSync("../study-repo/seed/reading.json", "utf8")), now);
  applyOp(db, { type: "add_note", text: "knee hurts, go easy on legs", ttl_days: 5 }, { now: () => new Date(nowMs) });
  for (const intent of INTENTS as readonly Intent[]) {
    const p = contextPacket(db, intent, nowMs, "finished the 100 page ml book, it was great");
    const chars = p.system.length + p.user.length;
    // ~4 chars per token: 4000 chars is ~1k tokens
    assert.ok(chars < 4000, `${intent} packet is ${chars} chars`);
  }
});

// ---------------------------------------------------------------- plan + override (Phase 10)

const TODAY = "2026-10-30"; // nowMs is 14:30 IST that day
const TOMORROW = "2026-10-31";

function planned() {
  const db = world();
  for (const [date, lane, title] of [
    [TODAY, "fitness", "Gym: Back / Biceps"],
    [TODAY, "study", "DSA: Two Sum"],
    [TODAY, "reading", "Read: Borges"],
    [TOMORROW, "study", "System design: Scalability"],
  ] as const) applyOp(db, { type: "add_item", date, lane, title }, { now });
  return db;
}
const itemId = (db: ReturnType<typeof planned>, title: string) => db.all<{ id: number }>("SELECT id FROM plan_item WHERE title = ?", title)[0].id;

test("plan: 'done with gym' resolves today's gym item by lane word", async () => {
  const db = planned();
  const out = await run(db, model("plan", 0.95, { action: "done", ref: "gym" }), "done with gym");
  assert.deepEqual(out, { kind: "ops", ops: [{ type: "set_item_status", item_id: itemId(db, "Gym: Back / Biceps"), status: "done" }] });
});

test("plan: skip by title fragment; tomorrow is searched when today has no match", async () => {
  const db = planned();
  const a = await run(db, model("plan", 0.9, { action: "skip", ref: "reading" }), "skip reading today");
  assert.deepEqual(a, { kind: "ops", ops: [{ type: "set_item_status", item_id: itemId(db, "Read: Borges"), status: "skipped" }] });
  const b = await run(db, model("plan", 0.9, { action: "skip", ref: "system design" }), "skip system design");
  assert.deepEqual(b, { kind: "ops", ops: [{ type: "set_item_status", item_id: itemId(db, "System design: Scalability"), status: "skipped" }] });
});

test("plan: add defaults to today and the personal lane; move needs a date", async () => {
  const db = planned();
  const add = await run(db, model("plan", 0.9, { action: "add", title: "Call mom", date: TOMORROW }), "add call mom tomorrow");
  assert.deepEqual(add, { kind: "ops", ops: [{ type: "add_item", date: TOMORROW, lane: "personal", title: "Call mom" }] });
  const mv = await run(db, model("plan", 0.9, { action: "move", ref: "dsa", date: "2026-11-01" }), "move DSA to Sunday");
  assert.deepEqual(mv, { kind: "ops", ops: [{ type: "move_item", item_id: itemId(db, "DSA: Two Sum"), to_date: "2026-11-01" }] });
  const m = model("plan", 0.9, { action: "move", ref: "dsa" });
  assert.equal((await run(db, m, "move DSA")).kind, "inbox", "no date -> rejected twice -> inbox");
});

test("plan: nothing matching, or several, becomes a question", async () => {
  const db = planned();
  const none = await run(db, model("plan", 0.9, { action: "done", ref: "guitar" }), "done with guitar");
  assert.ok(none.kind === "reply" && /couldn't find "guitar"/.test(none.html));
  applyOp(db, { type: "add_item", date: TODAY, lane: "study", title: "DSA: Valid Anagram" }, { now });
  const many = await run(db, model("plan", 0.9, { action: "done", ref: "dsa" }), "done dsa");
  assert.ok(many.kind === "reply" && /Which one/.test(many.html) && /Valid Anagram/.test(many.html));
});

test("override: dates are validated and the affected range is reported", async () => {
  const out = await run(world(), model("override", 0.95, { override_type: "TRAVEL", start_date: TODAY, end_date: "2026-11-01", note: "Pune" }), "travelling till Sunday");
  assert.deepEqual(out, {
    kind: "ops",
    ops: [{ type: "set_override", override_type: "TRAVEL", start_date: TODAY, end_date: "2026-11-01", note: "Pune" }],
    affects: { from: TODAY, to: "2026-11-01" },
  });
  const backwards = model("override", 0.95, { override_type: "SICK", start_date: TOMORROW, end_date: TODAY });
  assert.equal((await run(world(), backwards, "sick")).kind, "inbox");
  const farAway = model("override", 0.95, { override_type: "OUT", start_date: "2027-06-01", end_date: "2027-06-01" });
  assert.equal((await run(world(), farAway, "out next june")).kind, "inbox");
});
