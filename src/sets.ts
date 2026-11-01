// Set notation, the way it is written in life/gym-tracking.md and typed in chat. Pure: no database.
//
//   20x15 · 20 × 15 · 20kg x 15     weight_kg × reps            (dumbbell / machine)
//   BW x 20                          bodyweight, reps
//   7 kg · 30                        weight only                 (activity: walking lunges, calf raise)
//   15 reps                          reps only
//   30s · 1m · hold 30 seconds x 3   a duration (x N = N sets)
//   3x15 @ 20 · 3 sets of 15 at 20kg sets × reps at a weight
//   25x8F · 25x8 (failed out set)    taken to failure
//   20x15 (1m) · (45s)               rest after the set
//   20 x                             weight with the reps missing: kept, flagged incomplete
//
// For mobility moves "3 x 8" means 3 sets of 8 reps, not 3 kg; for bodyweight moves a bare number is reps.

export type ExerciseKind = "weighted" | "activity" | "mobility" | "bodyweight";
export type SetKind = "working" | "warmup" | "drop" | "failure";

export interface SetEntry {
  weight_kg: number | null;
  reps: number | null;
  duration_s: number | null;
  rest_s: number | null;
  kind: SetKind;
  bw: boolean;
  notes: string | null;
  incomplete: boolean;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const KG = String.raw`(?:\s*kgs?)?`;

function blank(): SetEntry {
  return { weight_kg: null, reps: null, duration_s: null, rest_s: null, kind: "working", bw: false, notes: null, incomplete: false };
}

function seconds(n: number, unit: string): number {
  return Math.round(/^m/i.test(unit) ? n * 60 : n);
}

const DURATION_UNIT = String.raw`(s|secs?|seconds?|m|mins?|minutes?)`;

/** One written entry -> one or more sets (an entry like "3x15 @ 20" or "30s x 3" stands for several). Null if it isn't a set. */
export function parseSetEntry(input: string, kind: ExerciseKind = "weighted"): SetEntry[] | null {
  let s = input
    .replace(/^\s*(?:\\?-|•|\*)\s*/, "")
    .replace(/[×✕✖*]/g, "x")
    .trim();
  if (!s) return null;

  const meta = blank();
  // Bracketed metadata: rest time, failure, warm-up, drop set, or a note.
  s = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    const t = inner.trim();
    const rest = new RegExp(String.raw`^${NUM}\s*${DURATION_UNIT}(?:\s*rest)?$`, "i").exec(t);
    if (rest) meta.rest_s = seconds(Number(rest[1]), rest[2]);
    else if (/fail/i.test(t)) meta.kind = "failure";
    else if (/warm/i.test(t)) meta.kind = "warmup";
    else if (/drop/i.test(t)) meta.kind = "drop";
    else if (t) meta.notes = meta.notes ? `${meta.notes}; ${t}` : t;
    return " ";
  }).trim();
  // Trailing failure marker: "25x8F", "25x8 F", "25x8 fail".
  s = s.replace(/(\d)\s*(?:f|fail(?:ed)?|failure)$/i, (_m, d: string) => {
    meta.kind = "failure";
    return d;
  }).trim();
  if (/^(?:w|wu|warm-?up)\s+/i.test(s)) {
    meta.kind = "warmup";
    s = s.replace(/^\S+\s+/, "");
  }

  const one = (patch: Partial<SetEntry>): SetEntry => ({ ...meta, ...patch });
  const many = (n: number, patch: Partial<SetEntry>): SetEntry[] | null =>
    Number.isInteger(n) && n >= 1 && n <= 20 ? Array.from({ length: n }, () => one(patch)) : null;
  let m: RegExpExecArray | null;

  // 3 sets of 15 (at 20kg) · 3x15 @ 20
  if ((m = new RegExp(String.raw`^(\d+)\s*sets?\s*(?:of|x)\s*(\d+)(?:\s*reps?)?(?:\s*(?:@|at|with)\s*${NUM}${KG})?$`, "i").exec(s))) {
    return many(Number(m[1]), { reps: Number(m[2]), weight_kg: m[3] ? Number(m[3]) : null });
  }
  if ((m = new RegExp(String.raw`^(\d+)\s*x\s*(\d+)\s*(?:@|at)\s*${NUM}${KG}$`, "i").exec(s))) {
    return many(Number(m[1]), { reps: Number(m[2]), weight_kg: Number(m[3]) });
  }
  // BW x 20
  if ((m = /^(?:bw|body\s*weight)\s*x\s*(\d+)(?:\s*reps?)?$/i.exec(s))) return [one({ bw: true, reps: Number(m[1]) })];
  // hold 30 seconds x 3 · 30s · 1m hold
  if ((m = new RegExp(String.raw`^(?:hold\s+)?${NUM}\s*${DURATION_UNIT}(?:\s+hold)?(?:\s*x\s*(\d+))?$`, "i").exec(s))) {
    const dur = seconds(Number(m[1]), m[2]);
    if (dur < 1 || dur > 7200) return null;
    return m[3] ? many(Number(m[3]), { duration_s: dur }) : [one({ duration_s: dur })];
  }
  // 20 x 15 (weight x reps; for mobility, sets x reps)
  if ((m = new RegExp(String.raw`^${NUM}${KG}\s*x\s*(\d+)(?:\s*reps?)?$`, "i").exec(s))) {
    if (kind === "mobility") return many(Number(m[1]), { reps: Number(m[2]) });
    return [one({ weight_kg: Number(m[1]), reps: Number(m[2]) })];
  }
  // 20 x  (reps missing)
  if ((m = new RegExp(String.raw`^${NUM}${KG}\s*x$`, "i").exec(s))) return [one({ weight_kg: Number(m[1]), incomplete: true })];
  // 15 reps
  if ((m = /^(\d+)\s*reps?$/i.exec(s))) return [one({ reps: Number(m[1]) })];
  // 7 kg
  if ((m = new RegExp(String.raw`^${NUM}\s*kgs?$`, "i").exec(s))) return [one({ weight_kg: Number(m[1]) })];
  // 30 (weight, or reps for a bodyweight move)
  if ((m = new RegExp(String.raw`^${NUM}$`).exec(s))) {
    return [kind === "bodyweight" || kind === "mobility" ? one({ reps: Number(m[1]) }) : one({ weight_kg: Number(m[1]) })];
  }
  return null;
}

