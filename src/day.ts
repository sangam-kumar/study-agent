// The day loop, database side: gather inputs for the pure planner, write drafts, lock, and render.
//   evening  -> recap of today + proposed tomorrow
//   23:00    -> auto-lock (silence is consent)
//   morning  -> deliver the locked plan; nothing to decide
// Drafts are written directly (not through ops) so they never clutter /undo. Everything the user
// changes afterwards goes through ops.

import type { Db } from "./db/db.ts";
import { bedtimeFor, draftDay } from "./plan.ts";
import type { DayKind, DraftDay, OverrideKind, Place, PlanInput, PlanReading, PlanUnit } from "./plan.ts";
import { currentReading } from "./reading.ts";
import { queryPlan } from "./seed.ts";
import { addDays, dateLabel, dayNumber, weekStart, weekdayIndex } from "./time.ts";

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------- config + events

export function getConfig(db: Db, key: string, fallback: string): string {
  return db.all<{ value: string }>("SELECT value FROM config WHERE key = ?", key)[0]?.value ?? fallback;
}

export function recordEvent(db: Db, type: string, refId: string | null, payload: unknown, nowMs: number, lane: string | null = null): void {
  db.run(
    "INSERT INTO event (ts, type, lane, ref_id, payload_json, source) VALUES (?, ?, ?, ?, ?, 'system')",
    new Date(nowMs).toISOString(), type, lane, refId, JSON.stringify(payload ?? {}),
  );
}

export function eventExists(db: Db, type: string, refId: string): boolean {
  return db.all("SELECT 1 FROM event WHERE type = ? AND ref_id = ? LIMIT 1", type, refId).length > 0;
}

// ----------------------------------------------------------------------- gather

interface DayRow {
  date: string;
  place: Place | null;
  wake_by: string | null;
  status: "draft" | "locked";
  locked_by: "user" | "auto" | null;
  version: number;
}

export function loadDayRow(db: Db, date: string): DayRow | null {
  return db.all<DayRow>("SELECT date, place, wake_by, status, locked_by, version FROM day_plan WHERE date = ?", date)[0] ?? null;
}

export interface ItemRow {
  id: number;
  date: string;
  lane: string;
  title: string;
  est_min: number | null;
  source: string;
  status: string;
  ref: string | null;
  unit_id: number | null;
  optional: number;
}

export function loadItems(db: Db, date: string): ItemRow[] {
  return db.all<ItemRow>(
    `SELECT id, date, lane, title, est_min, source, status, ref, unit_id, optional FROM plan_item WHERE date = ?
      ORDER BY CASE lane WHEN 'fitness' THEN 0 WHEN 'study' THEN 1 WHEN 'reading' THEN 2 ELSE 3 END, id`,
    date,
  );
}

function nextUnits(db: Db): Record<string, PlanUnit | undefined> {
  const out: Record<string, PlanUnit | undefined> = {};
  for (const p of queryPlan(db)) {
    if (p.finished || !p.next) continue;
    const row = db.all<{ id: number; size: "fragment" | "block"; est_min: number | null }>(
      "SELECT id, size, est_min FROM unit WHERE list_id = ? AND ordinal = ?", p.listId, p.ordinal,
    )[0];
    if (row) out[p.listId] = { unitId: row.id, listId: p.listId, ordinal: p.ordinal, title: p.next.title, size: row.size, estMin: row.est_min };
  }
  return out;
}

function pickReading(db: Db, dn: number): PlanReading | null {
  const now = currentReading(db);
  if (now.length > 0) {
    const r = now[dn % now.length];
    return { id: r.id, title: r.title, kind: "book" };
  }
  const q = db.all<{ id: number; title: string }>("SELECT id, title FROM reading_item WHERE state = 'queued' ORDER BY ordinal, id LIMIT 1")[0];
  return q ? { id: q.id, title: q.title, kind: "article" } : null;
}

