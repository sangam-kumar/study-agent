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
import { ReminderTimeError, resolveDelayMinutes } from "./reminder-time.ts";
import { buildSnapshot } from "./snapshot.ts";
import { queryPlan } from "./seed.ts";
import { resolvePlanItem } from "./day.ts";
import { addDays, dayKey } from "./time.ts";

export const MIN_CONFIDENCE = 0.6;

export interface WorkoutExercise {
  name: string;
  sets: number;
  reps: number;
  weight_kg?: number;
}

export type Outcome =
  /** affects: an override's date range, so the agent can re-plan today/tomorrow even if locked. */
  | { kind: "ops"; ops: Record<string, unknown>[]; affects?: { from: string; to: string } }
  | { kind: "reminder"; text: string; minutes: number }
  | { kind: "workout"; workout_type: string; exercises: WorkoutExercise[]; notes: string | null }
  | { kind: "snooze"; hours: number; reason: string }
  | { kind: "reply"; html: string }
  | { kind: "inbox"; reason: string };

export interface UnderstandDeps {
  db: Db;
  backends: InferBackend[];
  nowMs: number;
  log?: (line: string) => void;
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
      date: { type: "string", description: "YYYY-MM-DD" },
    },
    ["action"],
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
  study_done: S(
    { list_id: { type: "string" }, count: { type: "number", description: "units finished, default 1" } },
    ["list_id"],
  ),
  reminder: S(
    {
      reminder_text: { type: "string" },
      delay_minutes: { type: "number", description: "relative requests only; 0 for a clock time" },
      at_time: { type: "string", description: "24h HH:MM IST for a clock time, else empty" },
      on_date: { type: "string", description: "YYYY-MM-DD IST when a day was named, else empty" },
    },
    ["reminder_text", "delay_minutes"],
  ),
  note: S({ text: { type: "string" }, ttl_days: { type: "number", description: "1-30" } }, ["text"]),
  workout: S(
    {
      workout_type: { type: "string" },
      exercises: {
        type: "array",
        items: S(
          { name: { type: "string" }, sets: { type: "number" }, reps: { type: "number" }, weight_kg: { type: "number" } },
          ["name", "sets", "reps"],
        ),
      },
      notes: { type: "string" },
    },
    ["workout_type", "exercises"],
  ),
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
      if ("reply" in found) return { kind: "reply", html: found.reply };
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

  reminder: (_db, nowMs) => ({
    validate: (raw) => {
      const o = asObj(raw);
      const text = str(o, "reminder_text", 300);
      const delay = typeof o.delay_minutes === "number" ? o.delay_minutes : undefined;
      try {
        const minutes = resolveDelayMinutes({ delay_minutes: delay, at_time: optStr(o, "at_time", 10), on_date: optStr(o, "on_date", 10) }, nowMs);
        if (minutes > 60 * 24 * 60) throw new ValidationError("that is more than 60 days away");
        return { text, minutes };
      } catch (e) {
        if (e instanceof ReminderTimeError) throw new ValidationError(e.message);
        throw e;
      }
    },
    map: (v: { text: string; minutes: number }): Outcome => ({ kind: "reminder", text: v.text, minutes: v.minutes }),
  }),

  note: () => ({
    validate: (raw) => {
      const o = asObj(raw);
      const ttl = o.ttl_days === undefined || o.ttl_days === null ? 7 : Math.round(num(o, "ttl_days", 1, 365));
      return { text: str(o, "text", 300), ttl_days: Math.min(30, Math.max(1, ttl)) };
    },
    map: (v: { text: string; ttl_days: number }): Outcome => ({ kind: "ops", ops: [{ type: "add_note", text: v.text, ttl_days: v.ttl_days }] }),
  }),

  workout: () => ({
    validate: (raw) => {
      const o = asObj(raw);
      if (!Array.isArray(o.exercises) || o.exercises.length === 0) throw new ValidationError("exercises must be a non-empty array");
      const exercises = o.exercises.map((e, i): WorkoutExercise => {
        const eo = asObj(e);
        return {
          name: str(eo, "name", 100),
          sets: num(eo, "sets", 0, 100),
          reps: num(eo, "reps", 0, 1000),
          weight_kg: typeof eo.weight_kg === "number" && eo.weight_kg > 0 ? eo.weight_kg : undefined,
        };
      });
      return { workout_type: str(o, "workout_type", 60), exercises, notes: optStr(o, "notes", 500) ?? null };
    },
    map: (v: { workout_type: string; exercises: WorkoutExercise[]; notes: string | null }): Outcome => ({ kind: "workout", ...v }),
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

// --------------------------------------------------------------------- pipeline

export function addToInbox(db: Db, raw: string, nowMs: number): number {
  db.run("INSERT INTO inbox (raw, ts) VALUES (?, ?)", raw.slice(0, 2000), new Date(nowMs).toISOString());
  return db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
}

export async function understand(deps: UnderstandDeps, text: string): Promise<Outcome> {
  const { db, backends, nowMs } = deps;
  const log = deps.log ?? console.warn;

  try {
    const cls = await infer(
      backends,
      {
        task: "classify",
        system: `${BASE_CARD}\n\n${CLASSIFY_CARD}`,
        user: `${buildSnapshot(db, "chat", nowMs)}\n\nMessage: ${text}`,
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
        user: `${buildSnapshot(db, cls.intent, nowMs)}\n\nMessage: ${text}`,
        schema: EXTRACT_SCHEMAS[cls.intent],
        validate: handler.validate,
      },
      log,
    );
    return handler.map(extracted);
  } catch (e) {
    if (e instanceof InferError) {
      log(`understand: ${e.message}`);
      const down = e.attempts.every((a) => a.kind === "transport");
      return { kind: "inbox", reason: down ? "the AI is unavailable right now" : "I couldn't make sense of that" };
    }
    throw e;
  }
}

/** The exact packet a lane call sends, for tests and the size check. */
export function contextPacket(db: Db, intent: Intent, nowMs: number, text: string): { system: string; user: string } {
  return { system: `${BASE_CARD}\n\n${LANE_CARDS[intent]}`, user: `${buildSnapshot(db, intent, nowMs)}\n\nMessage: ${text}` };
}
