import type { Db } from "./db.ts";
import { SCHEMA_SQL } from "./schema.ts";

// Product-loop tables (spec §6). All CREATE ... IF NOT EXISTS so a partial run is safe to repeat.
const V2_SQL = `
CREATE TABLE IF NOT EXISTS processed_update (
  update_id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL
);

-- Append-only ground truth. Everything derived (logs, weekly numbers) reads from here.
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  lane TEXT,
  ref_id TEXT,
  payload_json TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  raw TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_event_ts ON event(ts);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(type, ts);

-- Row-level diff per applied op; powers undo.
CREATE TABLE IF NOT EXISTS revision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES event(id),
  summary TEXT NOT NULL,
  op_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  undone_at TEXT
);

-- Captures that could not be parsed with confidence; triaged at the evening check-in.
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dropped'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lane (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  resume_rule TEXT
);

CREATE TABLE IF NOT EXISTS target (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL CHECK(period IN ('week','month')),
  floor REAL,
  goal REAL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(lane, metric, period)
);

-- Static weekly shape: what KIND of day each weekday is (0 = Monday).
CREATE TABLE IF NOT EXISTS pattern (
  weekday INTEGER PRIMARY KEY CHECK(weekday BETWEEN 0 AND 6),
  kind TEXT NOT NULL CHECK(kind IN ('GYM','MOBILITY','REST')),
  note TEXT
);

CREATE TABLE IF NOT EXISTS rotation (
  lane TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (lane, ordinal)
);

-- Study content: track -> ordered lists -> ordered units. A pointer walks a list.
CREATE TABLE IF NOT EXISTS track (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  lane TEXT NOT NULL,
  alternate_json TEXT
);

CREATE TABLE IF NOT EXISTS unit_list (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES track(id),
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL REFERENCES unit_list(id),
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  grp TEXT,
  size TEXT NOT NULL DEFAULT 'fragment' CHECK(size IN ('fragment','block')),
  est_min INTEGER,
  tier TEXT,
  ref TEXT,
  needs_split INTEGER NOT NULL DEFAULT 0,
  prior_solution TEXT,
  UNIQUE(list_id, ordinal)
);

-- ordinal = the NEXT unit to do. ordinal = (unit count + 1) means the list is finished.
CREATE TABLE IF NOT EXISTS pointer (
  list_id TEXT PRIMARY KEY REFERENCES unit_list(id),
  ordinal INTEGER NOT NULL DEFAULT 1 CHECK(ordinal >= 1),
  updated_at TEXT NOT NULL
);

-- Exceptions to the routine. They suppress; they never create debt.
CREATE TABLE IF NOT EXISTS override (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('TRAVEL','SICK','OUT','LOW_MOOD')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  note TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(end_date >= start_date)
);

-- Ephemeral memory. Expiry is mandatory by construction.
CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_expires ON note(expires_at);

CREATE TABLE IF NOT EXISTS day_plan (
  date TEXT PRIMARY KEY,
  place TEXT CHECK(place IN ('OFFICE','REMOTE')),
  wake_by TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','locked')),
  locked_by TEXT CHECK(locked_by IN ('user','auto')),
  locked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS plan_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  lane TEXT NOT NULL,
  title TEXT NOT NULL,
  ref TEXT,
  est_min INTEGER,
  unit_id INTEGER REFERENCES unit(id),
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('pattern','pointer','user','minimum')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','done','skipped','dropped'))
);
CREATE INDEX IF NOT EXISTS idx_plan_item_date ON plan_item(date);
`;

// Things read or watched for their own sake. Separate from the v1 reading_queue (URL-only, shared via Telegram).
// state/slot/shortlist belong to the user: seed reloads refresh metadata but never touch them.
// Flow: backlog|queued -> sampling -> active -> done. paused = on hold (frees the slot, keeps progress);
// dropped = given up (reason kept). Both can be restarted.
// slot limits work in progress: at most one sampling/active item per slot.
const V3_SQL = `
CREATE TABLE IF NOT EXISTS reading_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_key TEXT UNIQUE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'article',
  subtype TEXT,
  author TEXT,
  topic TEXT,
  priority TEXT,
  est_length TEXT,
  url TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('queue','library','user')),
  state TEXT NOT NULL DEFAULT 'backlog' CHECK(state IN ('backlog','queued','sampling','active','paused','done','dropped')),
  slot TEXT CHECK(slot IN ('technical','narrative')),
  shortlist INTEGER NOT NULL DEFAULT 0,
  ordinal INTEGER,
  started_at TEXT,
  ended_at TEXT,
  drop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_reading_item_state ON reading_item(state);
`;

// Optional plan items (a remote-day block, reading) are shown as such and never count as missed.
const V4_SQL = `ALTER TABLE plan_item ADD COLUMN optional INTEGER NOT NULL DEFAULT 0;`;

// What was last written to each study-repo file, so an unchanged day makes no commit.
const V5_SQL = `
CREATE TABLE IF NOT EXISTS mirror_state (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "v1 base tables", sql: SCHEMA_SQL },
  { version: 2, name: "product loop: events, plan, tracks, overrides", sql: V2_SQL },
  { version: 3, name: "reading items", sql: V3_SQL },
  { version: 4, name: "optional plan items", sql: V4_SQL },
  { version: 5, name: "repo mirror state", sql: V5_SQL },
];

/** Apply any migration not yet recorded. Safe on a database that predates schema_migrations. */
export function runMigrations(db: Db, now: () => Date = () => new Date()): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec(m.sql);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, now().toISOString());
    applied.push(m.version);
  }
  return applied;
}
