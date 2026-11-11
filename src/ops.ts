// The single place where plan state changes.
//
//   unknown input --validateOp--> Op --applyOp--> rows + event + revision   (one transaction)
//                                          undoLast <-- revision.diff_json
//
// The LLM (Phase 9) only ever produces an Op. Code validates and applies it.

import { lastInsertId } from "./db/db.ts";
import type { Db, SqlValue } from "./db/db.ts";
import { displayName, loadCatalog, matchExercise, suggestExercise } from "./exercises.ts";
import type { ExerciseRow } from "./exercises.ts";
import { findSessionExercise, loadSession, proteinChange, sessionShape } from "./fitness.ts";
import { formatSet } from "./sets.ts";
import type { SetKind } from "./sets.ts";

// ------------------------------------------------------------------ types

export const LANES = ["fitness", "study", "reading", "career", "guitar", "personal"] as const;
export const OVERRIDE_TYPES = ["TRAVEL", "SICK", "OUT", "LOW_MOOD"] as const;
export const ITEM_STATUSES = ["planned", "done", "skipped", "dropped"] as const;
export const ITEM_SOURCES = ["pattern", "pointer", "user", "minimum"] as const;
export const READING_SLOTS = ["technical", "narrative"] as const;
export type ReadingSlot = (typeof READING_SLOTS)[number];
const MAX_NOTE_TTL_DAYS = 30;

export const SET_KINDS = ["warmup", "working", "drop", "failure"] as const;
export const METRICS = ["protein_g"] as const;
export const JOT_KINDS = ["point", "quote", "question", "connection", "todo"] as const;

export type Lane = (typeof LANES)[number];