/** "20x15, 22.5x12, 25x8F" or "25x15 25x15 25x12" -> sets. Null unless every entry parses. */
export function parseSets(input: string, kind: ExerciseKind = "weighted"): SetEntry[] | null {
  const out: SetEntry[] = [];
  const chunks = input.replace(/[×✕✖]/g, "x").split(/\s*[,;]\s*/).map((c) => c.trim()).filter(Boolean);
  if (chunks.length === 0) return null;
  for (const chunk of chunks) {
    const whole = parseSetEntry(chunk, kind);
    if (whole) {
      out.push(...whole);
      continue;
    }
    // Space-separated entries: split before each number / BW that starts a new entry ("20 x 15" stays whole).
    const parts = chunk.split(/(?<!x)\s+(?=(?:\d|bw\b))/i);
    if (parts.length < 2) return null;
    for (const p of parts) {
      const sets = parseSetEntry(p, kind);
      if (!sets) return null;
      out.push(...sets);
    }
  }
  return out.length > 0 && out.length <= 40 ? out : null;
}

// --------------------------------------------------------------------- display

const trim = (n: number) => String(Math.round(n * 100) / 100);

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

/** One set the way you'd write it: "20×15", "BW×20", "7 kg", "15 reps", "30s", with " F" for failure. ascii uses "x". */
export function formatSet(set: Pick<SetEntry, "weight_kg" | "reps" | "duration_s" | "kind" | "bw" | "incomplete">, ascii = false): string {
  const x = ascii ? "x" : "×";
  let core: string;
  if (set.duration_s !== null) core = formatDuration(set.duration_s);
  else if (set.bw) core = `BW${x}${set.reps ?? "?"}`;
  else if (set.weight_kg !== null && set.reps !== null) core = `${trim(set.weight_kg)}${x}${set.reps}`;
  else if (set.weight_kg !== null) core = set.incomplete ? `${trim(set.weight_kg)}${x}?` : `${trim(set.weight_kg)} kg`;
  else if (set.reps !== null) core = `${set.reps} reps`;
  else core = "?";
  return set.kind === "failure" ? `${core} F` : set.kind === "warmup" ? `w ${core}` : core;
}

// ------------------------------------------------------------------ whole text

export interface ParsedExercise {
  name: string;
  sets: SetEntry[];
  /** "Crossed out" in the log: listed but not done. */
  skipped: boolean;
}

const SKIP_RE = /^(?:\\?-\s*)?(?:crossed out|skipped|skip|not done)$/i;
const SET_LINE_RE = /^\s*(?:\\?-|•)\s*/;

/**
 * Lines of "name sets" or a name line followed by "- set" lines -> exercises.
 * kindOf tells the parser how to read the numbers for an exercise name.
 * Lines that are neither a set nor a name-with-sets become a name with no sets yet.
 */
export function parseExerciseLines(lines: string[], kindOf: (name: string) => ExerciseKind): { exercises: ParsedExercise[]; bad: string[] } {
  const exercises: ParsedExercise[] = [];
  const bad: string[] = [];
  let cur: ParsedExercise | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (SET_LINE_RE.test(line) || (cur && parseSets(line, kindOf(cur.name)) && !/[a-z]{3,}/i.test(line.replace(/\b(?:kgs?|reps?|sets?|of|at|bw|hold|seconds?|secs?|mins?|minutes?|fail(?:ed)?|failure|rest|warm-?up)\b/gi, "")))) {
      if (!cur) {
        bad.push(line);
        continue;
      }
      const body = line.replace(SET_LINE_RE, "");
      if (SKIP_RE.test(body)) {
        cur.skipped = true;
        continue;
      }
      const sets = parseSets(body, kindOf(cur.name));
      if (sets) cur.sets.push(...sets);
      else bad.push(line);
      continue;
    }

    const split = splitNameAndSets(line, kindOf);
    cur = split ? { name: split.name, sets: split.sets, skipped: false } : { name: cleanName(line), sets: [], skipped: false };
    exercises.push(cur);
  }
  return { exercises, bad };
}

function cleanName(s: string): string {
  return s.replace(/[\s:–—-]+$/, "").replace(/^[\s:–—-]+/, "").trim();
}

/** "flat bench 20x15, 22.5x12" -> name + sets: the shortest name whose remainder is all sets. */
export function splitNameAndSets(line: string, kindOf: (name: string) => ExerciseKind): { name: string; sets: SetEntry[] } | null {
  const words = line.trim().split(/\s+/);
  for (let k = 1; k < words.length; k++) {
    const name = cleanName(words.slice(0, k).join(" "));
    if (!/[a-z]/i.test(name)) continue;
    const rest = words.slice(k).join(" ");
    const sets = parseSets(rest, kindOf(name));
    if (sets) return { name, sets };
  }
  return null;
}
