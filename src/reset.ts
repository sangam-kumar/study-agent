// Clearing test data without touching the schema, the seeded plan content, or the daily cue schedules.
//
// Scopes are explicit and composable so nothing real is deleted by accident:
//
//   logs       interaction_logs, processed_update
//   workouts   workout_logs                         (v1 table)
//   reminders  reminders                            (+ the matching delayed alarms: see agent.resetData)
//   reading    reading_queue                        (v1 table)
//   snooze     bot_state snooze keys
//   plan       revision, event, inbox, plan_item, day_plan, override, note
//   pointers   every pointer back to unit 1         (units themselves are kept)
//
// NOT touched by any scope: tables/migrations, track/unit_list/unit content, config, lane, target,
// pattern, rotation, other bot_state keys.

import type { Db } from "./db/db.ts";

export const RESET_SCOPES = ["logs", "workouts", "reminders", "reading", "snooze", "plan", "pointers"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

export class ResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetError";
  }
}

/** Child tables first so foreign keys never block a delete. */
const TABLES: Record<Exclude<ResetScope, "snooze" | "pointers">, string[]> = {
  logs: ["interaction_logs", "processed_update"],
  workouts: ["workout_logs"],
  reminders: ["reminders"],
  reading: ["reading_queue"],
  plan: ["revision", "event", "inbox", "plan_item", "day_plan", "override", "note"],
};

const SNOOZE_WHERE = "key IN ('snooze_until', 'snooze_reason')";

export function parseScopes(input: string | string[]): ResetScope[] {
  const raw = (Array.isArray(input) ? input : input.split(",")).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) throw new ResetError(`scope is required: ${RESET_SCOPES.join(", ")} or all`);
  const out = new Set<ResetScope>();
  for (const s of raw) {
    if (s === "all") RESET_SCOPES.forEach((x) => out.add(x));
    else if ((RESET_SCOPES as readonly string[]).includes(s)) out.add(s as ResetScope);
    else throw new ResetError(`unknown scope "${s}" (valid: ${RESET_SCOPES.join(", ")}, all)`);
  }
  return RESET_SCOPES.filter((s) => out.has(s)); // stable order
}

function countRows(db: Db, scope: ResetScope): number {
  const c = (sql: string) => db.all<{ c: number }>(sql)[0].c;
  if (scope === "snooze") return c(`SELECT COUNT(*) AS c FROM bot_state WHERE ${SNOOZE_WHERE}`);
  if (scope === "pointers") return c("SELECT COUNT(*) AS c FROM pointer WHERE ordinal <> 1");
  return TABLES[scope].reduce((n, t) => n + c(`SELECT COUNT(*) AS c FROM ${t}`), 0);
}

/**
 * Returns rows affected per scope. dryRun counts without deleting. For `pointers` the count is
 * the number of pointers that are not already at unit 1.
 */
export function resetData(db: Db, scopes: ResetScope[], dryRun: boolean): Record<string, number> {
  const result: Record<string, number> = {};
  const apply = () => {
    for (const scope of scopes) {
      result[scope] = countRows(db, scope);
      if (dryRun) continue;
      if (scope === "snooze") db.run(`DELETE FROM bot_state WHERE ${SNOOZE_WHERE}`);
      else if (scope === "pointers") db.run("UPDATE pointer SET ordinal = 1 WHERE ordinal <> 1");
      else for (const t of TABLES[scope]) db.run(`DELETE FROM ${t}`);
    }
  };
  if (dryRun) apply();
  else db.transaction(apply);
  return result;
}
