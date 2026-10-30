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
  const held = db.all<Row>(`SELECT ${COLS} FROM reading_item WHERE state = 'paused' ORDER BY id`);
  if (held.length > 0) {
    lines.push("", "<b>On hold</b>");
    for (const h of held) lines.push(`• <code>#${h.id}</code> ${esc(h.title)}`);
  }

  const queue = db.all<Row>(`SELECT ${COLS} FROM reading_item WHERE state = 'queued' ORDER BY ordinal, id LIMIT 3`);
  if (queue.length > 0) {
    lines.push("", "<b>Up next in the queue</b>");
    for (const q of queue) lines.push(`• <code>#${q.id}</code> ${esc(q.title)}`);
  }
  lines.push("", "<i>/book add · start · keep · hold · done · drop — use an id or part of the title</i>");
  return lines.join("\n");
}

// ---------------------------------------------------------------- /book command

export type BookCommand = { op: Record<string, unknown> } | { reply: string };

const USAGE =
  "Usage: <code>/book add Title | Author</code>\n" +
  "<code>/book start|keep|hold|done &lt;id or title&gt;</code>\n" +
  "<code>/book drop &lt;id or title&gt; | reason</code>\n" +
  "<i>done works on anything, including books you read before.</i> See /books for ids.";

/** Finds one book by id or by part of its title. Done books are matched last. */
function resolveBook(db: Db, ref: string): { id: number } | { reply: string } {
  const text = ref.trim().replace(/^#/, "");
  if (/^\d+$/.test(text)) {
    return db.all("SELECT 1 FROM reading_item WHERE id = ?", Number(text)).length > 0
      ? { id: Number(text) }
      : { reply: `No book with id ${text}.` };
  }
  if (text === "") return { reply: USAGE };
  const rows = db.all<{ id: number; title: string; state: string }>(
    `SELECT id, title, state FROM reading_item WHERE instr(lower(title), lower(?)) > 0
      ORDER BY (state = 'done'), id LIMIT 6`,
    text,
  );
  if (rows.length === 0) return { reply: `Nothing on the shelf matches "${esc(text)}".` };
  if (rows.length === 1) return { id: rows[0].id };
  const list = rows.slice(0, 5).map((r) => `• <code>#${r.id}</code> ${esc(r.title)} <i>(${r.state})</i>`).join("\n");
  return { reply: `Several match "${esc(text)}" — use the id:\n${list}` };
}

const REF_OPS: Record<string, string> = {
  start: "start_reading",
  keep: "keep_reading",
  hold: "hold_reading",
  pause: "hold_reading",
  done: "finish_reading",
  drop: "drop_reading",
};

/** Turns `/book ...` arguments into an op, or a reply when the input is unclear. Pure apart from lookups. */
export function parseBookCommand(db: Db, args: string[]): BookCommand {
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1).join(" ").trim();

  if (sub === "add") {
    const [title, author] = rest.split("|").map((x) => x.trim());
    return title ? { op: { type: "add_reading", title, author: author || undefined } } : { reply: USAGE };
  }

  const type = REF_OPS[sub];
  if (!type) return { reply: USAGE };

  let ref = rest;
  let reason: string | undefined;
  if (rest.includes("|")) {
    const [r, why] = rest.split("|");
    ref = r;
    reason = why.trim() || undefined;
  } else if (sub === "drop") {
    // "drop 12 too dense": the first word is the reference unless a title fragment was meant (use "|").
    const [first, ...others] = rest.split(/\s+/);
    ref = first ?? "";
    reason = others.join(" ").trim() || undefined;
  }

  const found = resolveBook(db, ref);
  if ("reply" in found) return found;
  const op: Record<string, unknown> = { type, reading_id: found.id };
  if (type === "drop_reading" && reason) op.reason = reason;
  return { op };
}
