// Reminders v2 (spec §12): things you asked for, so they are never capped or silenced by an override.
//
//   timed      "remind me Fri 4pm to call the bank"  -> fires with Done / Snooze 1h / Tomorrow;
//                                                     unanswered -> one repeat after 30 min, then
//                                                     "still open" in the evening recap, no more pings
//   repeating  "every Monday 9am"                     -> each firing schedules the next one
//   task       "submit the form by Friday" (no time)  -> no ping: shown in the morning brief and the
//                                                     evening recap until it is done
//
// Rows live in the v1 `reminders` table (extended in migration v7). Status:
//   pending -> dispatched (fired, waiting for an answer) -> done | cancelled
// Pure database helpers here; the agent does the scheduling and the sending.

import type { Db } from "./db/db.ts";
import { parseWeekdays } from "./day.ts";
import { formatIn, formatWhen } from "./reminder-time.ts";
import { WEEKDAY_NAMES, addDays, calendarDate, dateLabel, istWallToMs, weekdayIndex, IST_OFFSET_MS } from "./time.ts";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Reminder {
  id: number;
  text: string;
  trigger_at: number;
  due_date: string | null;
  repeat_rule: string | null;
  status: "pending" | "dispatched" | "done" | "cancelled";
  fired_at: string | null;
  repeats: number;
  message_id: number | null;
}

const COLS = "id, COALESCE(text, json_extract(payload_json, '$.text'), 'Reminder') AS text, trigger_at, due_date, repeat_rule, status, fired_at, repeats, message_id";

export function getReminder(db: Db, id: number): Reminder | null {
  return db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE id = ?`, id)[0] ?? null;
}

// ------------------------------------------------------------------ repeats

/** "daily" | "weekdays" | "weekly:0,2" (Mon = 0). Null if the phrase isn't a repeat we know. */
export function parseRepeat(input: string | undefined | null): string | null {
  if (!input) return null;
  const t = input.toLowerCase().replace(/^every\s+/, "").replace(/[.!]$/, "").trim();
  if (!t) return null;
  if (/^(day|daily|everyday|each day|night|morning|evening)$/.test(t)) return "daily";
  if (/^(weekdays?|work ?days?|weekday mornings?|mon(day)?\s*(-|to)\s*fri(day)?)$/.test(t)) return "weekdays";
  if (/^weekends?$/.test(t)) return "weekly:5,6";
  const days = parseWeekdays(t.replace(/\b(every|each)\b/g, " ").replace(/s\b/g, ""));
  return days && days.length > 0 ? `weekly:${days.join(",")}` : null;
}

function matches(rule: string, date: string): boolean {
  const wd = weekdayIndex(date);
  if (rule === "daily") return true;
  if (rule === "weekdays") return wd <= 4;
  const m = /^weekly:([0-6](?:,[0-6])*)$/.exec(rule);
  return !!m && m[1].split(",").map(Number).includes(wd);
}

export function describeRepeat(rule: string): string {
  if (rule === "daily") return "every day";
  if (rule === "weekdays") return "every weekday";
  const days = rule.replace(/^weekly:/, "").split(",").map((d) => WEEKDAY_NAMES[Number(d)]);
  return `every ${days.join(", ")}`;
}

/** IST "HH:MM" of an instant. */
export function clockOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** The first time the rule matches at `hhmm`, strictly after `afterMs`. */
export function firstOccurrence(rule: string, hhmm: string, afterMs: number): number {
  const start = calendarDate(afterMs);
  for (let i = 0; i <= 8; i++) {
    const d = addDays(start, i);
    if (!matches(rule, d)) continue;
    const t = istWallToMs(d, hhmm);
    if (t > afterMs) return t;
  }
  throw new Error(`no occurrence for ${rule}`);
}

/** Next firing after one that was due at dueMs (same clock time), never in the past. */
export function nextOccurrence(rule: string, dueMs: number, nowMs: number): number {
  return firstOccurrence(rule, clockOf(dueMs), Math.max(dueMs, nowMs));
}

// ------------------------------------------------------------------- writes

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** An open reminder with the same text at (about) the same time, or the same task on the same day. */
export function findDuplicate(db: Db, text: string, when: { dueMs?: number; dueDate?: string }): Reminder | null {
  const open = db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE status IN ('pending','dispatched')`);
  return open.find((r) => norm(r.text) === norm(text) && (
    when.dueDate ? r.due_date === when.dueDate : r.due_date === null && Math.abs(r.trigger_at - (when.dueMs ?? 0)) < 60_000
  )) ?? null;
}

