// Loads reviewed seed JSON (produced by study-repo/scripts/seed_*.py) into the agent's tables.
//
// Rules:
//   * Idempotent. Re-loading the same file changes nothing.
//   * A reload NEVER moves a pointer. Pointers are created at ordinal 1 once and then only
//     advance through ops (advance_pointer).
//   * Nothing is deleted. Units that disappeared from the file are reported as orphans, because
//     plan items may already reference them.
//   * Bulk loads are not undoable: one 'seed' event with the counts, no revision.
//   * The LLM is not in this path.

import type { Db } from "./db/db.ts";

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

const MAX_UNITS_PER_LIST = 5000;
const SIZES = ["fragment", "block"] as const;
type Size = (typeof SIZES)[number];

export interface SeedUnit {
  ordinal: number;
  title: string;
  group: string | null;
  size: Size;
  est_min: number | null;
  tier: string | null;
  ref: string | null;
  needs_split: boolean;
  prior_solution: unknown;
}
export interface SeedList {
  id: string;
  title: string;
  units: SeedUnit[];
}
export interface SeedTrack {
  id: string;
  title: string;
  lane: string;
  alternate: string[];
  lists: SeedList[];
}
export interface StudySeed {
  tracks: SeedTrack[];
}

export interface SeedReport {
  tracks: number;
  lists: number;
  units: { inserted: number; updated: number; unchanged: number };
  pointersCreated: number;
  orphanUnits: number;
}

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new SeedError(`${path}: ${msg}`);
}
function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "expected an object");
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected an array");
  return v;
}
function text(v: unknown, path: string, max = 500): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "expected a non-empty string");
  if (v.length > max) fail(path, `longer than ${max} characters`);
  return v;
}
function optText(v: unknown, path: string, max = 1000): string | null {
  return v === undefined || v === null ? null : text(v, path, max);
}

export function parseStudySeed(input: unknown): StudySeed {
  const root = obj(input, "seed");
  const tracks = arr(root.tracks, "tracks").map((t, i): SeedTrack => {
    const tp = `tracks[${i}]`;
    const o = obj(t, tp);
    const lists = arr(o.lists, `${tp}.lists`).map((l, j): SeedList => {
      const lp = `${tp}.lists[${j}]`;
      const lo = obj(l, lp);
      const units = arr(lo.units, `${lp}.units`);
      if (units.length > MAX_UNITS_PER_LIST) fail(`${lp}.units`, `more than ${MAX_UNITS_PER_LIST} units`);
      const seen = new Set<number>();
      return {
        id: text(lo.id, `${lp}.id`, 100),
        title: text(lo.title, `${lp}.title`, 200),
        units: units.map((u, k): SeedUnit => {
          const up = `${lp}.units[${k}]`;
          const uo = obj(u, up);
          const ordinal = uo.ordinal;
          if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1) fail(`${up}.ordinal`, "expected an integer >= 1");
          if (seen.has(ordinal)) fail(`${up}.ordinal`, `duplicate ordinal ${ordinal}`);
          seen.add(ordinal);
          const size = uo.size === undefined ? "fragment" : uo.size;
          if (!(SIZES as readonly unknown[]).includes(size)) fail(`${up}.size`, `expected one of ${SIZES.join(", ")}`);
          const est = uo.est_min;
          if (est !== undefined && est !== null && (typeof est !== "number" || !Number.isInteger(est) || est < 1)) fail(`${up}.est_min`, "expected a positive integer or null");
          return {
            ordinal,
            title: text(uo.title, `${up}.title`, 300),
            group: optText(uo.group, `${up}.group`, 300),
            size: size as Size,
            est_min: (est as number | null | undefined) ?? null,
            tier: optText(uo.tier, `${up}.tier`, 20),
            ref: optText(uo.ref, `${up}.ref`, 1000),
            needs_split: uo.needs_split === true,
            prior_solution: uo.prior_solution ?? null,
          };
        }),
      };
    });
    const ids = new Set<string>();
    for (const l of lists) {
      if (ids.has(l.id)) fail(`${tp}.lists`, `duplicate list id ${l.id}`);
      ids.add(l.id);
    }
    return {
      id: text(o.id, `${tp}.id`, 100),
      title: text(o.title, `${tp}.title`, 200),
      lane: text(o.lane, `${tp}.lane`, 50),
      alternate: o.alternate === undefined ? [] : arr(o.alternate, `${tp}.alternate`).map((a, n) => text(a, `${tp}.alternate[${n}]`, 100)),
      lists,
    };
  });
  if (tracks.length === 0) fail("tracks", "no tracks in seed");

  const all = tracks.flatMap((t) => t.lists.map((l) => l.id));
  if (new Set(all).size !== all.length) fail("tracks", "list ids must be unique across tracks");
  return { tracks };
}

interface UnitRow {
  id: number;
  title: string;
  grp: string | null;
  size: string;
  est_min: number | null;
  tier: string | null;
  ref: string | null;
  needs_split: number;
  prior_solution: string | null;
}

