// Loads seed/reading.json into reading_item.
//
// Idempotent by seed_key. A reload refreshes metadata but NEVER touches `state`, because the user
// moves items between backlog / queued / active / done. Nothing is deleted; items missing from the
// file are counted as orphans. One 'seed' event, no revision (not undoable).

import type { Db } from "./db/db.ts";
import { SeedError } from "./seed.ts";

const SOURCES = ["queue", "library"] as const;
const STATES = ["backlog", "queued", "active", "done", "dropped"] as const;
const MAX_ITEMS = 5000;

export interface ReadingSeedItem {
  key: string;
  title: string;
  kind: string;
  subtype: string | null;
  author: string | null;
  topic: string | null;
  priority: string | null;
  est_length: string | null;
  url: string | null;
  note: string | null;
  source: (typeof SOURCES)[number];
  state: (typeof STATES)[number];
  ordinal: number | null;
}

export interface ReadingSeedReport {
  items: { inserted: number; updated: number; unchanged: number };
  orphans: number;
}

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new SeedError(`${path}: ${msg}`);
}
function str(v: unknown, path: string, max = 500): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "expected a non-empty string");
  if (v.length > max) fail(path, `longer than ${max} characters`);
  return v;
}
function optStr(v: unknown, path: string, max = 1000): string | null {
  return v === undefined || v === null || v === "" ? null : str(v, path, max);
}

export function parseReadingSeed(input: unknown): ReadingSeedItem[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("seed", "expected an object");
  const list = (input as Obj).items;
  if (!Array.isArray(list)) fail("items", "expected an array");
  if (list.length === 0) fail("items", "no items in seed");
  if (list.length > MAX_ITEMS) fail("items", `more than ${MAX_ITEMS} items`);

  const seen = new Set<string>();
  return list.map((raw, i): ReadingSeedItem => {
    const p = `items[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(p, "expected an object");
    const o = raw as Obj;
    const key = str(o.key, `${p}.key`, 200);
    if (seen.has(key)) fail(`${p}.key`, `duplicate key ${key}`);
    seen.add(key);
    const source = o.source;
    if (!(SOURCES as readonly unknown[]).includes(source)) fail(`${p}.source`, `expected one of ${SOURCES.join(", ")}`);
    const state = o.state ?? "backlog";
    if (!(STATES as readonly unknown[]).includes(state)) fail(`${p}.state`, `expected one of ${STATES.join(", ")}`);
    const ordinal = o.ordinal;
    if (ordinal !== undefined && ordinal !== null && (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 1)) {
      fail(`${p}.ordinal`, "expected an integer >= 1 or null");
    }
    return {
      key,
      title: str(o.title, `${p}.title`, 400),
      kind: str(o.kind ?? "article", `${p}.kind`, 30),
      subtype: optStr(o.subtype, `${p}.subtype`, 50),
      author: optStr(o.author, `${p}.author`, 300),
      topic: optStr(o.topic, `${p}.topic`, 200),
      priority: optStr(o.priority, `${p}.priority`, 20),
      est_length: optStr(o.est_length, `${p}.est_length`, 30),
      url: optStr(o.url, `${p}.url`, 1000),
      note: optStr(o.note, `${p}.note`, 1000),
      source: source as ReadingSeedItem["source"],
      state: state as ReadingSeedItem["state"],
      ordinal: (ordinal as number | null | undefined) ?? null,
    };
  });
}

interface Row {
  id: number;
  title: string;
  kind: string;
  subtype: string | null;
  author: string | null;
  topic: string | null;
  priority: string | null;
  est_length: string | null;
  url: string | null;
  note: string | null;
  source: string;
  ordinal: number | null;
}

export function loadReadingSeed(db: Db, input: unknown, now: () => Date = () => new Date()): ReadingSeedReport {
  const items = parseReadingSeed(input); // reject before any write
  const report: ReadingSeedReport = { items: { inserted: 0, updated: 0, unchanged: 0 }, orphans: 0 };

  db.transaction(() => {
    for (const it of items) {
      const row = db.all<Row>("SELECT * FROM reading_item WHERE seed_key = ?", it.key)[0];
      if (!row) {
        db.run(
          `INSERT INTO reading_item (seed_key, title, kind, subtype, author, topic, priority, est_length, url, note, source, state, ordinal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          it.key, it.title, it.kind, it.subtype, it.author, it.topic, it.priority, it.est_length, it.url, it.note, it.source, it.state, it.ordinal,
        );
        report.items.inserted++;
      } else if (
        row.title !== it.title || row.kind !== it.kind || row.subtype !== it.subtype || row.author !== it.author ||
        row.topic !== it.topic || row.priority !== it.priority || row.est_length !== it.est_length || row.url !== it.url ||
        row.note !== it.note || row.source !== it.source || row.ordinal !== it.ordinal
      ) {
        db.run(
          `UPDATE reading_item SET title = ?, kind = ?, subtype = ?, author = ?, topic = ?, priority = ?, est_length = ?,
                  url = ?, note = ?, source = ?, ordinal = ? WHERE id = ?`,
          it.title, it.kind, it.subtype, it.author, it.topic, it.priority, it.est_length, it.url, it.note, it.source, it.ordinal, row.id,
        );
        report.items.updated++;
      } else report.items.unchanged++;
    }

    const inFile = new Set(items.map((i) => i.key));
    report.orphans = db
      .all<{ seed_key: string }>("SELECT seed_key FROM reading_item WHERE seed_key IS NOT NULL")
      .filter((r) => !inFile.has(r.seed_key)).length;

    db.run(
      "INSERT INTO event (ts, type, payload_json, source) VALUES (?, 'seed', ?, 'admin')",
      now().toISOString(),
      JSON.stringify({ kind: "reading", ...report }),
    );
  });

  return report;
}
