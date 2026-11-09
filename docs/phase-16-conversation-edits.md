# Phase 16: Conversation state and natural-language edits — Implementation Guide

> **Goal:** short replies and corrections work in plain words: "both", "yes", "no, face pull", "set 2 was 10 not 12", "face full should be face pull". Restating a log never doubles it, and every change shows what changed.
>
> **Source:** `docs/backlog.md` — bugs **B1, B2, B3, B6**, design **N1, N2, N3, N5**. Check the real B3 messages first (`npm run export -- --view messages --from <day>`, Phase 15); the guards below are written from the code, and the messages show whether anything else is going on.

## 1. What goes wrong today

| You did | What happened | Cause (in the code) |
|---|---|---|
| Answered "Both" to "Which one on Tue 3 Nov?" | Saved to inbox as chat (10%) | `resolvePlanItem` asks, but nothing remembers the question. |
| Said "face full" for "face pull" | A second exercise was created | `matchExercise` is alias → exact → word-subset; no near-match step; `log_workout` creates unknown names silently. |
| Restated the log to correct it | Every set doubled | The model returns `replace` as a guess; `append` re-adds the whole list. `findRepeat` only catches an identical op within 15 minutes. |
| Wanted to fix one name or one set | No way | There is no rename / amend / remove operation. |

## 2. Conversation state (16.1)

One small record, `bot_state` key `convo`, read and written by `src/convo.ts` (pure, takes a `Db`).

```
{ pending: { kind, until, payload } | null,
  last:    { ts, summary, revisionId, exercises: string[] } | null }
```

* **pending** — the one open question: `choose_item` (which plan item), `confirm_exercise` (is this the exercise you meant). Expires after **30 minutes**; a newer question replaces it. The existing `fitness_pending` ("add again") moves into the same slot as kind `repeat_workout`.
* **last** — the last thing the agent changed, so "undo that", "no, …" and "it was …" have something to refer to. Expires after **2 hours**.
* Code checks `pending` **before** anything else on each message. Only a message that *answers* it is consumed; anything else carries on normally and the question stays open until it expires.

### Answers code understands (no model)

| Pending | Accepted replies |
|---|---|
| `choose_item` | `both` / `all` / `both of them`; `1`, `2`, `first`, `second`, `last`; a word from one option's title; `neither` / `none` / `cancel` / `never mind` (clears it, changes nothing) |
| `confirm_exercise` | `yes` / `yep` / `ya` / `y` / `correct` / `that one`; `new` / `no, new` / `it's new` (keep what I said as a new exercise); any other exercise name (use that one); `cancel` |
| `repeat_workout` | `add again` / `log anyway` / `again` (as today) |

## 3. Restating a log (16.2)

`reconcileWorkout(db, op)` runs on every `log_workout` before it is applied. For each exercise already in that day's session, with `n` sets logged and `m` sets in the message:

| Message vs session | Becomes |
|---|---|
| `m = n` and the sets are the same | **unchanged**, skipped |
| `m > n` and the first `n` sets are the same | **extend**: only the extra sets are added |
| `m ≥ n` and at least half of the existing sets appear again, but not identical | **restatement**: that exercise's sets are replaced |
| anything else | **append** (new sets, as today) |