export interface SetInput {
  weight_kg: number | null;
  reps: number | null;
  duration_s: number | null;
  rest_s: number | null;
  kind: SetKind;
  bw: boolean;
  notes: string | null;
  incomplete: boolean;
}
export type OverrideType = (typeof OVERRIDE_TYPES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type ItemSource = (typeof ITEM_SOURCES)[number];

export type Op =
  | { type: "add_item"; date: string; lane: Lane; title: string; est_min?: number; ref?: string; unit_id?: number; source?: ItemSource }
  | { type: "set_item_status"; item_id: number; status: ItemStatus }
  | { type: "move_item"; item_id: number; to_date: string }
  | { type: "set_override"; override_type: OverrideType; start_date: string; end_date: string; scope?: string; note?: string }
  | { type: "revoke_override"; override_id: number }
  | { type: "add_note"; lane?: Lane; text: string; ttl_days: number }
  | { type: "resolve_note"; note_id: number }
  | { type: "advance_pointer"; list_id: string; to_ordinal?: number }
  | { type: "set_config"; key: string; value: string }
  | { type: "set_place"; dates: string[]; place: "OFFICE" | "REMOTE" }
  | { type: "set_places"; places: { date: string; place: "OFFICE" | "REMOTE" }[] }
  | { type: "add_reading"; title: string; author?: string; kind?: string; url?: string; note?: string; slot?: ReadingSlot; shortlist?: boolean }
  | { type: "start_reading"; reading_id: number }
  | { type: "keep_reading"; reading_id: number }
  | { type: "finish_reading"; reading_id: number }
  | { type: "hold_reading"; reading_id: number }
  | { type: "drop_reading"; reading_id: number; reason?: string }
  /**
   * One chunk of a workout. append adds sets; replace swaps the named exercises' sets ("actually it was ...").
   * An exercise's own mode wins over the op's (restating a log replaces some exercises and extends others).
   * learn: the spelling the user typed, saved as an alias of the exercise it resolved to.
   */
  | { type: "log_workout"; date: string; mode: "append" | "replace"; exercises: { name: string; sets: SetInput[]; mode?: "append" | "replace"; learn?: string }[]; notes?: string; pain?: string }
  /** Fixes after the fact, on a day's session. rename moves (or merges) the sets of one exercise onto another. */
  | { type: "rename_exercise"; date: string; from: string; to: string }
  | { type: "amend_set"; date: string; exercise: string; set_no: number; weight_kg?: number; reps?: number; duration_s?: number }
  | { type: "remove_exercise"; date: string; exercise: string }
  /** mode "add" adds `value` to the day's total; "set" (default) makes it the total. `label` names the source (whey). */
  | { type: "log_metric"; date: string; metric: (typeof METRICS)[number]; value: number; mode?: "add" | "set"; label?: string }
  | { type: "add_jot"; reading_id: number; text: string; locator?: string; kind?: (typeof JOT_KINDS)[number] }
  /** "on p140" / "ch3 done": the book's place; also ticks off that day's reading item for the book. */
  | { type: "set_progress"; reading_id: number; locator: string; date: string }
  | { type: "note"; text: string };

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

export class VersionConflictError extends Error {
  readonly key: string;
  readonly expected: number;
  readonly actual: number;
  constructor(key: string, expected: number, actual: number) {
    super(`Version conflict on ${key}: expected ${expected}, found ${actual}`);
    this.name = "VersionConflictError";
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

// ------------------------------------------------------------- validation

type Obj = Record<string, unknown>;

function fail(msg: string): never {
  throw new OpError(msg);
}

function str(o: Obj, k: string, max = 500): string {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") fail(`${k} must be a non-empty string`);
  if (v.length > max) fail(`${k} is too long (max ${max})`);
  return v.trim();
}

function optStr(o: Obj, k: string, max = 500): string | undefined {
  return o[k] === undefined || o[k] === null ? undefined : str(o, k, max);
}

function int(o: Obj, k: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${k} must be an integer in [${min}, ${max}]`);
  return v;
}

function optInt(o: Obj, k: string, min: number, max?: number): number | undefined {
  return o[k] === undefined || o[k] === null ? undefined : int(o, k, min, max);
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(`${k} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

function optNum(o: Obj, k: string, min: number, max: number): number | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${k} must be a number in [${min}, ${max}]`);
  return v;
}

function validateSet(input: unknown): SetInput {
  if (typeof input !== "object" || input === null) fail("each set must be an object");
  const o = input as Obj;
  const set: SetInput = {
    weight_kg: optNum(o, "weight_kg", 0, 500),
    reps: o.reps === undefined || o.reps === null ? null : int(o, "reps", 0, 1000),
    duration_s: o.duration_s === undefined || o.duration_s === null ? null : int(o, "duration_s", 1, 7200),
    rest_s: o.rest_s === undefined || o.rest_s === null ? null : int(o, "rest_s", 0, 1800),
    kind: o.kind === undefined || o.kind === null ? "working" : oneOf(o, "kind", SET_KINDS),
    bw: o.bw === true,
    notes: optStr(o, "notes", 200) ?? null,
    incomplete: o.incomplete === true,
  };
  if (set.weight_kg === null && set.reps === null && set.duration_s === null) fail("a set needs a weight, reps or a duration");
  return set;
}

function date(o: Obj, k: string): string {
  const v = str(o, k, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) fail(`${k} must be YYYY-MM-DD`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) fail(`${k} is not a real date`);
  return v;
}

export function validateOp(input: unknown): Op {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("op must be an object");
  const o = input as Obj;
  switch (o.type) {
    case "add_item":
      return {
        type: "add_item",
        date: date(o, "date"),
        lane: oneOf(o, "lane", LANES),
        title: str(o, "title", 200),
        est_min: optInt(o, "est_min", 1, 24 * 60),
        ref: optStr(o, "ref", 500),
        unit_id: optInt(o, "unit_id", 1),
        source: o.source === undefined ? undefined : oneOf(o, "source", ITEM_SOURCES),
      };
    case "set_item_status":
      return { type: "set_item_status", item_id: int(o, "item_id", 1), status: oneOf(o, "status", ITEM_STATUSES) };
    case "move_item":
      return { type: "move_item", item_id: int(o, "item_id", 1), to_date: date(o, "to_date") };
    case "set_override": {
      const start_date = date(o, "start_date");
      const end_date = date(o, "end_date");
      if (end_date < start_date) fail("end_date must not be before start_date");
      return {
        type: "set_override",
        override_type: oneOf(o, "override_type", OVERRIDE_TYPES),
        start_date,
        end_date,
        scope: optStr(o, "scope", 100),
        note: optStr(o, "note", 300),
      };
    }
    case "revoke_override":
      return { type: "revoke_override", override_id: int(o, "override_id", 1) };
    case "add_note":
      return {
        type: "add_note",
        lane: o.lane === undefined ? undefined : oneOf(o, "lane", LANES),
        text: str(o, "text", 300),
        // Ephemeral memory must expire: no TTL, no note.
        ttl_days: int(o, "ttl_days", 1, MAX_NOTE_TTL_DAYS),
      };
    case "resolve_note":
      return { type: "resolve_note", note_id: int(o, "note_id", 1) };
    case "advance_pointer":
      return { type: "advance_pointer", list_id: str(o, "list_id", 100), to_ordinal: optInt(o, "to_ordinal", 1) };
    case "set_config":
      return { type: "set_config", key: str(o, "key", 100), value: str(o, "value", 500) };
    case "set_place": {
      if (!Array.isArray(o.dates) || o.dates.length === 0 || o.dates.length > 14) fail("dates must be 1-14 dates");
      const dates = o.dates.map((d) => date({ d }, "d"));
      return { type: "set_place", dates: [...new Set(dates)], place: oneOf(o, "place", ["OFFICE", "REMOTE"] as const) };
    }
    case "set_places": {
      if (!Array.isArray(o.places) || o.places.length === 0 || o.places.length > 14) fail("places must be 1-14 entries");
      const places = o.places.map((p) => {
        if (typeof p !== "object" || p === null) fail("each place needs a date and a place");
        const po = p as Obj;
        return { date: date(po, "date"), place: oneOf(po, "place", ["OFFICE", "REMOTE"] as const) };
      });
      return { type: "set_places", places };
    }
    case "add_reading":
      return {
        type: "add_reading",
        title: str(o, "title", 300),
        author: optStr(o, "author", 200),
        kind: optStr(o, "kind", 30),
        url: optStr(o, "url", 1000),
        note: optStr(o, "note", 500),
        slot: o.slot === undefined || o.slot === null ? undefined : oneOf(o, "slot", READING_SLOTS),
        shortlist: o.shortlist === true,
      };
    case "start_reading":
    case "keep_reading":
    case "finish_reading":
    case "hold_reading":
      return { type: o.type, reading_id: int(o, "reading_id", 1) };
    case "drop_reading":
      return { type: "drop_reading", reading_id: int(o, "reading_id", 1), reason: optStr(o, "reason", 300) };
    case "log_workout": {
      if (!Array.isArray(o.exercises) || o.exercises.length === 0 || o.exercises.length > 20) fail("exercises must be 1-20 entries");
      const exercises = o.exercises.map((e) => {
        if (typeof e !== "object" || e === null) fail("each exercise needs a name and sets");
        const eo = e as Obj;
        if (!Array.isArray(eo.sets) || eo.sets.length === 0 || eo.sets.length > 40) fail("each exercise needs 1-40 sets");
        return {
          name: str(eo, "name", 100),
          sets: eo.sets.map(validateSet),
          mode: eo.mode === undefined ? undefined : oneOf(eo, "mode", ["append", "replace"] as const),
          learn: optStr(eo, "learn", 100),
        };
      });
      return {
        type: "log_workout",
        date: date(o, "date"),
        mode: o.mode === undefined ? "append" : oneOf(o, "mode", ["append", "replace"] as const),
        exercises,
        notes: optStr(o, "notes", 500),
        pain: optStr(o, "pain", 200),
      };
    }
    case "rename_exercise":
      return { type: "rename_exercise", date: date(o, "date"), from: str(o, "from", 100), to: str(o, "to", 100) };
    case "amend_set": {
      const weight_kg = optNum(o, "weight_kg", 0, 500);
      const reps = o.reps === undefined || o.reps === null ? null : int(o, "reps", 0, 1000);
      const duration_s = o.duration_s === undefined || o.duration_s === null ? null : int(o, "duration_s", 1, 7200);
      if (weight_kg === null && reps === null && duration_s === null) fail("amend_set needs a new weight, reps or duration");
      return {
        type: "amend_set",
        date: date(o, "date"),
        exercise: str(o, "exercise", 100),
        set_no: int(o, "set_no", 1, 40),
        ...(weight_kg !== null ? { weight_kg } : {}),
        ...(reps !== null ? { reps } : {}),
        ...(duration_s !== null ? { duration_s } : {}),
      };
    }
    case "remove_exercise":
      return { type: "remove_exercise", date: date(o, "date"), exercise: str(o, "exercise", 100) };
    case "log_metric": {
      const value = optNum(o, "value", 0, 1000);
      if (value === null) fail("value is required");
      const mode = o.mode === undefined ? undefined : oneOf(o, "mode", ["add", "set"] as const);
      const label = optStr(o, "label", 60);
      return { type: "log_metric", date: date(o, "date"), metric: oneOf(o, "metric", METRICS), value, ...(mode ? { mode } : {}), ...(label ? { label } : {}) };
    }
    case "add_jot":
      return {
        type: "add_jot",
        reading_id: int(o, "reading_id", 1),
        text: str(o, "text", 2000),
        locator: optStr(o, "locator", 40),
        kind: o.kind === undefined || o.kind === null ? undefined : oneOf(o, "kind", JOT_KINDS),
      };
    case "set_progress":
      return { type: "set_progress", reading_id: int(o, "reading_id", 1), locator: str(o, "locator", 40), date: date(o, "date") };
    case "note":
      return { type: "note", text: str(o, "text", 1000) };
    default:
      return fail(`unknown op type: ${String(o.type)}`);
  }
}

// --------------------------------------------------------------- recorder

type Row = Record<string, SqlValue>;

interface Change {
  table: string;
  pk: string;
  key: SqlValue;
  before: Row | null;
  after: Row | null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`bad identifier: ${name}`);
  return name;
}

/** Every write a handler makes goes through here so undo can replay it backwards. */
class Recorder {
  readonly changes: Change[] = [];
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(table: string, key: SqlValue, pk = "id"): Row | null {
    return this.db.all<Row>(`SELECT * FROM ${ident(table)} WHERE ${ident(pk)} = ?`, key)[0] ?? null;
  }

  insert(table: string, row: Row, pk = "id"): SqlValue {
    const cols = Object.keys(row).map(ident);
    this.db.run(
      `INSERT INTO ${ident(table)} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => row[c]),
    );
    const key = row[pk] ?? lastInsertId(this.db);
    this.changes.push({ table, pk, key, before: null, after: this.get(table, key, pk) });
    return key;
  }

  update(table: string, key: SqlValue, patch: Row, pk = "id"): Row {
    const before = this.get(table, key, pk);
    if (!before) throw new OpError(`${table} ${key} not found`);
    const cols = Object.keys(patch).map(ident);
    this.db.run(
      `UPDATE ${ident(table)} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${ident(pk)} = ?`,
      ...cols.map((c) => patch[c]),
      key,
    );
    const after = this.get(table, key, pk)!;
    this.changes.push({ table, pk, key, before, after });
    return after;
  }

  delete(table: string, key: SqlValue, pk = "id"): void {
    const before = this.get(table, key, pk);
    if (!before) return;
    this.db.run(`DELETE FROM ${ident(table)} WHERE ${ident(pk)} = ?`, key);
    this.changes.push({ table, pk, key, before, after: null });
  }
}