function countDone(db: Db, where: string, from: string, to: string): number {
  return db.all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM plan_item WHERE status = 'done' AND date >= ? AND date <= ? AND ${where}`, from, to,
  )[0].c;
}

export function gatherPlanInput(db: Db, date: string): PlanInput {
  const weekday = weekdayIndex(date);
  const pat = db.all<{ kind: DayKind; note: string | null }>("SELECT kind, note FROM pattern WHERE weekday = ?", weekday)[0];

  const overrides = db
    .all<{ type: OverrideKind }>("SELECT type FROM override WHERE revoked_at IS NULL AND start_date <= ? AND end_date >= ?", date, date)
    .map((o) => o.type);

  const rotCount = db.all<{ c: number }>("SELECT COUNT(*) AS c FROM rotation WHERE lane = 'fitness'")[0].c;
  let rotation: PlanInput["rotation"] = null;
  if (rotCount > 0) {
    const want = Number(getConfig(db, "rotation.fitness", "1"));
    const ordinal = Number.isInteger(want) && want >= 1 && want <= rotCount ? want : 1;
    const label = db.all<{ label: string }>("SELECT label FROM rotation WHERE lane = 'fitness' AND ordinal = ?", ordinal)[0]?.label;
    if (label) rotation = { ordinal, label };
  }

  const floor = db.all<{ floor: number | null }>(
    "SELECT floor FROM target WHERE lane = 'fitness' AND metric = 'lift_sessions' AND period = 'week'",
  )[0]?.floor;

  const week = weekStart(date);
  const day = loadDayRow(db, date);
  const dn = dayNumber(date);

  return {
    date,
    weekday,
    kind: pat?.kind ?? "REST",
    patternNote: pat?.note ?? null,
    place: day?.place ?? (getConfig(db, "default_place", "REMOTE") === "OFFICE" ? "OFFICE" : "REMOTE"),
    overrides,
    gymWakeBy: getConfig(db, "gym_wake_by", "07:00"),
    rotation,
    liftsDone: countDone(db, "lane = 'fitness' AND ref LIKE 'rotation:%'", week, date),
    liftFloor: floor ?? 2,
    gymSlotsLeft: db.all<{ c: number }>("SELECT COUNT(*) AS c FROM pattern WHERE kind = 'GYM' AND weekday > ? AND weekday <= 5", weekday)[0].c,
    next: nextUnits(db),
    dayNumber: dn,
    reading: pickReading(db, dn),
  };
}

// -------------------------------------------------------------------- draft/lock

export type EnsureResult = { locked: true } | { locked: false; draft: DraftDay };

/**
 * Write (or refresh) the draft for a date. Items the user added, and anything already done or
 * skipped, stay. A locked day is left alone unless `force` (an explicit override such as "I'm sick"
 * re-plans it; it stays locked).
 */
export function ensureDraft(db: Db, date: string, nowMs: number, opts: { force?: boolean } = {}): EnsureResult {
  const row = loadDayRow(db, date);
  if (row?.status === "locked" && !opts.force) return { locked: true };

  const draft = draftDay(gatherPlanInput(db, date));
  db.transaction(() => {
    if (row) db.run("UPDATE day_plan SET wake_by = ?, version = version + 1 WHERE date = ?", draft.wake_by, date);
    else db.run("INSERT INTO day_plan (date, place, wake_by, status, version) VALUES (?, NULL, ?, 'draft', 1)", date, draft.wake_by);

    db.run("DELETE FROM plan_item WHERE date = ? AND source IN ('pattern','pointer','minimum') AND status = 'planned'", date);
    // Skip what is already accounted for: kept on this day (moved here, done, skipped) or moved to a later day.
    const taken = new Set(
      db.all<{ ref: string }>(
        "SELECT ref FROM plan_item WHERE ref IS NOT NULL AND (date = ? OR (date > ? AND status = 'planned'))", date, date,
      ).map((r) => r.ref),
    );
    for (const it of draft.items) {
      if (it.ref && taken.has(it.ref)) continue;
      db.run(
        "INSERT INTO plan_item (date, lane, title, ref, est_min, unit_id, source, status, optional) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)",
        date, it.lane, it.title, it.ref, it.est_min, it.unit_id, it.source, it.optional ? 1 : 0,
      );
    }
    recordEvent(db, "draft", date, { items: draft.items.length, kind: draft.kind }, nowMs);
  });
  return { locked: false, draft };
}

/** Lock a date (drafting it first if needed). Returns false when it was already locked. */
export function lockDay(db: Db, date: string, by: "user" | "auto", nowMs: number): boolean {
  if (loadDayRow(db, date)?.status !== "locked") ensureDraft(db, date, nowMs);
  const row = loadDayRow(db, date);
  if (!row || row.status === "locked") return false;
  db.run("UPDATE day_plan SET status = 'locked', locked_by = ?, locked_at = ? WHERE date = ?", by, new Date(nowMs).toISOString(), date);
  recordEvent(db, "lock", date, { by }, nowMs);
  return true;
}

// ------------------------------------------------------------------------ render

const ICON: Record<string, string> = { fitness: "🏋️", study: "📚", reading: "📖" };
const STATUS_MARK: Record<string, string> = { done: "✅ ", skipped: "⏭ ", dropped: "✖ ", planned: "" };

function itemLine(it: ItemRow): string {
  const tag = it.optional ? " <i>(optional)</i>" : "";
  const mins = it.est_min ? ` <i>~${it.est_min}m</i>` : "";
  return `• ${STATUS_MARK[it.status] ?? ""}${ICON[it.lane] ?? "▫️"} ${esc(it.title)}${mins}${tag}`;
}

export function renderDayBlock(db: Db, date: string): string {
  const items = loadItems(db, date);
  const row = loadDayRow(db, date);
  const lines = items.length > 0 ? items.map(itemLine) : ["• Nothing planned."];
  const meta: string[] = [];
  if (row?.place) meta.push(row.place === "OFFICE" ? "🏢 office" : "🏠 remote");
  if (row?.wake_by) meta.push(`up by ${row.wake_by}`);
  return `${meta.length ? `<i>${meta.join(" · ")}</i>\n` : ""}${lines.join("\n")}`;
}

function weeklyLine(db: Db, date: string): string {
  const week = weekStart(date);
  const lifts = countDone(db, "lane = 'fitness' AND ref LIKE 'rotation:%'", week, date);
  const floor = db.all<{ floor: number | null }>("SELECT floor FROM target WHERE lane = 'fitness' AND metric = 'lift_sessions' AND period = 'week'")[0]?.floor ?? 2;
  const reads = countDone(db, "lane = 'reading'", week, date);
  const readFloor = db.all<{ floor: number | null }>("SELECT floor FROM target WHERE lane = 'reading' AND metric = 'items' AND period = 'week'")[0]?.floor ?? 1;
  const parts: string[] = [];
  if (lifts < floor) parts.push(`lifts ${lifts}/${floor}`);
  if (reads < readFloor && weekdayIndex(date) >= 3) parts.push(`reading ${reads}/${readFloor}`);
  return parts.length ? `This week so far: ${parts.join(" · ")}` : "";
}

function bedtimeLine(db: Db, date: string): string {
  const row = loadDayRow(db, date);
  if (!row?.wake_by) return "";
  const sleepGoal = db.all<{ goal: number | null }>("SELECT goal FROM target WHERE metric = 'sleep_h_avg' AND period = 'week'")[0]?.goal ?? 8;
  const gym = loadItems(db, date).find((i) => i.lane === "fitness" && i.ref?.startsWith("rotation:"));
  const what = gym ? gym.title.replace(/^Gym:\s*/, "") : "Gym";
  return `${esc(what)} tomorrow, up by ${row.wake_by} → lights out ~${bedtimeFor(row.wake_by, sleepGoal)}.`;
}

/** The 21:30 message: how today went, and tomorrow as it will be locked. */
export function renderEvening(db: Db, today: string): string {
  const tomorrow = addDays(today, 1);
  const todays = loadItems(db, today);
  const recap = todays.length === 0
    ? "No plan was set for today."
    : todays.map((i) => `${STATUS_MARK[i.status] || "⬜ "}${esc(i.title)}`).join("  ·  ");

  const lines = [`🌙 <b>${dateLabel(today)}</b>`, recap];
  const weekly = weeklyLine(db, today);
  if (weekly) lines.push(`<i>${weekly}</i>`);
  lines.push("", `<b>Tomorrow — ${dateLabel(tomorrow)}</b>`, renderDayBlock(db, tomorrow));
  const bed = bedtimeLine(db, tomorrow);
  if (bed) lines.push("", bed);
  lines.push("", `Change anything ("skip gym", "add call mom") or say <b>ok</b> to lock. It locks itself at 23:00.`);
  return lines.join("\n");
}

/** The morning message: the locked plan, filled in. */
export function renderMorning(db: Db, date: string): string {
  const row = loadDayRow(db, date);
  const mark = row?.locked_by === "auto" ? " <i>(locked last night)</i>" : row?.status === "draft" ? " <i>(draft)</i>" : "";
  return [`☀️ <b>${dateLabel(date)}</b>${mark}`, renderDayBlock(db, date), "", `<i>Tell me as you go: "done with gym", "skip reading", "feeling low". /plan to see this again.</i>`].join("\n");
}

export function renderPlan(db: Db, date: string): string {
  const row = loadDayRow(db, date);
  const state = row ? (row.status === "locked" ? `locked (${row.locked_by})` : "draft") : "not planned yet";
  return `📋 <b>${dateLabel(date)}</b> — ${state}\n${renderDayBlock(db, date)}`;
}

// ------------------------------------------------------------------- resolution

const LANE_WORDS: Record<string, string> = {
  gym: "fitness", workout: "fitness", lift: "fitness", lifting: "fitness", mobility: "fitness", fitness: "fitness", exercise: "fitness",
  study: "study", studying: "study",
  reading: "reading", read: "reading", book: "reading", article: "reading",
};

/**
 * Finds one plan item on the given dates (in order of preference) from a word or title fragment.
 * Returns the item, or an HTML reply when nothing or several things match.
 */
export function resolvePlanItem(db: Db, ref: string, dates: string[], statuses: string[]): { item: ItemRow } | { reply: string } {
  const want = ref.trim().toLowerCase();
  for (const date of dates) {
    const items = loadItems(db, date).filter((i) => statuses.includes(i.status));
    const byTitle = items.filter((i) => i.title.toLowerCase().includes(want));
    const lane = LANE_WORDS[want];
    const hits = byTitle.length > 0 ? byTitle : lane ? items.filter((i) => i.lane === lane) : [];
    if (hits.length === 1) return { item: hits[0] };
    if (hits.length > 1) {
      const required = hits.filter((i) => !i.optional);
      if (required.length === 1) return { item: required[0] };
      return { reply: `Which one on ${dateLabel(date)}?\n${hits.map((i) => `• ${esc(i.title)}`).join("\n")}` };
    }
  }
  return { reply: `I couldn't find "${esc(ref)}" in the plan for ${dates.map(dateLabel).join(" or ")}. /plan shows it.` };
}
