// Drafting a day. Pure: plain data in, plain data out. No database, no model, no clock.
// Spec §4 (pattern + pointers), §5 (overrides), §5c (place and wake_by), §7 (the day loop).
//
// The weekly pattern only says what KIND of day it is. What goes in it comes from pointers
// (next rotation split, next unit, current book), so a skipped day never shifts or piles up.

export type DayKind = "GYM" | "MOBILITY" | "REST";
export type Place = "OFFICE" | "REMOTE";
export type OverrideKind = "TRAVEL" | "SICK" | "OUT" | "LOW_MOOD";
export type Lane = "fitness" | "study" | "reading";

/** The study lists the planner draws from (ids come from seed/study.json). */
export const DSA_LIST = "dsa";
export const BLOCK_LISTS = ["system-design", "frontier"] as const;
const LIST_LABEL: Record<string, string> = { dsa: "DSA", "system-design": "System design", frontier: "Frontier lab" };

const GYM_MIN = 105; // 1.5-2 h
const MOBILITY_MIN = 20;
const FRAGMENT_MIN = 45;
const BLOCK_MIN = 90;
const SHORT_FRAGMENT_MIN = 25;
const BOOK_MIN = 20;
const ARTICLE_MIN = 10;

export interface PlanUnit {
  unitId: number;
  listId: string;
  ordinal: number;
  title: string;
  size: "fragment" | "block";
  estMin: number | null;
}

export interface PlanReading {
  id: number;
  title: string;
  kind: "book" | "article";
}

export interface PlanInput {
  date: string;
  /** Monday = 0 ... Sunday = 6 */
  weekday: number;
  /** From the seeded weekly pattern. */
  kind: DayKind;
  patternNote: string | null;
  place: Place;
  overrides: OverrideKind[];
  gymWakeBy: string;
  rotation: { ordinal: number; label: string } | null;
  /** Lifts logged this week so far, the weekly floor, and gym-pattern days still ahead this week. */
  liftsDone: number;
  liftFloor: number;
  gymSlotsLeft: number;
  /** Next unit of each list, by list id. */
  next: Record<string, PlanUnit | undefined>;
  /** Days since epoch: used to alternate between the block lists. */
  dayNumber: number;
  reading: PlanReading | null;
}

export interface DraftItem {
  lane: Lane;
  title: string;
  est_min: number;
  source: "pattern" | "pointer" | "minimum";
  ref: string | null;
  unit_id: number | null;
  optional: boolean;
}

export interface DraftDay {
  date: string;
  kind: DayKind;
  place: Place;
  wake_by: string | null;
  items: DraftItem[];
  /** One-line explanations the renderer can show (why the day looks like this). */
  notes: string[];
}

const item = (i: Partial<DraftItem> & Pick<DraftItem, "lane" | "title" | "est_min" | "source">): DraftItem => ({
  ref: null,
  unit_id: null,
  optional: false,
  ...i,
});

function unitItem(u: PlanUnit, optional: boolean, fragmentMin = FRAGMENT_MIN): DraftItem {
  const label = LIST_LABEL[u.listId] ?? u.listId;
  return item({
    lane: "study",
    title: `${label}: ${u.title}`,
    est_min: u.estMin ?? (u.size === "block" ? BLOCK_MIN : fragmentMin),
    source: "pointer",
    ref: `unit:${u.listId}:${u.ordinal}`,
    unit_id: u.unitId,
    optional,
  });
}

/** SICK beats LOW_MOOD beats TRAVEL beats OUT. */
function dominant(overrides: OverrideKind[]): OverrideKind | null {
  for (const o of ["SICK", "LOW_MOOD", "TRAVEL", "OUT"] as const) if (overrides.includes(o)) return o;
  return null;
}