// ---------------------------------------------------------------- handlers

interface HandlerCtx {
  rec: Recorder;
  db: Db;
  now: Date;
}
interface HandlerResult {
  lane?: string;
  refId?: SqlValue;
  summary: string;
}

const iso = (d: Date) => d.toISOString();

/** The reply when an edit names an exercise the day's session does not have: say what it does have. */
function missingExercise(db: Db, date: string, name: string): string {
  const session = loadSession(db, date);
  if (!session || session.exercises.length === 0) return `No workout is logged for ${date}.`;
  return `I can't find "${name}" in ${date}'s workout (${session.exercises.map((e) => e.name).join(", ")}).`;
}

/** Title and kind follow the exercises in the session, so they are recomputed after an edit. */
function refreshShape(h: HandlerCtx, sessionId: number): void {
  const sess = h.rec.get("workout_session", sessionId)!;
  const shape = sessionShape(h.db, sessionId, (sess.title as string | null) ?? null);
  const patch: Row = { version: (sess.version as number) + 1 };
  if (shape.kind !== sess.kind) patch.kind = shape.kind;
  if (shape.title !== sess.title) patch.title = shape.title;
  h.rec.update("workout_session", sessionId, patch);
}

/** A day_plan row must exist for any date that has items; version tracks edits to that day. */
function touchDay(h: HandlerCtx, day: string): void {
  const plan = h.rec.get("day_plan", day, "date");
  if (!plan) h.rec.insert("day_plan", { date: day, status: "draft", version: 1 }, "date");
  else h.rec.update("day_plan", day, { version: (plan.version as number) + 1 }, "date");
}

function requireItem(h: HandlerCtx, id: number): Row {
  const item = h.rec.get("plan_item", id);
  if (!item) throw new OpError(`plan item ${id} not found`);
  return item;
}

function requireReading(h: HandlerCtx, id: number): Row {
  const r = h.rec.get("reading_item", id);
  if (!r) throw new OpError(`reading item ${id} not found`);
  return r;
}

