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
