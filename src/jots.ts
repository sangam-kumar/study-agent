// Jots (spec §15b, stage 1: just store it). A thought, quote or question about what you're reading,
// attached to the book, with where you were. Plus progress ("finished ch3", "on p140").
//
//   "ch3: leader-based replication, lag breaks read-your-writes"  -> jot on the book you're reading
//   "finished ch3" / "on p140"                                    -> that book's progress
//   study/notes/<book-slug>.md                                    <- regenerated from the jots (mirror)
//
// With one book on the go, both are read in code. With two, or naming another book, the model
// picks the book (the jot / progress intents) and code resolves the title.

import type { Db } from "./db/db.ts";
import { currentReading, titleScore } from "./reading.ts";
import type { ShelfItem } from "./reading.ts";
import { dateLabel, dayKey } from "./time.ts";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const JOT_KINDS = ["point", "quote", "question", "connection", "todo"] as const;
export type JotKind = (typeof JOT_KINDS)[number];

const LOCATOR = String.raw`(?:ch(?:apter)?\.?\s*\d+(?:\.\d+)?|p(?:age|g)?\.?\s*\d+|part\s*\d+|ep(?:isode)?\.?\s*\d+|\d{1,2}:\d{2}(?::\d{2})?)`;

/** "chapter 3" -> "ch3", "page 140" -> "p140", "12:40" stays. */
export function normalizeLocator(raw: string): string {
  const t = raw.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)$/.exec(t))) return `ch${m[1]}`;
  if ((m = /^p(?:age|g)?\.?\s*(\d+)$/.exec(t))) return `p${m[1]}`;
  if ((m = /^part\s*(\d+)$/.exec(t))) return `part ${m[1]}`;
  if ((m = /^ep(?:isode)?\.?\s*(\d+)$/.exec(t))) return `ep${m[1]}`;
  return t;
}

/** Kind from the text itself: a quote in quotes, a question, a todo. */
export function jotKind(text: string): JotKind {
  const t = text.trim();
  if (/^["“'‘]/.test(t)) return "quote";
  if (/^(todo|to do|look up|read up)\b/i.test(t)) return "todo";
  if (/\?$/.test(t)) return "question";
  if (/^(like|reminds me|connects? to|same as|similar to)\b/i.test(t)) return "connection";
  return "point";
}

export type JotInput = { kind: "jot"; locator: string | null; text: string } | { kind: "progress"; locator: string };

/** Code-only reading of a message: "ch3: ...", "jot: ...", "finished ch3", "on p140". Null if neither. */
export function parseJotText(text: string): JotInput | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = new RegExp(String.raw`^(${LOCATOR})\s*[:\-–—]\s+(.{3,})$`, "is").exec(t))) return { kind: "jot", locator: normalizeLocator(m[1]), text: m[2].trim() };
  if ((m = /^(?:jot|takeaway|note to self|thought)\s*[:\-–—]\s*(.{3,})$/is.exec(t))) return { kind: "jot", locator: null, text: m[1].trim() };
  if ((m = new RegExp(String.raw`^(?:finished|done with|read|completed|through)\s+(${LOCATOR})[.!]?$`, "i").exec(t))) return { kind: "progress", locator: `${normalizeLocator(m[1])} done` };
  if ((m = new RegExp(String.raw`^(?:on|at|now on|reached|up to)\s+(${LOCATOR})[.!]?$`, "i").exec(t))) return { kind: "progress", locator: normalizeLocator(m[1]) };
  return null;
}

/** The book a jot belongs to when none is named: the one you're reading, if there is exactly one. */
export function soleCurrentBook(db: Db): ShelfItem | null {
  const now = currentReading(db);
  return now.length === 1 ? now[0] : null;
}

/** A book by part of its title, preferring ones you're reading. */
export function findBook(db: Db, ref: string): { id: number; title: string } | { reply: string } {
  const rows = db.all<{ id: number; title: string; state: string }>("SELECT id, title, state FROM reading_item WHERE state <> 'dropped'");
  const scored = rows.map((r) => ({ ...r, score: titleScore(r.title, ref) + (r.state === "sampling" || r.state === "active" ? 0.5 : 0) })).filter((r) => r.score >= 2);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { reply: `No book on the shelf matches "${esc(ref)}". /books to see it.` };
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return { reply: `Which one?\n${scored.slice(0, 4).map((r) => `• ${esc(r.title)}`).join("\n")}` };
  }
  return { id: scored[0].id, title: scored[0].title };
}

// ------------------------------------------------------------------ display

interface JotRow {
  id: number;
  locator: string | null;
  text: string;
  kind: JotKind;
  created_at: string;
}

export function loadJots(db: Db, readingId: number, limit = 1000): JotRow[] {
  return db.all<JotRow>("SELECT id, locator, text, kind, created_at FROM jot WHERE reading_id = ? ORDER BY id LIMIT ?", readingId, limit);
}

const KIND_MARK: Record<JotKind, string> = { point: "", quote: "💬 ", question: "❓ ", connection: "🔗 ", todo: "☐ " };

export function renderJots(db: Db, readingId: number, limit = 12): string {
  const book = db.all<{ title: string; progress: string | null }>("SELECT title, progress FROM reading_item WHERE id = ?", readingId)[0];
  if (!book) return "That book is gone.";
  const all = loadJots(db, readingId);
  const head = `📝 <b>${esc(book.title)}</b>${book.progress ? ` · <i>${esc(book.progress)}</i>` : ""}`;
  if (all.length === 0) return `${head}\nNo jots yet. Send <i>ch3: what struck you</i> while reading.`;
  const shown = all.slice(-limit);
  const more = all.length > shown.length ? `\n<i>…and ${all.length - shown.length} earlier, all in study/notes/${notesSlug(book.title)}.md</i>` : "";
  return `${head}\n${shown.map((j) => `• ${j.locator ? `<b>${esc(j.locator)}</b> ` : ""}${KIND_MARK[j.kind]}${esc(j.text)}`).join("\n")}${more}`;
}

export function notesSlug(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "untitled";
}

export function notesPath(title: string): string {
  return `study/notes/${notesSlug(title)}.md`;
}

/** The whole notes file for a book, regenerated from its jots (one-way: never parsed back). */
export function renderNotesMarkdown(db: Db, readingId: number): string | null {
  const book = db.all<{ title: string; author: string | null; progress: string | null; state: string }>(
    "SELECT title, author, progress, state FROM reading_item WHERE id = ?", readingId,
  )[0];
  const jots = loadJots(db, readingId);
  if (!book || jots.length === 0) return null;
  const meta = [book.author, book.state, book.progress].filter(Boolean).join(" · ");
  const lines = [`# ${book.title}`, "", `_${meta}_`, "", "<!-- Written by the study agent from your jots; edits here are overwritten. -->", ""];
  let lastLoc: string | null | undefined;
  for (const j of jots) {
    if (j.locator !== lastLoc && j.locator) lines.push("", `## ${j.locator}`, "");
    lastLoc = j.locator;
    const day = dateLabel(dayKey(Date.parse(j.created_at)));
    const text = j.kind === "quote" ? `> ${j.text}` : `- ${KIND_MARK[j.kind]}${j.text}`;
    lines.push(`${text} _(${day})_`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/** Books whose jots or progress changed since `sinceIso` (for the mirror). */
export function booksWithJots(db: Db): { id: number; title: string }[] {
  return db.all<{ id: number; title: string }>("SELECT DISTINCT r.id AS id, r.title AS title FROM reading_item r JOIN jot j ON j.reading_id = r.id ORDER BY r.id");
}