/** What finishing a pointer-driven plan item advances: a study pointer, the gym rotation, or a queue article. */
function completeSource(h: HandlerCtx, item: Row): void {
  const ref = (item.ref as string | null) ?? "";

  if (item.unit_id !== null && item.unit_id !== undefined) {
    const unit = h.rec.get("unit", item.unit_id as number);
    const ptr = unit ? h.rec.get("pointer", unit.list_id as string, "list_id") : null;
    if (unit && ptr && ptr.ordinal === unit.ordinal) {
      const total = h.db.all<{ c: number }>("SELECT COUNT(*) AS c FROM unit WHERE list_id = ?", unit.list_id as string)[0].c;
      h.rec.update("pointer", unit.list_id as string, { ordinal: Math.min((ptr.ordinal as number) + 1, total + 1), updated_at: iso(h.now) }, "list_id");
    }
  }

  const rot = /^rotation:([a-z_]+):(\d+)$/.exec(ref);
  if (rot) {
    const count = h.db.all<{ c: number }>("SELECT COUNT(*) AS c FROM rotation WHERE lane = ?", rot[1])[0].c;
    if (count > 0) {
      const key = `rotation.${rot[1]}`;
      const next = String((Number(rot[2]) % count) + 1);
      if (h.rec.get("config", key, "key")) h.rec.update("config", key, { value: next }, "key");
      else h.rec.insert("config", { key, value: next }, "key");
    }
  }

  const rd = /^reading:(\d+)$/.exec(ref);
  if (rd) {
    const r = h.rec.get("reading_item", Number(rd[1]));
    // A queue article is finished by reading it once; a book keeps its own state.
    if (r && !r.slot && (r.state === "queued" || r.state === "backlog")) {
      h.rec.update("reading_item", Number(rd[1]), { state: "done", ended_at: iso(h.now) });
    }
  }
}

/**
 * A logged workout ticks off that day's gym item, so the rotation moves on in the same undoable change.
 * The split you actually did wins: planned Chest but logged back and biceps -> the item becomes Back / Biceps.
 * Lifting on a day with no gym item adds a done one, so the week counts it.
 */
function completeWorkoutItem(h: HandlerCtx, day: string, kind: "lift" | "mobility", split: { ordinal: number; label: string } | null): void {
  const items = h.db.all<Row>("SELECT * FROM plan_item WHERE date = ? AND lane = 'fitness' ORDER BY id", day);
  if (kind === "mobility") {
    const mob = items.find((i) => i.status !== "done" && i.status !== "dropped" && /^mobility/i.test(i.title as string));
    if (mob) {
      h.rec.update("plan_item", mob.id as number, { status: "done" });
      touchDay(h, day);
    }
    return;
  }
  const gym = items.filter((i) => ((i.ref as string | null) ?? "").startsWith("rotation:"));
  if (gym.some((i) => i.status === "done")) return;
  const planned = gym.find((i) => i.status === "planned" || i.status === "skipped");
  if (planned) {
    if (split && planned.ref !== `rotation:fitness:${split.ordinal}`) {
      h.rec.update("plan_item", planned.id as number, { title: `Gym: ${split.label}`, ref: `rotation:fitness:${split.ordinal}` });
    }
    const item = h.rec.update("plan_item", planned.id as number, { status: "done" });
    touchDay(h, day);
    completeSource(h, item);
    return;
  }
  let rot = split;
  if (!rot) {
    const want = Number(h.db.all<{ value: string }>("SELECT value FROM config WHERE key = 'rotation.fitness'")[0]?.value ?? "1");
    rot = h.db.all<{ ordinal: number; label: string }>("SELECT ordinal, label FROM rotation WHERE lane = 'fitness' AND ordinal = ?", want)[0] ?? null;
  }
  if (!rot) return;
  touchDay(h, day);
  const id = h.rec.insert("plan_item", {
    date: day, lane: "fitness", title: `Gym: ${rot.label}`, ref: `rotation:fitness:${rot.ordinal}`, source: "user", status: "done",
  });
  completeSource(h, h.rec.get("plan_item", id)!);
}

