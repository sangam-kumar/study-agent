// The Sunday summary (spec §5b, §12): the week from the database, in a few lines. On the first Sunday
// of a month it adds the month just gone. Sent with Sunday's evening message and written into
// Sunday's daily note. Targets are shown as numbers, not verdicts.

import type { Db } from "./db/db.ts";
import { formatHours, sleepNights } from "./day.ts";
import { weekFitness } from "./fitness.ts";
import { addDays, dateLabel, istWallToMs, weekStart } from "./time.ts";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Study units moved on per list in [fromMs, toMs): from the pointer changes in undo history (undone ones excluded). */
export function unitsAdvanced(db: Db, fromMs: number, toMs: number): Map<string, number> {
  const out = new Map<string, number>();
  const revs = db.all<{ diff_json: string }>(
    "SELECT diff_json FROM revision WHERE undone_at IS NULL AND ts >= ? AND ts < ?", new Date(fromMs).toISOString(), new Date(toMs).toISOString(),
  );
  for (const r of revs) {
    let changes: { table: string; key: string; before: { ordinal?: number } | null; after: { ordinal?: number } | null }[] = [];
    try {
      changes = JSON.parse(r.diff_json);
    } catch {}
    for (const c of changes) {
      if (c.table !== "pointer") continue;
      const delta = (c.after?.ordinal ?? 1) - (c.before?.ordinal ?? 1);
      if (delta > 0) out.set(String(c.key), (out.get(String(c.key)) ?? 0) + delta);
    }
  }
  return out;
}

interface Period {
  from: string; // first day
  to: string; // last day
}

function planCounts(db: Db, p: Period): { done: number; total: number; extras: number } {
  const rows = db.all<{ status: string; optional: number }>(
    "SELECT status, optional FROM plan_item WHERE date >= ? AND date <= ? AND status <> 'dropped'", p.from, p.to,
  );
  const core = rows.filter((r) => !r.optional);
  return { done: core.filter((r) => r.status === "done").length, total: core.length, extras: rows.filter((r) => r.optional && r.status === "done").length };
}

function readingCounts(db: Db, fromMs: number, toMs: number): { finished: string[]; started: string[]; dropped: string[] } {
  const f = new Date(fromMs).toISOString();
  const t = new Date(toMs).toISOString();
  const titles = (sql: string) => db.all<{ title: string }>(sql, f, t).map((r) => r.title);
  return {
    finished: titles("SELECT title FROM reading_item WHERE state = 'done' AND ended_at >= ? AND ended_at < ? ORDER BY ended_at"),
    started: titles("SELECT title FROM reading_item WHERE started_at >= ? AND started_at < ? AND state IN ('sampling','active','paused') ORDER BY started_at"),
    dropped: titles("SELECT title FROM reading_item WHERE state = 'dropped' AND ended_at >= ? AND ended_at < ? ORDER BY ended_at"),
  };
}

function listTitles(db: Db): Map<string, string> {
  return new Map(db.all<{ id: string; title: string }>("SELECT id, title FROM unit_list").map((l) => [l.id, l.title]));
}

