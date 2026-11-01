// The exercise catalog: canonical names, aliases and how each one is logged. Seeded from the names
// used in life/gym-tracking.md (Oct 2026). A name never seen before is added on first use.
//
// Name resolution: alias -> normalised match -> unique word-subset match. No model involved.

import type { Db } from "./db/db.ts";
import type { ExerciseKind } from "./sets.ts";

export interface CatalogEntry {
  name: string;
  group: string;
  kind: ExerciseKind;
  aliases: string[];
}

export const CATALOG: CatalogEntry[] = [
  // chest
  { name: "Flat Dumbbell Bench Press", group: "chest", kind: "weighted", aliases: ["Flat Bench Press DB", "Flat Bench", "bench press", "bench", "flat bench press", "db bench"] },
  { name: "Incline Dumbbell Press", group: "chest", kind: "weighted", aliases: ["Incline DB Press", "Inclined Bench", "Inclined Press DB", "incline bench", "incline press", "incline bench press"] },
  { name: "Incline Dumbbell Fly", group: "chest", kind: "weighted", aliases: ["Incline Flies DB", "Inclined Flies (DB)", "Inclined Flies DB", "incline flies", "incline fly"] },
  { name: "Pec Deck Fly", group: "chest", kind: "weighted", aliases: ["Peck Machine Flies", "Peck/Deck Flies", "Peck Flies", "pec deck", "pec fly", "machine fly", "pec deck flies"] },
  { name: "Push-up", group: "chest", kind: "bodyweight", aliases: ["pushups", "push ups", "push up"] },
  // triceps
  { name: "Triceps Pushdown", group: "triceps", kind: "weighted", aliases: ["Triceps Push Down DB", "Tricep Push Down", "tricep pushdown", "triceps push down", "pushdown"] },
  { name: "Dumbbell Side Extension", group: "triceps", kind: "weighted", aliases: ["Side Extension DB", "Side Extension"] },
  { name: "Straight Extension", group: "triceps", kind: "weighted", aliases: [] },
  { name: "Double Arm Extension", group: "triceps", kind: "weighted", aliases: ["double arm triceps extension"] },
  // back
  { name: "Lat Pulldown", group: "back", kind: "weighted", aliases: ["Lat Pull Down", "Lat Pull Up", "lat pulldowns", "lat pull"] },
  { name: "Seated Row", group: "back", kind: "weighted", aliases: ["Seated Rowing", "cable row", "seated cable row"] },
  { name: "V-Bar Pulldown", group: "back", kind: "weighted", aliases: ["V-Bar Pull Down", "V-Drop Pull Down", "v bar pulldown", "v pulldown"] },
  { name: "Reverse Grip Pulldown", group: "back", kind: "weighted", aliases: ["Reverse Grip Pull Down"] },
  { name: "Rope Pulldown", group: "back", kind: "weighted", aliases: ["Rope Pull Down"] },
  { name: "Single Arm Dumbbell Row", group: "back", kind: "weighted", aliases: ["Single DB Rowing", "one arm row", "single arm row", "db row"] },
  { name: "Chest Supported Dumbbell Row", group: "back", kind: "weighted", aliases: ["Chest Supported Double Dumbbell Rowing", "chest supported row"] },
  { name: "Pull-up", group: "back", kind: "bodyweight", aliases: ["pullups", "pull ups", "pull up", "chin up", "chin ups"] },
  // biceps
  { name: "Alternate Dumbbell Curl", group: "biceps", kind: "weighted", aliases: ["Alternate Dumbbell Curls", "Alt DB Curls", "alternate curls", "alternate db curls", "db curls", "dumbbell curls"] },
  { name: "Hammer Curl", group: "biceps", kind: "weighted", aliases: ["Hammer Dumbbell Curls", "Hammer Curls", "At a Time Hammer Curls DB", "Hammer Curls (At a Time)", "alternate hammer curls"] },
  { name: "Inner Hammer Curl", group: "biceps", kind: "weighted", aliases: ["Inner Hammer Curls DB", "inner hammer curls"] },
  { name: "Cable Curl", group: "biceps", kind: "weighted", aliases: ["Cable Curls"] },
  { name: "Concentration Curl", group: "biceps", kind: "weighted", aliases: ["Concentration Curls"] },
  { name: "Spider Curl", group: "biceps", kind: "weighted", aliases: ["Spider Curls"] },
  // shoulders
  { name: "Dumbbell Shoulder Press", group: "shoulders", kind: "weighted", aliases: ["Alternate Shoulder Press DB", "Shoulder Press (DB)", "Shoulder Press", "db shoulder press", "overhead press"] },
  { name: "Lateral Raise", group: "shoulders", kind: "weighted", aliases: ["Lateral Raise DB", "lateral raises", "side raise", "side raises", "laterals"] },
  { name: "Reverse Fly", group: "shoulders", kind: "weighted", aliases: ["Reverse Fly Machine", "reverse flies", "rear delt fly", "rear delt"] },
  { name: "Front Raise", group: "shoulders", kind: "weighted", aliases: ["Alternate Front Raise", "front raises"] },
  { name: "Shoulder Raise", group: "shoulders", kind: "weighted", aliases: [] },
  { name: "Dumbbell Shrug", group: "shoulders", kind: "weighted", aliases: ["Dumbbell Shrugs", "Shrugs", "shrug"] },
  // legs
  { name: "Goblet Squat", group: "legs", kind: "weighted", aliases: ["Goblet Squats", "Mobility Squats (Kettlebell)", "kettlebell squat", "kb squat"] },
  { name: "Prone Leg Curl", group: "legs", kind: "weighted", aliases: ["Reverse Curls", "Reverse Prone Curls", "leg curl", "leg curls", "hamstring curl"] },
  { name: "Leg Extension", group: "legs", kind: "weighted", aliases: ["Leg Extensions"] },
  { name: "Leg Press", group: "legs", kind: "weighted", aliases: [] },
  { name: "Calf Raise", group: "legs", kind: "activity", aliases: ["calf raises", "calves"] },
  { name: "Walking Lunge", group: "legs", kind: "activity", aliases: ["Walking Lunges", "lunges"] },
  // mobility
  { name: "Deep Squat Hold", group: "mobility", kind: "mobility", aliases: ["Deep Squats", "deep squat"] },
  { name: "Floor Hip Rotation", group: "mobility", kind: "mobility", aliases: ["On Floor Hip Rotations", "hip rotations"] },
  { name: "Lunge and Stretch", group: "mobility", kind: "mobility", aliases: ["lunge stretch"] },
  { name: "Side Lunge and Stretch", group: "mobility", kind: "mobility", aliases: ["Side Lunge & Stretch", "side lunge stretch"] },
  { name: "90-90 Hip Rotation", group: "mobility", kind: "mobility", aliases: ["90–90 Hip Rotation", "90 90", "90/90"] },
  { name: "Plank", group: "core", kind: "mobility", aliases: ["planks"] },
];

