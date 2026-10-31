import { test } from "node:test";
import assert from "node:assert/strict";
import { bedtimeFor, draftDay } from "../src/plan.ts";
import type { PlanInput, PlanUnit } from "../src/plan.ts";
import { addDays, dateLabel, dayKey, dayNumber, istWallToMs, minusMinutes, weekStart, weekdayIndex } from "../src/time.ts";

const unit = (listId: string, ordinal: number, title: string, size: "fragment" | "block" = "fragment"): PlanUnit => ({
  unitId: ordinal + (listId === "dsa" ? 0 : listId === "frontier" ? 2000 : 1000), listId, ordinal, title, size, estMin: null,
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  const date = over.date ?? "2026-10-27"; // a Tuesday
  return {
    date,
    weekday: weekdayIndex(date),
    kind: "REST",
    patternNote: null,
    place: "REMOTE",
    overrides: [],
    gymWakeBy: "07:00",
    rotation: { ordinal: 2, label: "Back / Biceps" },
    liftsDone: 0,
    liftFloor: 2,
    gymSlotsLeft: 3,
    next: {
      dsa: unit("dsa", 1, "Two Sum"),
      "system-design": unit("system-design", 1, "Scalability Basics", "block"),
      frontier: unit("frontier", 1, "Main post", "block"),
    },
    dayNumber: dayNumber(date),
    reading: { id: 7, title: "DDIA", kind: "book" },
    ...over,
  };
}
const titles = (d: ReturnType<typeof draftDay>) => d.items.map((i) => i.title);

test("time helpers: the 03:00 boundary, weekdays and IST wall clock", () => {
  assert.equal(weekdayIndex("2026-10-26"), 0, "Monday");
  assert.equal(weekdayIndex("2026-11-01"), 6, "Sunday");
  assert.equal(weekStart("2026-10-30"), "2026-10-26");
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(dateLabel("2026-10-27"), "Tue 27 Oct");
  // 01:30 IST on the 28th still belongs to the 27th; 03:00 IST starts the 28th
  assert.equal(dayKey(istWallToMs("2026-10-28", "01:30")), "2026-10-27");
  assert.equal(dayKey(istWallToMs("2026-10-28", "03:00")), "2026-10-28");
  assert.equal(dayKey(istWallToMs("2026-10-27", "23:59")), "2026-10-27");
  assert.equal(istWallToMs("2026-10-30", "14:30"), Date.UTC(2026, 9, 30, 9, 0));
  assert.equal(minusMinutes("07:00", 480), "23:00");
});

test("gym day: next rotation split, wake_by, one study fragment, reading", () => {
  const d = draftDay(input({ date: "2026-10-26", kind: "GYM" }));
  assert.deepEqual(titles(d), ["Gym: Back / Biceps", "DSA: Two Sum", "Read: DDIA"]);
  assert.equal(d.wake_by, "07:00");
  assert.equal(d.items[0].ref, "rotation:fitness:2");
  assert.equal(d.items[1].unit_id, 1);
  assert.equal(d.items[1].optional, false);
  assert.equal(d.items[2].optional, true);
});

test("remote non-gym weekday adds an optional block that alternates by day", () => {
  const a = draftDay(input({ date: "2026-10-27", kind: "MOBILITY", patternNote: "Tue: rest / lower mobility" }));
  const b = draftDay(input({ date: "2026-10-28", kind: "REST" }));
  assert.ok(titles(a).includes("Mobility (lower)"));
  const blocks = [a, b].map((d) => d.items.find((i) => i.optional && i.lane === "study")!.title);
  assert.notEqual(blocks[0], blocks[1], "system design one day, frontier the next");
  assert.ok(blocks.every((t) => t.startsWith("System design") || t.startsWith("Frontier")));
});

test("office day: fragment only", () => {
  const d = draftDay(input({ place: "OFFICE", kind: "REST" }));
  assert.equal(d.items.filter((i) => i.lane === "study").length, 1);
});

test("weekend: a block from the right list, plus an optional fragment", () => {
  const sat = draftDay(input({ date: "2026-10-31", kind: "MOBILITY" }));
  const sun = draftDay(input({ date: "2026-11-01", kind: "REST" }));
  assert.equal(sat.items.find((i) => i.lane === "study" && !i.optional)!.title, "System design: Scalability Basics");
  assert.equal(sun.items.find((i) => i.lane === "study" && !i.optional)!.title, "Frontier lab: Main post");
  assert.equal(sun.items.some((i) => i.lane === "fitness"), false, "Sunday is rest");
});

test("a slipped lift is offered again, but only when the weekly floor is at risk", () => {
  // Thursday: nothing lifted yet, only Fri left -> 0 + 1 < 2: upgrade
  const upgraded = draftDay(input({ date: "2026-10-29", kind: "REST", liftsDone: 0, gymSlotsLeft: 1 }));
  assert.equal(upgraded.kind, "GYM");
  assert.equal(upgraded.wake_by, "07:00");
  assert.match(upgraded.notes.join(" "), /floor/);
  // on pace: stays rest
  const calm = draftDay(input({ date: "2026-10-29", kind: "REST", liftsDone: 1, gymSlotsLeft: 1 }));
  assert.equal(calm.kind, "REST");
  assert.equal(calm.items.some((i) => i.lane === "fitness"), false);
  // Sunday never upgrades
  assert.equal(draftDay(input({ date: "2026-11-01", kind: "REST", liftsDone: 0, gymSlotsLeft: 0 })).kind, "REST");
});

test("SICK plans nothing", () => {
  const d = draftDay(input({ kind: "GYM", overrides: ["SICK"] }));
  assert.deepEqual(d.items, []);
  assert.match(d.notes[0], /Sick/);
});

test("TRAVEL: no gym, fragment only, reading still allowed", () => {
  const d = draftDay(input({ kind: "GYM", overrides: ["TRAVEL"], liftsDone: 0, gymSlotsLeft: 0 }));
  assert.equal(d.items.some((i) => i.lane === "fitness"), false, "not even an upgrade");
  assert.equal(d.items.filter((i) => i.lane === "study").length, 1);
  assert.ok(d.items.some((i) => i.lane === "reading"));
  assert.equal(d.wake_by, null);
});

test("OUT: gym unchanged, shorter study, no reading", () => {
  const d = draftDay(input({ kind: "GYM", overrides: ["OUT"] }));
  assert.ok(titles(d).includes("Gym: Back / Biceps"));
  assert.equal(d.items.find((i) => i.lane === "study")!.est_min, 25);
  assert.equal(d.items.some((i) => i.lane === "reading"), false);
});

test("LOW_MOOD: the minimum, one small item per lane, wins over a gym day", () => {
  const d = draftDay(input({ kind: "GYM", overrides: ["LOW_MOOD", "OUT"] }));
  assert.equal(d.items.length, 3);
  assert.ok(d.items.every((i) => i.source === "minimum"));
  assert.deepEqual(d.items.map((i) => i.lane), ["fitness", "study", "reading"]);
  assert.equal(d.wake_by, null);
});

test("SICK beats LOW_MOOD", () => {
  assert.deepEqual(draftDay(input({ overrides: ["LOW_MOOD", "SICK"] })).items, []);
});

test("empty pointers and no book simply leave things out", () => {
  const d = draftDay(input({ kind: "GYM", next: {}, reading: null }));
  assert.deepEqual(titles(d), ["Gym: Back / Biceps"]);
});

test("drafting is deterministic", () => {
  const i = input({ kind: "GYM" });
  assert.deepEqual(draftDay(i), draftDay(i));
});

test("bedtime is wake_by minus the sleep goal", () => {
  assert.equal(bedtimeFor("07:00"), "23:00");
  assert.equal(bedtimeFor("05:30", 8), "21:30");
  assert.equal(bedtimeFor("07:00", 7), "00:00");
});
