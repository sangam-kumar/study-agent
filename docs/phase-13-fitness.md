# Phase 13: Fitness lane — Implementation Guide

> **Goal:** log the gym the way you already write it down, one message or many, and have the plan, the rotation and the week follow.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §4, §5b, §8 (Fitness), §9 step 5. Reform-plan step **W9**.

## 1. Logging

| You send | What happens |
|---|---|
| `bench 20x15, 22.5x12, 25x8F` | Read in code (no model): Flat Dumbbell Bench Press, 3 sets, the last to failure. |
| a name line, then `- 25x15` lines (the gym-log layout) | Same: one exercise per name, its sets below. Several exercises per message are fine. |
| `yesterday` on the first line | Logged to yesterday's session. |
| a voice note, or "did chest: flat bench 3 sets of 12 at 20kg" | The model writes the sets in the notation; **code parses them**. A set it can't read is retried once, then the message goes to the inbox. |
| "actually bench was 22.5x10" | A correction: that exercise's sets are replaced (model path, it sees today's log). |
| "left knee felt off" inside a log | Kept on the session as pain, plus a 7-day note so the next days know. |
| `protein 110`, "had 120 g protein" | One number a day (a second one replaces it). The evening message asks until it is logged. |

**Notation** (`src/sets.ts`, from `life/gym-tracking.md`): `20x15` = 20 kg × 15 reps (also `20 × 15`, `20kg x 15`) · `BWx20` bodyweight · `7 kg` / `30` weight only · `15 reps` · `30s`, `1m`, `hold 30 seconds x 3` · `3x15 @ 20`, `3 sets of 15 at 20kg` expand to one entry per set · `F` or `(failed out set)` = failure · `(1m)` / `(45s)` = rest · `w 10x15` warm-up · `20 x` keeps the weight, flags the reps missing. For mobility moves `3 × 8` is 3 sets of 8; for bodyweight moves a bare number is reps.

**Safety of the code path.** A message only skips the model when every line reads as sets, and each exercise is either in the catalog or has a weight × reps set. "call mom 2", "remind me in 10 min", "done with gym" all go to the model as before.

## 2. One session per day, built from chunks

* Identity is the **date**, not the message: every chunk on a day lands in that day's `workout_session`. Sets continue numbering.
* Each chunk is **one `log_workout` op**, so `/undo` removes exactly the last chunk (and the session if it was the first).
* Messages are already handled one at a time (`SerialQueue` in the agent), so two voice notes a second apart can't interleave; no version rebase is needed inside one Durable Object.
* **Repeat:** the same sets on the same day within 15 minutes (a resent voice note) are held back: *"That's the same as what you sent at 8:10, so I didn't add it again. Say add again if you really did those sets twice."*
* The 23:00 job closes the day's session; a later chunk reopens the same session.

## 3. Plan, rotation, week

* Logging a lift **ticks off the day's gym item** and moves the rotation on, in the same undoable change.
* **The split you did wins.** Planned Chest / Triceps but logged pulldowns and curls → the item becomes Back / Biceps and the next split is Legs / Shoulders. Detected from the catalog's muscle groups.
* Lifting on a day with no gym item adds a done one, so the week counts it.
* Mobility work (catalog kind `mobility`) ticks off the mobility item and counts as mobility, not a lift.
* Tomorrow's draft is refreshed after a log, so it offers the next split.
* **Evening line** (only what is below its floor, as before): `lifts 1/2`, `mobility 0/1` from Thursday, `protein 82 g a day (aim 90+)` once two days are logged.
* **Daily note** (mirror): the session goes under the plan, one line per exercise.

## 4. Commands

* `/gym` — this week (lifts, mobility, protein against targets) and the last session. `/gym yesterday`, `/gym today`.
* `/lift bench` — the last 6 times and the best set (heaviest, then most reps).
* `/protein 110`.

## 5. Data (migration v6)

`exercise_catalog` (canonical name, muscle group, kind `weighted|activity|mobility|bodyweight`, aliases) · `workout_session` (date UNIQUE, title, kind `lift|mobility`, status, pain_notes, version) · `session_exercise` · `session_set` (weight_kg, reps, duration_s, rest_s, bw, kind `warmup|working|drop|failure`, incomplete) · `metric_log` (date, metric, value; UNIQUE per day).

The migration seeds the catalog (41 exercises with the aliases from your Oct log, `src/exercises.ts`) and copies any v1 `workout_logs` rows into sessions. A name never seen before is added on first use (the reply says "new: …"; `/undo` takes it out). `reset?scope=workouts` clears sessions, sets and protein; the catalog stays.

## 6. Import the October log (once)

```powershell
curl.exe -X POST "https://<worker>/admin/seed?kind=fitness" -H "Authorization: Bearer $token" -H "Content-Type: text/markdown" --data-binary "@C:\study\study-repo\life\gym-tracking.md"
```

Expected: `sessions 14, exercises 77, sets 217`, `unreadLines: []`, one `incomplete` (07/10 V-Drop Pull Down, reps missing; also put in `/inbox`). Re-running replaces what the import wrote and never touches a session logged in chat. The file stays in `life/` (gitignored); nothing is copied into the repo.

**Note:** calf raise `30` imports as 30 kg (spec rule: a bare number on an activity move is a weight). If those were reps, write `30 reps` in the file and re-run the import.

## 7. Sub-steps

- [x] 13.1 `workout_session` (UNIQUE date) / `session_exercise` / `session_set` / `exercise_catalog` / `metric_log`; v1 `workout_logs` migrated.
- [x] 13.2 Set-notation parser, shared by the code path, the model path and the import.
- [x] 13.3 One op per chunk (`log_workout` append/replace, `log_metric`); repeat → ask; serialised per user (version rebase not needed inside one DO, see §2).
- [x] 13.4 Rotation advances on a logged lift (split detected); protein at evening; weekly fitness targets in the recap; `/gym`, `/lift`.

## 8. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
npm run live-check -- --only workout,workout-voice
```

Covered (`tests/sets.test.ts`, `tests/fitness.test.ts`): every notation form; name/sets splitting; gym-log layout; catalog aliases; ordinary messages not mistaken for sets; two chunks → one session, undo per chunk; correction replaces; rotation advance and its undo; split detection; rest-day lift counted once; mobility; late chunk reopens; new exercise joins the catalog and leaves on undo; pain note; repeat detection; protein replace/undo; evening parts; `/gym`, `/lift`; daily-note block; import (re-run, skip chat sessions, inbox once, year rollover); the real `life/gym-tracking.md` reads completely; v1 migration. Live (gemini-3.5-flash-lite): 5/5 workout phrasings.

After deploy: send `bench 20x15, 22.5x12` → the session; send it again → the repeat question; `/undo`; `protein 110`; `/gym`; run the import; `/lift lat pulldown`.