const HANDLERS: { [K in Op["type"]]: (h: HandlerCtx, op: Extract<Op, { type: K }>) => HandlerResult } = {
  add_item(h, op) {
    if (op.unit_id !== undefined && !h.rec.get("unit", op.unit_id)) throw new OpError(`unit ${op.unit_id} not found`);
    touchDay(h, op.date);
    const id = h.rec.insert("plan_item", {
      date: op.date,
      lane: op.lane,
      title: op.title,
      ref: op.ref ?? null,
      est_min: op.est_min ?? null,
      unit_id: op.unit_id ?? null,
      source: op.source ?? "user",
      status: "planned",
    });
    return { lane: op.lane, refId: id, summary: `Added to ${op.date}: ${op.title}` };
  },

  set_item_status(h, op) {
    const item = requireItem(h, op.item_id);
    h.rec.update("plan_item", op.item_id, { status: op.status });
    touchDay(h, item.date as string);
    // Finishing an item moves whatever it was drawn from, in the same undoable change.
    if (op.status === "done" && item.status !== "done") completeSource(h, item);
    return { lane: item.lane as string, refId: op.item_id, summary: `${item.title} → ${op.status}` };
  },

  set_places(h, op) {
    for (const p of op.places) {
      const plan = h.rec.get("day_plan", p.date, "date");
      if (!plan) h.rec.insert("day_plan", { date: p.date, place: p.place, status: "draft", version: 1 }, "date");
      else if (plan.place !== p.place) h.rec.update("day_plan", p.date, { place: p.place, version: (plan.version as number) + 1 }, "date");
    }
    const office = op.places.filter((p) => p.place === "OFFICE").map((p) => p.date);
    return { summary: office.length ? `Office days: ${office.join(", ")}; other weekdays remote` : "All remote" };
  },

  set_place(h, op) {
    for (const day of op.dates) {
      const plan = h.rec.get("day_plan", day, "date");
      if (!plan) h.rec.insert("day_plan", { date: day, place: op.place, status: "draft", version: 1 }, "date");
      else h.rec.update("day_plan", day, { place: op.place, version: (plan.version as number) + 1 }, "date");
    }
    return { summary: `${op.place === "OFFICE" ? "In office" : "Remote"}: ${op.dates.join(", ")}` };
  },

  move_item(h, op) {
    const item = requireItem(h, op.item_id);
    const from = item.date as string;
    if (from === op.to_date) throw new OpError("item is already on that date");
    // Once moved it is the user's item: re-drafting either day must neither delete nor regenerate it.
    h.rec.update("plan_item", op.item_id, { date: op.to_date, status: "planned", source: "user" });
    touchDay(h, from);
    touchDay(h, op.to_date);
    return { lane: item.lane as string, refId: op.item_id, summary: `Moved ${item.title}: ${from} → ${op.to_date}` };
  },

  set_override(h, op) {
    const id = h.rec.insert("override", {
      type: op.override_type,
      start_date: op.start_date,
      end_date: op.end_date,
      scope: op.scope ?? "all",
      note: op.note ?? null,
      created_at: iso(h.now),
    });
    const span = op.start_date === op.end_date ? op.start_date : `${op.start_date} to ${op.end_date}`;
    return { refId: id, summary: `${op.override_type} ${span}` };
  },

  revoke_override(h, op) {
    const ov = h.rec.get("override", op.override_id);
    if (!ov) throw new OpError(`override ${op.override_id} not found`);
    if (ov.revoked_at) throw new OpError(`override ${op.override_id} is already revoked`);
    h.rec.update("override", op.override_id, { revoked_at: iso(h.now) });
    return { refId: op.override_id, summary: `Cancelled ${ov.type} ${ov.start_date}` };
  },

  add_note(h, op) {
    const expires = new Date(h.now.getTime() + op.ttl_days * 86_400_000);
    const id = h.rec.insert("note", {
      lane: op.lane ?? null,
      text: op.text,
      created_at: iso(h.now),
      expires_at: iso(expires),
    });
    return { lane: op.lane, refId: id, summary: `Noted for ${op.ttl_days}d: ${op.text}` };
  },

  resolve_note(h, op) {
    const n = h.rec.get("note", op.note_id);
    if (!n) throw new OpError(`note ${op.note_id} not found`);
    if (n.resolved_at) throw new OpError(`note ${op.note_id} is already resolved`);
    h.rec.update("note", op.note_id, { resolved_at: iso(h.now) });
    return { lane: (n.lane as string | null) ?? undefined, refId: op.note_id, summary: `Resolved: ${n.text}` };
  },

  advance_pointer(h, op) {
    if (!h.rec.get("unit_list", op.list_id)) throw new OpError(`list ${op.list_id} not found`);
    const count = h.db.all<{ c: number }>("SELECT COUNT(*) AS c FROM unit WHERE list_id = ?", op.list_id)[0].c;
    const cur = h.rec.get("pointer", op.list_id, "list_id");
    const current = cur ? (cur.ordinal as number) : 1;
    const target = Math.min(op.to_ordinal ?? current + 1, count + 1);
    if (cur) h.rec.update("pointer", op.list_id, { ordinal: target, updated_at: iso(h.now) }, "list_id");
    else h.rec.insert("pointer", { list_id: op.list_id, ordinal: target, updated_at: iso(h.now) }, "list_id");
    const finished = target === count + 1;
    return { lane: "study", refId: op.list_id, summary: finished ? `${op.list_id}: finished` : `${op.list_id}: now at ${target}/${count}` };
  },

  set_config(h, op) {
    const cur = h.rec.get("config", op.key, "key");
    if (cur) h.rec.update("config", op.key, { value: op.value }, "key");
    else h.rec.insert("config", { key: op.key, value: op.value }, "key");
    return { refId: op.key, summary: `${op.key} = ${op.value}` };
  },

  add_reading(h, op) {
    const dup = h.db.all("SELECT 1 FROM reading_item WHERE lower(title) = lower(?) AND state NOT IN ('done','dropped')", op.title);
    if (dup.length > 0) throw new OpError(`"${op.title}" is already on the shelf`);
    const id = h.rec.insert("reading_item", {
      title: op.title,
      author: op.author ?? null,
      kind: op.kind ?? "book",
      url: op.url ?? null,
      note: op.note ?? null,
      source: "user",
      state: "backlog",
      slot: op.slot ?? null,
      shortlist: op.shortlist ? 1 : 0,
    });
    return { lane: "reading", refId: id, summary: `Added to the shelf: ${op.title}` };
  },

  start_reading(h, op) {
    const r = requireReading(h, op.reading_id);
    if (!["backlog", "queued", "paused", "dropped"].includes(r.state as string)) throw new OpError(`${r.title} is already ${r.state}`);
    if (r.slot) {
      const busy = h.db.all<{ title: string }>(
        "SELECT title FROM reading_item WHERE slot = ? AND state IN ('sampling','active') AND id <> ?", r.slot, op.reading_id,
      )[0];
      if (busy) throw new OpError(`one ${r.slot} book at a time: finish or drop "${busy.title}" first`);
    }
    h.rec.update("reading_item", op.reading_id, { state: "sampling", started_at: iso(h.now), ended_at: null, drop_reason: null });
    return { lane: "reading", refId: op.reading_id, summary: `Sampling: ${r.title}` };
  },

  keep_reading(h, op) {
    const r = requireReading(h, op.reading_id);
    if (r.state !== "sampling") throw new OpError(`${r.title} is ${r.state}, not sampling`);
    h.rec.update("reading_item", op.reading_id, { state: "active" });
    return { lane: "reading", refId: op.reading_id, summary: `Keeping: ${r.title}` };
  },

  finish_reading(h, op) {
    const r = requireReading(h, op.reading_id);
    if (r.state === "done") throw new OpError(`${r.title} is already marked done`);
    // Allowed from any other state: a book read before it was ever started on the shelf is still finished.
    h.rec.update("reading_item", op.reading_id, { state: "done", ended_at: iso(h.now) });
    return { lane: "reading", refId: op.reading_id, summary: `Finished: ${r.title}` };
  },

  hold_reading(h, op) {
    const r = requireReading(h, op.reading_id);
    if (r.state !== "sampling" && r.state !== "active") throw new OpError(`${r.title} is ${r.state}, only a book being read can be put on hold`);
    h.rec.update("reading_item", op.reading_id, { state: "paused" });
    return { lane: "reading", refId: op.reading_id, summary: `On hold: ${r.title} (start it again any time)` };
  },

  drop_reading(h, op) {
    const r = requireReading(h, op.reading_id);
    if (r.state === "done" || r.state === "dropped") throw new OpError(`${r.title} is already ${r.state}`);
    h.rec.update("reading_item", op.reading_id, { state: "dropped", ended_at: iso(h.now), drop_reason: op.reason ?? null });
    return { lane: "reading", refId: op.reading_id, summary: `Dropped: ${r.title}${op.reason ? ` (${op.reason})` : ""}` };
  },

  log_workout(h, op) {
    const now = iso(h.now);
    const existing = h.db.all<Row>("SELECT * FROM workout_session WHERE date = ?", op.date)[0];
    let sessionId: number;
    if (existing) {
      sessionId = existing.id as number;
      // A late chunk reopens the same day's session.
      h.rec.update("workout_session", sessionId, { status: "open", closed_at: null, version: (existing.version as number) + 1 });
    } else {
      sessionId = h.rec.insert("workout_session", { date: op.date, status: "open", source: "telegram", version: 1, created_at: now }) as number;
    }

    const catalog = loadCatalog(h.db);
    const added: string[] = [];
    const names: string[] = [];
    let total = 0;
    let corrected = false;
    for (const ex of op.exercises) {
      const mode = ex.mode ?? op.mode;
      let entry = matchExercise(catalog, ex.name);
      if (!entry) {
        const name = displayName(ex.name);
        const id = h.rec.insert("exercise_catalog", { canonical_name: name, kind: "weighted", aliases_json: "[]", source: "user" });
        entry = h.rec.get("exercise_catalog", id) as unknown as ExerciseRow;
        catalog.push(entry);
        added.push(name);
      } else if (ex.learn) {
        // A spelling the user confirmed ("face full" = Face Pull) resolves by itself next time.
        const aliases = JSON.parse(entry.aliases_json) as string[];
        const have = [entry.canonical_name, ...aliases].map((a) => a.trim().toLowerCase());
        if (!have.includes(ex.learn.trim().toLowerCase())) {
          const next = JSON.stringify([...aliases, ex.learn.trim()]);
          h.rec.update("exercise_catalog", entry.id, { aliases_json: next });
          entry = { ...entry, aliases_json: next };
          catalog[catalog.findIndex((c) => c.id === entry!.id)] = entry;
        }
      }
      let se = h.db.all<Row>("SELECT * FROM session_exercise WHERE session_id = ? AND exercise_id = ? ORDER BY id LIMIT 1", sessionId, entry.id)[0];
      if (!se) {
        const ordinal = (h.db.all<{ m: number | null }>("SELECT MAX(ordinal) AS m FROM session_exercise WHERE session_id = ?", sessionId)[0].m ?? 0) + 1;
        const id = h.rec.insert("session_exercise", { session_id: sessionId, ordinal, exercise_id: entry.id, display_name: entry.canonical_name, status: "done" });
        se = h.rec.get("session_exercise", id)!;
      } else if (se.status !== "done") {
        h.rec.update("session_exercise", se.id as number, { status: "done" });
      }
      const old = h.db.all<{ id: number; set_no: number }>("SELECT id, set_no FROM session_set WHERE session_exercise_id = ? ORDER BY set_no", se.id as number);
      if (mode === "replace") for (const s of old) h.rec.delete("session_set", s.id);
      if (mode === "replace") corrected = true;
      let setNo = mode === "replace" ? 0 : old.reduce((m, s) => Math.max(m, s.set_no), 0);
      for (const s of ex.sets) {
        h.rec.insert("session_set", {
          session_exercise_id: se.id as number, set_no: ++setNo, reps: s.reps, weight_kg: s.weight_kg, duration_s: s.duration_s,
          rest_s: s.rest_s, bw: s.bw ? 1 : 0, kind: s.kind, incomplete: s.incomplete ? 1 : 0, notes: s.notes,
        });
      }
      total += ex.sets.length;
      names.push(entry.canonical_name);
    }

    const sess = h.rec.get("workout_session", sessionId)!;
    const patch: Row = {};
    if (op.notes) patch.notes = sess.notes ? `${sess.notes}; ${op.notes}` : op.notes;
    if (op.pain) {
      patch.pain_notes = sess.pain_notes ? `${sess.pain_notes}; ${op.pain}` : op.pain;
      // The implication lives a week, then expires on its own.
      h.rec.insert("note", { lane: "fitness", text: `Pain: ${op.pain}`, created_at: now, expires_at: iso(new Date(h.now.getTime() + 7 * 86_400_000)) });
    }
    const shape = sessionShape(h.db, sessionId, (sess.title as string | null) ?? null);
    if (shape.kind !== sess.kind) patch.kind = shape.kind;
    if (shape.title !== sess.title) patch.title = shape.title;
    if (Object.keys(patch).length > 0) h.rec.update("workout_session", sessionId, patch);

    completeWorkoutItem(h, op.date, shape.kind, shape.split);

    const verb = corrected ? "Corrected" : "Logged";
    const newOnes = added.length ? ` (new: ${added.join(", ")})` : "";
    return { lane: "fitness", refId: sessionId, summary: `${verb} ${total} set${total === 1 ? "" : "s"}: ${names.join(", ")}${newOnes}` };
  },

  rename_exercise(h, op) {
    const se = findSessionExercise(h.db, op.date, op.from);
    if (!se) throw new OpError(missingExercise(h.db, op.date, op.from));
    const catalog = loadCatalog(h.db);
    let target = matchExercise(catalog, op.to) ?? suggestExercise(catalog, op.to);
    if (!target) {
      const id = h.rec.insert("exercise_catalog", { canonical_name: displayName(op.to), kind: "weighted", aliases_json: "[]", source: "user" });
      target = h.rec.get("exercise_catalog", id) as unknown as ExerciseRow;
    }
    if (target.id === se.exerciseId) throw new OpError(`${se.name} is already ${target.canonical_name}`);

    const sessionId = h.db.all<{ session_id: number }>("SELECT session_id FROM session_exercise WHERE id = ?", se.id)[0].session_id;
    const other = h.db.all<Row>("SELECT * FROM session_exercise WHERE session_id = ? AND exercise_id = ? AND id <> ?", sessionId, target.id, se.id)[0];
    const moving = h.db.all<{ id: number }>("SELECT id FROM session_set WHERE session_exercise_id = ? ORDER BY set_no, id", se.id);
    if (other) {
      // The target is already in the session: its sets and these become one list.
      let setNo = h.db.all<{ m: number | null }>("SELECT MAX(set_no) AS m FROM session_set WHERE session_exercise_id = ?", other.id as number)[0].m ?? 0;
      for (const s of moving) h.rec.update("session_set", s.id, { session_exercise_id: other.id as number, set_no: ++setNo });
      h.rec.delete("session_exercise", se.id);
    } else {
      h.rec.update("session_exercise", se.id, { exercise_id: target.id, display_name: target.canonical_name });
    }

    // A catalog entry the user made up (not from the seed) that nothing uses any more was a wrong spelling:
    // drop it, and keep the spelling as an alias of the right exercise.
    const wrong = se.exerciseId === null ? null : (h.rec.get("exercise_catalog", se.exerciseId) as unknown as (ExerciseRow & { source: string }) | null);
    if (wrong && wrong.source === "user" && wrong.id !== target.id) {
      const stillUsed = h.db.all("SELECT 1 FROM session_exercise WHERE exercise_id = ? LIMIT 1", wrong.id).length > 0;
      if (!stillUsed) {
        h.rec.delete("exercise_catalog", wrong.id);
        const aliases = JSON.parse(target.aliases_json) as string[];
        const have = [target.canonical_name, ...aliases].map((a) => a.toLowerCase());
        if (!have.includes(wrong.canonical_name.toLowerCase())) {
          h.rec.update("exercise_catalog", target.id, { aliases_json: JSON.stringify([...aliases, wrong.canonical_name]) });
        }
      }
    }
    refreshShape(h, sessionId);
    return {
      lane: "fitness",
      refId: sessionId,
      summary: other ? `Merged ${se.name} into ${target.canonical_name}` : `Renamed ${se.name} to ${target.canonical_name}`,
    };
  },

  amend_set(h, op) {
    const se = findSessionExercise(h.db, op.date, op.exercise);
    if (!se) throw new OpError(missingExercise(h.db, op.date, op.exercise));
    const row = h.db.all<Row>("SELECT * FROM session_set WHERE session_exercise_id = ? AND set_no = ?", se.id, op.set_no)[0];
    if (!row) throw new OpError(`${se.name} has ${se.sets.length} set${se.sets.length === 1 ? "" : "s"}, so there is no set ${op.set_no}`);
    const patch: Row = { incomplete: 0 };
    if (op.weight_kg !== undefined) patch.weight_kg = op.weight_kg;
    if (op.reps !== undefined) patch.reps = op.reps;
    if (op.duration_s !== undefined) patch.duration_s = op.duration_s;
    const after = h.rec.update("session_set", row.id as number, patch);
    const text = (r: Row) =>
      formatSet({ weight_kg: r.weight_kg as number | null, reps: r.reps as number | null, duration_s: r.duration_s as number | null, kind: r.kind as SetKind, bw: r.bw === 1, incomplete: r.incomplete === 1 });
    return { lane: "fitness", refId: row.id as number, summary: `${se.name} set ${op.set_no}: ${text(row)} → ${text(after)}` };
  },

  remove_exercise(h, op) {
    const se = findSessionExercise(h.db, op.date, op.exercise);
    if (!se) throw new OpError(missingExercise(h.db, op.date, op.exercise));
    const sessionId = h.db.all<{ session_id: number }>("SELECT session_id FROM session_exercise WHERE id = ?", se.id)[0].session_id;
    for (const s of h.db.all<{ id: number }>("SELECT id FROM session_set WHERE session_exercise_id = ?", se.id)) h.rec.delete("session_set", s.id);
    h.rec.delete("session_exercise", se.id);
    const left = h.db.all("SELECT 1 FROM session_exercise WHERE session_id = ? LIMIT 1", sessionId).length;
    // A day with nothing left is a day with no workout: the absence is the record.
    if (left === 0) h.rec.delete("workout_session", sessionId);
    else refreshShape(h, sessionId);
    return { lane: "fitness", refId: sessionId, summary: `Removed ${se.name} (${se.sets.length} set${se.sets.length === 1 ? "" : "s"})` };
  },

  log_metric(h, op) {
    const cur = h.db.all<Row>("SELECT * FROM metric_log WHERE date = ? AND metric = ?", op.date, op.metric)[0];
    const before = cur ? Number(cur.value) : 0;
    const mode = op.mode ?? "set";
    const after = mode === "add" ? before + op.value : op.value;
    if (cur) h.rec.update("metric_log", cur.id as number, { value: after, ts: iso(h.now) });
    else h.rec.insert("metric_log", { date: op.date, metric: op.metric, value: after, ts: iso(h.now) });
    // The entry records the change, so the day can be explained; the total above stays authoritative.
    if (after !== before) {
      h.rec.insert("protein_entry", { date: op.date, grams: after - before, label: op.label ?? (mode === "set" ? "total set" : null), ts: iso(h.now) });
    }
    return { lane: "fitness", refId: op.date, summary: proteinChange(h.db, op.date, mode, after - before, after, op.label) };
  },

  add_jot(h, op) {
    const r = requireReading(h, op.reading_id);
    const id = h.rec.insert("jot", {
      reading_id: op.reading_id, locator: op.locator ?? null, text: op.text, kind: op.kind ?? "point", created_at: iso(h.now),
    });
    const short = op.text.length > 60 ? `${op.text.slice(0, 59)}…` : op.text;
    return { lane: "reading", refId: id, summary: `Jot on ${r.title}${op.locator ? ` (${op.locator})` : ""}: ${short}` };
  },

  set_progress(h, op) {
    const r = requireReading(h, op.reading_id);
    h.rec.update("reading_item", op.reading_id, { progress: op.locator });
    // Reading it today counts as today's reading.
    const item = h.db.all<Row>("SELECT * FROM plan_item WHERE date = ? AND ref = ? AND status = 'planned'", op.date, `reading:${op.reading_id}`)[0];
    if (item) {
      h.rec.update("plan_item", item.id as number, { status: "done" });
      touchDay(h, op.date);
    }
    return { lane: "reading", refId: op.reading_id, summary: `${r.title}: ${op.locator}` };
  },

  note(_h, op) {
    return { summary: `Note: ${op.text}` };
  },
};

