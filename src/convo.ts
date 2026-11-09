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

const norm = (t: string) =>
  t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

const CANCEL = new Set(["neither", "none", "cancel", "never mind", "nevermind", "forget it", "no", "nope", "no thanks", "skip it", "leave it", "none of them"]);
const ALL = new Set(["both", "all", "all of them", "both of them", "everything", "do both", "both please", "all please", "the both", "both of those", "all of those"]);
const ORDINALS: Record<string, number> = {
  "1": 1, "1st": 1, first: 1, one: 1,
  "2": 2, "2nd": 2, second: 2, two: 2,
  "3": 3, "3rd": 3, third: 3, three: 3,
  "4": 4, "4th": 4, fourth: 4, four: 4,
};
const FILLER = new Set(["the", "a", "an", "one", "number", "no", "option", "item", "please", "just", "only", "that", "this", "it", "do", "mark", "for"]);

/** The reply to "Which one?": the chosen option ids, "cancel", or null when the text does not answer it. */
export function answerChoice(text: string, options: ChooseOption[]): { ids: number[] } | "cancel" | null {
  const t = norm(text);
  if (!t || t.split(" ").length > 8) return null;
  if (CANCEL.has(t)) return "cancel";
  if (ALL.has(t) && options.length >= 2) return { ids: options.map((o) => o.id) };

  // "2", "second", "the first one", "option 1", "the last one"; a bare "one" / "two" counts too.
  const core = t.split(" ").filter((w) => !FILLER.has(w));
  const pick = core.length === 1 ? core[0] : t in ORDINALS ? t : undefined;
  if (pick === "last") return { ids: [options[options.length - 1].id] };
  if (pick !== undefined && pick in ORDINALS) {
    const o = options[ORDINALS[pick] - 1];
    return o ? { ids: [o.id] } : null;
  }

  // A distinctive word from one title: "scalability", "high scalability".
  const typed = t.split(" ").filter((w) => w.length >= 3 && !FILLER.has(w));
  if (typed.length === 0) return null;
  const hits = options.filter((o) => {
    const title = norm(o.title);
    return typed.every((w) => title.includes(w));
  });
  return hits.length === 1 ? { ids: [hits[0].id] } : null;
}

const YES = new Set(["yes", "y", "yep", "yeah", "ya", "yup", "yes please", "correct", "right", "thats right", "thats it", "that one", "that is right", "ok", "okay", "sure", "yes that one", "yes thats it"]);
const NEW = new Set(["new", "its new", "it is new", "new one", "add new", "as said", "keep it", "keep it as is", "no its new", "no new", "no keep it", "create it", "a new one"]);

/** The reply to "Is X really Y?": yes, new, cancel, a different name to check, or null. */
export function answerConfirm(text: string): "yes" | "new" | "cancel" | { name: string } | null {
  const t = norm(text);
  if (!t) return null;
  if (YES.has(t)) return "yes";
  if (NEW.has(t)) return "new";
  if (CANCEL.has(t)) return "cancel";
  if (t.split(" ").length > 6 || text.trim().endsWith("?")) return null;
  const name = t.replace(/^(?:no |not that |its |it is |i meant |the |say |use )+/, "").trim();
  return name.length >= 3 ? { name } : null;
}