const SYNONYM: Record<string, string> = {
  db: "dumbbell", dumbell: "dumbbell", dumbbells: "dumbbell", kb: "kettlebell",
  peck: "pec", inclined: "incline", rowing: "row", rows: "row", flies: "fly", flyes: "fly",
  alt: "alternate", pulldown: "pull down", pulldowns: "pull down", pushdown: "push down", pushdowns: "push down",
  tricep: "triceps", bicep: "biceps",
};
const KEEP_S = new Set(["press", "biceps", "triceps", "abs", "calves", "cross"]);

/** Lower-case words with synonyms and plurals folded: "Inclined Flies (DB)" -> "incline fly dumbbell". */
export function normalizeName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[–—]/g, "-")
    .replace(/(\d)\s*[-/]\s*(\d)/g, "$1 $2")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (SYNONYM[w] ?? w).split(" "))
    .map((w) => (w.length > 3 && w.endsWith("s") && !KEEP_S.has(w) ? w.slice(0, -1) : w))
    .filter((w) => w !== "the" && w !== "a" && w !== "and");
  return words.join(" ");
}

const key = (name: string) => normalizeName(name).split(" ").sort().join(" ");

export interface ExerciseRow {
  id: number;
  canonical_name: string;
  muscle_group: string | null;
  kind: ExerciseKind;
  aliases_json: string;
}

export function loadCatalog(db: Db): ExerciseRow[] {
  return db.all<ExerciseRow>("SELECT id, canonical_name, muscle_group, kind, aliases_json FROM exercise_catalog ORDER BY id");
}

/** The catalog entry a name refers to, or null. Exact (after normalising) beats a unique word-subset match. */
export function matchExercise(rows: ExerciseRow[], name: string): ExerciseRow | null {
  const want = key(name);
  if (!want) return null;
  const names = (r: ExerciseRow) => [r.canonical_name, ...(JSON.parse(r.aliases_json) as string[])];
  for (const r of rows) if (names(r).some((n) => key(n) === want)) return r;

  // "incline fly" -> "Incline Dumbbell Fly": every typed word appears in one entry's name, and only one entry.
  const typed = want.split(" ");
  if (typed.length < 2 && typed[0].length < 5) return null;
  const hits = rows.filter((r) => names(r).some((n) => {
    const have = new Set(key(n).split(" "));
    return typed.every((w) => have.has(w));
  }));
  return hits.length === 1 ? hits[0] : null;
}

export function findExercise(db: Db, name: string): ExerciseRow | null {
  return matchExercise(loadCatalog(db), name);
}

/** Title case for a name typed the first time: "cable crossover" -> "Cable Crossover". */
export function displayName(name: string): string {
  const t = name.trim().replace(/\s+/g, " ");
  return t === t.toLowerCase() ? t.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : t;
}

/** Insert catalog entries that aren't there yet (by canonical name). Returns how many were added. */
export function ensureCatalog(db: Db): number {
  let added = 0;
  for (const e of CATALOG) {
    const have = db.all("SELECT 1 FROM exercise_catalog WHERE canonical_name = ?", e.name).length > 0;
    if (have) {
      db.run("UPDATE exercise_catalog SET muscle_group = ?, kind = ?, aliases_json = ? WHERE canonical_name = ?", e.group, e.kind, JSON.stringify(e.aliases), e.name);
      continue;
    }
    db.run(
      "INSERT INTO exercise_catalog (canonical_name, muscle_group, kind, aliases_json, source) VALUES (?, ?, ?, ?, 'seed')",
      e.name, e.group, e.kind, JSON.stringify(e.aliases),
    );
    added++;
  }
  return added;
}