// ------------------------------------------------------------------ apply

export interface ApplyOptions {
  now?: () => Date;
  /** "telegram" | "system" | ... free text, stored on the event. */
  source?: string;
  /** Replaying the same key returns the stored result and writes nothing. */
  idempotencyKey?: string;
  /** Original user text / transcript, for the audit trail. */
  raw?: string;
  /** e.g. { "day_plan:2026-10-27": 3 } — fail if the row changed since the caller read it. */
  expectVersions?: Record<string, number>;
}

export interface ApplyResult {
  duplicate: boolean;
  eventId: number;
  revisionId: number;
  summary: string;
}

function checkVersions(db: Db, expected: Record<string, number>): void {
  for (const [key, want] of Object.entries(expected)) {
    const [table, id] = key.split(/:(.*)/s);
    if (table !== "day_plan") throw new Error(`versioned table not supported: ${table}`);
    const row = db.all<{ version: number }>("SELECT version FROM day_plan WHERE date = ?", id)[0];
    const actual = row?.version ?? 0;
    if (actual !== want) throw new VersionConflictError(key, want, actual);
  }
}

export function applyOp(db: Db, input: unknown, opts: ApplyOptions = {}): ApplyResult {
  const op = validateOp(input); // reject before touching the database
  const now = (opts.now ?? (() => new Date()))();

  return db.transaction(() => {
    if (opts.idempotencyKey) {
      const prior = db.all<{ id: number; payload_json: string }>(
        "SELECT id, payload_json FROM event WHERE idempotency_key = ?",
        opts.idempotencyKey,
      )[0];
      if (prior) {
        const rev = db.all<{ id: number; summary: string }>("SELECT id, summary FROM revision WHERE event_id = ?", prior.id)[0];
        return { duplicate: true, eventId: prior.id, revisionId: rev?.id ?? 0, summary: rev?.summary ?? "" };
      }
    }
    if (opts.expectVersions) checkVersions(db, opts.expectVersions);

    const rec = new Recorder(db);
    const handler = HANDLERS[op.type] as (h: HandlerCtx, op: Op) => HandlerResult;
    const res = handler({ rec, db, now }, op);

    db.run(
      "INSERT INTO event (ts, type, lane, ref_id, payload_json, source, raw, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      iso(now),
      op.type,
      res.lane ?? null,
      res.refId === undefined || res.refId === null ? null : String(res.refId),
      JSON.stringify({ op, summary: res.summary }),
      opts.source ?? "system",
      opts.raw ?? null,
      opts.idempotencyKey ?? null,
    );
    const eventId = lastInsertId(db);

    db.run(
      "INSERT INTO revision (ts, event_id, summary, op_json, diff_json) VALUES (?, ?, ?, ?, ?)",
      iso(now),
      eventId,
      res.summary,
      JSON.stringify(op),
      JSON.stringify(rec.changes),
    );
    return { duplicate: false, eventId, revisionId: lastInsertId(db), summary: res.summary };
  });
}