export function draftDay(input: PlanInput): DraftDay {
  const override = dominant(input.overrides);
  const notes: string[] = [];
  const items: DraftItem[] = [];
  let kind = input.kind;
  let wakeBy: string | null = null;

  // --- SICK: nothing at all.
  if (override === "SICK") {
    return { date: input.date, kind: "REST", place: input.place, wake_by: null, items: [], notes: ["Sick day: nothing planned. Rest up."] };
  }

  // --- LOW_MOOD: one small item per lane, nothing else.
  if (override === "LOW_MOOD") {
    items.push(item({ lane: "fitness", title: "10-minute walk", est_min: 10, source: "minimum" }));
    const dsa = input.next[DSA_LIST];
    items.push(
      dsa
        ? { ...unitItem(dsa, false, 15), title: `Open one DSA problem: ${dsa.title}`, est_min: 15, source: "minimum" }
        : item({ lane: "study", title: "One small study thing", est_min: 15, source: "minimum" }),
    );
    items.push(item({ lane: "reading", title: input.reading ? `One page of ${input.reading.title}` : "One page of anything", est_min: 5, source: "minimum" }));
    return { date: input.date, kind: "REST", place: input.place, wake_by: null, items, notes: ["Low-mood day: just the minimum. That counts."] };
  }

  // --- Fitness
  const gymOff = override === "TRAVEL";
  if (gymOff) {
    kind = "REST";
    notes.push("Travelling: no gym.");
  } else if ((kind === "REST" || kind === "MOBILITY") && input.weekday !== 6 && input.rotation) {
    // A slipped lift gets offered again: upgrade a quiet day only when the weekly floor is at risk.
    if (input.liftsDone + input.gymSlotsLeft < input.liftFloor) {
      kind = "GYM";
      notes.push(`Lift moved here to keep the week's floor (${input.liftsDone}/${input.liftFloor} done).`);
    }
  }

  if (kind === "GYM" && input.rotation) {
    items.push(
      item({
        lane: "fitness",
        title: `Gym: ${input.rotation.label}`,
        est_min: GYM_MIN,
        source: "pattern",
        ref: `rotation:fitness:${input.rotation.ordinal}`,
      }),
    );
    wakeBy = input.gymWakeBy;
  } else if (kind === "MOBILITY") {
    const part = /lower/i.test(input.patternNote ?? "") ? " (lower)" : /upper/i.test(input.patternNote ?? "") ? " (upper)" : "";
    items.push(item({ lane: "fitness", title: `Mobility${part}`, est_min: MOBILITY_MIN, source: "pattern" }));
  }

  // --- Study
  const fragmentOnly = override === "TRAVEL" || override === "OUT" || kind === "GYM" || input.place === "OFFICE";
  const weekend = input.weekday >= 5;
  const dsa = input.next[DSA_LIST];
  const blockListId = weekend ? (input.weekday === 5 ? BLOCK_LISTS[0] : BLOCK_LISTS[1]) : BLOCK_LISTS[input.dayNumber % 2];
  const block = input.next[blockListId];

  if (weekend && !fragmentOnly) {
    if (block) items.push(unitItem(block, false));
    if (dsa) items.push(unitItem(dsa, true));
  } else {
    if (dsa) items.push(unitItem(dsa, false, override === "OUT" ? SHORT_FRAGMENT_MIN : FRAGMENT_MIN));
    if (!fragmentOnly && !weekend && block) items.push(unitItem(block, true));
  }
  if (fragmentOnly && override === null && kind === "GYM") notes.push("Gym day: study is one fragment.");
  if (override === "OUT") notes.push("Out today: shorter study, no reading.");

  // --- Reading (light by design; off when you're out)
  if (override !== "OUT" && input.reading) {
    const r = input.reading;
    items.push(
      item({
        lane: "reading",
        title: `Read: ${r.title}`,
        est_min: r.kind === "book" ? BOOK_MIN : ARTICLE_MIN,
        source: "pointer",
        ref: `reading:${r.id}`,
        optional: true,
      }),
    );
  }

  return { date: input.date, kind, place: input.place, wake_by: wakeBy, items, notes };
}

/** "Lights out ~23:00" for a gym day: wake_by minus the sleep goal. */
export function bedtimeFor(wakeBy: string, sleepGoalHours = 8): string {
  const [h, m] = wakeBy.split(":").map(Number);
  const t = (((h * 60 + m - Math.round(sleepGoalHours * 60)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
