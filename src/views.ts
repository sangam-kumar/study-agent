// Read-only named views over the agent's own tables (Phase 15). A caller picks a view and passes
// validated parameters; no SQL text ever comes from outside, and each view lists the columns it returns.
// Tables that are not listed here (bot_state, config, processed_update, mirror_state) cannot be read.

import type { Db, SqlValue } from "./db/db.ts";
import { addDays, dayKey, istWallToMs } from "./time.ts";

export class ViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewError";
  }
}

export type ViewRow = Record<string, SqlValue>;

export interface ViewResult {
  view: string;
  params: Record<string, string | number>;
  columns: string[];
  count: number;
  truncated: boolean;
  rows: ViewRow[];
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

interface Ctx {
  db: Db;
  nowMs: number;
  /** Validated parameters; from / to are dates, the rest are strings checked by the view. */
  p: Record<string, string>;
  /** Rows to fetch: the limit plus one, so a cut-off result can be flagged. */
  take: number;
}

interface ViewDef {
  description: string;
  /** Parameters besides `limit`. */
  params: string[];
  /** When set, `from` / `to` default to this many days ending today (date-column views). */
  defaultDays?: number;
  columns: string[];
  run: (c: Ctx) => ViewRow[];
}

const isoOf = (ms: number) => new Date(ms).toISOString();
/** interaction_logs.created_at is SQLite's CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" in UTC. */
const sqlTimeOf = (ms: number) => isoOf(ms).slice(0, 19).replace("T", " ");

/** WHERE parts for a timestamp column, bounded by the user's days (they turn over at 03:00 IST). */
function tsRange(c: Ctx, column: string, fmt: (ms: number) => string): { where: string[]; args: SqlValue[] } {
  const where: string[] = [];
  const args: SqlValue[] = [];
  if (c.p.from) {
    where.push(`${column} >= ?`);
    args.push(fmt(istWallToMs(c.p.from, "03:00")));
  }
  if (c.p.to) {
    where.push(`${column} < ?`);
    args.push(fmt(istWallToMs(addDays(c.p.to, 1), "03:00")));
  }
  return { where, args };
}

const whereSql = (where: string[]) => (where.length ? `WHERE ${where.join(" AND ")}` : "");

function oneOf(c: Ctx, name: string, allowed: readonly string[]): string | undefined {
  const v = c.p[name];
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) throw new ViewError(`${name} must be one of: ${allowed.join(", ")}`);
  return v;
}

const READING_STATES = ["backlog", "queued", "sampling", "active", "paused", "done", "dropped"] as const;

