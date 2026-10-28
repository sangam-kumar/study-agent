// Minimal database surface used by ops/migrations. Production: Durable Object SQLite.
// Tests: node:sqlite. Keeping it this small is what makes the op layer testable.

export type SqlValue = string | number | null;

export interface Db {
  /** Run one or more statements with no parameters (DDL). */
  exec(sql: string): void;
  /** Run a parameterised statement that returns no rows. */
  run(sql: string, ...params: SqlValue[]): void;
  /** Run a parameterised query and return all rows. */
  all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[];
  /** Run fn atomically. Throwing rolls everything back. Not re-entrant. */
  transaction<T>(fn: () => T): T;
}

export function lastInsertId(db: Db): number {
  return db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
}

/** Adapter over a Durable Object's embedded SQLite. */
export function doDb(ctx: DurableObjectState): Db {
  const sql = ctx.storage.sql;
  return {
    exec(statements) {
      sql.exec(statements);
    },
    run(statement, ...params) {
      sql.exec(statement, ...params);
    },
    all<T>(statement: string, ...params: SqlValue[]): T[] {
      return sql.exec(statement, ...params).toArray() as T[];
    },
    transaction(fn) {
      return ctx.storage.transactionSync(fn);
    },
  };
}
