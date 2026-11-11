import { test } from "node:test";
import assert from "node:assert/strict";
import { logIn, logOut } from "../src/chatlog.ts";
import { buildConversation } from "../src/conversation.ts";
import { setPending } from "../src/convo.ts";
import type { InferBackend } from "../src/infer.ts";
import { understand } from "../src/understand.ts";
import { migratedDb } from "./helpers.ts";

// 2026-11-09 21:05 IST
const NOW = Date.UTC(2026, 10, 9, 15, 35, 0);
const min = (n: number) => NOW + n * 60_000;

test("nothing to show: an empty string, so prompts stay as short as before", () => {
  assert.equal(buildConversation(migratedDb(), NOW), "");
});

test("a swipe-reply shows the message it answers with its tag; recent lines carry time and who spoke", () => {
  const db = migratedDb();
  logOut(db, min(-30), { text: "Tomorrow: <b>Gym Legs</b>, DSA x2.\nReply ok to lock.", tgId: 700, tag: "evening_recap" });
  logOut(db, min(-5), { text: "⏰ <b>call the bank</b>", tgId: 701, tag: "reminder:4" });
  const id = logIn(db, NOW, { text: "ok", tgId: 702, replyToTgId: 700 });
  const out = buildConversation(db, NOW, { replyTo: { tgId: 700, text: "ignored when we have it" }, excludeLogId: id });
  assert.match(out, /^Conversation:/);
  assert.match(out, /Replying to \[bot evening_recap\]: "Tomorrow: Gym Legs, DSA x2\. Reply ok to lock\."/);
  assert.match(out, /\[bot 20:35 evening_recap\] Tomorrow: Gym Legs/);
  assert.match(out, /\[bot 21:00 reminder:4\] ⏰ call the bank/);
  assert.doesNotMatch(out, /\[you 21:05\] ok/, "the message being understood is not in Recent");
});

test("a reply to a message we never logged still shows Telegram's copy of it", () => {
  const out = buildConversation(migratedDb(), NOW, { replyTo: { tgId: 9, text: "older message text" } });
  assert.match(out, /Replying to: "older message text"/);
});

test("an open question is described with its numbered options", () => {
  const db = migratedDb();
  setPending(db, NOW, { kind: "choose_item", action: "done", options: [{ id: 1, title: "Reading: DDIA" }, { id: 2, title: "Reading: Sapiens" }] });
  assert.match(buildConversation(db, NOW), /Open question \(which plan item to done\): 1\. Reading: DDIA {2}2\. Reading: Sapiens/);
});

test("understand puts the conversation into both the classify and the extract prompts", async () => {
  const db = migratedDb();
  const seen: { task: string; user: string }[] = [];
  const backend: InferBackend = {
    name: "spy",
    async json(req: { system: string; user: string }) {
      seen.push({ task: req.system.includes("Classify the message") ? "classify" : "extract", user: req.user });
      return req.system.includes("Classify the message") ? { intent: "chat", confidence: 0.9 } : { reply: "ok" };
    },
  };
  const conversation = 'Conversation:\nReplying to [bot evening_recap]: "Reply ok to lock."';
  await understand({ db, backends: [backend], nowMs: NOW, log: () => {}, conversation }, "ok");
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.ok(s.user.includes("Replying to [bot evening_recap]"), s.task);
    assert.ok(s.user.endsWith("Message: ok"), s.task);
  }
  seen.length = 0;
  await understand({ db, backends: [backend], nowMs: NOW, log: () => {} }, "hello");
  assert.ok(!seen[0].user.includes("Conversation:"));
});
