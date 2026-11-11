# Phase 17: Protein as additions, presets, and a feedback intent — Implementation Guide

> **Goal:** protein can be added to through the day ("whey", "protein 26") with the running total against your 90–120 g band, and a note *about the agent* lands somewhere you can find it instead of vanishing.
>
> **Source:** `docs/backlog.md` — **B4, B5, P-1, P-2**. Decisions already made there: protein target 90 g minimum, 120 g maximum; `protein N` **adds**, `protein total N` **sets**; whey ≈ 26 g, soy chunks ≈ 50 g (100 g dry); a soft warning above 120.
>
> **Principle (from 16b):** the model reads the words, code decides the effect. No new text patterns: "whey", "two scoops of whey", "protein 26", "protein total 90", "whey is 30 g now" and "bug: …" all reach the code as typed fields.

## 1. Protein

### 1.1 Data
* `metric_log` stays the **day's total** (one row per date and metric). Every reader (evening message, `/gym`, weekly summary, views) keeps working.
* New table `protein_entry (id, date, grams, label, ts)`: one row per change. `grams` is the change (negative when a total is corrected downward). The entries explain the total; the total is authoritative, so days logged before this phase (no entries) stay correct.
* One op, `log_metric`, gains `mode` (`add` | `set`, default `set` so old callers and `/undo` history behave as before) and `label`. A handler change writes the entry **and** the total in the same revision, so `/undo` reverses both.

### 1.2 Meaning
| You say | Model returns | Effect |
|---|---|---|
| `protein 26`, `had 30 g protein` | action `add`, value 26 | total + 26 |
| `whey` | action `add`, label `whey` | total + the preset (26) |
| `two scoops of whey` | action `add`, label `whey`, count 2 | total + 52 |
| `protein total 90`, `make it 90` | action `set_total`, value 90 | total = 90 (entry = the difference) |
| `whey is 30 g now` | action `set_preset`, label `whey`, value 30 | preset changed (config), nothing added |
| `soy chunks 100 g dry` | action `add`, label `soy chunks`, value 50 | the model converts only if the preset card says so; otherwise it asks |

Code resolves the number: value given → used; only a label → the preset; neither → the agent asks which preset or how many grams. The model never does the addition.

### 1.3 Presets
* Stored in config key `protein.presets` (JSON `{ "whey": 26, "soy chunks": 50 }`), seeded on first use, editable by saying so (`set_config`, undoable).
* The `metric` lane sees them in its snapshot ("Protein presets: whey 26 g, soy chunks 50 g") so "scoop of whey" maps to the label.

### 1.4 Reply
```
🥩 whey +26 → 52 / 90 g
```
* `total / floor` while below the floor; `total g ✓ (90–120)` inside the band; above the ceiling: `🥩 +30 → 128 g — above your 120 g ceiling, no need for more` (gentle, once per message).
* `/undo` reverses the last add.

### 1.5 Commands (shortcuts)
`/protein 26` adds, `/protein total 90` sets, `/protein` alone shows today's entries and the presets. The words after the command are the argument, not free text.

### 1.6 Evening prompt (P-2)
* Below 90 g (or nothing logged): `🥩 Protein 52 / 90 g — add with e.g. whey or protein 26.`
* At or above 90 g: one quiet line, `🥩 Protein 96 g ✓`, no prompt.

## 2. Feedback (B4)

### 2.1 What it is
Anything addressed to or about the agent itself: a bug ("it duplicated my sets"), an idea ("let me say protein presets"), a complaint, a request. Distinct from `note`, which is a few days of context about *you* ("knee hurts, go easy on legs").

### 2.2 Storage
* Table `feedback (id, ts, date, kind, text, status)`; `kind` is `bug` | `idea` | `other`; `status` is `open` | `done`.
* Op `add_feedback` (undoable).
* Mirrored: the day's block in the daily note gets a `### Agent feedback` list, so it shows up where you look. It is part of the marked block, so it is rewritten each time, never duplicated.
* View `feedback` (Phase 15 registry) and command `/feedback` (list open; `/feedback done <id>`).

