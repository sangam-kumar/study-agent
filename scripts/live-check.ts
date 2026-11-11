// Live check of the model calls: every example phrase goes through the REAL model(s) against the
// real seeds in an in-memory database, and the outcome is checked. Nothing is sent to Telegram and
// nothing touches the deployed agent. Costs a few dozen model calls.
//
//   npm run live-check              # Gemini, all phrases
//   npm run live-check -- --workers # Workers AI (fallback), a smaller set to save the daily neurons
//   npm run live-check -- --only reminder,plan --model gemini-3.5-flash --gap 13
//
// Reads GEMINI_API_KEY / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from .dev.vars (never printed).

import { readFileSync } from "node:fs";
import { GeminiBackend, WorkersAiBackend } from "../src/ai/backends.ts";
import type { InferBackend } from "../src/infer.ts";
import { applyOp } from "../src/ops.ts";
import { ensureDraft, loadItems } from "../src/day.ts";
import { loadConfigSeed } from "../src/seed-config.ts";
import { loadReadingSeed } from "../src/seed-reading.ts";
import { loadStudySeed } from "../src/seed.ts";
import { istWallToMs } from "../src/time.ts";
import { understand } from "../src/understand.ts";
import { insertReminder } from "../src/reminders.ts";
import type { Outcome } from "../src/understand.ts";
import { migratedDb } from "../tests/helpers.ts";

// ------------------------------------------------------------------ setup

const vars: Record<string, string> = {};
for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const args = process.argv.slice(2);
const useWorkers = args.includes("--workers");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "gemini-3.5-flash-lite";
const gapMs = args.includes("--gap") ? Number(args[args.indexOf("--gap") + 1]) * 1000 : 6500;

const TODAY = "2026-11-02"; // Monday: a gym day
const TOMORROW = "2026-11-03";
const nowMs = istWallToMs(TODAY, "10:00");
const now = () => new Date(nowMs);

const db = migratedDb();
const seed = (f: string) => JSON.parse(readFileSync(`../study-repo/seed/${f}`, "utf8"));
loadConfigSeed(db, seed("config.json"), now);
loadStudySeed(db, seed("study.json"), now);
loadReadingSeed(db, seed("reading.json"), now);
const ddia = db.all<{ id: number }>("SELECT id FROM reading_item WHERE title = 'Designing Data-Intensive Applications (DDIA)'")[0].id;
applyOp(db, { type: "start_reading", reading_id: ddia }, { now });
ensureDraft(db, TODAY, nowMs);
ensureDraft(db, TOMORROW, nowMs);
// Today's session, so the workout_edit phrases have something to point at.
const set = (weight_kg: number, reps: number) => ({ weight_kg, reps, duration_s: null, rest_s: null, kind: "working" as const, bw: false, notes: null, incomplete: false });
applyOp(db, { type: "log_workout", date: TODAY, mode: "append", exercises: [
  { name: "Face Fll", sets: [set(15, 12), set(15, 12)] },
  { name: "Flat Bench Press", sets: [set(20, 12), set(20, 12), set(20, 12)] },
  { name: "Calf Raise", sets: [set(0, 20)] },
] } as never, { now });
// Logging that session ticked today's gym item; the plan cases need it open.
db.run("UPDATE plan_item SET status = 'planned' WHERE lane = 'fitness' AND date = ?", TODAY);
const bankReminder = insertReminder(db, { text: "call the bank about the card", dueMs: istWallToMs(TOMORROW, "16:00") }, nowMs);
const item = (date: string, pred: (t: string) => boolean) => loadItems(db, date).find((i) => pred(i.title))?.id;
const bookId = (like: string) => db.all<{ id: number }>("SELECT id FROM reading_item WHERE title LIKE ?", like)[0]?.id;

// ------------------------------------------------------------------ cases

type Check = (o: Outcome) => boolean;
interface Case { group: string; text: string; expect: string; check: Check; workers?: boolean; conversation?: string }

const ops = (o: Outcome) => (o.kind === "ops" ? o.ops : []);
const op1 = (o: Outcome) => ops(o)[0] ?? {};
const isOp = (type: string, extra: Record<string, unknown> = {}): Check => (o) =>
  op1(o).type === type && Object.entries(extra).every(([k, v]) => (typeof v === "function" ? (v as (x: unknown) => boolean)(op1(o)[k]) : op1(o)[k] === v));