export const VIEWS: Record<string, ViewDef> = {
  events: {
    description: "Append-only log of everything that happened (messages applied, jobs, nudges).",
    params: ["from", "to", "type"],
    columns: ["id", "ts", "type", "lane", "source", "raw", "payload_json"],
    run(c) {
      const { where, args } = tsRange(c, "ts", isoOf);
      if (c.p.type) {
        where.push("type = ?");
        args.push(c.p.type);
      }
      return c.db.all<ViewRow>(
        `SELECT id, ts, type, lane, source, raw, payload_json FROM event ${whereSql(where)} ORDER BY id DESC LIMIT ?`,
        ...args, c.take,
      );
    },
  },

  revisions: {
    description: "Every applied change with its summary and operation; undone ones carry undone_at.",
    params: ["from", "to"],
    columns: ["id", "ts", "summary", "op_json", "undone_at"],
    run(c) {
      const { where, args } = tsRange(c, "ts", isoOf);
      return c.db.all<ViewRow>(
        `SELECT id, ts, summary, op_json, undone_at FROM revision ${whereSql(where)} ORDER BY id DESC LIMIT ?`,
        ...args, c.take,
      );
    },
  },

  messages: {
    description: "What you sent and how it was read (the interaction log).",
    params: ["from", "to"],
    columns: ["id", "source", "raw_content", "parsed_json", "created_at"],
    run(c) {
      const { where, args } = tsRange(c, "created_at", sqlTimeOf);
      return c.db.all<ViewRow>(
        `SELECT id, source, raw_content, parsed_json, created_at FROM interaction_logs ${whereSql(where)} ORDER BY id DESC LIMIT ?`,
        ...args, c.take,
      );
    },
  },

  inbox: {
    description: "Messages the agent could not read with confidence.",
    params: ["status"],
    columns: ["id", "ts", "raw", "status"],
    run(c) {
      const status = oneOf(c, "status", ["open", "resolved", "dropped"]) ?? "open";
      return c.db.all<ViewRow>("SELECT id, ts, raw, status FROM inbox WHERE status = ? ORDER BY id DESC LIMIT ?", status, c.take);
    },
  },

  plan: {
    description: "Planned items per day with their status (default: the last 7 days).",
    params: ["from", "to"],
    defaultDays: 7,
    columns: ["date", "day_status", "locked_by", "place", "item_id", "lane", "title", "est_min", "source", "status", "optional"],
    run(c) {
      return c.db.all<ViewRow>(
        `SELECT p.date AS date, d.status AS day_status, d.locked_by AS locked_by, d.place AS place,
                p.id AS item_id, p.lane AS lane, p.title AS title, p.est_min AS est_min,
                p.source AS source, p.status AS status, p.optional AS optional
           FROM plan_item p LEFT JOIN day_plan d ON d.date = p.date
          WHERE p.date >= ? AND p.date <= ? ORDER BY p.date, p.id LIMIT ?`,
        c.p.from, c.p.to, c.take,
      );
    },
  },

  sessions: {
    description: "Workout sets, one row per set (default: the last 14 days).",
    params: ["from", "to"],
    defaultDays: 14,
    columns: [
      "date", "session", "session_kind", "session_status", "ordinal", "exercise", "set_no", "weight_kg", "reps",
      "duration_s", "rest_s", "bw", "set_kind", "incomplete", "pain_notes", "notes",
    ],
    run(c) {
      return c.db.all<ViewRow>(
        `SELECT s.date AS date, s.title AS session, s.kind AS session_kind, s.status AS session_status,
                e.ordinal AS ordinal, e.display_name AS exercise, t.set_no AS set_no, t.weight_kg AS weight_kg,
                t.reps AS reps, t.duration_s AS duration_s, t.rest_s AS rest_s, t.bw AS bw, t.kind AS set_kind,
                t.incomplete AS incomplete, s.pain_notes AS pain_notes, s.notes AS notes
           FROM workout_session s
           LEFT JOIN session_exercise e ON e.session_id = s.id
           LEFT JOIN session_set t ON t.session_exercise_id = e.id
          WHERE s.date >= ? AND s.date <= ?
          ORDER BY s.date, e.ordinal, t.set_no LIMIT ?`,
        c.p.from, c.p.to, c.take,
      );
    },
  },

  metrics: {
    description: "One number per day and metric, e.g. protein_g (default: the last 30 days).",
    params: ["from", "to", "metric"],
    defaultDays: 30,
    columns: ["date", "metric", "value", "ts"],
    run(c) {
      const args: SqlValue[] = [c.p.from, c.p.to];
      let extra = "";
      if (c.p.metric) {
        extra = " AND metric = ?";
        args.push(c.p.metric);
      }
      return c.db.all<ViewRow>(
        `SELECT date, metric, value, ts FROM metric_log WHERE date >= ? AND date <= ?${extra} ORDER BY date DESC, metric LIMIT ?`,
        ...args, c.take,
      );
    },
  },

  reminders: {
    description: "Reminders and date-only tasks, newest first.",
    params: ["status"],
    columns: ["id", "text", "due_at", "due_date", "status", "repeat_rule", "repeats", "fired_at", "done_at", "created_at"],
    run(c) {
      const status = oneOf(c, "status", ["pending", "dispatched", "done", "cancelled"]);
      const rows = c.db.all<ViewRow>(
        `SELECT id, text, trigger_at, due_date, status, repeat_rule, repeats, fired_at, done_at, created_at
           FROM reminders ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT ?`,
        ...(status ? [status] : []), c.take,
      );
      return rows.map(({ trigger_at, ...rest }) => ({
        id: rest.id,
        text: rest.text,
        due_at: typeof trigger_at === "number" ? isoOf(trigger_at) : null,
        due_date: rest.due_date,
        status: rest.status,
        repeat_rule: rest.repeat_rule,
        repeats: rest.repeats,
        fired_at: rest.fired_at,
        done_at: rest.done_at,
        created_at: rest.created_at,
      }));
    },
  },

  reading: {
    description: "Books, manga and articles with their state and progress; the ones on the go come first.",
    params: ["state"],
    columns: ["id", "title", "kind", "author", "state", "slot", "progress", "priority", "started_at", "ended_at"],
    run(c) {
      const state = oneOf(c, "state", READING_STATES);
      return c.db.all<ViewRow>(
        `SELECT id, title, kind, author, state, slot, progress, priority, started_at, ended_at
           FROM reading_item ${state ? "WHERE state = ?" : ""}
          ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'sampling' THEN 1 ELSE 2 END, id LIMIT ?`,
        ...(state ? [state] : []), c.take,
      );
    },
  },

  jots: {
    description: "Notes taken while reading, newest first.",
    params: [],
    columns: ["id", "created_at", "item", "locator", "kind", "text"],
    run(c) {
      return c.db.all<ViewRow>(
        `SELECT j.id AS id, j.created_at AS created_at, r.title AS item, j.locator AS locator, j.kind AS kind, j.text AS text
           FROM jot j LEFT JOIN reading_item r ON r.id = j.reading_id ORDER BY j.id DESC LIMIT ?`,
        c.take,
      );
    },
  },

  pointers: {
    description: "Where you are in each study list.",
    params: [],
    columns: ["list_id", "list", "ordinal", "total", "current"],
    run(c) {
      return c.db.all<ViewRow>(
        `SELECT p.list_id AS list_id, l.title AS list, p.ordinal AS ordinal,
                (SELECT COUNT(*) FROM unit u WHERE u.list_id = p.list_id) AS total,
                (SELECT u.title FROM unit u WHERE u.list_id = p.list_id AND u.ordinal = p.ordinal) AS current
           FROM pointer p LEFT JOIN unit_list l ON l.id = p.list_id ORDER BY p.list_id LIMIT ?`,
        c.take,
      );
    },
  },

  overrides: {
    description: "Travel, sick, out and low-mood spans; cancelled ones carry revoked_at.",
    params: [],
    columns: ["id", "type", "start_date", "end_date", "scope", "note", "revoked_at"],
    run(c) {
      return c.db.all<ViewRow>(
        "SELECT id, type, start_date, end_date, scope, note, revoked_at FROM override ORDER BY id DESC LIMIT ?",
        c.take,
      );
    },
  },

  notes: {
    description: "Short-lived notes the agent keeps as context, with their expiry.",
    params: [],
    columns: ["id", "lane", "text", "created_at", "expires_at", "resolved_at"],
    run(c) {
      return c.db.all<ViewRow>(
        "SELECT id, lane, text, created_at, expires_at, resolved_at FROM note ORDER BY id DESC LIMIT ?",
        c.take,
      );
    },
  },
};