export function insertReminder(db: Db, r: { text: string; dueMs?: number; dueDate?: string; repeat?: string | null }, nowMs: number): number {
  const trigger = r.dueDate ? istWallToMs(r.dueDate, "09:00") : Math.max(Math.round(r.dueMs ?? nowMs), nowMs + 1000);
  db.run(
    "INSERT INTO reminders (reminder_type, trigger_at, payload_json, status, text, due_date, repeat_rule) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
    r.dueDate ? "task" : "adhoc", trigger, JSON.stringify({ text: r.text }), r.text, r.dueDate ?? null, r.repeat ?? null,
  );
  return db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0].id;
}

export function markFired(db: Db, id: number, nowMs: number, messageId: number | null): void {
  db.run("UPDATE reminders SET status = 'dispatched', fired_at = ?, message_id = ? WHERE id = ?", new Date(nowMs).toISOString(), messageId, id);
}

export function markDone(db: Db, id: number, nowMs: number): void {
  db.run("UPDATE reminders SET status = 'done', done_at = ? WHERE id = ?", new Date(nowMs).toISOString(), id);
}

export function markCancelled(db: Db, id: number): void {
  db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", id);
}

/** Back to pending at a new time (Snooze 1h / Tomorrow). Its repeat allowance starts over. */
export function reschedule(db: Db, id: number, dueMs: number): void {
  db.run("UPDATE reminders SET status = 'pending', trigger_at = ?, repeats = 0, fired_at = NULL WHERE id = ?", Math.round(dueMs), id);
}

/** "Tomorrow": the same clock time on the next day that is still ahead. */
export function tomorrowAt(r: Reminder, nowMs: number): number {
  const hhmm = clockOf(r.trigger_at);
  return istWallToMs(addDays(calendarDate(nowMs), 1), hhmm);
}

// ------------------------------------------------------------------- lookup

/** "cancel the bank reminder" -> the one open reminder whose text has all those words. */
export function resolveReminder(db: Db, ref: string): { reminder: Reminder } | { reply: string } {
  const open = db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE status IN ('pending','dispatched') ORDER BY trigger_at`);
  const id = /^#?(\d+)$/.exec(ref.trim());
  if (id) {
    const r = open.find((x) => x.id === Number(id[1]));
    return r ? { reminder: r } : { reply: `No open reminder #${id[1]}. See /reminders.` };
  }
  const words = norm(ref).split(" ").filter((w) => w.length > 2 && !["the", "reminder", "remind", "about", "for", "one", "task"].includes(w));
  const hits = open.filter((r) => words.length > 0 && words.every((w) => norm(r.text).includes(w)));
  if (hits.length === 1) return { reminder: hits[0] };
  if (hits.length === 0) return { reply: `No open reminder matches "${esc(ref)}". See /reminders.` };
  return { reply: `Which one?\n${hits.slice(0, 5).map((r) => `• <code>#${r.id}</code> ${esc(r.text)}`).join("\n")}\n<i>/cancel &lt;id&gt; or /done &lt;id&gt;</i>` };
}

// ------------------------------------------------------------------ display

