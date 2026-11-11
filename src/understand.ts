// Free text -> a typed outcome. The model only classifies and extracts; code resolves and decides.
//
//   classify (cheap, tiny context) -> lane extractor (that lane's card + snapshot) -> validate -> map
//
// Low confidence or total failure never loses the message: it goes to the inbox.

import type { Db } from "./db/db.ts";
import { BASE_CARD, CLASSIFY_CARD, INTENTS, LANE_CARDS } from "./cards.ts";
import type { Intent } from "./cards.ts";
import { InferError, ValidationError, infer } from "./infer.ts";
import type { InferBackend, JsonSchema } from "./infer.ts";
import { parseBookCommand } from "./reading.ts";
import { findBook, jotKind, normalizeLocator, soleCurrentBook } from "./jots.ts";
import { ReminderTimeError, resolveDelayMinutes } from "./reminder-time.ts";
import { firstOccurrence, parseRepeat, resolveReminder } from "./reminders.ts";
import { buildSnapshot } from "./snapshot.ts";
import { queryPlan } from "./seed.ts";
import { resolvePlanItem } from "./day.ts";
import { addDays, dayKey, istWallToMs } from "./time.ts";
import { findExercise } from "./exercises.ts";
import { parseSets } from "./sets.ts";
import { PRESETS_KEY, findPreset, proteinPresets } from "./fitness.ts";
import type { LogWorkoutOp } from "./fitness.ts";
import type { Answer, Pending } from "./convo.ts";

export const MIN_CONFIDENCE = 0.6;

export type Outcome =
  /** affects: an override's date range, so the agent can re-plan today/tomorrow even if locked. */
  | { kind: "ops"; ops: Record<string, unknown>[]; affects?: { from: string; to: string } }
  /** dueMs: the exact instant, so model latency never shifts the time. repeat: "daily" | "weekdays" | "weekly:0,2". */
  | { kind: "reminder"; text: string; dueMs: number; repeat?: string }
  /** A day with no time: shown in the brief and the recap, never pinged. */
  | { kind: "task"; text: string; dueDate: string }
  | { kind: "reminder_action"; action: "cancel" | "done"; id: number }
  /** protein: grams, when the same message mentioned it. */
  | { kind: "workout"; op: LogWorkoutOp; protein?: number }
  /** A reply to something the bot said. Code decides what it answers (the message tag, or the open question). */
  | { kind: "answer"; answer: Answer; confidence: number }
  /** Going to bed or waking up. */
  | { kind: "status"; status: "bed" | "wake" }
  /** The coming week's office days, as weekday numbers (Mon = 0). Empty = all remote. */
  | { kind: "office"; weekdays: number[] }
  | { kind: "snooze"; hours: number; reason: string }
  | { kind: "reply"; html: string }
  /** A question whose answer is a short reply; the agent stores the pending question (convo.ts). */
  | { kind: "choose"; html: string; pending: Extract<Pending, { kind: "choose_item" }> }
  | { kind: "inbox"; reason: string; /** every model backend failed to answer (not a problem with the message) */ down?: boolean };

export interface UnderstandDeps {
  db: Db;
  backends: InferBackend[];
  nowMs: number;
  log?: (line: string) => void;
  /** buildConversation() output: the replied-to message, recent messages, any open question. */
  conversation?: string;
}

// ------------------------------------------------------------ validation helpers

type Obj = Record<string, unknown>;