// ------------------------------------------------------------------ parameters

function dateParam(name: string, v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || addDays(v, 0) !== v) throw new ViewError(`${name} must be a date like 2026-11-05`);
  return v;
}

function limitParam(v: string | undefined): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new ViewError("limit must be a whole number of at least 1");
  return Math.min(Number(v), MAX_LIMIT);
}

/** Validates the caller's parameters for a view and fills in the date defaults. */
function resolveParams(def: ViewDef, raw: Record<string, string>, nowMs: number): Record<string, string> {
  const allowed = new Set([...def.params, "limit"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new ViewError(`unknown parameter "${key}" (accepted: ${[...allowed].join(", ")})`);
  }
  const p: Record<string, string> = {};
  for (const key of def.params) {
    const v = raw[key];
    if (v === undefined || v === "") continue;
    p[key] = key === "from" || key === "to" ? dateParam(key, v) : v;
  }
  if (def.defaultDays !== undefined) {
    p.to ??= dayKey(nowMs);
    p.from ??= addDays(p.to, -(def.defaultDays - 1));
  }
  if (p.from && p.to && p.from > p.to) throw new ViewError("from must not be after to");
  return p;
}

// ------------------------------------------------------------------ public API

export function listViews(): { name: string; description: string; params: string[] }[] {
  return Object.entries(VIEWS).map(([name, def]) => ({ name, description: def.description, params: [...def.params, "limit"] }));
}

export function readView(db: Db, name: string, raw: Record<string, string>, nowMs: number): ViewResult {
  const def = Object.hasOwn(VIEWS, name) ? VIEWS[name] : undefined;
  if (!def) throw new ViewError(`unknown view "${name}" (see /admin/view for the list)`);
  const limit = limitParam(raw.limit);
  const { limit: _ignored, ...rest } = raw;
  const p = resolveParams(def, rest, nowMs);
  const fetched = def.run({ db, nowMs, p, take: limit + 1 });
  const truncated = fetched.length > limit;
  const rows = truncated ? fetched.slice(0, limit) : fetched;
  return { view: name, params: { ...p, limit }, columns: def.columns, count: rows.length, truncated, rows };
}

// ------------------------------------------------------------------ CSV

/** A spreadsheet runs a cell that starts with one of these as a formula, so such text gets a leading apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v: SqlValue | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: ViewRow[]): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((col) => csvCell(row[col])).join(","));
  return lines.join("\r\n") + "\r\n";
}