const has = (s: string) => (x: unknown) => typeof x === "string" && x.toLowerCase().includes(s);


// Conversation contexts for the answer cases (what buildConversation() would hand the model).
const RECAP = 'Conversation:\nReplying to [bot evening_recap]: "Tomorrow (Tue 3 Nov): Gym Legs, DSA x2, Reading DDIA. Reply ok to lock."\nRecent:\n  [bot 21:00 evening_recap] Tomorrow (Tue 3 Nov): Gym Legs, DSA x2, Reading DDIA. Reply ok to lock.';
const RECAP_PLAIN = 'Conversation:\nRecent:\n  [bot 21:00 evening_recap] Tomorrow (Tue 3 Nov): Gym Legs, DSA x2, Reading DDIA. Reply ok to lock.';
const WHICH = 'Conversation:\nRecent:\n  [you 10:01] done with reading\n  [bot 10:01 question] Which one on Mon 2 Nov? 1. Reading: DDIA  2. Reading: Sapiens\nOpen question (which plan item to done): 1. Reading: DDIA  2. Reading: Sapiens';
const CONFIRM = 'Conversation:\nRecent:\n  [you 11:20] face full 15x12, 15x12\n  [bot 11:20 question] Is this the exercise you meant? "face full" -> Face Pull. Reply yes, new, or say the name.\nOpen question (is this the exercise?): "face full" = "Face Pull"?';
const REMIND = 'Conversation:\nReplying to [bot reminder:4]: "call the bank about the card"\nRecent:\n  [bot 16:00 reminder:4] call the bank about the card';
const isAnswer = (kind: string, ids?: number[], name?: string): Check => (o) =>
  o.kind === "answer" && o.answer.kind === kind && (!ids || JSON.stringify(o.answer.ids) === JSON.stringify(ids)) && (!name || o.answer.name.toLowerCase().includes(name));