/** Plain lines (no HTML) for one week ending on `sunday`. */
export function weeklyLines(db: Db, sunday: string): string[] {
  const p: Period = { from: weekStart(sunday), to: sunday };
  const fromMs = istWallToMs(p.from, "03:00");
  const toMs = istWallToMs(addDays(p.to, 1), "03:00");
  const lines: string[] = [`Week of ${dateLabel(p.from)} – ${dateLabel(p.to)}`];

  const w = weekFitness(db, sunday);
  const lift = w.target("lift_sessions");
  const mob = w.target("mobility_sessions");
  const pro = w.target("protein_g_avg");
  const fit = [`lifts ${w.lifts}/${lift.goal ?? 3}`, `mobility ${w.mobility}/${mob.goal ?? 2}`];
  if (w.proteinAvg !== null) fit.push(`protein ${Math.round(w.proteinAvg)} g a day over ${w.proteinDays} day${w.proteinDays === 1 ? "" : "s"} (aim ${pro.goal ?? 120})`);
  lines.push(`🏋️ ${fit.join(" · ")}`);

  const nights = sleepNights(db, p.from, p.to);
  if (nights.length > 0) {
    const avg = nights.reduce((a, n) => a + n.hours, 0) / nights.length;
    lines.push(`😴 sleep ${formatHours(avg)} a night over ${nights.length} night${nights.length === 1 ? "" : "s"}`);
  }

  const units = unitsAdvanced(db, fromMs, toMs);
  const names = listTitles(db);
  const total = [...units.values()].reduce((a, b) => a + b, 0);
  lines.push(total > 0 ? `📚 ${total} study unit${total === 1 ? "" : "s"}: ${[...units].map(([id, n]) => `${names.get(id) ?? id} +${n}`).join(", ")}` : "📚 no study units moved on");

  const r = readingCounts(db, fromMs, toMs);
  const reading: string[] = [];
  if (r.finished.length) reading.push(`finished ${r.finished.join(", ")}`);
  if (r.started.length) reading.push(`started ${r.started.join(", ")}`);
  if (r.dropped.length) reading.push(`dropped ${r.dropped.join(", ")}`);
  const readDone = db.all<{ c: number }>("SELECT COUNT(*) AS c FROM plan_item WHERE lane = 'reading' AND status = 'done' AND date >= ? AND date <= ?", p.from, p.to)[0].c;
  if (readDone) reading.push(`read on ${readDone} day${readDone === 1 ? "" : "s"}`);
  lines.push(`📖 ${reading.length ? reading.join(" · ") : "no reading logged"}`);

  const plan = planCounts(db, p);
  if (plan.total > 0) lines.push(`📋 kept ${plan.done} of ${plan.total} planned${plan.extras ? `, plus ${plan.extras} optional` : ""}`);

  const rem = db.all<{ status: string; c: number }>(
    "SELECT status, COUNT(*) AS c FROM reminders WHERE (done_at >= ? AND done_at < ?) OR (status = 'dispatched' AND fired_at >= ? AND fired_at < ?) GROUP BY status",
    new Date(fromMs).toISOString(), new Date(toMs).toISOString(), new Date(fromMs).toISOString(), new Date(toMs).toISOString(),
  );
  const done = rem.find((x) => x.status === "done")?.c ?? 0;
  const open = rem.find((x) => x.status === "dispatched")?.c ?? 0;
  if (done || open) lines.push(`⏰ reminders: ${done} done${open ? ` · ${open} still open` : ""}`);

  // First Sunday of the month: the month just gone, summed.
  if (Number(sunday.slice(8, 10)) <= 7) lines.push(...monthLines(db, sunday));
  return lines;
}

function monthLines(db: Db, sunday: string): string[] {
  const [y, m] = sunday.split("-").map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const from = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
  const to = addDays(`${y}-${String(m).padStart(2, "0")}-01`, -1);
  const lifts = db.all<{ c: number }>("SELECT COUNT(*) AS c FROM workout_session WHERE kind = 'lift' AND date >= ? AND date <= ?", from, to)[0].c;
  const units = [...unitsAdvanced(db, istWallToMs(from, "03:00"), istWallToMs(addDays(to, 1), "03:00")).values()].reduce((a, b) => a + b, 0);
  const books = db.all<{ c: number }>("SELECT COUNT(*) AS c FROM reading_item WHERE state = 'done' AND ended_at >= ? AND ended_at < ?", `${from}T00:00`, `${addDays(to, 1)}T00:00`)[0].c;
  const plan = planCounts(db, { from, to });
  const month = new Date(Date.UTC(prevY, prevM - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
  return [`🗓 ${month}: ${lifts} lifts · ${units} study units · ${books} finished · kept ${plan.done} of ${plan.total} planned`];
}

export function renderWeekly(db: Db, sunday: string): string {
  const [head, ...rest] = weeklyLines(db, sunday);
  return [`📊 <b>${esc(head)}</b>`, ...rest.map(esc)].join("\n");
}

export function weeklyMarkdown(db: Db, sunday: string): string[] {
  const [head, ...rest] = weeklyLines(db, sunday);
  return ["", `**${head}**`, ...rest.map((l) => `- ${l}`)];
}
