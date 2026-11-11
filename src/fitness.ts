// The fitness lane, database side. One session per date, built from chunks: every message that logs
// sets is one log_workout op (ops.ts), so /undo removes exactly that chunk.
//
//   model reads "bench 20x15, 22.5x12"  -->  log_workout op  --applyOp-->  session / exercise / sets
//   life/gym-tracking.md    --importGymLog------>  closed sessions (source 'import'), once
//
// Derived, never stored: weekly lifts and mobility, protein average, best sets.

import type { Db } from "./db/db.ts";
import { ensureCatalog, findExercise, loadCatalog, matchExercise, normalizeName, suggestExercise } from "./exercises.ts";
import type { ExerciseRow } from "./exercises.ts";
import { formatSet, parseExerciseLines } from "./sets.ts";
import type { ExerciseKind, SetEntry } from "./sets.ts";
import type { Op } from "./ops.ts";
import { addDays, dateLabel, dayKey, weekStart, weekdayIndex } from "./time.ts";

export type LogWorkoutOp = Extract<Op, { type: "log_workout" }>;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------- reading

export interface SessionRow {
  id: number;
  date: string;
  title: string | null;
  kind: "lift" | "mobility";
  status: "open" | "closed";
  source: string;
  pain_notes: string | null;
  notes: string | null;
}

export interface SetRow {
  set_no: number;
  weight_kg: number | null;
  reps: number | null;
  duration_s: number | null;
  rest_s: number | null;
  kind: SetEntry["kind"];
  bw: number;
  incomplete: number;
}

export interface SessionExercise {
  id: number;
  name: string;
  status: string;
  exerciseId: number | null;
  sets: SetRow[];
}

export interface Session extends SessionRow {
  exercises: SessionExercise[];
}

const asEntry = (s: SetRow) => ({ ...s, bw: s.bw === 1, incomplete: s.incomplete === 1 });

export function loadSession(db: Db, date: string): Session | null {
  const row = db.all<SessionRow>(
    "SELECT id, date, title, kind, status, source, pain_notes, notes FROM workout_session WHERE date = ?", date,
  )[0];
  if (!row) return null;
  const exercises = db
    .all<{ id: number; display_name: string; status: string; exercise_id: number | null }>(
      "SELECT id, display_name, status, exercise_id FROM session_exercise WHERE session_id = ? ORDER BY ordinal, id", row.id,
    )
    .map((e) => ({
      id: e.id,
      name: e.display_name,
      status: e.status,
      exerciseId: e.exercise_id,
      sets: db.all<SetRow>(
        "SELECT set_no, weight_kg, reps, duration_s, rest_s, kind, bw, incomplete FROM session_set WHERE session_exercise_id = ? ORDER BY set_no, id", e.id,
      ),
    }));
  return { ...row, exercises };
}

export function setsText(sets: SetRow[], ascii = false): string {
  return sets.map((s) => formatSet(asEntry(s), ascii)).join(", ");
}

function exerciseLine(e: SessionExercise, ascii = false): string {
  if (e.status === "skipped") return `${e.name}: skipped`;
  return e.sets.length ? `${e.name}: ${setsText(e.sets, ascii)}` : `${e.name}: (no sets)`;
}

function totals(s: Session): { exercises: number; sets: number } {
  const done = s.exercises.filter((e) => e.status !== "skipped");
  return { exercises: done.length, sets: done.reduce((n, e) => n + e.sets.length, 0) };
}

/** The Telegram view of a day's session. */
export function renderSession(db: Db, date: string): string {
  const s = loadSession(db, date);
  if (!s) return `No workout logged for ${dateLabel(date)}.`;
  const t = totals(s);
  const lines = [
    `🏋️ <b>${esc(s.title ?? "Workout")}</b> — ${dateLabel(date)}`,
    ...s.exercises.map((e) => `• ${esc(exerciseLine(e))}`),
    `<i>${t.exercises} exercise${t.exercises === 1 ? "" : "s"} · ${t.sets} set${t.sets === 1 ? "" : "s"}${s.pain_notes ? ` · pain: ${esc(s.pain_notes)}` : ""}</i>`,
  ];
  return lines.join("\n");
}

