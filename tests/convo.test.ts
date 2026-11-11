import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAST_MS, PENDING_MS, choiceFrom, choiceOps, clearPending, confirmFrom, getLast, getPending, setLast, setPending,
} from "../src/convo.ts";
import type { Answer, Pending } from "../src/convo.ts";
import { applyOp } from "../src/ops.ts";
import { loadStudySeed } from "../src/seed.ts";
import { understand } from "../src/understand.ts";
import type { InferBackend } from "../src/infer.ts";
import { fixedNow, migratedDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);
const options = [
  { id: 11, title: "System design: Learn: 1.1 Scalability Basics" },
  { id: 12, title: "Read: High Scalability - pick any \"How X scales\" article" },
];
const choose: Pending = { kind: "choose_item", action: "done", options };

// -------------------------------------------------------------------- state

test("a pending question lasts 30 minutes, then is gone", () => {
  const db = migratedDb();
  assert.equal(getPending(db, T0), null);
  setPending(db, T0, choose);
  assert.deepEqual(getPending(db, T0 + PENDING_MS - 1), choose);
  assert.equal(getPending(db, T0 + PENDING_MS), null);
});

test("a newer question replaces the old one; clearing leaves the last action alone", () => {
  const db = migratedDb();
  setLast(db, T0, { summary: "Logged 3 sets", revisionId: 7, exercises: ["Face Pull"] });
  setPending(db, T0, choose);
  const other: Pending = { kind: "choose_item", action: "skip", options: [options[0]] };
  setPending(db, T0 + 1000, other);
  assert.deepEqual(getPending(db, T0 + 2000), other);
  clearPending(db);
  assert.equal(getPending(db, T0 + 2000), null);
  assert.equal(getLast(db, T0 + 2000)?.revisionId, 7);
  clearPending(db); // clearing nothing is fine
});

test("the last action lasts two hours", () => {
  const db = migratedDb();
  setLast(db, T0, { summary: "Logged", revisionId: 1, exercises: [] });
  assert.ok(getLast(db, T0 + LAST_MS - 1));
  assert.equal(getLast(db, T0 + LAST_MS), null);
});

test("a corrupt stored value is treated as no state", () => {
  const db = migratedDb();
  db.run("INSERT INTO bot_state (key, value) VALUES ('convo', '{not json')");
  assert.equal(getPending(db, T0), null);
  setPending(db, T0, choose); // and can be overwritten
  assert.deepEqual(getPending(db, T0), choose);
});

// ------------------------------------------------------------ answering a choice

const ans = (kind: Answer["kind"], ids: number[] = [], name = ""): Answer => ({ kind, ids, name });

test("choice: the model's numbers become the option ids", () => {
  assert.deepEqual(choiceFrom(ans("choose", [1, 2]), options), { ids: [11, 12] }, "both");
  assert.deepEqual(choiceFrom(ans("choose", [2]), options), { ids: [12] });
  assert.deepEqual(choiceFrom(ans("choose", [1, 1]), options), { ids: [11] }, "a repeated number counts once");
});

test("choice: deny cancels; a number that is not an option, or no pick, is not an answer", () => {
  assert.equal(choiceFrom(ans("deny"), options), "cancel");
  assert.equal(choiceFrom(ans("choose", [3]), options), null, "there is no third option");
  assert.equal(choiceFrom(ans("choose", [1, 3]), options), null, "a partly wrong pick is not guessed at");
  assert.equal(choiceFrom(ans("choose", []), options), null);
  assert.equal(choiceFrom(ans("affirm"), options), null, "'yes' does not say which");
  assert.equal(choiceFrom(ans("name", [], "basics"), options), null);
});

test("choiceOps: the same action for every chosen item", () => {
  assert.deepEqual(choiceOps({ kind: "choose_item", action: "done", options }, [11, 12]), [
    { type: "set_item_status", item_id: 11, status: "done" },
    { type: "set_item_status", item_id: 12, status: "done" },
  ]);
  assert.deepEqual(choiceOps({ kind: "choose_item", action: "skip", options }, [12]), [{ type: "set_item_status", item_id: 12, status: "skipped" }]);
  assert.deepEqual(choiceOps({ kind: "choose_item", action: "move", toDate: "2026-11-07", options }, [11]), [
    { type: "move_item", item_id: 11, to_date: "2026-11-07" },
  ]);
});

// --------------------------------------------------------- answering a confirmation

test("confirm: affirm is yes, new is new, deny cancels, a name is checked", () => {
  assert.equal(confirmFrom(ans("affirm")), "yes");
  assert.equal(confirmFrom(ans("new")), "new");
  assert.equal(confirmFrom(ans("deny")), "cancel");
  assert.deepEqual(confirmFrom(ans("name", [], " rear delt fly ")), { name: "rear delt fly" });
  assert.equal(confirmFrom(ans("name", [], "ab")), null, "too short to be a name");
  assert.equal(confirmFrom(ans("choose", [1])), null);
});

// ------------------------------------------------- the real flow: the "Both" bug

const now = fixedNow();
const TODAY = "2026-11-03";
const nowMs = Date.UTC(2026, 10, 3, 9, 0, 0); // 14:30 IST

function ambiguousDay() {
  const db = migratedDb();
  loadStudySeed(db, { tracks: [{ id: "t", title: "T", lane: "study", lists: [{ id: "l", title: "L", units: [{ ordinal: 1, title: "x" }] }] }] }, now);
  applyOp(db, { type: "add_item", date: TODAY, lane: "study", title: "System design: Learn: 1.1 Scalability Basics" }, { now });
  applyOp(db, { type: "add_item", date: TODAY, lane: "reading", title: "Read: High Scalability - pick any \"How X scales\" article" }, { now });
  return db;
}

const scripted = (extraction: unknown): InferBackend => ({
  name: "fake",
  async json(req: { system: string }) {
    return req.system.includes("Classify the message") ? { intent: "plan", confidence: 0.95 } : extraction;
  },
});

test("'which one?' then 'Both' marks both items done", async () => {
  const db = ambiguousDay();
  const out = await understand({ db, backends: [scripted({ action: "done", ref: "scalability", date: TODAY })], nowMs, log: () => {} }, "completed the scalability readings");
  assert.equal(out.kind, "choose");
  if (out.kind !== "choose") return;
  assert.deepEqual(out.pending.options.map((o) => o.title), options.map((o) => o.title).map((t) => t));
  setPending(db, nowMs, out.pending);

  const open = getPending(db, nowMs + 20_000)!;
  assert.equal(open.kind, "choose_item");
  const a = choiceFrom(ans("choose", [1, 2]), (open as Extract<Pending, { kind: "choose_item" }>).options);
  assert.ok(a !== null && a !== "cancel");
  if (open.kind !== "choose_item") return;
  for (const op of choiceOps(open, a.ids)) applyOp(db, op, { now });
  clearPending(db);

  const statuses = db.all<{ status: string }>("SELECT status FROM plan_item WHERE date = ? ORDER BY id", TODAY).map((r) => r.status);
  assert.deepEqual(statuses, ["done", "done"]);
  assert.equal(getPending(db, nowMs + 30_000), null, "answered, so nothing is left open");
});