export function whenText(r: Reminder, nowMs: number): string {
  if (r.due_date) return `by ${dateLabel(r.due_date)}`;
  const rep = r.repeat_rule ? ` · ${describeRepeat(r.repeat_rule)}` : "";
  return `${formatWhen(r.trigger_at, nowMs)} <i>(${formatIn(r.trigger_at, nowMs)})</i>${rep}`;
}

/** Tasks with a date and no time: due on or before `date`, still open. */
export function tasksDue(db: Db, date: string): Reminder[] {
  return db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE due_date IS NOT NULL AND due_date <= ? AND status = 'pending' ORDER BY due_date, id`, date);
}

/** Fired but never answered, in the last day: shown once in the evening recap. */
export function unanswered(db: Db, nowMs: number): Reminder[] {
  return db.all<Reminder>(
    `SELECT ${COLS} FROM reminders WHERE status = 'dispatched' AND fired_at >= ? ORDER BY trigger_at`,
    new Date(nowMs - 24 * 3600_000).toISOString(),
  );
}

/** Morning line: today's and overdue date-only tasks. */
export function morningTaskLine(db: Db, date: string): string {
  const due = tasksDue(db, date);
  if (due.length === 0) return "";
  return `📌 ${due.map((t) => `${esc(t.text)}${t.due_date! < date ? " <i>(overdue)</i>" : t.due_date === date ? " <i>(today)</i>" : ""} <code>/done ${t.id}</code>`).join(" · ")}`;
}

/** Evening lines: reminders that fired and got no answer, and tasks due by tomorrow. */
export function eveningOpenLines(db: Db, today: string, nowMs: number): string[] {
  const lines: string[] = [];
  const open = unanswered(db, nowMs);
  if (open.length) lines.push(`⏰ Still open: ${open.map((r) => `${esc(r.text)} <code>/done ${r.id}</code>`).join(" · ")}`);
  const tasks = tasksDue(db, addDays(today, 1));
  if (tasks.length) lines.push(`📌 Due: ${tasks.map((t) => `${esc(t.text)} <i>(${t.due_date! <= today ? (t.due_date! < today ? "overdue" : "today") : "tomorrow"})</i> <code>/done ${t.id}</code>`).join(" · ")}`);
  return lines;
}

/** /reminders: coming up, open, and tasks, each with its id. */
export function renderReminderList(db: Db, nowMs: number): string {
  const upcoming = db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE status = 'pending' AND due_date IS NULL ORDER BY trigger_at LIMIT 15`);
  const open = db.all<Reminder>(
    `SELECT ${COLS} FROM reminders WHERE status = 'dispatched' AND fired_at >= ? ORDER BY trigger_at LIMIT 10`,
    new Date(nowMs - 7 * 86_400_000).toISOString(),
  );
  const tasks = db.all<Reminder>(`SELECT ${COLS} FROM reminders WHERE status = 'pending' AND due_date IS NOT NULL ORDER BY due_date LIMIT 15`);
  if (upcoming.length + open.length + tasks.length === 0) return "📭 No reminders. Say <i>remind me Friday 4pm to call the bank</i>.";
  const line = (r: Reminder) => `• <code>#${r.id}</code> ${esc(r.text)} — ${whenText(r, nowMs)}`;
  const parts: string[] = [];
  if (upcoming.length) parts.push(`⏰ <b>Coming up</b>\n${upcoming.map(line).join("\n")}`);
  if (open.length) parts.push(`🔔 <b>Fired, not marked done</b>\n${open.map(line).join("\n")}`);
  if (tasks.length) parts.push(`📌 <b>To do by a date</b>\n${tasks.map(line).join("\n")}`);
  return `${parts.join("\n\n")}\n\n<i>/done &lt;id&gt; · /cancel &lt;id&gt; · or say "cancel the bank reminder"</i>`;
}

export const REMINDER_BUTTONS = (id: number) => [[
  { text: "✅ Done", data: `r:done:${id}` },
  { text: "⏰ 1h", data: `r:snooze:${id}` },
  { text: "📅 Tomorrow", data: `r:tmrw:${id}` },
]];
