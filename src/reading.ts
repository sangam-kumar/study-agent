// Reading shelf queries. Deterministic: the LLM never chooses what you read next.
//
// Candidate rule: at most one sampling/active book per slot (technical, narrative). For every free
// slot offer the next shortlisted book, then one wildcard from the rest of the library (High priority,
// rotating by day so it is stable within a day but changes tomorrow).

import type { Db } from "./db/db.ts";

export interface ShelfItem {
  id: number;
  title: string;
  author: string | null;
  slot: string | null;
  state: string;
  started_at: string | null;
  shortlist: boolean;
}

export interface Candidate extends ShelfItem {
  why: "technical" | "narrative" | "wildcard";
}

interface Row {
  id: number;
  title: string;
  author: string | null;
  slot: string | null;
  state: string;
  started_at: string | null;
  shortlist: number;
}

const toItem = (r: Row): ShelfItem => ({
  id: r.id, title: r.title, author: r.author, slot: r.slot, state: r.state, started_at: r.started_at, shortlist: r.shortlist === 1,
});

const COLS = "id, title, author, slot, state, started_at, shortlist";

/** Books being sampled or read right now. */
export function currentReading(db: Db): ShelfItem[] {
  return db
    .all<Row>(`SELECT ${COLS} FROM reading_item WHERE state IN ('sampling','active') ORDER BY started_at, id`)
    .map(toItem);
}

/** Up to three picks: one per free slot from the shortlist, plus a wildcard. dayIndex = days since epoch. */
export function pickCandidates(db: Db, dayIndex: number): Candidate[] {
  const busy = new Set(currentReading(db).map((r) => r.slot));
  const out: Candidate[] = [];

  for (const slot of ["technical", "narrative"] as const) {
    if (busy.has(slot)) continue;
    const row = db.all<Row>(
      `SELECT ${COLS} FROM reading_item
        WHERE shortlist = 1 AND slot = ? AND state IN ('backlog','queued')
        ORDER BY COALESCE(ordinal, 1000000), id LIMIT 1`,
      slot,
    )[0];
    if (row) out.push({ ...toItem(row), why: slot });
  }

  const pool = db.all<Row>(
    `SELECT ${COLS} FROM reading_item
      WHERE source = 'library' AND shortlist = 0 AND state = 'backlog' AND priority = 'High'
      ORDER BY id`,
  );
  if (pool.length > 0) out.push({ ...toItem(pool[((dayIndex % pool.length) + pool.length) % pool.length]), why: "wildcard" });
  return out;
}

/** Dropped books with the reason, newest first: the raw material for "you tend to drop long textbooks". */
export function droppedBooks(db: Db, limit = 10): { id: number; title: string; reason: string | null }[] {
  return db.all(`SELECT id, title, drop_reason AS reason FROM reading_item WHERE state = 'dropped' ORDER BY ended_at DESC LIMIT ?`, limit);
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML for /books: what is being read, then what to pick next. */
export function renderShelf(db: Db, dayIndex: number): string {
  const now = currentReading(db);
  const picks = pickCandidates(db, dayIndex);
  const lines: string[] = ["📖 <b>Reading</b>"];

  if (now.length === 0) lines.push("", "Nothing in progress.");
  for (const r of now) {
    const label = r.state === "sampling" ? "sampling — keep or drop?" : "reading";
    lines.push("", `• <b>${esc(r.title)}</b> <code>#${r.id}</code> (${label})`);
  }

  if (picks.length > 0) {
    lines.push("", "<b>Pick next</b> — <code>/book start &lt;id&gt;</code>");
    for (const c of picks) {
      const tag = c.why === "wildcard" ? "wildcard" : c.why;
      lines.push(`• <code>#${c.id}</code> ${esc(c.title)}${c.author ? ` — ${esc(c.author)}` : ""} <i>(${tag})</i>`);
    }
  }
  lines.push("", "<i>/book add &lt;title&gt; | &lt;author&gt; · keep · done · drop &lt;id&gt; [reason]</i>");
  return lines.join("\n");
}
