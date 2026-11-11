// Conversation state (Phase 16): the one open question and the last thing the agent changed, so a short
// reply ("both", "yes", "no, face pull") has something to refer to. Stored as one bot_state row.
// Code reads these first; a message that does not answer the open question carries on as normal.

import type { Db } from "./db/db.ts";
import type { LogWorkoutOp } from "./fitness.ts";

export const PENDING_MS = 30 * 60_000;
export const LAST_MS = 2 * 3_600_000;
const KEY = "convo";

export interface ChooseOption {
  id: number;
  title: string;
}

export type Pending =
  /** Several plan items matched; the reply picks which one(s) the action applies to. */
  | { kind: "choose_item"; action: "done" | "skip" | "move"; toDate?: string; options: ChooseOption[] }
  /** A workout held because a name is probably a misspelling; asked: typed name -> the catalog name it may be. */
  | { kind: "confirm_exercise"; op: LogWorkoutOp; asked: { typed: string; suggestion: string }[] }
  /** A workout identical to what is already logged, held until "add again". */
  | { kind: "repeat_workout"; op: LogWorkoutOp };

export interface LastAction {
  summary: string;
  revisionId: number;
  /** Exercise names touched, so "no, face pull" knows which one is meant. */
  exercises: string[];
  date?: string;
}

interface Stored {
  pending?: Pending & { until: number };
  last?: LastAction & { until: number };
}

function load(db: Db): Stored {
  const row = db.all<{ value: string }>("SELECT value FROM bot_state WHERE key = ?", KEY)[0];
  if (!row) return {};
  try {
    return JSON.parse(row.value) as Stored;
  } catch {
    return {};
  }
}

function save(db: Db, s: Stored): void {
  db.run(
    `INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    KEY, JSON.stringify(s),
  );
}

export function setPending(db: Db, nowMs: number, p: Pending): void {
  save(db, { ...load(db), pending: { ...p, until: nowMs + PENDING_MS } });
}

export function getPending(db: Db, nowMs: number): Pending | null {
  const p = load(db).pending;
  if (!p || p.until <= nowMs) return null;
  const { until: _until, ...rest } = p;
  return rest as Pending;
}

export function clearPending(db: Db): void {
  const s = load(db);
  if (!s.pending) return;
  delete s.pending;
  save(db, s);
}

export function setLast(db: Db, nowMs: number, last: LastAction): void {
  save(db, { ...load(db), last: { ...last, until: nowMs + LAST_MS } });
}

export function getLast(db: Db, nowMs: number): LastAction | null {
  const l = load(db).last;
  if (!l || l.until <= nowMs) return null;
  const { until: _until, ...rest } = l;
  return rest;
}

/** The operations a "Which one?" answer stands for: the same action on each chosen item. */
export function choiceOps(p: Extract<Pending, { kind: "choose_item" }>, ids: number[]): Record<string, unknown>[] {
  return ids.map((id) =>
    p.action === "move"
      ? { type: "move_item", item_id: id, to_date: p.toDate }
      : { type: "set_item_status", item_id: id, status: p.action === "done" ? "done" : "skipped" },
  );
}

// ------------------------------------------------------------------ answers

/** What the model heard in a reply: its meaning only. Code decides what that means for the open question. */
export interface Answer {
  kind: "affirm" | "deny" | "choose" | "name" | "new";
  /** choose: the numbers of the options picked, as listed (1 = the first). "Both" is every option. */
  ids: number[];
  /** name: the name offered ("face pull"). */
  name: string;
}

/** The reply to "Which one?": the chosen option ids, "cancel", or null when it does not pick any. */
export function choiceFrom(a: Answer, options: ChooseOption[]): { ids: number[] } | "cancel" | null {
  if (a.kind === "deny") return "cancel";
  if (a.kind !== "choose") return null;
  const picked = [...new Set(a.ids)].map((n) => options[n - 1]).filter((o): o is ChooseOption => !!o);
  return picked.length > 0 && picked.length === new Set(a.ids).size ? { ids: picked.map((o) => o.id) } : null;
}

/** The reply to "Is X really Y?": yes, new, cancel, another name to check, or null. */
export function confirmFrom(a: Answer): "yes" | "new" | "cancel" | { name: string } | null {
  if (a.kind === "affirm") return "yes";
  if (a.kind === "new") return "new";
  if (a.kind === "deny") return "cancel";
  if (a.kind === "name") return a.name.trim().length >= 3 ? { name: a.name.trim() } : null;
  return null;
}
