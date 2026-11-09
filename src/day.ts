// The day loop, database side: gather inputs for the pure planner, write drafts, lock, and render.
//   evening  -> recap of today + proposed tomorrow
//   23:00    -> auto-lock (silence is consent)
//   morning  -> deliver the locked plan; nothing to decide
// Drafts are written directly (not through ops) so they never clutter /undo. Everything the user
// changes afterwards goes through ops.

import type { Db } from "./db/db.ts";
import type { ChooseOption } from "./convo.ts";
import { bedtimeFor, draftDay } from "./plan.ts";
import type { DayKind, DraftDay, OverrideKind, Place, PlanInput, PlanReading, PlanUnit } from "./plan.ts";
import { currentReading } from "./reading.ts";
import { proteinFor, weeklyFitnessParts } from "./fitness.ts";
import { eveningOpenLines, morningTaskLine } from "./reminders.ts";
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
  const reads = countDone(db, "lane = 'reading'", week, date);
  const readFloor = db.all<{ floor: number | null }>("SELECT floor FROM target WHERE lane = 'reading' AND metric = 'items' AND period = 'week'")[0]?.floor ?? 1;
  // Only what is below its floor: lifts, mobility (from Thursday), protein average.
  const parts: string[] = weeklyFitnessParts(db, date);
  if (reads < readFloor && weekdayIndex(date) >= 3) parts.push(`reading ${reads}/${readFloor}`);
  const nights = sleepNights(db, week, date);
  const sleepFloor = db.all<{ floor: number | null }>("SELECT floor FROM target WHERE metric = 'sleep_h_avg' AND period = 'week'")[0]?.floor ?? 7;
  if (nights.length >= 2) {
    const avg = nights.reduce((a, n) => a + n.hours, 0) / nights.length;
    if (avg < sleepFloor) parts.push(`sleep ${avg.toFixed(1)} h a night (aim ${sleepFloor}+)`);
  }
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
export function renderEvening(db: Db, today: string, nowMs = Date.now()): string {
  const tomorrow = addDays(today, 1);
  const todays = loadItems(db, today);
  const recap = todays.length === 0
    ? "No plan was set for today."
    : todays.map((i) => `${STATUS_MARK[i.status] || "⬜ "}${esc(i.title)}`).join("  ·  ");

  const lines = [`🌙 <b>${dateLabel(today)}</b>`, recap];
  const weekly = weeklyLine(db, today);
  if (weekly) lines.push(`<i>${weekly}</i>`);
  lines.push(...eveningOpenLines(db, today, nowMs));
  const protein = proteinFor(db, today);
  lines.push(protein === null ? "🥩 Protein today? Reply e.g. <b>protein 110</b>." : `🥩 Protein ${protein} g`);
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
  const slept = sleepNights(db, date, date)[0];
  const sleepLine = slept ? `
<i>😴 slept ${formatHours(slept.hours)}</i>` : "";
  const tasks = morningTaskLine(db, date);
  return [`☀️ <b>${dateLabel(date)}</b>${mark}${sleepLine}`, renderDayBlock(db, date), ...(tasks ? [tasks] : []), "", `<i>Tell me as you go: "done with gym", "skip reading", "feeling low". /plan to see this again.</i>`].join("\n");
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
export function resolvePlanItem(db: Db, ref: string, dates: string[], statuses: string[]): { item: ItemRow } | { reply: string; options?: ChooseOption[] } {
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
      return {
        reply: `Which one on ${dateLabel(date)}?\n${hits.map((i, n) => `${n + 1}. ${esc(i.title)}`).join("\n")}\n<i>Reply with a number, "all", or "neither".</i>`,
        options: hits.map((i) => ({ id: i.id, title: i.title })),
      };
    }
  }
  return { reply: `I couldn't find "${esc(ref)}" in the plan for ${dates.map(dateLabel).join(" or ")}. /plan shows it.` };
}

