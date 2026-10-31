// The small slice of state a model call needs, as plain text. Everything is capped so the
// packet stays small: the lane decides what is included.

import type { Db } from "./db/db.ts";
import type { Intent } from "./cards.ts";
import { istNowLabel } from "./reminder-time.ts";
import { currentReading, pickCandidates } from "./reading.ts";
import { queryPlan } from "./seed.ts";
import { loadItems } from "./day.ts";
import { addDays, dateLabel, dayKey } from "./time.ts";

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Intent -> the event lane whose recent history is worth showing. */
const EVENT_LANE: Partial<Record<Intent, string>> = { reading: "reading", study_done: "study", workout: "fitness" };

export function buildSnapshot(db: Db, intent: Intent, nowMs: number): string {
  const lines: string[] = [`Now: ${istNowLabel(nowMs)}.`];
  const today = dayKey(nowMs);

  const overrides = db.all<{ type: string; start_date: string; end_date: string }>(
    "SELECT type, start_date, end_date FROM override WHERE revoked_at IS NULL AND start_date <= ? AND end_date >= ? LIMIT 3",
    today, today,
  );
  if (overrides.length > 0) lines.push(`Active overrides: ${overrides.map((o) => `${o.type} ${o.start_date}..${o.end_date}`).join("; ")}.`);

  const notes = db.all<{ text: string }>(
    "SELECT text FROM note WHERE resolved_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 4",
    new Date(nowMs).toISOString(),
  );
  if (notes.length > 0) lines.push(`Notes: ${notes.map((n) => clip(n.text)).join(" | ")}`);

  if (intent === "plan" || intent === "override") {
    const days = Array.from({ length: 8 }, (_, i) => addDays(today, i));
    lines.push(`Calendar: ${days.map((d, i) => `${i === 0 ? "today " : i === 1 ? "tomorrow " : ""}${dateLabel(d)} = ${d}`).join("; ")}.`);
    if (intent === "plan") {
      for (const d of days.slice(0, 2)) {
        const items = loadItems(db, d);
        if (items.length > 0) lines.push(`${d === today ? "Today" : "Tomorrow"}: ${items.map((i) => `${clip(i.title, 50)} [${i.status}]`).join("; ")}.`);
      }
    }
  }

  if (intent === "reading") {
    const now = currentReading(db);
    if (now.length > 0) lines.push(`Reading now: ${now.map((r) => `${clip(r.title, 60)} (${r.state})`).join("; ")}.`);
    const held = db.all<{ title: string }>("SELECT title FROM reading_item WHERE state = 'paused' ORDER BY id LIMIT 3");
    if (held.length > 0) lines.push(`On hold: ${held.map((h) => clip(h.title, 60)).join("; ")}.`);
    const picks = pickCandidates(db, Math.floor(nowMs / 86_400_000));
    if (picks.length > 0) lines.push(`Suggested next: ${picks.map((p) => clip(p.title, 60)).join("; ")}.`);
    // So "the ML book" can be expanded to a real title.
    const shortlist = db.all<{ title: string }>(
      "SELECT title FROM reading_item WHERE shortlist = 1 AND state NOT IN ('done','dropped') ORDER BY slot, ordinal LIMIT 14",
    );
    if (shortlist.length > 0) lines.push(`Shortlist: ${shortlist.map((s) => clip(s.title, 45)).join("; ")}.`);
  }

  if (intent === "study_done") {
    for (const p of queryPlan(db)) {
      const next = p.finished ? "finished" : p.next ? `next: ${clip(p.next.title, 70)}` : "empty";
      lines.push(`List ${p.listId} — ${clip(p.trackTitle, 40)} / ${clip(p.listTitle, 40)} [${Math.min(p.ordinal, p.total)}/${p.total}] ${next}`);
    }
  }

  const lane = EVENT_LANE[intent];
  if (lane) {
    const events = db.all<{ payload_json: string | null }>(
      "SELECT payload_json FROM event WHERE lane = ? AND type <> 'seed' ORDER BY id DESC LIMIT 3",
      lane,
    );
    const summaries = events
      .map((e) => {
        try {
          return (JSON.parse(e.payload_json ?? "{}") as { summary?: string }).summary;
        } catch {
          return undefined;
        }
      })
      .filter((s): s is string => !!s);
    if (summaries.length > 0) lines.push(`Recent: ${summaries.map((s) => clip(s, 70)).join(" | ")}`);
  }

  return lines.join("\n");
}