### 2.3 Replies
* Feedback: `📮 Saved as feedback #12 (bug). It is in /feedback and in today's daily note.`
* Ordinary notes stop pretending to be saved: `📝 Remembered for 7 days (not written to your notes): …`

### 2.4 Model side
New intent `feedback` (`kind`, `text`). The classify card separates it from `note` with examples on both sides. Live-check cases include the sentence that started this ("Note for today, the agent is duplicating the sets…").

## 3. Sub-steps

Each ends with typecheck, test typecheck and tests green, and its own commit.

- [x] **17.1 Protein entries and add/set.** Migration 10 (`protein_entry`, `feedback`), `log_metric` `mode`/`label`, handler, band-aware reply, undo; tests.
- [x] **17.2 Presets and the `metric` intent.** `protein.presets` config, snapshot line, `metric` schema (`action`, `value`, `label`, `count`), `set_preset`; the workout lane's `protein_g` becomes an add; tests and live-check.
- [x] **17.3 Commands and the evening line (P-2).** `/protein` add / total / list; conditional evening line; tests.
- [x] **17.4 Feedback.** `feedback` intent, `add_feedback` op, `/feedback`, view, daily-note section, note reply wording; tests and live-check.
- [x] **17.5 Docs.** `/help`, this doc, plan, backlog statuses (B4, B5, P-1, P-2).

## 4. Risks

| Risk | Handling |
|---|---|
| "protein 110" used to set; now adds, so a habit of typing the day's total doubles it | The reply always shows the running total against the band; `/undo`; `protein total` is one phrase away; the evening line shows the total |
| The model reads "whey" with a wrong count | Count and label are structured fields shown back in the reply (`whey ×2 +52 → 78 / 90`) |
| Feedback mistaken for a note or the reverse | Examples both ways in the card; both are cheap and visible in the reply wording, and `/feedback` lists them |
| Old `metric_log` rows have no entries | The total stays authoritative; the breakdown says "earlier total" for the remainder |

## 5. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
npm run live-check -- --only metric,feedback,note
```

After deploy: `whey` → 26 / 90; `whey` again → 52; `protein total 90`; `/undo` back to 52; `/protein` shows entries; `whey is 30 g now`, then `whey`; say "Note for today, the agent is duplicating sets" → saved as feedback and visible in `/feedback` and the next mirror of the daily note; "knee hurts, go easy on legs" → remembered for 7 days (not saved to notes).

## 6. Where the build differs

* **Reply wording:** protein replies come through the common "✅ …" line, e.g. `✅ whey +26 → 52 / 90 g`, followed by `/undo to reverse`, not a separate `🥩` format. `/protein` itself uses `🥩`.
* **`value` vs `count`:** a number the user said is the total grams for that message and wins; `count` only multiplies a preset. The model never adds ("two scoops of whey" is `label whey, count 2`, code makes 52).
* **Bare numbers add.** The first live run read `protein 110` and `had about 95g protein today` as totals; the card now says a bare number, even with "today", always adds, and only total / so far / make it / set it to means set. Both pass live.
* **The workout lane's `protein_g`** (a protein mention inside a workout message) is also an add.
* **Unknown food** ("dal") is not guessed: the agent asks for grams and shows the known presets. Estimating from a food description stays P-3.
* **Reset:** `protein_entry` clears with the `workouts` scope; `feedback` with `plan`.
* **Feedback is dated by the day it was said** and shows in that day's note only if the day has a plan row (it normally does).
* **Verified live (Gemini flash-lite):** `protein 26`, `whey`, `two scoops of whey`, `soy chunks`, `protein total 90`, `whey is 30 g now`, and five feedback-versus-note phrases, including the sentence that started this phase. Several runs hit the free-tier "AI unavailable" limit and were repeated slower.
