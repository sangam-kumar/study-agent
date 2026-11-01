// Agent nudges (spec §12): rules choose, code budgets, a template words it. Reminders you set are a
// separate channel and never count here.
//
//   budget   ≤ 3 agent-started messages a day (morning fallback, evening, ≤ 1 nudge); the evening is
//            always kept free, so a nudge only goes out if it leaves room for it
//   quiet    nothing before you're up (a wake event) or after 22:30; nothing within 90 min of another
//   lanes    nothing on a day with an override (sick, travel, out, low), or while paused
//   ignored  two nudges in a row with no answer -> no more nudges until next week
//   silence  2 days without a word from you -> one "pause or keep going?" and then quiet
//
// The one nudge type built: closure. At 18:00, the first planned, non-optional gym or study item
// still open gets one message with Done / Skip / Later. Every nudge cites a plan item, else none.

import type { Db } from "./db/db.ts";
import { getConfig, loadItems, recordEvent } from "./day.ts";
import type { ItemRow } from "./day.ts";
import { addDays, dayKey, istWallToMs, weekStart } from "./time.ts";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type AgentMessageKind = "morning" | "evening" | "nudge" | "pause_check";

/** Every message the agent starts on its own is counted against the day's budget. */
export function recordAgentMessage(db: Db, kind: AgentMessageKind, nowMs: number, payload: Record<string, unknown> = {}): void {
  recordEvent(db, "agent_message", dayKey(nowMs), { kind, ...payload }, nowMs);
}

export function agentMessagesToday(db: Db, nowMs: number): { count: number; lastMs: number | null } {
  const rows = db.all<{ ts: string }>("SELECT ts FROM event WHERE type = 'agent_message' AND ref_id = ? ORDER BY id", dayKey(nowMs));
  return { count: rows.length, lastMs: rows.length ? Date.parse(rows[rows.length - 1].ts) : null };
}

function muted(db: Db, nowMs: number): boolean {
  try {
    const m = JSON.parse(getConfig(db, "mute", "{}")) as { until?: number };
    return !!m.until && m.until > nowMs;
  } catch {
    return false;
  }
}

/** The last two nudge outcomes this week were both "ignored". */
export function nudgesStoppedThisWeek(db: Db, nowMs: number): boolean {
  const from = weekStart(dayKey(nowMs));
  const last = db.all<{ type: string }>(
    "SELECT type FROM event WHERE type IN ('nudge_acted','nudge_ignored') AND ref_id >= ? ORDER BY id DESC LIMIT 2", from,
  );
  return last.length === 2 && last.every((e) => e.type === "nudge_ignored");
}

export type Gate = { ok: true } | { ok: false; reason: string };

export function nudgeGate(db: Db, nowMs: number): Gate {
  const today = dayKey(nowMs);
  if (getConfig(db, "nudges", "on") === "off") return { ok: false, reason: "nudges are off (/nudges on)" };
  if (muted(db, nowMs)) return { ok: false, reason: "my messages are paused" };
  const ov = db.all("SELECT 1 FROM override WHERE revoked_at IS NULL AND start_date <= ? AND end_date >= ?", today, today);
  if (ov.length > 0) return { ok: false, reason: "an override is on today" };
  if (db.all("SELECT 1 FROM event WHERE type = 'wake' AND ref_id = ?", today).length === 0) return { ok: false, reason: "you're not up yet" };
  if (nowMs >= istWallToMs(today, getConfig(db, "quiet_hours_start", "22:30"))) return { ok: false, reason: "quiet hours" };
  const cap = Number(getConfig(db, "nudge_cap_per_day", "3")) || 3;
  const sent = agentMessagesToday(db, nowMs);
  // The evening message is still to come today: keep a slot for it.
  if (sent.count + 1 >= cap) return { ok: false, reason: `the day's ${cap} messages are used` };
  if (sent.lastMs !== null && nowMs - sent.lastMs < 90 * 60_000) return { ok: false, reason: "a message went out in the last 90 minutes" };
  if (nudgesStoppedThisWeek(db, nowMs)) return { ok: false, reason: "the last two nudges went unanswered, so none until Monday" };
  if (db.all("SELECT 1 FROM event WHERE type = 'nudge_sent' AND ref_id = ?", today).length > 0) return { ok: false, reason: "today's nudge already went out" };
  return { ok: true };
}