function asObj(raw: unknown): Obj {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ValidationError("answer must be a JSON object");
  return raw as Obj;
}
function str(o: Obj, k: string, max = 300): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") throw new ValidationError(`${k} must be a non-empty string`);
  if (v.length > max) throw new ValidationError(`${k} is too long (max ${max})`);
  return v.trim();
}
function optStr(o: Obj, k: string, max = 300): string | undefined {
  const v = o[k];
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : str(o, k, max);
}
function num(o: Obj, k: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ValidationError(`${k} must be a number between ${min} and ${max}`);
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ValidationError(`${k} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

/** YYYY-MM-DD, a real date, within [today - 1, today + 60]. */
function ymd(o: Obj, k: string, nowMs: number): string {
  const v = str(o, k, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCDate() !== +m[3] || d.getUTCMonth() !== +m[2] - 1) throw new ValidationError(`${k} must be a real YYYY-MM-DD date`);
  const today = dayKey(nowMs);
  if (v < addDays(today, -1) || v > addDays(today, 60)) throw new ValidationError(`${k} must be between yesterday and 60 days from now`);
  return v;
}
function optYmd(o: Obj, k: string, nowMs: number): string | undefined {
  return o[k] === undefined || o[k] === null || o[k] === "" ? undefined : ymd(o, k, nowMs);
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------- schemas

const S = (properties: Obj, required: string[]): JsonSchema => ({ type: "object", properties, required });

const CLASSIFY_SCHEMA = S(
  { intent: { type: "string", enum: [...INTENTS] }, confidence: { type: "number", description: "0 to 1" } },
  ["intent", "confidence"],
);

const READING_ACTIONS = ["add", "start", "keep", "hold", "done", "drop"] as const;
const PLAN_ACTIONS = ["done", "skip", "add", "move"] as const;
const ADD_LANES = ["fitness", "study", "reading", "personal"] as const;
const OVERRIDES = ["TRAVEL", "SICK", "OUT", "LOW_MOOD"] as const;

const EXTRACT_SCHEMAS: Record<Intent, JsonSchema> = {
  plan: S(
    {
      action: { type: "string", enum: [...PLAN_ACTIONS] },
      ref: { type: "string", description: "done/skip/move: the item as the user named it" },
      title: { type: "string", description: "add: the task" },
      lane: { type: "string", enum: [...ADD_LANES] },
      date: { type: "string", description: "YYYY-MM-DD from the calendar. add/move: the target day. done/skip: the day the item is on (today unless said otherwise)." },
    },
    ["action", "date"],
  ),
  override: S(
    {
      override_type: { type: "string", enum: [...OVERRIDES] },
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD" },
      note: { type: "string" },
    },
    ["override_type", "start_date", "end_date"],
  ),
  reading: S(
    {
      action: { type: "string", enum: [...READING_ACTIONS] },
      ref: { type: "string", description: "part of the book/article title" },
      author: { type: "string", description: "add only" },
      reason: { type: "string", description: "drop only" },
    },
    ["action", "ref"],
  ),
  jot: S(
    {
      book: { type: "string" },
      locator: { type: "string" },
      text: { type: "string" },
      kind: { type: "string", enum: ["point", "quote", "question", "connection", "todo"] },
    },
    ["text"],
  ),
  progress: S({ book: { type: "string" }, locator: { type: "string" }, finished_book: { type: "boolean" } }, ["locator"]),
  study_done: S(
    { list_id: { type: "string" }, count: { type: "number", description: "units finished, default 1" } },
    ["list_id"],
  ),
  reminder: S(
    {
      action: { type: "string", enum: ["set", "cancel", "done"] },
      ref: { type: "string", description: "cancel/done: words that identify the reminder" },
      no_time: { type: "boolean", description: "true when only a day was given, no clock time" },
      repeat: { type: "string", description: '"daily", "weekdays", or day names like "mon thu"; else empty' },
      reminder_text: { type: "string" },
      delay_minutes: { type: "number", description: "relative requests only; 0 for a clock time" },
      at_time: { type: "string", description: "24h HH:MM IST for a clock time, else empty" },
      on_date: { type: "string", description: "YYYY-MM-DD IST when a day was named, else empty" },
    },
    ["action"],
  ),
  note: S({ text: { type: "string" }, ttl_days: { type: "number", description: "1-30" } }, ["text"]),
  workout: S(
    {
      exercises: {
        type: "array",
        items: S(
          {
            name: { type: "string", description: "the exercise as said" },
            sets: { type: "string", description: 'every set, comma separated, e.g. "20x15, 22.5x12, 25x8 F"' },
          },
          ["name", "sets"],
        ),
      },
      date: { type: "string", description: "YYYY-MM-DD only if a past day was named (yesterday), else empty" },
      replace: { type: "boolean", description: "true only when correcting sets already logged" },
      pain: { type: "string" },
      notes: { type: "string" },
      protein_g: { type: "number", description: "grams of protein mentioned in this message (an amount eaten, not a total)" },
    },
    ["exercises"],
  ),
  workout_edit: S(
    {
      action: { type: "string", enum: ["rename_exercise", "amend_set", "remove_exercise"] },
      exercise: { type: "string", description: "the exercise as currently logged" },
      to_name: { type: "string", description: "rename_exercise: the correct name" },
      set_no: { type: "number", description: "amend_set: 1 = first set" },
      field: { type: "string", enum: ["reps", "weight_kg", "duration_s"], description: "amend_set: which value changes (ignored for other actions)" },
      value: { type: "number", description: "amend_set: the new value of that field" },
      date: { type: "string", description: "YYYY-MM-DD only if a past day was named, else empty" },
    },
    ["action", "exercise", "field", "value"],
  ),
  metric: S(
    {
      metric: { type: "string", enum: ["protein_g"] },
      action: { type: "string", enum: ["add", "set_total", "set_preset"], description: "add = protein eaten now; set_total = the day's total; set_preset = change what a named amount is" },
      value: { type: "number", description: "grams as said; 0 when only a preset name was said" },
      label: { type: "string", description: "the preset or food named (whey, soy chunks), else empty" },
      count: { type: "number", description: "how many of the named preset (two scoops = 2), else 1" },
      date: { type: "string", description: "YYYY-MM-DD only if a past day was named, else empty" },
    },
    ["metric", "action", "value", "label", "count"],
  ),
  answer: S(
    {
      kind: { type: "string", enum: ["affirm", "deny", "choose", "new", "name"] },
      ids: { type: "array", items: { type: "number" }, description: "choose: the option numbers picked (1 = first)" },
      name: { type: "string", description: "name: the name offered" },
    },
    ["kind", "ids", "name"],
  ),
  status: S({ kind: { type: "string", enum: ["bed", "wake"] } }, ["kind"]),
  office: S({ days: { type: "array", items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri"] } } }, ["days"]),
  snooze: S({ duration_hours: { type: "number" }, reason: { type: "string" } }, ["reason"]),
  chat: S({ reply: { type: "string" } }, ["reply"]),
};

// -------------------------------------------------------------------- extractors

/** Each lane: validate the model's answer (throws ValidationError -> one retry), then map it to an outcome. */
const LANE_HANDLERS: Record<Intent, (db: Db, nowMs: number) => { validate: (raw: unknown) => unknown; map: (v: any) => Outcome }> = {
  plan: (db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const action = oneOf(o, "action", PLAN_ACTIONS);
      const v = {
        action,
        ref: action === "add" ? undefined : str(o, "ref", 120),
        title: action === "add" ? str(o, "title", 200) : undefined,
        lane: action === "add" ? (o.lane === undefined || o.lane === null || o.lane === "" ? "personal" : oneOf(o, "lane", ADD_LANES)) : undefined,
        date: optYmd(o, "date", nowMs),
      };
      if (action === "move" && !v.date) throw new ValidationError("date is required for move");
      return v;
    },
    map: (v: { action: string; ref?: string; title?: string; lane?: string; date?: string }): Outcome => {
      const today = dayKey(nowMs);
      if (v.action === "add") return { kind: "ops", ops: [{ type: "add_item", date: v.date ?? today, lane: v.lane, title: v.title }] };
      const where = v.action === "move" ? [today, addDays(today, 1)] : v.date ? [v.date] : [today, addDays(today, 1)];
      const statuses = v.action === "done" ? ["planned", "skipped"] : ["planned"];
      const found = resolvePlanItem(db, v.ref!, where, statuses);
      if ("reply" in found) {
        // Several matched: ask, and remember the options so "both" / "2" can answer it.
        if (found.options) {
          const action = v.action as "done" | "skip" | "move";
          return { kind: "choose", html: found.reply, pending: { kind: "choose_item", action, toDate: action === "move" ? v.date : undefined, options: found.options } };
        }
        return { kind: "reply", html: found.reply };
      }
      if (v.action === "move") return { kind: "ops", ops: [{ type: "move_item", item_id: found.item.id, to_date: v.date }] };
      return { kind: "ops", ops: [{ type: "set_item_status", item_id: found.item.id, status: v.action === "done" ? "done" : "skipped" }] };
    },
  }),

  override: (_db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const start = ymd(o, "start_date", nowMs);
      const end = ymd(o, "end_date", nowMs);
      if (end < start) throw new ValidationError("end_date must not be before start_date");
      return { type: oneOf(o, "override_type", OVERRIDES), start, end, note: optStr(o, "note", 200) };
    },
    map: (v: { type: string; start: string; end: string; note?: string }): Outcome => ({
      kind: "ops",
      ops: [{ type: "set_override", override_type: v.type, start_date: v.start, end_date: v.end, note: v.note }],
      affects: { from: v.start, to: v.end },
    }),
  }),

  reading: (db) => ({
    validate: (raw) => {
      const o = asObj(raw);
      return {
        action: oneOf(o, "action", READING_ACTIONS),
        ref: str(o, "ref", 300),
        author: optStr(o, "author", 200),
        reason: optStr(o, "reason", 300),
      };
    },
    map: (v: { action: string; ref: string; author?: string; reason?: string }): Outcome => {
      // Always give drop a "|" so a multi-word title is not mistaken for "id + reason".
      const rest = v.action === "add" ? (v.author ? `${v.ref} | ${v.author}` : v.ref) : v.action === "drop" ? `${v.ref} | ${v.reason ?? ""}` : v.ref;
      const cmd = parseBookCommand(db, [v.action, rest]);
      return "op" in cmd ? { kind: "ops", ops: [cmd.op] } : { kind: "reply", html: cmd.reply };
    },
  }),

  jot: (db) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const kind = o.kind === undefined || o.kind === null || o.kind === "" ? undefined : oneOf(o, "kind", ["point", "quote", "question", "connection", "todo"] as const);
      return { book: optStr(o, "book", 200), locator: optStr(o, "locator", 40), text: str(o, "text", 2000), kind };
    },
    map: (v: { book?: string; locator?: string; text: string; kind?: string }): Outcome => {
      const book = whichBook(db, v.book);
      if ("reply" in book) return { kind: "reply", html: book.reply };
      return {
        kind: "ops",
        ops: [{ type: "add_jot", reading_id: book.id, text: v.text, locator: v.locator ? normalizeLocator(v.locator) : undefined, kind: v.kind ?? jotKind(v.text) }],
      };
    },
  }),

  progress: (db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      return { book: optStr(o, "book", 200), locator: str(o, "locator", 40), finished: o.finished_book === true };
    },
    map: (v: { book?: string; locator: string; finished: boolean }): Outcome => {
      const book = whichBook(db, v.book);
      if ("reply" in book) return { kind: "reply", html: book.reply };
      if (v.finished) return { kind: "ops", ops: [{ type: "finish_reading", reading_id: book.id }] };
      const loc = v.locator.replace(/^(.*?)(\s+done)?$/i, (_m, a: string, d?: string) => `${normalizeLocator(a)}${d ? " done" : ""}`);
      return { kind: "ops", ops: [{ type: "set_progress", reading_id: book.id, locator: loc, date: dayKey(nowMs) }] };
    },
  }),

  study_done: (db) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const list_id = str(o, "list_id", 100);
      if (!queryPlan(db).some((p) => p.listId === list_id)) throw new ValidationError(`list_id "${list_id}" is not one of the listed ids`);
      const count = o.count === undefined || o.count === null ? 1 : Math.round(num(o, "count", 1, 20));
      return { list_id, count };
    },
    map: (v: { list_id: string; count: number }): Outcome => {
      const p = queryPlan(db).find((x) => x.listId === v.list_id)!;
      if (p.finished) return { kind: "reply", html: `${esc(p.listTitle)} is already finished.` };
      const to = Math.min(p.ordinal + v.count, p.total + 1);
      return { kind: "ops", ops: [{ type: "advance_pointer", list_id: v.list_id, to_ordinal: to }] };
    },
  }),

  reminder: (db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const action = o.action === undefined || o.action === null || o.action === "" ? "set" : oneOf(o, "action", ["set", "cancel", "done"] as const);
      if (action !== "set") return { action, ref: str(o, "ref", 200) };
      const text = str(o, "reminder_text", 300);
      if (o.no_time === true) {
        const due = optYmd(o, "on_date", nowMs) ?? dayKey(nowMs);
        return { action, text, dueDate: due };
      }
      const repeatRaw = optStr(o, "repeat", 60);
      if (repeatRaw) {
        const rule = parseRepeat(repeatRaw);
        if (!rule) throw new ValidationError(`repeat "${repeatRaw}" must be daily, weekdays or day names`);
        const at = optStr(o, "at_time", 10);
        if (!at || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new ValidationError("a repeating reminder needs at_time as HH:MM");
        const hhmm = at.padStart(5, "0");
        // The first firing: the named day if given, else the next matching day.
        const from = optYmd(o, "on_date", nowMs);
        const after = from ? Math.max(nowMs, istWallToMs(from, "00:00") - 1) : nowMs;
        return { action, text, dueMs: firstOccurrence(rule, hhmm, after), repeat: rule };
      }
      const delay = typeof o.delay_minutes === "number" ? o.delay_minutes : undefined;
      try {
        const minutes = resolveDelayMinutes({ delay_minutes: delay, at_time: optStr(o, "at_time", 10), on_date: optStr(o, "on_date", 10) }, nowMs);
        if (minutes > 60 * 24 * 60) throw new ValidationError("that is more than 60 days away");
        return { action, text, dueMs: Math.round(nowMs + minutes * 60_000) };
      } catch (e) {
        if (e instanceof ReminderTimeError) throw new ValidationError(e.message);
        throw e;
      }
    },
    map: (v: { action: "set" | "cancel" | "done"; ref?: string; text?: string; dueMs?: number; dueDate?: string; repeat?: string }): Outcome => {
      if (v.action !== "set") {
        const found = resolveReminder(db, v.ref!);
        return "reply" in found ? { kind: "reply", html: found.reply } : { kind: "reminder_action", action: v.action, id: found.reminder.id };
      }
      if (v.dueDate) return { kind: "task", text: v.text!, dueDate: v.dueDate };
      return { kind: "reminder", text: v.text!, dueMs: v.dueMs!, ...(v.repeat ? { repeat: v.repeat } : {}) };
    },
  }),

  metric: (db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const today = dayKey(nowMs);
      const date = optStr(o, "date", 10) ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < addDays(today, -7)) throw new ValidationError("date must be today or one of the last 7 days");
      const action = oneOf(o, "action", ["add", "set_total", "set_preset"] as const);
      const value = typeof o.value === "number" && o.value > 0 ? Math.round(num(o, "value", 1, 400)) : 0;
      const label = optStr(o, "label", 60)?.toLowerCase() ?? "";
      const count = typeof o.count === "number" && o.count >= 1 ? Math.min(20, Math.round(o.count)) : 1;
      if (action === "set_total" && value === 0) throw new ValidationError("set_total needs the grams");
      if (action === "set_preset" && (value === 0 || !label)) throw new ValidationError("set_preset needs a name and the grams");
      return { metric: oneOf(o, "metric", ["protein_g"] as const), action, value, label, count, date };
    },
    map: (v: { metric: "protein_g"; action: "add" | "set_total" | "set_preset"; value: number; label: string; count: number; date: string }): Outcome => {
      const presets = proteinPresets(db);
      if (v.action === "set_preset") {
        const next = { ...presets, [v.label]: v.value };
        return { kind: "ops", ops: [{ type: "set_config", key: PRESETS_KEY, value: JSON.stringify(next) }] };
      }
      if (v.action === "set_total") {
        return { kind: "ops", ops: [{ type: "log_metric", date: v.date, metric: v.metric, value: v.value, mode: "set" }] };
      }
      // add: grams said win; otherwise a preset times the count. Code does the sum, never the model.
      if (v.value > 0) return { kind: "ops", ops: [{ type: "log_metric", date: v.date, metric: v.metric, value: v.value, mode: "add", ...(v.label ? { label: v.label } : {}) }] };
      const hit = findPreset(presets, v.label);
      if (!hit) {
        const known = Object.entries(presets).map(([n, g]) => `${n} ${g} g`).join(", ");
        return {
          kind: "reply",
          html: v.label
            ? `I don't know "${esc(v.label)}" as a protein amount yet. Say how many grams (e.g. <i>${esc(v.label)} 20 g protein</i>) or teach me: <i>${esc(v.label)} is 20 g</i>. Known: ${esc(known)}.`
            : `How many grams? Known amounts: ${esc(known)}.`,
        };
      }
      return { kind: "ops", ops: [{ type: "log_metric", date: v.date, metric: v.metric, value: hit.grams * v.count, mode: "add", label: v.count > 1 ? `${hit.name} ×${v.count}` : hit.name }] };
    },
  }),

  answer: () => ({
    validate: (raw): Answer => {
      const o = asObj(raw);
      const ids = Array.isArray(o.ids) ? o.ids.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20) : [];
      return { kind: oneOf(o, "kind", ["affirm", "deny", "choose", "new", "name"] as const), ids, name: optStr(o, "name", 100) ?? "" };
    },
    map: (v: Answer): Outcome => ({ kind: "answer", answer: v, confidence: 1 }),
  }),

  status: () => ({
    validate: (raw) => ({ status: oneOf(asObj(raw), "kind", ["bed", "wake"] as const) }),
    map: (v: { status: "bed" | "wake" }): Outcome => ({ kind: "status", status: v.status }),
  }),

  office: () => ({
    validate: (raw) => {
      const o = asObj(raw);
      if (!Array.isArray(o.days)) throw new ValidationError("days must be a list");
      const days = o.days.map((d) => {
        const i = typeof d === "string" ? ["mon", "tue", "wed", "thu", "fri"].indexOf(d.toLowerCase().slice(0, 3)) : -1;
        if (i < 0) throw new ValidationError(`not a weekday: ${String(d)}`);
        return i;
      });
      return { weekdays: [...new Set(days)].sort() };
    },
    map: (v: { weekdays: number[] }): Outcome => ({ kind: "office", weekdays: v.weekdays }),
  }),

  note: () => ({
    validate: (raw) => {
      const o = asObj(raw);
      const ttl = o.ttl_days === undefined || o.ttl_days === null ? 7 : Math.round(num(o, "ttl_days", 1, 365));
      return { text: str(o, "text", 300), ttl_days: Math.min(30, Math.max(1, ttl)) };
    },
    map: (v: { text: string; ttl_days: number }): Outcome => ({ kind: "ops", ops: [{ type: "add_note", text: v.text, ttl_days: v.ttl_days }] }),
  }),

  workout: (db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      if (!Array.isArray(o.exercises) || o.exercises.length === 0) throw new ValidationError("exercises must be a non-empty array");
      // The model writes sets in the notation; code reads them, so a bad set is retried, never guessed.
      const exercises = o.exercises.map((e) => {
        const eo = asObj(e);
        const name = str(eo, "name", 100);
        const text = str(eo, "sets", 600);
        const sets = parseSets(text, findExercise(db, name)?.kind ?? "weighted");
        if (!sets) throw new ValidationError(`sets for ${name} are not in the notation ("20x15, 22.5x12"): ${text}`);
        return { name, sets };
      });
      const today = dayKey(nowMs);
      const date = optStr(o, "date", 10) ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < addDays(today, -7)) throw new ValidationError("date must be today or one of the last 7 days");
      const protein = typeof o.protein_g === "number" && o.protein_g > 0 && o.protein_g <= 400 ? Math.round(o.protein_g) : undefined;
      return { date, exercises, replace: o.replace === true, pain: optStr(o, "pain", 200), notes: optStr(o, "notes", 500), protein };
    },
    map: (v: { date: string; exercises: LogWorkoutOp["exercises"]; replace: boolean; pain?: string; notes?: string; protein?: number }): Outcome => ({
      kind: "workout",
      op: { type: "log_workout", date: v.date, mode: v.replace ? "replace" : "append", exercises: v.exercises, pain: v.pain, notes: v.notes },
      protein: v.protein,
    }),
  }),

  workout_edit: (_db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const action = oneOf(o, "action", ["rename_exercise", "amend_set", "remove_exercise"] as const);
      const exercise = str(o, "exercise", 100);
      const today = dayKey(nowMs);
      const date = optStr(o, "date", 10) ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today || date < addDays(today, -7)) throw new ValidationError("date must be today or one of the last 7 days");
      if (action === "rename_exercise") return { action, date, exercise, to: str(o, "to_name", 100) };
      if (action === "remove_exercise") return { action, date, exercise };
      const field = oneOf(o, "field", ["reps", "weight_kg", "duration_s"] as const);
      const value = num(o, "value", 0, field === "weight_kg" ? 500 : field === "reps" ? 1000 : 7200);
      return { action, date, exercise, set_no: Math.round(num(o, "set_no", 1, 40)), field, value };
    },
    map: (v: { action: string; date: string; exercise: string; to?: string; set_no?: number; field?: "reps" | "weight_kg" | "duration_s"; value?: number }): Outcome => {
      if (v.action === "rename_exercise") return { kind: "ops", ops: [{ type: "rename_exercise", date: v.date, from: v.exercise, to: v.to }] };
      if (v.action === "remove_exercise") return { kind: "ops", ops: [{ type: "remove_exercise", date: v.date, exercise: v.exercise }] };
      return {
        kind: "ops",
        ops: [{
          type: "amend_set", date: v.date, exercise: v.exercise, set_no: v.set_no,
          [v.field!]: v.field === "weight_kg" ? v.value : Math.round(v.value!),
        }],
      };
    },
  }),

  snooze: () => ({
    validate: (raw) => {
      const o = asObj(raw);
      const hours = o.duration_hours === undefined || o.duration_hours === null ? 2 : num(o, "duration_hours", 0.25, 48);
      return { hours, reason: str(o, "reason", 200) };
    },
    map: (v: { hours: number; reason: string }): Outcome => ({ kind: "snooze", ...v }),
  }),

  chat: () => ({
    validate: (raw) => ({ reply: str(asObj(raw), "reply", 600) }),
    map: (v: { reply: string }): Outcome => ({ kind: "reply", html: esc(v.reply) }),
  }),
};