/** Compact, for the model's snapshot: "Lat Pulldown: 25x15, 25x15 | Seated Row: 25x12". */
export function sessionNotation(db: Db, date: string): string {
  const s = loadSession(db, date);
  return s ? s.exercises.map((e) => exerciseLine(e, true)).join(" | ") : "";
}

/** Markdown lines for the daily note (mirror). Empty when nothing was logged. */
export function sessionMarkdown(db: Db, date: string): string[] {
  const s = loadSession(db, date);
  if (!s || s.exercises.length === 0) return [];
  const t = totals(s);
  return [
    "",
    `**Workout — ${s.title ?? "Workout"}** · ${t.exercises} exercises · ${t.sets} sets`,
    ...s.exercises.map((e) => `- ${exerciseLine(e)}`),
    ...(s.pain_notes ? [`- _pain: ${s.pain_notes}_`] : []),
  ];
}

// ------------------------------------------------------------- split detection

/** Which rotation split a set of muscle groups looks like ("chest", "triceps" -> Chest / Triceps). */
export function detectSplit(db: Db, groups: (string | null)[]): { ordinal: number; label: string } | null {
  const rot = db.all<{ ordinal: number; label: string }>("SELECT ordinal, label FROM rotation WHERE lane = 'fitness' ORDER BY ordinal");
  let best: { ordinal: number; label: string } | null = null;
  let bestScore = 0;
  let tie = false;
  for (const r of rot) {
    const label = r.label.toLowerCase();
    const score = groups.filter((g) => g && label.includes(g)).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return best && !tie ? best : null;
}

// ------------------------------------------------------------------- weekly

export interface WeekFitness {
  lifts: number;
  mobility: number;
  proteinAvg: number | null;
  proteinDays: number;
  target: (metric: string) => { floor: number | null; goal: number | null };
}

export function weekFitness(db: Db, date: string): WeekFitness {
  const from = weekStart(date);
  const kinds = db.all<{ kind: string; c: number }>(
    "SELECT kind, COUNT(*) AS c FROM workout_session WHERE date >= ? AND date <= ? GROUP BY kind", from, date,
  );
  const c = (k: string) => kinds.find((x) => x.kind === k)?.c ?? 0;
  const p = db.all<{ avg: number | null; n: number }>(
    "SELECT AVG(value) AS avg, COUNT(*) AS n FROM metric_log WHERE metric = 'protein_g' AND date >= ? AND date <= ?", from, date,
  )[0];
  return {
    // A lift counts when it is logged or ticked off in the plan ("done with gym" without sets).
    lifts: Math.max(
      c("lift"),
      db.all<{ c: number }>(
        "SELECT COUNT(DISTINCT date) AS c FROM plan_item WHERE lane = 'fitness' AND ref LIKE 'rotation:%' AND status = 'done' AND date >= ? AND date <= ?", from, date,
      )[0].c,
    ),
    mobility: c("mobility"),
    proteinAvg: p.n > 0 ? p.avg : null,
    proteinDays: p.n,
    target: (metric) =>
      db.all<{ floor: number | null; goal: number | null }>(
        "SELECT floor, goal FROM target WHERE lane = 'fitness' AND metric = ? AND period = 'week'", metric,
      )[0] ?? { floor: null, goal: null },
  };
}

/** Fitness parts of the evening "this week" line: only what is below its floor. */
export function weeklyFitnessParts(db: Db, date: string): string[] {
  const w = weekFitness(db, date);
  const parts: string[] = [];
  const lift = w.target("lift_sessions");
  if (w.lifts < (lift.floor ?? 2)) parts.push(`lifts ${w.lifts}/${lift.floor ?? 2}`);
  const mob = w.target("mobility_sessions");
  if (weekdayIndex(date) >= 3 && w.mobility < (mob.floor ?? 1)) parts.push(`mobility ${w.mobility}/${mob.floor ?? 1}`);
  const pro = w.target("protein_g_avg");
  if (w.proteinAvg !== null && w.proteinDays >= 2 && w.proteinAvg < (pro.floor ?? 90)) {
    parts.push(`protein ${Math.round(w.proteinAvg)} g a day (aim ${pro.floor ?? 90}+)`);
  }
  return parts;
}

export function proteinFor(db: Db, date: string): number | null {
  return db.all<{ value: number }>("SELECT value FROM metric_log WHERE metric = 'protein_g' AND date = ?", date)[0]?.value ?? null;
}

/** /gym: the week against targets, then today's (or the latest) session. */
export function renderGymWeek(db: Db, today: string): string {
  const w = weekFitness(db, today);
  const lift = w.target("lift_sessions");
  const mob = w.target("mobility_sessions");
  const pro = w.target("protein_g_avg");
  const lines = [
    `🏋️ <b>This week</b> (from ${dateLabel(weekStart(today))})`,
    `• Lifts: <b>${w.lifts}</b> (aim ${lift.goal ?? 3}, at least ${lift.floor ?? 2})`,
    `• Mobility: <b>${w.mobility}</b> (aim ${mob.goal ?? 2}, at least ${mob.floor ?? 1})`,
    `• Protein: ${w.proteinAvg === null ? "nothing logged" : `<b>${Math.round(w.proteinAvg)} g</b> a day over ${w.proteinDays} day${w.proteinDays === 1 ? "" : "s"}`} (aim ${pro.goal ?? 120}, at least ${pro.floor ?? 90})`,
  ];
  const last = db.all<{ date: string }>("SELECT date FROM workout_session WHERE date <= ? ORDER BY date DESC LIMIT 1", today)[0];
  if (last) lines.push("", renderSession(db, last.date));
  return lines.join("\n");
}

/** /lift <name>: the last few times and the best set (heaviest, then most reps). */
export function renderLiftHistory(db: Db, name: string, limit = 6): string {
  const ex = findExercise(db, name);
  if (!ex) return `I don't know an exercise called "${esc(name)}" yet. Log it once and it's added.`;
  const rows = db.all<{ date: string; seid: number }>(
    `SELECT ws.date AS date, se.id AS seid FROM session_exercise se JOIN workout_session ws ON ws.id = se.session_id
      WHERE se.exercise_id = ? AND se.status <> 'skipped' ORDER BY ws.date DESC LIMIT ?`, ex.id, limit,
  );
  if (rows.length === 0) return `No ${esc(ex.canonical_name)} logged yet.`;
  const best = db.all<{ date: string; weight_kg: number; reps: number | null }>(
    `SELECT ws.date AS date, ss.weight_kg AS weight_kg, ss.reps AS reps FROM session_set ss
      JOIN session_exercise se ON se.id = ss.session_exercise_id JOIN workout_session ws ON ws.id = se.session_id
      WHERE se.exercise_id = ? AND ss.weight_kg IS NOT NULL ORDER BY ss.weight_kg DESC, COALESCE(ss.reps, 0) DESC, ws.date LIMIT 1`, ex.id,
  )[0];
  const lines = rows.map((r) => {
    const sets = db.all<SetRow>(
      "SELECT set_no, weight_kg, reps, duration_s, rest_s, kind, bw, incomplete FROM session_set WHERE session_exercise_id = ? ORDER BY set_no, id", r.seid,
    );
    return `• ${dateLabel(r.date)} — ${esc(sets.length ? setsText(sets) : "(no sets)")}`;
  });
  const bestLine = best ? `\n\nBest: <b>${formatSet({ weight_kg: best.weight_kg, reps: best.reps, duration_s: null, kind: "working", bw: false, incomplete: best.reps === null })}</b> (${dateLabel(best.date)})` : "";
  return `🏋️ <b>${esc(ex.canonical_name)}</b>\n${lines.join("\n")}${bestLine}`;
}

/** The same sets sent again within 15 minutes (a resent voice note, a double tap). Returns when the first one was logged. */
export function findRepeat(db: Db, op: LogWorkoutOp, nowMs: number): string | null {
  const since = new Date(nowMs - 15 * 60_000).toISOString();
  const prev = db.all<{ op_json: string; ts: string }>(
    `SELECT op_json, ts FROM revision WHERE undone_at IS NULL AND ts >= ? AND json_extract(op_json, '$.type') = 'log_workout'
      ORDER BY id DESC LIMIT 1`, since,
  )[0];
  if (!prev) return null;
  const p = JSON.parse(prev.op_json) as LogWorkoutOp;
  const shape = (o: LogWorkoutOp) => JSON.stringify([o.date, o.mode, o.exercises.map((e) => [e.name.toLowerCase(), e.sets])]);
  return shape(p) === shape(op) ? prev.ts : null;
}

// --------------------------------------------------- restating a log (Phase 16)

type SetLike = { weight_kg: number | null; reps: number | null; duration_s: number | null; bw: boolean | number; kind: string };
const setKey = (s: SetLike) => `${s.weight_kg ?? ""}|${s.reps ?? ""}|${s.duration_s ?? ""}|${s.bw ? 1 : 0}|${s.kind}`;

export interface Reconciled {
  /** What to apply; null when every exercise was already logged exactly as sent. */
  op: LogWorkoutOp | null;
  /** Exercises left out because their sets are in the session already. */
  unchanged: string[];
  /** Exercises where the earlier sets were repeated and new ones added: only the new ones are applied. */
  extended: { name: string; added: number }[];
  /** Exercises where the earlier sets were repeated with a change: their sets are replaced. */
  restated: string[];
}

/**
 * Compares a message with what the day's session already holds, per exercise, so sending a log again
 * (or the whole log with one set changed) changes only what differs instead of adding everything twice.
 *   same sets                       -> left out
 *   earlier sets, then more         -> only the extra sets
 *   mostly the earlier sets, edited -> replaces that exercise's sets
 *   anything else                   -> appended, as before
 * A model-set "replace" is respected as given.
 */
export function reconcileWorkout(db: Db, op: LogWorkoutOp): Reconciled {
  const session = loadSession(db, op.date);
  const out: LogWorkoutOp["exercises"] = [];
  const unchanged: string[] = [];
  const extended: { name: string; added: number }[] = [];
  const restated: string[] = [];
  let firstUnchanged: LogWorkoutOp["exercises"][number] | undefined;

  for (const ex of op.exercises) {
    const entry = findExercise(db, ex.name);
    const have = session && entry ? session.exercises.find((e) => e.exerciseId === entry.id) : undefined;
    if (!have || have.sets.length === 0 || (ex.mode ?? op.mode) === "replace") {
      out.push(ex);
      continue;
    }
    const before = have.sets.map(setKey);
    const after = ex.sets.map(setKey);
    const n = before.length;
    const m = after.length;
    if (m === n && after.every((k, i) => k === before[i])) {
      unchanged.push(have.name);
      firstUnchanged ??= ex;
      continue;
    }
    if (m > n && before.every((k, i) => k === after[i])) {
      out.push({ ...ex, sets: ex.sets.slice(n), mode: "append" });
      extended.push({ name: have.name, added: m - n });
      continue;
    }
    if (m >= n) {
      const pool = [...before];
      let overlap = 0;
      for (const k of after) {
        const i = pool.indexOf(k);
        if (i >= 0) {
          pool.splice(i, 1);
          overlap++;
        }
      }
      if (overlap >= Math.ceil(n / 2)) {
        out.push({ ...ex, mode: "replace" });
        restated.push(have.name);
        continue;
      }
    }
    out.push(ex);
  }

  // Nothing new to add, but the message carried a note or a pain: rewrite one exercise with its own sets so they are kept.
  if (out.length === 0 && firstUnchanged && (op.notes || op.pain)) out.push({ ...firstUnchanged, mode: "replace" });
  return { op: out.length > 0 ? { ...op, exercises: out } : null, unchanged, extended, restated };
}

/**
 * The exercise in a day's session that a name refers to: by catalog entry, by the name as logged, or by a near-miss
 * ("face full" for "Face Pull"). null when the day has no such exercise.
 */
export function findSessionExercise(db: Db, date: string, name: string): SessionExercise | null {
  const session = loadSession(db, date);
  if (!session) return null;
  const entry = findExercise(db, name);
  if (entry) {
    const hit = session.exercises.find((e) => e.exerciseId === entry.id);
    if (hit) return hit;
  }
  const want = normalizeName(name);
  const exact = session.exercises.find((e) => normalizeName(e.name) === want);
  if (exact) return exact;
  const ids = new Set(session.exercises.map((e) => e.exerciseId));
  const near = suggestExercise(loadCatalog(db).filter((r) => ids.has(r.id)), name);
  return near ? (session.exercises.find((e) => e.exerciseId === near.id) ?? null) : null;
}

/** Names in a log that match nothing in the catalog but look like a misspelling of an entry: "face full" -> Face Pull. */
export function unsureNames(db: Db, op: LogWorkoutOp): { typed: string; suggestion: string }[] {
  const rows = loadCatalog(db);
  const out: { typed: string; suggestion: string }[] = [];
  for (const ex of op.exercises) {
    if (matchExercise(rows, ex.name)) continue;
    const near = suggestExercise(rows, ex.name);
    if (near && !out.some((o) => o.typed.toLowerCase() === ex.name.toLowerCase())) out.push({ typed: ex.name, suggestion: near.canonical_name });
  }
  return out;
}

/**
 * The log with the named exercises swapped for the ones the user confirmed. `learn` carries the spelling that was
 * typed, so it is saved as an alias in the same step. Names not in the mapping are left as they were.
 */
export function renameInOp(op: LogWorkoutOp, mapping: Record<string, string>): LogWorkoutOp {
  const by = new Map(Object.entries(mapping).map(([typed, to]) => [typed.toLowerCase(), to]));
  return {
    ...op,
    exercises: op.exercises.map((ex) => {
      const to = by.get(ex.name.toLowerCase());
      return to ? { ...ex, name: to, learn: ex.name } : ex;
    }),
  };
}

/** What changed between two views of a day's session, one line each. changed is false when sets were only added. */
export function diffSessions(before: Session | null, after: Session | null): { lines: string[]; changed: boolean } {
  const lines: string[] = [];
  let changed = false;
  const text = (s: SetRow) => formatSet(asEntry(s));
  const keyOf = (e: SessionExercise) => (e.exerciseId !== null ? `id:${e.exerciseId}` : `name:${e.name.toLowerCase()}`);
  const was = new Map((before?.exercises ?? []).map((e) => [keyOf(e), e]));
  const now = new Map((after?.exercises ?? []).map((e) => [keyOf(e), e]));

  for (const [key, e] of now) {
    const old = was.get(key);
    if (!old) {
      lines.push(`+ ${esc(e.name)}: ${esc(setsText(e.sets))}`);
      continue;
    }
    for (let i = 0; i < Math.max(old.sets.length, e.sets.length); i++) {
      const a = old.sets[i];
      const b = e.sets[i];
      if (a && b && text(a) !== text(b)) {
        lines.push(`${esc(e.name)}: set ${i + 1} ${esc(text(a))} → ${esc(text(b))}`);
        changed = true;
      } else if (!a && b) {
        lines.push(`${esc(e.name)}: + set ${i + 1} ${esc(text(b))}`);
      } else if (a && !b) {
        lines.push(`${esc(e.name)}: − set ${i + 1} (${esc(text(a))})`);
        changed = true;
      }
    }
  }
  for (const [key, e] of was) {
    if (!now.has(key)) {
      lines.push(`− ${esc(e.name)} removed`);
      changed = true;
    }
  }
  return { lines, changed };
}

/** Sessions still open on or before a date are closed (23:00 job). A later chunk reopens the same day. */
export function closeOpenSessions(db: Db, upTo: string, nowMs: number): number {
  const n = db.all<{ c: number }>("SELECT COUNT(*) AS c FROM workout_session WHERE status = 'open' AND date <= ?", upTo)[0].c;
  if (n > 0) db.run("UPDATE workout_session SET status = 'closed', closed_at = ? WHERE status = 'open' AND date <= ?", new Date(nowMs).toISOString(), upTo);
  return n;
}

// -------------------------------------------------------------- import + v1

interface SessionWrite {
  date: string;
  title: string | null;
  source: string;
  exercises: { name: string; sets: SetEntry[]; skipped: boolean }[];
}

/** Writes a whole session directly (seed and migration only; chat goes through ops). */
function writeSession(db: Db, s: SessionWrite, nowMs: number): { sets: number; added: string[] } {
  const rows = loadCatalog(db);
  const added: string[] = [];
  db.run(
    "INSERT INTO workout_session (date, title, kind, status, source, version, created_at, closed_at) VALUES (?, ?, 'lift', 'closed', ?, 1, ?, ?)",
    s.date, s.title, s.source, new Date(nowMs).toISOString(), new Date(nowMs).toISOString(),
  );
  const sessionId = db.all<{ id: number }>("SELECT id FROM workout_session WHERE date = ?", s.date)[0].id;
  let sets = 0;
  s.exercises.forEach((e, i) => {
    let ex = matchExercise(rows, e.name);
    if (!ex) {
      const kind: ExerciseKind = /mobility/i.test(s.title ?? "") ? "mobility" : "weighted";
      db.run("INSERT INTO exercise_catalog (canonical_name, kind, aliases_json, source) VALUES (?, ?, '[]', ?)", e.name, kind, s.source);
      ex = db.all<ExerciseRow>("SELECT id, canonical_name, muscle_group, kind, aliases_json FROM exercise_catalog WHERE canonical_name = ?", e.name)[0];
      rows.push(ex);
      added.push(e.name);
    }
    const status = e.skipped ? "skipped" : e.sets.length === 0 ? "partial" : "done";
    db.run(
      "INSERT INTO session_exercise (session_id, ordinal, exercise_id, display_name, status) VALUES (?, ?, ?, ?, ?)",
      sessionId, i + 1, ex.id, ex.canonical_name, status,
    );
    const seId = db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
    e.sets.forEach((st, k) => {
      db.run(
        "INSERT INTO session_set (session_exercise_id, set_no, reps, weight_kg, duration_s, rest_s, bw, kind, incomplete, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        seId, k + 1, st.reps, st.weight_kg, st.duration_s, st.rest_s, st.bw ? 1 : 0, st.kind, st.incomplete ? 1 : 0, st.notes,
      );
      sets++;
    });
  });
  refreshSessionShape(db, sessionId);
  return { sets, added };
}

/** kind (lift / mobility) and title (the rotation split it looks like) from what was logged. */
export function sessionShape(db: Db, sessionId: number, fallbackTitle: string | null): { kind: "lift" | "mobility"; title: string; split: { ordinal: number; label: string } | null } {
  const groups = db.all<{ kind: string; muscle_group: string | null }>(
    `SELECT c.kind AS kind, c.muscle_group AS muscle_group FROM session_exercise se JOIN exercise_catalog c ON c.id = se.exercise_id
      WHERE se.session_id = ? AND se.status <> 'skipped'`, sessionId,
  );
  const kind = groups.length > 0 && groups.every((g) => g.kind === "mobility") ? "mobility" : "lift";
  const split = kind === "lift" ? detectSplit(db, groups.map((g) => g.muscle_group)) : null;
  return { kind, title: kind === "mobility" ? "Mobility" : split?.label ?? fallbackTitle ?? "Workout", split };
}

function refreshSessionShape(db: Db, sessionId: number): void {
  const cur = db.all<{ title: string | null }>("SELECT title FROM workout_session WHERE id = ?", sessionId)[0];
  const shape = sessionShape(db, sessionId, cur?.title ?? null);
  // Imported titles ("Biceps", "Legs / Shoulders") are what you wrote: keep them; only fill the kind.
  db.run("UPDATE workout_session SET kind = ?, title = COALESCE(title, ?) WHERE id = ?", shape.kind, shape.title, sessionId);
}

export interface ImportReport {
  sessions: number;
  exercises: number;
  sets: number;
  replaced: number;
  skippedDates: string[];
  newExercises: string[];
  incomplete: string[];
  unreadLines: string[];
}

const HEADER_RE = /^##\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:[—–-]+\s*(.*))?$/;

/**
 * One-time import of life/gym-tracking.md: "## DD/MM — Title", an exercise name, then "- 20 × 15" lines.
 * Re-running replaces what an earlier import wrote and never touches a session logged in chat.
 * Sets with the reps missing ("20 ×") are kept, flagged, and listed in the inbox once.
 */
export function importGymLog(db: Db, markdown: string, nowMs: number): ImportReport {
  ensureCatalog(db);
  const today = dayKey(nowMs);
  const thisYear = Number(today.slice(0, 4));
  const report: ImportReport = { sessions: 0, exercises: 0, sets: 0, replaced: 0, skippedDates: [], newExercises: [], incomplete: [], unreadLines: [] };

  const blocks: { date: string; title: string | null; lines: string[] }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const h = HEADER_RE.exec(line.trim());
    if (h) {
      const d = Number(h[1]);
      const m = Number(h[2]);
      let y = h[3] ? Number(h[3].length === 2 ? `20${h[3]}` : h[3]) : thisYear;
      const pad = (n: number) => String(n).padStart(2, "0");
      let date = `${y}-${pad(m)}-${pad(d)}`;
      if (!h[3] && date > today) date = `${(y = thisYear - 1)}-${pad(m)}-${pad(d)}`;
      blocks.push({ date, title: h[4]?.trim() || null, lines: [] });
    } else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
  }

  db.transaction(() => {
    for (const b of blocks) {
      const existing = db.all<{ id: number; source: string }>("SELECT id, source FROM workout_session WHERE date = ?", b.date)[0];
      if (existing && existing.source !== "import") {
        report.skippedDates.push(b.date);
        continue;
      }
      if (existing) {
        deleteSession(db, existing.id);
        report.replaced++;
      }
      const rows = loadCatalog(db);
      const mobilityDay = /mobility/i.test(b.title ?? "");
      const { exercises, bad } = parseExerciseLines(b.lines, (name) => matchExercise(rows, name)?.kind ?? (mobilityDay ? "mobility" : "weighted"));
      report.unreadLines.push(...bad.map((l) => `${b.date}: ${l}`));
      const res = writeSession(db, { date: b.date, title: b.title, source: "import", exercises }, nowMs);
      report.sessions++;
      report.exercises += exercises.length;
      report.sets += res.sets;
      report.newExercises.push(...res.added);
      for (const e of exercises) {
        if (e.sets.some((s) => s.incomplete)) {
          const msg = `Gym import ${b.date}: ${e.name} has sets with the reps missing (${e.sets.map((s) => formatSet(s, true)).join(", ")})`;
          report.incomplete.push(msg);
          if (db.all("SELECT 1 FROM inbox WHERE raw = ?", msg).length === 0) {
            db.run("INSERT INTO inbox (raw, ts) VALUES (?, ?)", msg, new Date(nowMs).toISOString());
          }
        }
      }
    }
  });
  return report;
}

