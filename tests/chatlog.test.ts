import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP_MS, byTgId, lastOut, logIn, logOut, noteOutcome, plain, recent } from "../src/chatlog.ts";
import { readView } from "../src/views.ts";
import { migratedDb } from "./helpers.ts";

const T0 = Date.parse("2026-11-09T15:30:00Z");
const min = (n: number) => T0 + n * 60_000;

test("plain: strips tags and entities, collapses space, clips", () => {
  assert.equal(plain("🔒 <b>Locked</b> Tue &amp; Wed\n\n<i>see you</i>"), "🔒 Locked Tue & Wed see you");
  assert.equal(plain("x".repeat(500)).length, 240);
});

test("both directions are logged, with ids, tags and the replied-to message", () => {
  const db = migratedDb();
  logOut(db, min(0), { text: "<b>Tomorrow</b>: Gym, DSA. Reply ok to lock.", tgId: 501, tag: "evening_recap" });
  const id = logIn(db, min(2), { text: "ok", tgId: 502, replyToTgId: 501, replyToText: "Tomorrow: Gym, DSA." });
  const rows = recent(db, min(3));
  assert.deepEqual(rows.map((r) => [r.dir, r.tag, r.tg_message_id]), [["out", "evening_recap", 501], ["in", null, 502]]);
  assert.equal(rows[1].reply_to_tg_id, 501);
  assert.equal(byTgId(db, 501)?.tag, "evening_recap");
  assert.equal(byTgId(db, 502), null, "only bot messages are looked up by id");
  assert.equal(recent(db, min(3), { excludeId: id }).length, 1, "the message being understood can be left out");
});

test("recent: last four within two hours, oldest first", () => {
  const db = migratedDb();
  logOut(db, min(-300), { text: "old" });
  for (let i = 0; i < 6; i++) logOut(db, min(i), { text: `m${i}` });
  assert.deepEqual(recent(db, min(10)).map((r) => r.text), ["m2", "m3", "m4", "m5"]);
  assert.equal(lastOut(db, min(10))?.text, "m5");
  assert.equal(lastOut(db, min(10 + 200)), null, "nothing recent enough");
});

test("old rows are pruned when the bot sends", () => {
  const db = migratedDb();
  logOut(db, T0 - KEEP_MS - 60_000, { text: "ancient" });
  logOut(db, T0, { text: "fresh" });
  assert.deepEqual(db.all<{ text: string }>("SELECT text FROM chat_log").map((r) => r.text), ["fresh"]);
});

test("outcomes are merged into the inbound row and show in the chat_log view", () => {
  const db = migratedDb();
  const id = logIn(db, T0, { text: "protein 110", replyToText: "x" });
  noteOutcome(db, id, { intent: "metric", confidence: 0.9, ms: 812 });
  const row = JSON.parse(db.all<{ parsed_json: string }>("SELECT parsed_json FROM chat_log WHERE id = ?", id)[0].parsed_json);
  assert.deepEqual(row, { replied_to_text: "x", intent: "metric", confidence: 0.9, ms: 812 });
  const view = readView(db, "chat_log", {}, T0);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].text, "protein 110");
});