/** The named book, or the one being read now when none is named. */
function whichBook(db: Db, ref: string | undefined): { id: number; title: string } | { reply: string } {
  if (ref) return findBook(db, ref);
  const cur = soleCurrentBook(db);
  if (cur) return { id: cur.id, title: cur.title };
  return { reply: "Which book is that for? Say e.g. <i>DDIA ch3: …</i>, or start one with /books." };
}

// --------------------------------------------------------------------- pipeline

export function addToInbox(db: Db, raw: string, nowMs: number): number {
  db.run("INSERT INTO inbox (raw, ts) VALUES (?, ?)", raw.slice(0, 2000), new Date(nowMs).toISOString());
  return db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
}

export async function understand(deps: UnderstandDeps, text: string): Promise<Outcome> {
  const { db, backends, nowMs } = deps;
  const log = deps.log ?? console.warn;
  const convo = deps.conversation ? `${deps.conversation}\n\n` : "";

  try {
    const cls = await infer(
      backends,
      {
        task: "classify",
        system: `${BASE_CARD}\n\n${CLASSIFY_CARD}`,
        user: `${buildSnapshot(db, "chat", nowMs)}\n\n${convo}Message: ${text}`,
        schema: CLASSIFY_SCHEMA,
        validate: (raw) => {
          const o = asObj(raw);
          return { intent: oneOf(o, "intent", INTENTS), confidence: num(o, "confidence", 0, 1) };
        },
      },
      log,
    );
    if (cls.confidence < MIN_CONFIDENCE) return { kind: "inbox", reason: `not sure what that was (${cls.intent}, ${Math.round(cls.confidence * 100)}%)` };

    const handler = LANE_HANDLERS[cls.intent](db, nowMs);
    const extracted = await infer(
      backends,
      {
        task: `extract:${cls.intent}`,
        system: `${BASE_CARD}\n\n${LANE_CARDS[cls.intent]}`,
        user: `${buildSnapshot(db, cls.intent, nowMs)}\n\n${convo}Message: ${text}`,
        schema: EXTRACT_SCHEMAS[cls.intent],
        validate: handler.validate,
      },
      log,
    );
    const mapped = handler.map(extracted);
    return mapped.kind === "answer" ? { ...mapped, confidence: cls.confidence } : mapped;
  } catch (e) {
    if (e instanceof InferError) {
      log(`understand: ${e.message}`);
      const down = e.attempts.every((a) => a.kind === "transport");
      return { kind: "inbox", reason: down ? "the AI is unavailable right now" : "I couldn't make sense of that", ...(down ? { down: true } : {}) };
    }
    throw e;
  }
}

/** The exact packet a lane call sends, for tests and the size check. */
export function contextPacket(db: Db, intent: Intent, nowMs: number, text: string): { system: string; user: string } {
  return { system: `${BASE_CARD}\n\n${LANE_CARDS[intent]}`, user: `${buildSnapshot(db, intent, nowMs)}\n\nMessage: ${text}` };
}