const cases: Case[] = [
  // reading
  { group: "reading", text: "finished the 100 page ml book", expect: "finish_reading Hundred-Page", check: isOp("finish_reading", { reading_id: bookId("The Hundred-Page%") }), workers: true },
  { group: "reading", text: "drop sapiens, it's boring", expect: "drop_reading Sapiens + reason", check: isOp("drop_reading", { reading_id: bookId("Sapiens%"), reason: has("bor") }) },
  { group: "reading", text: "pause DDIA for now", expect: "hold_reading DDIA", check: isOp("hold_reading", { reading_id: ddia }) },
  { group: "reading", text: "add Deep Work by Cal Newport to my books", expect: "add_reading + author", check: isOp("add_reading", { title: has("deep work"), author: has("newport") }) },
  // reminders (now = Mon 10:00 IST)
  { group: "reminder", text: "remind me to play ball at 6:30 pm today", expect: "reminder today 18:30", check: (o) => o.kind === "reminder" && o.dueMs === istWallToMs(TODAY, "18:30") && /ball/i.test(o.text), workers: true },
  { group: "reminder", text: "remind me in 45 minutes to stretch", expect: "reminder in 45 min", check: (o) => o.kind === "reminder" && o.dueMs === nowMs + 45 * 60_000 },
  { group: "reminder", text: "remind me tomorrow at 7am to call the bank", expect: "reminder Tue 07:00", check: (o) => o.kind === "reminder" && o.dueMs === istWallToMs(TOMORROW, "07:00") },
  { group: "reminder", text: "submit the Amazon application by Sunday", expect: "task due Sun 8 Nov, no ping", check: (o) => o.kind === "task" && o.dueDate === "2026-11-08" && /amazon/i.test(o.text) },
  { group: "reminder", text: "every Monday at 9am remind me to review the week", expect: "repeat weekly:0, first Mon 9 Nov 09:00", check: (o) => o.kind === "reminder" && o.repeat === "weekly:0" && o.dueMs === istWallToMs("2026-11-09", "09:00") },
  { group: "reminder", text: "remind me every weekday at 7:30 am to stretch", expect: "repeat weekdays, first Tue 07:30", check: (o) => o.kind === "reminder" && o.repeat === "weekdays" && o.dueMs === istWallToMs(TOMORROW, "07:30") },
  { group: "reminder", text: "cancel the bank reminder", expect: "cancel the bank reminder", check: (o) => o.kind === "reminder_action" && o.action === "cancel" && o.id === bankReminder },
  { group: "reminder", text: "remind me on Friday at 4pm to submit the application", expect: "reminder Fri 6 Nov 16:00", check: (o) => o.kind === "reminder" && o.dueMs === istWallToMs("2026-11-06", "16:00") },
  { group: "reminder", text: "remind me on 15 Nov at 6pm to pay rent", expect: "reminder Sun 15 Nov 18:00", check: (o) => o.kind === "reminder" && o.dueMs === istWallToMs("2026-11-15", "18:00") },
  // plan edits (today: gym day)
  { group: "plan", text: "done with gym", expect: "gym item done", check: isOp("set_item_status", { item_id: item(TODAY, (t) => t.startsWith("Gym")), status: "done" }), workers: true },
  { group: "plan", text: "skip reading today", expect: "reading item skipped", check: isOp("set_item_status", { item_id: item(TODAY, (t) => t.startsWith("Read")), status: "skipped" }) },
  { group: "plan", text: "add call mom tomorrow", expect: "add_item tomorrow", check: isOp("add_item", { date: TOMORROW, title: has("mom") }), workers: true },
  { group: "plan", text: "move DSA to Saturday", expect: "move_item to 2026-11-07", check: isOp("move_item", { to_date: "2026-11-07" }) },
  // overrides
  { group: "override", text: "travelling Fri to Sun", expect: "TRAVEL 11-06..11-08", check: isOp("set_override", { override_type: "TRAVEL", start_date: "2026-11-06", end_date: "2026-11-08" }), workers: true },
  { group: "override", text: "down with a fever", expect: "SICK from today", check: isOp("set_override", { override_type: "SICK", start_date: TODAY }) },
  { group: "override", text: "feeling low today", expect: "LOW_MOOD today", check: isOp("set_override", { override_type: "LOW_MOOD", start_date: TODAY, end_date: TODAY }) },
  { group: "override", text: "out all day tomorrow", expect: "OUT tomorrow", check: isOp("set_override", { override_type: "OUT", start_date: TOMORROW, end_date: TOMORROW }) },
  // jots and progress (DDIA is the one book being read)
  { group: "jot", text: "ch5 of DDIA: replication lag breaks read-your-writes", expect: "jot on DDIA at ch5", check: (o) => ops(o).length === 1 && ops(o)[0].type === "add_jot" && ops(o)[0].reading_id === ddia && ops(o)[0].locator === "ch5" },
  { group: "jot", text: "interesting point in the book about quorums needing w plus r greater than n", expect: "jot on the current book", check: (o) => ops(o)[0]?.type === "add_jot" && ops(o)[0].reading_id === ddia },
  { group: "jot", text: "finished chapter 3 of DDIA", expect: "progress ch3 done (not the whole book)", check: isOp("set_progress", { reading_id: ddia, locator: "ch3 done" }) },
  { group: "jot", text: "I'm on page 140 of designing data intensive applications", expect: "progress p140", check: isOp("set_progress", { reading_id: ddia, locator: "p140" }) },
  // study, note, workout, snooze, chat, vague
  { group: "study", text: "did 3 DSA problems", expect: "advance dsa to 4", check: isOp("advance_pointer", { list_id: "dsa", to_ordinal: 4 }), workers: true },
  { group: "note", text: "my knee hurts, go easy on legs this week", expect: "add_note", check: isOp("add_note", { text: has("knee") }) },
  {
    group: "workout", text: "did chest today: flat bench 3 sets of 12 at 20kg, incline press 3x10 at 15kg", expect: "2 exercises, 3 × (20 kg × 12) and 3 × (15 kg × 10)", workers: true,
    check: (o) => o.kind === "workout" && o.op.date === TODAY && o.op.exercises.length === 2
      && o.op.exercises[0].sets.length === 3 && o.op.exercises[0].sets.every((s) => s.weight_kg === 20 && s.reps === 12)
      && o.op.exercises[1].sets.every((s) => s.weight_kg === 15 && s.reps === 10),
  },
  {
    group: "workout-voice", text: "lat pulldown twenty five kgs fifteen reps, then twenty five for twelve, then thirty kgs for eight to failure", expect: "25×15, 25×12, 30×8 F",
    check: (o) => o.kind === "workout" && o.op.exercises.length === 1
      && JSON.stringify(o.op.exercises[0].sets.map((s) => [s.weight_kg, s.reps])) === "[[25,15],[25,12],[30,8]]" && o.op.exercises[0].sets[2].kind === "failure",
  },
  {
    group: "workout", text: "yesterday legs: calf raises bodyweight 3 sets of 20, deep squat hold 30 seconds twice; left knee felt a bit off", expect: "yesterday, BW×20 ×3, 2 × 30s, pain noted",
    check: (o) => o.kind === "workout" && o.op.date === "2026-11-01" && !!o.op.pain && /knee/i.test(o.op.pain)
      && o.op.exercises.some((e) => e.sets.length === 3 && e.sets.every((s) => s.reps === 20 && (s.bw || s.weight_kg === null)))
      && o.op.exercises.some((e) => e.sets.length === 2 && e.sets.every((s) => s.duration_s === 30)),
  },
  {
    group: "workout", text: "done with shoulders, lateral raise 5x15 three times, and had about 110g protein", expect: "3 sets + protein 110",
    check: (o) => o.kind === "workout" && o.protein === 110 && o.op.exercises[0].sets.length === 3,
  },
  { group: "workout_edit", text: "face fll should be face pull", expect: "rename_exercise Face Fll -> Face Pull", check: isOp("rename_exercise", { from: has("face"), to: has("face pull") }) },
  { group: "workout_edit", text: "oops the bench set 2 was 10 reps not 12", expect: "amend_set bench set 2 reps 10", check: isOp("amend_set", { set_no: 2, reps: 10 }) },
  { group: "workout_edit", text: "I didn't actually do calf raises, remove them", expect: "remove_exercise calf", check: isOp("remove_exercise", { exercise: has("calf") }) },
  { group: "workout_edit", text: "the last bench set was only 8 reps", expect: "amend_set bench set 3 reps 8", check: isOp("amend_set", { set_no: 3, reps: 8 }) },
  // baseline (16b.1): phrases the hand-written shortcuts catch today, run through the model alone
  { group: "baseline", text: "protein 110", expect: "protein 110 recorded", check: (o) => o.kind === "workout" && o.protein === 110 || (o.kind === "ops" && op1(o).type === "log_metric" && op1(o).value === 110) },
  { group: "baseline", text: "had about 95g protein today", expect: "protein 95 recorded", check: (o) => o.kind === "workout" && o.protein === 95 || (o.kind === "ops" && op1(o).type === "log_metric" && op1(o).value === 95) },
  { group: "baseline", text: "ch3: leader replication lag breaks read-your-writes", expect: "add_jot on DDIA, locator ch3", check: isOp("add_jot", { reading_id: ddia, text: has("replication lag") }) },
  { group: "baseline", text: "finished ch3", expect: "set_progress on DDIA ch3", check: isOp("set_progress", { reading_id: ddia, locator: has("3") }) },
  { group: "baseline", text: "on p140", expect: "set_progress on DDIA p140", check: isOp("set_progress", { reading_id: ddia, locator: has("140") }) },
  { group: "baseline", text: "bench 20x15, 22.5x12", expect: "one exercise, 20x15 and 22.5x12", check: (o) => o.kind === "workout" && o.op.exercises.length === 1 && JSON.stringify(o.op.exercises[0].sets.map((s) => [s.weight_kg, s.reps])) === "[[20,15],[22.5,12]]" },
  { group: "baseline", text: "lat pulldown 25x15, row 30x12 and 30x10", expect: "two exercises", check: (o) => o.kind === "workout" && o.op.exercises.length === 2 },
  // answers (16b.7): short replies read against the conversation
  { group: "answer", text: "ok", conversation: RECAP, expect: "affirm (swipe-reply to the recap)", check: isAnswer("affirm") },
  { group: "answer", text: "lock it", conversation: RECAP_PLAIN, expect: "affirm (plain reply after the recap)", check: isAnswer("affirm") },
  { group: "answer", text: "looks good", conversation: RECAP_PLAIN, expect: "affirm", check: isAnswer("affirm") },
  { group: "answer", text: "no wait, leave it for now", conversation: RECAP_PLAIN, expect: "deny", check: isAnswer("deny") },
  { group: "answer", text: "both", conversation: WHICH, expect: "choose 1 and 2", check: isAnswer("choose", [1, 2]) },
  { group: "answer", text: "the second one", conversation: WHICH, expect: "choose 2", check: isAnswer("choose", [2]) },
  { group: "answer", text: "the sapiens one", conversation: WHICH, expect: "choose 2", check: isAnswer("choose", [2]) },
  { group: "answer", text: "neither", conversation: WHICH, expect: "deny", check: isAnswer("deny") },
  { group: "answer", text: "yeah that's right", conversation: CONFIRM, expect: "affirm", check: isAnswer("affirm") },
  { group: "answer", text: "no it's a new one", conversation: CONFIRM, expect: "new", check: isAnswer("new") },
  { group: "answer", text: "rear delt fly", conversation: CONFIRM, expect: "name rear delt fly", check: isAnswer("name", undefined, "rear delt") },
  { group: "answer", text: "done", conversation: REMIND, expect: "affirm (a reminder reply)", check: isAnswer("affirm") },
  { group: "answer-not", text: "move gym to Saturday", conversation: RECAP_PLAIN, expect: "a plan edit, not an answer", check: (o) => o.kind === "ops" && op1(o).type === "move_item" },
  { group: "answer-not", text: "protein 90", conversation: RECAP_PLAIN, expect: "a protein entry, not an answer", check: (o) => o.kind === "ops" && op1(o).type === "log_metric" },
  { group: "status", text: "gn", expect: "bed", check: (o) => o.kind === "status" && o.status === "bed" },
  { group: "status", text: "Sleeping now", expect: "bed", check: (o) => o.kind === "status" && o.status === "bed" },
  { group: "status", text: "off to bed, long day", expect: "bed", check: (o) => o.kind === "status" && o.status === "bed" },
  { group: "status", text: "up", expect: "wake", check: (o) => o.kind === "status" && o.status === "wake" },
  { group: "status", text: "good morning", expect: "wake", check: (o) => o.kind === "status" && o.status === "wake" },
  { group: "status", text: "I slept badly", expect: "not a status", check: (o) => o.kind !== "status" },
  { group: "office", text: "office tue thu", expect: "Tue, Thu", check: (o) => o.kind === "office" && JSON.stringify(o.weekdays) === "[1,3]" },
  { group: "office", text: "I'm in the office on Monday and Wednesday this week", expect: "Mon, Wed", check: (o) => o.kind === "office" && JSON.stringify(o.weekdays) === "[0,2]" },
  { group: "office", text: "working from home all week", expect: "none", check: (o) => o.kind === "office" && o.weekdays.length === 0 },
  { group: "office", text: "add office party on friday to my plan", expect: "a plan edit, not office days", check: (o) => o.kind !== "office" },
  // protein as additions (Phase 17)
  { group: "metric", text: "protein 26", expect: "add 26", check: isOp("log_metric", { value: 26, mode: "add" }) },
  { group: "metric", text: "whey", expect: "add 26 (whey preset)", check: isOp("log_metric", { value: 26, mode: "add", label: has("whey") }) },
  { group: "metric", text: "had two scoops of whey", expect: "add 52 (2 x whey)", check: isOp("log_metric", { value: 52, mode: "add" }) },
  { group: "metric", text: "soy chunks", expect: "add 50 (soy chunks preset)", check: isOp("log_metric", { value: 50, mode: "add" }) },
  { group: "metric", text: "protein total 90", expect: "set the total to 90", check: isOp("log_metric", { value: 90, mode: "set" }) },
  { group: "metric", text: "whey is 30 g now", expect: "set_config presets", check: isOp("set_config", { key: "protein.presets" }) },
  // feedback vs note (Phase 17)
  { group: "feedback", text: "Note for today, the agent is duplicating the sets when the protein is updated across the day", expect: "feedback bug", check: isOp("add_feedback", { kind: "bug" }) },
  { group: "feedback", text: "idea: let me set my own protein presets", expect: "feedback idea", check: isOp("add_feedback", { kind: "idea" }) },
  { group: "feedback", text: "note for the dev: the evening message came twice", expect: "feedback (bug or other)", check: (o) => op1(o).type === "add_feedback" },
  { group: "feedback", text: "it would be nice if you showed my protein in the weekly summary", expect: "feedback idea", check: (o) => op1(o).type === "add_feedback" },
  { group: "feedback", text: "my left shoulder is sore, go easy on pressing this week", expect: "a note about me, not feedback", check: isOp("add_note") },
  { group: "snooze", text: "pause your messages for 3 hours, I'm in a meeting", expect: "snooze 3h", check: (o) => o.kind === "snooze" && o.hours === 3 },
  { group: "chat", text: "hey how's it going", expect: "a reply, nothing changed", check: (o) => o.kind === "reply" },
  { group: "chat", text: "Today's workout\nLegs/Shoulders", expect: "a reply asking for the sets, not the inbox", check: (o) => o.kind === "reply" && /set/i.test(o.html) },
  { group: "vague", text: "the thing from earlier", expect: "inbox or a question", check: (o) => o.kind === "inbox" || o.kind === "reply", workers: true },
];

