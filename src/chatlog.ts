// The conversation as the model needs to see it: every message you send and every message the bot sends,
// with Telegram's message ids, so "ok" can be read against the message it answers.
//
//   in  : what you typed or said (voice is the transcript), plus the message you swipe-replied to
//   out : what the bot sent, tagged with what kind of message it was (evening_recap, reminder:12, question, ...)
//
// The tag is how code decides what an "ok" does; the model only decides that it was an "ok".

import type { Db } from "./db/db.ts";

export const KEEP_MS = 14 * 24 * 3_600_000;
export const WINDOW_MS = 2 * 3_600_000;
export const RECENT_COUNT = 4;
const CLIP = 240;

export interface ChatRow {
  id: number;
  ts: string;
  dir: "in" | "out";
  tg_message_id: number | null;
  reply_to_tg_id: number | null;
  text: string;
  tag: string | null;
}

/** Plain text for the prompt: tags and entities removed, whitespace collapsed, clipped. */
export function plain(text: string, max = CLIP): string {
  const t = text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function logIn(db: Db, nowMs: number, m: { text: string; tgId?: number; replyToTgId?: number; replyToText?: string }): number {
  db.run(
    "INSERT INTO chat_log (ts, dir, tg_message_id, reply_to_tg_id, text, tag, parsed_json) VALUES (?, 'in', ?, ?, ?, NULL, ?)",
    new Date(nowMs).toISOString(), m.tgId ?? null, m.replyToTgId ?? null, m.text,
    m.replyToText ? JSON.stringify({ replied_to_text: m.replyToText.slice(0, 600) }) : null,
  );
  return db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
}

export function logOut(db: Db, nowMs: number, m: { text: string; tgId?: number; tag?: string }): void {
  db.run(
    "INSERT INTO chat_log (ts, dir, tg_message_id, reply_to_tg_id, text, tag, parsed_json) VALUES (?, 'out', ?, NULL, ?, ?, NULL)",
    new Date(nowMs).toISOString(), m.tgId ?? null, m.text, m.tag ?? null,
  );
  db.run("DELETE FROM chat_log WHERE ts < ?", new Date(nowMs - KEEP_MS).toISOString());
}

/** What the model decided about an inbound message, and how long it took: kept for debugging. */
export function noteOutcome(db: Db, id: number, info: Record<string, unknown>): void {
  const row = db.all<{ parsed_json: string | null }>("SELECT parsed_json FROM chat_log WHERE id = ?", id)[0];
  const prev = row?.parsed_json ? (JSON.parse(row.parsed_json) as Record<string, unknown>) : {};
  db.run("UPDATE chat_log SET parsed_json = ? WHERE id = ?", JSON.stringify({ ...prev, ...info }), id);
}

export function byTgId(db: Db, tgId: number): ChatRow | null {
  return db.all<ChatRow>("SELECT * FROM chat_log WHERE tg_message_id = ? AND dir = 'out' ORDER BY id DESC LIMIT 1", tgId)[0] ?? null;
}

/** The latest bot message with a tag, within the window: what a bare "ok" most likely answers. */
export function lastOut(db: Db, nowMs: number, windowMs = WINDOW_MS): ChatRow | null {
  return db.all<ChatRow>(
    "SELECT * FROM chat_log WHERE dir = 'out' AND ts >= ? ORDER BY id DESC LIMIT 1", new Date(nowMs - windowMs).toISOString(),
  )[0] ?? null;
}

/** The last few messages, oldest first, both directions. `excludeId` leaves out the message being understood. */
export function recent(db: Db, nowMs: number, opts: { count?: number; windowMs?: number; excludeId?: number } = {}): ChatRow[] {
  const rows = db.all<ChatRow>(
    "SELECT * FROM chat_log WHERE ts >= ? AND id != ? ORDER BY id DESC LIMIT ?",
    new Date(nowMs - (opts.windowMs ?? WINDOW_MS)).toISOString(), opts.excludeId ?? -1, opts.count ?? RECENT_COUNT,
  );
  return rows.reverse();
}