function deleteSession(db: Db, sessionId: number): void {
  db.run("DELETE FROM session_set WHERE session_exercise_id IN (SELECT id FROM session_exercise WHERE session_id = ?)", sessionId);
  db.run("DELETE FROM session_exercise WHERE session_id = ?", sessionId);
  db.run("DELETE FROM workout_session WHERE id = ?", sessionId);
}

/** Migration v6: catalog, then each v1 workout_logs row as a closed session (sets x reps copies of the same set). */
export function migrateV1Workouts(db: Db, nowMs = Date.now()): number {
  ensureCatalog(db);
  const hasV1 = db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workout_logs'").length > 0;
  if (!hasV1) return 0;
  const logs = db.all<{ date: string; workout_type: string; exercises_json: string; notes: string | null }>(
    "SELECT date, workout_type, exercises_json, notes FROM workout_logs ORDER BY id",
  );
  const byDate = new Map<string, SessionWrite>();
  for (const l of logs) {
    let list: { name?: unknown; sets?: unknown; reps?: unknown; weight_kg?: unknown }[] = [];
    try {
      list = JSON.parse(l.exercises_json);
    } catch {}
    const s = byDate.get(l.date) ?? { date: l.date, title: l.workout_type || null, source: "v1", exercises: [] };
    for (const e of Array.isArray(list) ? list : []) {
      if (typeof e?.name !== "string" || !e.name.trim()) continue;
      const n = typeof e.sets === "number" && e.sets >= 1 ? Math.min(Math.round(e.sets), 20) : 1;
      const reps = typeof e.reps === "number" && e.reps > 0 ? Math.round(e.reps) : null;
      const w = typeof e.weight_kg === "number" && e.weight_kg > 0 ? e.weight_kg : null;
      const set: SetEntry = { weight_kg: w, reps, duration_s: null, rest_s: null, kind: "working", bw: false, notes: null, incomplete: false };
      s.exercises.push({ name: e.name.trim(), sets: reps === null && w === null ? [] : Array.from({ length: n }, () => ({ ...set })), skipped: false });
    }
    byDate.set(l.date, s);
  }
  let moved = 0;
  for (const s of byDate.values()) {
    if (db.all("SELECT 1 FROM workout_session WHERE date = ?", s.date).length > 0) continue;
    writeSession(db, s, nowMs);
    moved++;
  }
  return moved;
}