// ------------------------------------------------------------------ office days

const DAY_PREFIX = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "office tue thu", "in office monday and wednesday", "I'm in the office on Tue": group 1 is the days. */
export const OFFICE_RE = /^(?:i'?m\s+|i am\s+)?(?:in\s+(?:the\s+)?)?(?:office|wfo)(?:\s+days?)?(?:\s+on)?[\s:]+(.+)$/i;

/** "tue thu", "Tuesday and Thursday", "mon, wed" -> [1, 3]. null if a word isn't a weekday or nothing is named. */
export function parseWeekdays(text: string): number[] | null {
  const words = text.toLowerCase().split(/[\s,&/+]+/).filter((w) => w && !["and", "on", "days", "day"].includes(w));
  if (words.length === 0) return null;
  const out = new Set<number>();
  for (const w of words) {
    const i = DAY_PREFIX.findIndex((p) => w.startsWith(p)); // tue, tues, tuesday
    if (i < 0) return null;
    out.add(i);
  }
  return [...out].sort();
}

/**
 * The next 7 days from `start`: the named weekdays become office days, the other weekdays remote.
 * Weekends are left alone. Naming the days replaces the whole week, so an old office day doesn't linger.
 */
export function officeWindow(start: string, officeWeekdays: number[]): { date: string; place: Place }[] {
  const out: { date: string; place: Place }[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const w = weekdayIndex(date);
    if (w >= 5) continue;
    out.push({ date, place: officeWeekdays.includes(w) ? "OFFICE" : "REMOTE" });
  }
  return out;
}

/** Weekdays that were office days in the 7 days before `today` (the default for the coming week). */
export function lastWeeksOfficeDays(db: Db, today: string): number[] {
  const rows = db.all<{ date: string }>(
    "SELECT date FROM day_plan WHERE place = 'OFFICE' AND date >= ? AND date < ?", addDays(today, -7), today,
  );
  return [...new Set(rows.map((r) => weekdayIndex(r.date)).filter((w) => w < 5))].sort();
}

export const weekdayNames = (days: number[]) => days.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]).join(", ");

// ------------------------------------------------------------------------ sleep

/** "sleeping", "good night", "gn", "off to bed"... A bedtime needs no model. */
export const BED_RE = /^(sleeping|going to (bed|sleep)|off to (bed|sleep)|heading to bed|good ?night|gn|nite|night night|bed ?time|to bed)[.!]*$/i;

const MIN_SLEEP_H = 2;
const MAX_SLEEP_H = 14;

/**
 * Nights whose wake-up ("up") falls on a date in [from, to]: hours from the latest bedtime before
 * that wake. A first message of the day is not a wake time (you may have been up for hours), so only
 * an explicit "up" counts. Implausible gaps are ignored.
 */
export function sleepNights(db: Db, from: string, to: string): { date: string; hours: number }[] {
  const wakes = db.all<{ ref_id: string; ts: string }>(
    `SELECT ref_id, ts FROM event WHERE type = 'wake' AND ref_id >= ? AND ref_id <= ?
       AND json_extract(payload_json, '$.trigger') = 'wake_word' ORDER BY ref_id`,
    from, to,
  );
  const out: { date: string; hours: number }[] = [];
  for (const w of wakes) {
    const wakeMs = Date.parse(w.ts);
    const bed = db.all<{ ts: string }>(
      "SELECT ts FROM event WHERE type = 'bed' AND ts < ? AND ts > ? ORDER BY ts DESC LIMIT 1",
      w.ts, new Date(wakeMs - MAX_SLEEP_H * 3_600_000).toISOString(),
    )[0];
    if (!bed) continue;
    const hours = (wakeMs - Date.parse(bed.ts)) / 3_600_000;
    if (hours >= MIN_SLEEP_H && hours <= MAX_SLEEP_H) out.push({ date: w.ref_id, hours });
  }
  return out;
}

export const formatHours = (h: number) => {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