/** The item a closure nudge is about: gym first (it anchors the day), then study. Optional items never. */
export function pickNudge(db: Db, today: string): ItemRow | null {
  const open = loadItems(db, today).filter((i) => i.status === "planned" && !i.optional && (i.lane === "fitness" || i.lane === "study"));
  return open[0] ?? null;
}

export function nudgeText(item: ItemRow): string {
  return `${item.lane === "fitness" ? "🏋️" : "📚"} <b>${esc(item.title)}</b> is still open for today. Did it happen?`;
}

export const NUDGE_BUTTONS = (itemId: number) => [[
  { text: "✅ Done", data: `n:done:${itemId}` },
  { text: "⏭ Skip", data: `n:skip:${itemId}` },
  { text: "Later", data: `n:later:${itemId}` },
]];

export function recordNudgeSent(db: Db, item: ItemRow, nowMs: number): void {
  recordEvent(db, "nudge_sent", dayKey(nowMs), { trigger: "closure", item_id: item.id }, nowMs, item.lane);
  recordAgentMessage(db, "nudge", nowMs, { item_id: item.id });
}

export function recordNudgeAnswer(db: Db, nowMs: number, answer: string, itemId: number): void {
  recordEvent(db, "nudge_acted", dayKey(nowMs), { answer, item_id: itemId }, nowMs);
}

/** Evening: today's nudge with no answer counts as ignored. */
export function closeIgnoredNudge(db: Db, today: string, nowMs: number): boolean {
  const sent = db.all("SELECT 1 FROM event WHERE type = 'nudge_sent' AND ref_id = ?", today).length > 0;
  const answered = db.all("SELECT 1 FROM event WHERE type IN ('nudge_acted','nudge_ignored') AND ref_id = ?", today).length > 0;
  if (!sent || answered) return false;
  recordEvent(db, "nudge_ignored", today, {}, nowMs);
  return true;
}

// ------------------------------------------------------------------ silence

/** When you last sent anything (any update), or null if nothing is on record. */
export function lastHeardMs(db: Db): number | null {
  const ts = db.all<{ ts: string | null }>("SELECT MAX(ts) AS ts FROM processed_update")[0]?.ts;
  return ts ? Date.parse(ts) : null;
}

/** Two days without a word, and not asked since: time for the one "pause or keep going?" */
export function shouldAskPause(db: Db, nowMs: number): boolean {
  const last = lastHeardMs(db);
  if (last === null || nowMs - last < 48 * 3600_000) return false;
  const asked = db.all<{ ts: string }>("SELECT ts FROM event WHERE type = 'agent_message' AND json_extract(payload_json, '$.kind') = 'pause_check' ORDER BY id DESC LIMIT 1")[0];
  return !asked || Date.parse(asked.ts) < last;
}

export function pauseQuestion(db: Db, nowMs: number): string {
  const last = lastHeardMs(db);
  const days = last === null ? 2 : Math.floor((nowMs - last) / 86_400_000);
  return `👋 I haven't heard from you in ${days} days, so I'll go quiet. Your plan still locks itself each night and your reminders still fire.\n\nWant me to keep sending the morning and evening messages?`;
}

export const PAUSE_BUTTONS = [[
  { text: "Keep going", data: "p:resume:0" },
  { text: "Pause a week", data: "p:week:0" },
]];

/** How long the quiet lasts after the question if you never answer: until you write again. */
export const SILENT_MUTE_DAYS = 30;

export function nudgeStatus(db: Db, nowMs: number): string {
  const sent = agentMessagesToday(db, nowMs);
  const gate = nudgeGate(db, nowMs);
  const cap = Number(getConfig(db, "nudge_cap_per_day", "3")) || 3;
  const at = getConfig(db, "nudge_time", "18:00");
  const lines = [
    `📣 <b>Messages I start</b> (your reminders don't count)`,
    `• Today: ${sent.count} of ${cap}`,
    `• Check-in nudge: ${getConfig(db, "nudges", "on") === "off" ? "off" : `on, at ${at} if something is still open`}`,
    `• Right now: ${gate.ok ? "a nudge could go out" : esc(gate.reason)}`,
  ];
  if (nudgesStoppedThisWeek(db, nowMs)) lines.push(`• Paused until ${addDays(weekStart(dayKey(nowMs)), 7)}: the last two went unanswered`);
  lines.push("", "<i>/nudges off · /nudges on</i>");
  return lines.join("\n");
}