export function loadStudySeed(db: Db, input: unknown, now: () => Date = () => new Date()): SeedReport {
  const seed = parseStudySeed(input); // reject before any write
  const ts = now().toISOString();
  const report: SeedReport = {
    tracks: seed.tracks.length,
    lists: 0,
    units: { inserted: 0, updated: 0, unchanged: 0 },
    pointersCreated: 0,
    orphanUnits: 0,
  };

  db.transaction(() => {
    for (const t of seed.tracks) {
      db.run(
        `INSERT INTO track (id, title, lane, alternate_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, lane = excluded.lane, alternate_json = excluded.alternate_json`,
        t.id, t.title, t.lane, JSON.stringify(t.alternate),
      );
      for (const l of t.lists) {
        report.lists++;
        db.run(
          `INSERT INTO unit_list (id, track_id, title) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET track_id = excluded.track_id, title = excluded.title`,
          l.id, t.id, l.title,
        );

        for (const u of l.units) {
          const prior = u.prior_solution === null ? null : JSON.stringify(u.prior_solution);
          const row = db.all<UnitRow>("SELECT * FROM unit WHERE list_id = ? AND ordinal = ?", l.id, u.ordinal)[0];
          if (!row) {
            db.run(
              `INSERT INTO unit (list_id, ordinal, title, grp, size, est_min, tier, ref, needs_split, prior_solution)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              l.id, u.ordinal, u.title, u.group, u.size, u.est_min, u.tier, u.ref, u.needs_split ? 1 : 0, prior,
            );
            report.units.inserted++;
          } else if (
            row.title !== u.title || row.grp !== u.group || row.size !== u.size || row.est_min !== u.est_min ||
            row.tier !== u.tier || row.ref !== u.ref || (row.needs_split === 1) !== u.needs_split || row.prior_solution !== prior
          ) {
            db.run(
              `UPDATE unit SET title = ?, grp = ?, size = ?, est_min = ?, tier = ?, ref = ?, needs_split = ?, prior_solution = ? WHERE id = ?`,
              u.title, u.group, u.size, u.est_min, u.tier, u.ref, u.needs_split ? 1 : 0, prior, row.id,
            );
            report.units.updated++;
          } else {
            report.units.unchanged++;
          }
        }

        // Pointers start at 1 and are never touched by a reload.
        const had = db.all("SELECT 1 FROM pointer WHERE list_id = ?", l.id).length > 0;
        if (!had) {
          db.run("INSERT INTO pointer (list_id, ordinal, updated_at) VALUES (?, 1, ?)", l.id, ts);
          report.pointersCreated++;
        }

        const inFile = new Set(l.units.map((u) => u.ordinal));
        const inDb = db.all<{ ordinal: number }>("SELECT ordinal FROM unit WHERE list_id = ?", l.id);
        report.orphanUnits += inDb.filter((r) => !inFile.has(r.ordinal)).length;
      }
    }

    db.run(
      "INSERT INTO event (ts, type, payload_json, source) VALUES (?, 'seed', ?, 'admin')",
      ts,
      JSON.stringify({ kind: "study", ...report }),
    );
  });

  return report;
}

// ------------------------------------------------------------------ query

export interface ListStatus {
  trackId: string;
  trackTitle: string;
  listId: string;
  listTitle: string;
  ordinal: number;
  total: number;
  finished: boolean;
  next: { title: string; group: string | null; size: string; est_min: number | null; ref: string | null } | null;
}

/** Where every pointer is and what the next unit is. The planner (Phase 10) builds on this. */
export function queryPlan(db: Db): ListStatus[] {
  const lists = db.all<{
    track_id: string; track_title: string; list_id: string; list_title: string; ordinal: number | null; total: number;
  }>(
    `SELECT t.id AS track_id, t.title AS track_title, l.id AS list_id, l.title AS list_title,
            p.ordinal AS ordinal, (SELECT COUNT(*) FROM unit u WHERE u.list_id = l.id) AS total
       FROM unit_list l
       JOIN track t ON t.id = l.track_id
       LEFT JOIN pointer p ON p.list_id = l.id
      ORDER BY t.rowid, l.rowid`,
  );
  return lists.map((l) => {
    const ordinal = l.ordinal ?? 1;
    const next = db.all<{ title: string; grp: string | null; size: string; est_min: number | null; ref: string | null }>(
      "SELECT title, grp, size, est_min, ref FROM unit WHERE list_id = ? AND ordinal = ?",
      l.list_id, ordinal,
    )[0];
    return {
      trackId: l.track_id,
      trackTitle: l.track_title,
      listId: l.list_id,
      listTitle: l.list_title,
      ordinal,
      total: l.total,
      finished: l.total > 0 && ordinal > l.total,
      next: next ? { title: next.title, group: next.grp, size: next.size, est_min: next.est_min, ref: next.ref } : null,
    };
  });
}
