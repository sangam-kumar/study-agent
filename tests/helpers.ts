import { DatabaseSync } from "node:sqlite";
import type { Db, SqlValue } from "../src/db/db.ts";
import { runMigrations } from "../src/db/migrations.ts";

/** In-memory SQLite behind the same Db interface the Durable Object adapter implements. */
export function memoryDb(): Db {
  const d = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...params: SqlValue[]) => {
      d.prepare(sql).run(...params);
    },
    all: <T>(sql: string, ...params: SqlValue[]) => d.prepare(sql).all(...params) as T[],
    transaction: <T>(fn: () => T): T => {
      if (depth > 0) throw new Error("nested transaction");
      depth++;
      d.exec("BEGIN");
      try {
        const out = fn();
        d.exec("COMMIT");
        return out;
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

export function migratedDb(): Db {
  const db = memoryDb();
  runMigrations(db);
  return db;
}

export const fixedNow = (iso = "2026-10-26T12:00:00.000Z") => () => new Date(iso);

export function count(db: Db, table: string, where = "1=1"): number {
  return db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`)[0].c;
}

// ---- test fixture: typed set notation -> log_workout op (the model does this in production)
import { loadCatalog, matchExercise } from "../src/exercises.ts";
import { parseExerciseLines } from "../src/sets.ts";
import type { ExerciseKind, SetEntry } from "../src/sets.ts";
import type { LogWorkoutOp } from "../src/fitness.ts";
import { addDays, dayKey } from "../src/time.ts";

const setInput = (s: SetEntry) => ({
  weight_kg: s.weight_kg, reps: s.reps, duration_s: s.duration_s, rest_s: s.rest_s, kind: s.kind, bw: s.bw,
  notes: s.notes, incomplete: s.incomplete,
});

/** "bench 20x15, 22.5x12" or a name line plus set lines, "yesterday" first line allowed. Null unless all of it reads as sets. */
export function parseChatWorkout(db: Db, text: string, nowMs: number): LogWorkoutOp | null {
  const today = dayKey(nowMs);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let date = today;
  if (lines.length > 1 && /^yesterday:?$/i.test(lines[0])) {
    date = addDays(today, -1);
    lines.shift();
  }
  const rows = loadCatalog(db);
  const kindOf = (name: string): ExerciseKind => matchExercise(rows, name)?.kind ?? "weighted";
  const { exercises, bad } = parseExerciseLines(lines, kindOf);
  if (bad.length > 0 || exercises.length === 0 || exercises.length > 20) return null;
  for (const e of exercises) {
    if (e.sets.length === 0 || e.skipped) return null;
    if (!matchExercise(rows, e.name) && !e.sets.some((s) => s.reps !== null && (s.weight_kg !== null || s.bw))) return null;
  }
  return { type: "log_workout", date, mode: "append", exercises: exercises.map((e) => ({ name: e.name, sets: e.sets.map(setInput) })) };
}