// ------------------------------------------------------------------ backends

/** Spaces calls out so the free tier's per-minute limit is not hit. */
function throttled(b: InferBackend, gapMs: number): InferBackend & { calls: number } {
  let last = 0;
  const t = {
    name: b.name,
    calls: 0,
    async json(req: Parameters<InferBackend["json"]>[0]) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      t.calls++;
      const r = await b.json(req);
      if (process.env.DBG) console.log("RAW", JSON.stringify(r).slice(0, 400));
      return r;
    },
  };
  return t;
}

let backend: InferBackend & { calls: number };
if (useWorkers) {
  const acct = vars.CLOUDFLARE_ACCOUNT_ID;
  const token = vars.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing in .dev.vars");
  const rest = async (model: string, input: Record<string, unknown>) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!r.ok) throw new Error(`Workers AI HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { result: unknown }).result;
  };
  backend = throttled(new WorkersAiBackend(rest), 500);
} else {
  if (!vars.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing in .dev.vars");
  backend = throttled(new GeminiBackend(vars.GEMINI_API_KEY, model), gapMs);
}

// ------------------------------------------------------------------ run

const groups = only ? only.split(",") : null;
const selected = cases.filter((c) => (!useWorkers || c.workers) && (!groups || groups.includes(c.group)) && (!process.env.ONLY_TEXT || process.env.ONLY_TEXT.split("|").includes(c.text.split(String.fromCharCode(10))[0])));
console.log(`Live check: ${backend.name}, ${selected.length} phrases, now = Mon 2 Nov 10:00 IST\n`);

let pass = 0;
const fails: string[] = [];
for (const c of selected) {
  const warnings: string[] = [];
  const started = Date.now();
  let out: Outcome;
  try {
    out = await understand({ db, backends: [backend], nowMs, conversation: c.conversation, log: (l) => { warnings.push(l); if (process.env.DBG) console.log("LOG", l.slice(0, 600)); } }, c.text);
  } catch (e) {
    out = { kind: "reply", html: `CRASH: ${(e as Error).message}` };
  }
  const ok = c.check(out);
  if (ok) pass++;
  const got = out.kind === "ops" ? JSON.stringify(out.ops) : out.kind === "reply" ? `reply: ${out.html.slice(0, 80)}` : out.kind === "inbox" ? `inbox: ${out.reason}` : JSON.stringify(out);
  const retry = warnings.length ? `
      ${warnings.length} retry/warning: ${warnings[0].replace(/\s+/g, " ").slice(0, 400)}` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  [${c.group}] "${c.text}"\n      expect ${c.expect}\n      got    ${ok ? got.slice(0, 200) : got}  ${Math.round((Date.now() - started) / 1000)}s${retry}`);
  if (!ok) fails.push(c.text);
}
console.log(`\n${pass}/${selected.length} passed, ${backend.calls} model calls.${fails.length ? `\nFailed: ${fails.map((f) => `"${f}"`).join(", ")}` : ""}`);
process.exitCode = fails.length ? 1 : 0;