* If **every** exercise is unchanged, nothing is applied: the reply says so, and `add again` (pending `repeat_workout`) logs it anyway. This is the old repeat guard, no longer limited to 15 minutes.
* The op carries a **mode per exercise** (`exercises[].mode`, default the op's `mode`). Model-set `replace` still wins.
* Result: sending the same log twice, or the whole log with one set changed, changes only what differs.

## 4. Showing the change (16.2)

When a message changed sets that already existed (replace, restatement, rename, amend, remove), the reply starts with the differences and then the session:

```
✏️ Changed
Bench: set 2 12 → 10 reps
Face Pull: + set 3 (15 kg × 12)
✅ Corrected 2 sets: Bench Press, Face Pull
```

Plain appends keep the current reply (summary + session). `/undo` reverses either.

## 5. Near-matches for exercise names (16.3)

* `suggestExercise(rows, name)` — the catalog entry a typo most likely means: edit distance on the normalised name (up to about a fifth of its length), with word-level checks for short names, and it must be clearly the best one. "face full" → "Face Pull".
* A name that matches exactly, by alias, or by the existing unique word-subset rule is used as before.
* A name with **no** match and **no** near-match is a new exercise, as before (the reply says *new: …*).
* A name with **no** match but a near-match **holds the log** and asks: *"Is “face full” Face Pull? yes · new · or say the name"* (pending `confirm_exercise`). Nothing is written until you answer.
* **Yes** (or another name) → the sets are logged under that exercise and the misspelling is **saved as an alias** in the same revision, so it resolves next time. **New** → it is created as asked.

## 6. Edits after the fact (16.4)

Three operations, each undoable like any other:

| Operation | Does |
|---|---|
| `rename_exercise` | Moves a day's sets from one exercise to another (if the target is already in that session, the sets are merged and renumbered). A wrong catalog entry that nothing else uses is removed and its spelling becomes an alias of the target. |
| `amend_set` | Changes `weight`, `reps` (or duration) of one set. |
| `remove_exercise` | Removes an exercise and its sets from that day. |

Reached two ways:
* **Without a model:** "face full should be face pull", "it was face pull not face full", "no, face pull" (the exercise from `last`), "set 2 of bench was 10 reps".
* **With the model:** a new intent `workout_edit` (classified and extracted like the others, with today's session in its context) for everything else.

## 7. Plan-item questions (16.1)

When "done with reading" matches several items, the agent asks as today **and** remembers the options and the action (done, skip or move, with the target day). Your reply resolves them in code; "both" marks both, and the confirmation lists what changed.

## 8. Sub-steps

- [x] 16.1 `src/convo.ts` (pending + last, expiry, answer parsing); `choose_item` for plan questions; "add again" moved onto it (`fitness_pending` is gone).
- [x] 16.2 `reconcileWorkout`, per-exercise mode in `log_workout`, change summary on replies (`diffSessions`).
- [x] 16.3 `suggestExercise`; `confirm_exercise`; alias learning inside `log_workout`.
- [x] 16.4 `rename_exercise`, `amend_set`, `remove_exercise`; text patterns (`parseExerciseEdit`); `workout_edit` intent.
- [x] 16.5 `/help`, docs, plan and backlog updated.

### Where the build differs from the sections above

* **Matching:** the near-match step also compares with spaces removed ("pulldwn" → "Lat Pulldown"), because the catalog normaliser splits "pulldown" into "pull down". It allows about one wrong letter in seven, for names of 5+ letters.
* **`last` is stored but only used by one pattern** ("no, face pull" names the one exercise the last log touched). Plain "undo that" is not wired: `/undo` still does that.
* **`rename_exercise`** accepts a `to` that is only a near-match of a catalog name and uses the closest; a `to` that matches nothing becomes a new exercise. It deletes the wrong catalog entry only if the user made it (not a seed entry) and nothing else uses it; its name becomes an alias of the right one.
* **`remove_exercise`** deletes the whole session when it was the last exercise, so a day with nothing left has no workout.
* **Not done (kept for later):** the `confirm_exercise` question is asked only for a log that comes through `logWorkout`; the same near-match check is not yet applied to `rename_exercise`'s `from` beyond the session lookup. `Q1`/`N6` (questions answered from data) and the other lanes' use of pending questions (reminders, readings) are not in this phase.

## 9. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Each sub-step adds its own tests; the cases from real use are written as tests first (the "Both" reply, "face full", restating a whole log with one set changed, "face full should be face pull").

`npm run live-check -- --only workout_edit` runs four edit phrases through the real model (Gemini flash-lite): 4/4 pass. It found that the model put the unchanged weight in `weight_kg` and dropped `reps`, so `amend_set` extraction now uses one `field` + `value` pair (both required).

## 10. After deploy

1. "done with reading" when two reading items are planned → answer "both".
2. Log `face full 15x12, 15x12` → asked "Face Pull?" → "yes"; then `face full 15x10` → goes straight to Face Pull.
3. Log a few exercises, send the same text again → "unchanged"; send it again with one set different → only that set changes, and the reply shows the change.
4. "set 2 of bench was 10 reps" → amended; `/undo` restores it.
5. Create a wrong exercise on purpose (a made-up name), then "X should be Face Pull" → merged.
