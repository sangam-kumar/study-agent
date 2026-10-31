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
const ddia = db.all<{ id: number }>("SELECT id FROM reading_item WHERE title LIKE 'Designing Data-Intensive%'")[0].id;
applyOp(db, { type: "start_reading", reading_id: ddia }, { now });
ensureDraft(db, TODAY, nowMs);
ensureDraft(db, TOMORROW, nowMs);
const item = (date: string, pred: (t: string) => boolean) => loadItems(db, date).find((i) => pred(i.title))?.id;
const bookId = (like: string) => db.all<{ id: number }>("SELECT id FROM reading_item WHERE title LIKE ?", like)[0]?.id;

// ------------------------------------------------------------------ cases

type Check = (o: Outcome) => boolean;
interface Case { group: string; text: string; expect: string; check: Check; workers?: boolean }

const ops = (o: Outcome) => (o.kind === "ops" ? o.ops : []);
const op1 = (o: Outcome) => ops(o)[0] ?? {};
const isOp = (type: string, extra: Record<string, unknown> = {}): Check => (o) =>
  op1(o).type === type && Object.entries(extra).every(([k, v]) => (typeof v === "function" ? (v as (x: unknown) => boolean)(op1(o)[k]) : op1(o)[k] === v));
const has = (s: string) => (x: unknown) => typeof x === "string" && x.toLowerCase().includes(s);

const cases: Case[] = [
  // reading
  { group: "reading", text: "finished the 100 page ml book", expect: "finish_reading Hundred-Page", check: isOp("finish_reading", { reading_id: bookId("The Hundred-Page%") }), workers: true },
  { group: "reading", text: "drop sapiens, it's boring", expect: "drop_reading Sapiens + reason", check: isOp("drop_reading", { reading_id: bookId("Sapiens%"), reason: has("bor") }) },
  { group: "reading", text: "pause DDIA for now", expect: "hold_reading DDIA", check: isOp("hold_reading", { reading_id: ddia }) },
  { group: "reading", text: "add Deep Work by Cal Newport to my books", expect: "add_reading + author", check: isOp("add_reading", { title: has("deep work"), author: has("newport") }) },
  // reminders (now = Mon 10:00 IST)
  { group: "reminder", text: "remind me to play ball at 6:30 pm today", expect: "reminder 510 min", check: (o) => o.kind === "reminder" && o.minutes === 510 && /ball/i.test(o.text), workers: true },
  { group: "reminder", text: "remind me in 45 minutes to stretch", expect: "reminder 45 min", check: (o) => o.kind === "reminder" && o.minutes === 45 },
  { group: "reminder", text: "remind me tomorrow at 7am to call the bank", expect: "reminder 1260 min", check: (o) => o.kind === "reminder" && o.minutes === 1260 },
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
  // study, note, workout, snooze, chat, vague
  { group: "study", text: "did 3 DSA problems", expect: "advance dsa to 4", check: isOp("advance_pointer", { list_id: "dsa", to_ordinal: 4 }), workers: true },
  { group: "note", text: "my knee hurts, go easy on legs this week", expect: "add_note", check: isOp("add_note", { text: has("knee") }) },
  { group: "workout", text: "did chest today: flat bench 3 sets of 12 at 20kg, incline press 3x10 at 15kg", expect: "workout, 2 exercises", check: (o) => o.kind === "workout" && o.exercises.length === 2, workers: true },
  { group: "snooze", text: "pause your messages for 3 hours, I'm in a meeting", expect: "snooze 3h", check: (o) => o.kind === "snooze" && o.hours === 3 },
  { group: "chat", text: "hey how's it going", expect: "a reply, nothing changed", check: (o) => o.kind === "reply" },
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
      return b.json(req);
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
const selected = cases.filter((c) => (!useWorkers || c.workers) && (!groups || groups.includes(c.group)));
console.log(`Live check: ${backend.name}, ${selected.length} phrases, now = Mon 2 Nov 10:00 IST\n`);

let pass = 0;
const fails: string[] = [];
for (const c of selected) {
  const warnings: string[] = [];
  const started = Date.now();
  let out: Outcome;
  try {
    out = await understand({ db, backends: [backend], nowMs, log: (l) => warnings.push(l) }, c.text);
  } catch (e) {
    out = { kind: "reply", html: `CRASH: ${(e as Error).message}` };
  }
  const ok = c.check(out);
  if (ok) pass++;
  const got = out.kind === "ops" ? JSON.stringify(out.ops) : out.kind === "reply" ? `reply: ${out.html.slice(0, 80)}` : out.kind === "inbox" ? `inbox: ${out.reason}` : JSON.stringify(out);
  const retry = warnings.length ? `
      ${warnings.length} retry/warning: ${warnings[0].replace(/\s+/g, " ").slice(0, 400)}` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  [${c.group}] "${c.text}"\n      expect ${c.expect}\n      got    ${got.slice(0, 200)}  ${Math.round((Date.now() - started) / 1000)}s${retry}`);
  if (!ok) fails.push(c.text);
}
console.log(`\n${pass}/${selected.length} passed, ${backend.calls} model calls.${fails.length ? `\nFailed: ${fails.map((f) => `"${f}"`).join(", ")}` : ""}`);
process.exitCode = fails.length ? 1 : 0;
