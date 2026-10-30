// Loads seed/config.json: config defaults, lanes, targets, the weekly gym pattern and the rotation.
//
// Ownership decides what a reload may overwrite:
//   * config, lane, target are the USER's once seeded (set_config ops change them), so a reload only
//     inserts what is missing and never overwrites an existing value.
//   * pattern and rotation are static plan content owned by the seed, so a reload upserts them.
// Nothing is deleted. One 'seed' event, no revision (not undoable).

import type { Db } from "./db/db.ts";
import { SeedError } from "./seed.ts";

const KINDS = ["GYM", "MOBILITY", "REST"] as const;
const STATUSES = ["active", "paused"] as const;
const PERIODS = ["week", "month"] as const;

export interface ConfigSeed {
  config: Record<string, string>;
  lanes: { name: string; status: "active" | "paused"; resume_rule: string | null }[];
  targets: { lane: string; metric: string; period: "week" | "month"; floor: number | null; goal: number | null }[];
  pattern: { weekday: number; kind: (typeof KINDS)[number]; note: string | null }[];
  rotation: { lane: string; ordinal: number; label: string }[];
}

export interface ConfigSeedReport {
  config: { inserted: number; kept: number };
  lanes: { inserted: number; kept: number };
  targets: { inserted: number; kept: number };
  pattern: { inserted: number; updated: number; unchanged: number };
  rotation: { inserted: number; updated: number; unchanged: number };
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
function str(v: unknown, path: string, max = 300): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "expected a non-empty string");
  if (v.length > max) fail(path, `longer than ${max} characters`);
  return v;
}
function optStr(v: unknown, path: string): string | null {
  return v === undefined || v === null ? null : str(v, path, 500);
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (!(allowed as readonly unknown[]).includes(v)) fail(path, `expected one of ${allowed.join(", ")}`);
  return v as T;
}
function optNum(v: unknown, path: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(path, "expected a number >= 0 or null");
  return v;
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(path, `expected an integer ${min}..${max}`);
  return v;
}
function noDuplicates(keys: string[], path: string): void {
  if (new Set(keys).size !== keys.length) fail(path, "duplicate entries");
}

export function parseConfigSeed(input: unknown): ConfigSeed {
  const root = obj(input, "seed");

  const configObj = obj(root.config ?? {}, "config");
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(configObj)) config[str(k, `config.${k}`, 100)] = str(v, `config.${k}`);

  const lanes = arr(root.lanes ?? [], "lanes").map((l, i) => {
    const o = obj(l, `lanes[${i}]`);
    return {
      name: str(o.name, `lanes[${i}].name`, 50),
      status: oneOf(o.status ?? "active", STATUSES, `lanes[${i}].status`),
      resume_rule: optStr(o.resume_rule, `lanes[${i}].resume_rule`),
    };
  });
  noDuplicates(lanes.map((l) => l.name), "lanes");

  const targets = arr(root.targets ?? [], "targets").map((t, i) => {
    const o = obj(t, `targets[${i}]`);
    const floor = optNum(o.floor, `targets[${i}].floor`);
    const goal = optNum(o.goal, `targets[${i}].goal`);
    if (floor !== null && goal !== null && floor > goal) fail(`targets[${i}]`, "floor is above goal");
    return {
      lane: str(o.lane, `targets[${i}].lane`, 50),
      metric: str(o.metric, `targets[${i}].metric`, 100),
      period: oneOf(o.period, PERIODS, `targets[${i}].period`),
      floor,
      goal,
    };
  });
  noDuplicates(targets.map((t) => `${t.lane}/${t.metric}/${t.period}`), "targets");

  const pattern = arr(root.pattern ?? [], "pattern").map((p, i) => {
    const o = obj(p, `pattern[${i}]`);
    return {
      weekday: int(o.weekday, `pattern[${i}].weekday`, 0, 6),
      kind: oneOf(o.kind, KINDS, `pattern[${i}].kind`),
      note: optStr(o.note, `pattern[${i}].note`),
    };
  });
  noDuplicates(pattern.map((p) => String(p.weekday)), "pattern");

  const rotation = arr(root.rotation ?? [], "rotation").map((r, i) => {
    const o = obj(r, `rotation[${i}]`);
    return {
      lane: str(o.lane, `rotation[${i}].lane`, 50),
      ordinal: int(o.ordinal, `rotation[${i}].ordinal`, 1, 100),
      label: str(o.label, `rotation[${i}].label`, 100),
    };
  });
  noDuplicates(rotation.map((r) => `${r.lane}/${r.ordinal}`), "rotation");

  return { config, lanes, targets, pattern, rotation };
}

