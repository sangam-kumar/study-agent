// The single place where plan state changes.
//
//   unknown input --validateOp--> Op --applyOp--> rows + event + revision   (one transaction)
//                                          undoLast <-- revision.diff_json
//
// The LLM (Phase 9) only ever produces an Op. Code validates and applies it.

import { lastInsertId } from "./db/db.ts";
import type { Db, SqlValue } from "./db/db.ts";

// ------------------------------------------------------------------ types

export const LANES = ["fitness", "study", "reading", "career", "guitar"] as const;
export const OVERRIDE_TYPES = ["TRAVEL", "SICK", "OUT", "LOW_MOOD"] as const;
export const ITEM_STATUSES = ["planned", "done", "skipped", "dropped"] as const;
export const ITEM_SOURCES = ["pattern", "pointer", "user", "minimum"] as const;
export const READING_SLOTS = ["technical", "narrative"] as const;
export type ReadingSlot = (typeof READING_SLOTS)[number];
const MAX_NOTE_TTL_DAYS = 30;

export type Lane = (typeof LANES)[number];
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
  | { type: "add_reading"; title: string; author?: string; kind?: string; url?: string; note?: string; slot?: ReadingSlot; shortlist?: boolean }
  | { type: "start_reading"; reading_id: number }
  | { type: "keep_reading"; reading_id: number }
  | { type: "finish_reading"; reading_id: number }
  | { type: "hold_reading"; reading_id: number }
  | { type: "drop_reading"; reading_id: number; reason?: string }
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
    return { lane: item.lane as string, refId: op.item_id, summary: `${item.title} → ${op.status}` };
  },

  move_item(h, op) {
    const item = requireItem(h, op.item_id);
    const from = item.date as string;
    if (from === op.to_date) throw new OpError("item is already on that date");
    h.rec.update("plan_item", op.item_id, { date: op.to_date, status: "planned" });
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