// ------------------------------------------------------------------- undo

export interface UndoResult {
  undone: boolean;
  summary: string;
  revisionId?: number;
}

function restore(db: Db, c: Change): void {
  const t = ident(c.table);
  const pk = ident(c.pk);
  if (c.before === null) {
    db.run(`DELETE FROM ${t} WHERE ${pk} = ?`, c.key);
  } else if (c.after === null) {
    const cols = Object.keys(c.before).map(ident);
    db.run(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((k) => c.before![k]));
  } else {
    const cols = Object.keys(c.before).filter((k) => k !== c.pk).map(ident);
    if (cols.length === 0) return;
    db.run(`UPDATE ${t} SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE ${pk} = ?`, ...cols.map((k) => c.before![k]), c.key);
  }
}

/** Undo the most recent op that has not been undone (stack order). */
export function undoLast(db: Db, opts: { now?: () => Date; source?: string } = {}): UndoResult {
  const now = (opts.now ?? (() => new Date()))();
  return db.transaction(() => {
    const rev = db.all<{ id: number; summary: string; diff_json: string; event_id: number }>(
      "SELECT id, summary, diff_json, event_id FROM revision WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1",
    )[0];
    if (!rev) return { undone: false, summary: "Nothing to undo." };

    const changes = JSON.parse(rev.diff_json) as Change[];
    for (const c of [...changes].reverse()) restore(db, c);

    db.run("UPDATE revision SET undone_at = ? WHERE id = ?", iso(now), rev.id);
    db.run(
      "INSERT INTO event (ts, type, ref_id, payload_json, source) VALUES (?, 'undo', ?, ?, ?)",
      iso(now),
      String(rev.id),
      JSON.stringify({ revision: rev.id, summary: rev.summary }),
      opts.source ?? "system",
    );
    return { undone: true, summary: `Undid: ${rev.summary}`, revisionId: rev.id };
  });
}