export function loadConfigSeed(db: Db, input: unknown, now: () => Date = () => new Date()): ConfigSeedReport {
  const seed = parseConfigSeed(input); // reject before any write
  const report: ConfigSeedReport = {
    config: { inserted: 0, kept: 0 },
    lanes: { inserted: 0, kept: 0 },
    targets: { inserted: 0, kept: 0 },
    pattern: { inserted: 0, updated: 0, unchanged: 0 },
    rotation: { inserted: 0, updated: 0, unchanged: 0 },
  };

  db.transaction(() => {
    for (const [key, value] of Object.entries(seed.config)) {
      const exists = db.all("SELECT 1 FROM config WHERE key = ?", key).length > 0;
      if (exists) report.config.kept++;
      else {
        db.run("INSERT INTO config (key, value) VALUES (?, ?)", key, value);
        report.config.inserted++;
      }
    }

    for (const l of seed.lanes) {
      const exists = db.all("SELECT 1 FROM lane WHERE name = ?", l.name).length > 0;
      if (exists) report.lanes.kept++;
      else {
        db.run("INSERT INTO lane (name, status, resume_rule) VALUES (?, ?, ?)", l.name, l.status, l.resume_rule);
        report.lanes.inserted++;
      }
    }

    for (const t of seed.targets) {
      const exists = db.all("SELECT 1 FROM target WHERE lane = ? AND metric = ? AND period = ?", t.lane, t.metric, t.period).length > 0;
      if (exists) report.targets.kept++;
      else {
        db.run("INSERT INTO target (lane, metric, period, floor, goal) VALUES (?, ?, ?, ?, ?)", t.lane, t.metric, t.period, t.floor, t.goal);
        report.targets.inserted++;
      }
    }

    for (const p of seed.pattern) {
      const row = db.all<{ kind: string; note: string | null }>("SELECT kind, note FROM pattern WHERE weekday = ?", p.weekday)[0];
      if (!row) {
        db.run("INSERT INTO pattern (weekday, kind, note) VALUES (?, ?, ?)", p.weekday, p.kind, p.note);
        report.pattern.inserted++;
      } else if (row.kind !== p.kind || row.note !== p.note) {
        db.run("UPDATE pattern SET kind = ?, note = ? WHERE weekday = ?", p.kind, p.note, p.weekday);
        report.pattern.updated++;
      } else report.pattern.unchanged++;
    }

    for (const r of seed.rotation) {
      const row = db.all<{ label: string }>("SELECT label FROM rotation WHERE lane = ? AND ordinal = ?", r.lane, r.ordinal)[0];
      if (!row) {
        db.run("INSERT INTO rotation (lane, ordinal, label) VALUES (?, ?, ?)", r.lane, r.ordinal, r.label);
        report.rotation.inserted++;
      } else if (row.label !== r.label) {
        db.run("UPDATE rotation SET label = ? WHERE lane = ? AND ordinal = ?", r.label, r.lane, r.ordinal);
        report.rotation.updated++;
      } else report.rotation.unchanged++;
    }

    db.run(
      "INSERT INTO event (ts, type, payload_json, source) VALUES (?, 'seed', ?, 'admin')",
      now().toISOString(),
      JSON.stringify({ kind: "config", ...report }),
    );
  });

  return report;
}
