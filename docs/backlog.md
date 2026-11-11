# study-agent — Backlog

*Gathered 2026-11-09 from real use. Not a plan: every item is a bug, fix, or idea with a suspected cause and a priority. Items marked **verify** need the actual data before fixing (see D1).*

Priority: **P1** trust-breaking · **P2** fitness model · **P3** quality of life · **P4** later.

---

## Decisions made

| Topic | Decision |
|---|---|
| Jog / CrossFit | Count as the **gym/fitness slot**. Activity types: lift, run, crossfit, mobility. |
| Weekly gym shape | Soft rules, changeable per whim. Mon–Wed different groups, Thu–Fri repeat, Sat CrossFit, legs about once a week on any day. |
| Protein target | **90 g minimum, 120 g maximum** per day. |
| Protein sources | Vegetarian at home: whey scoops (~26 g each, 1–2/day), soy chunks (100 g dry ≈ 50 g protein). |
| Protein input | `protein 26` **adds**; `protein total 90` **sets** (to correct a mistake). Presets planned (below). |
| Model provider | Gemini; workout data to Gemini is fine. |

---

## Bugs and fixes

### P1 — trust

| ID | Problem | Suspected cause | Fix idea |
|---|---|---|---|
| ✅ B1 | "Which one on Tue 3 Nov?" → "Both" goes to the inbox as chat (10%) | The clarification question is not remembered; the reply is classified from scratch. | Store a short-lived **pending prompt** with its options. The next message is checked against it first: "both", "1", "the first one", "all", "neither" resolve with no model call. Expire after ~30 min. |
| ✅ B2 | "Face full" (meant Face Pull) created a second exercise; later logs went to the wrong one | Name resolution is alias → normalised → word-subset; no fuzzy match; unknown names are created silently. | (a) Fuzzy step (edit distance + sound-alike for voice). (b) An unknown name asks "Face Pull?" with a tap **before** creating. (c) Correction phrase "no, face pull" moves the sets and learns the spelling as an alias. (d) A merge command for duplicates that already exist. |
| B3 (guard done in Phase 16; verify with the real messages) | Protein updated through the day → **sets duplicated** (**verify**) | Not confirmed. Strongest guess: a protein message that doesn't match the strict `parseProtein` patterns (e.g. "protein shake 30g after workout") goes to the model; the extractor sees today's session in the snapshot and re-emits the sets as an append. `findRepeat` only guards identical repeats within 15 minutes. | Pull the interaction log for that day (D1) to see the raw message and parsed ops. Then: protein is never parsed by the workout extractor; a workout op identical to sets already in the session is rejected or asked about, regardless of time window. |
| ✅ B4 | "Note for today, …" → "I have recorded this feedback", but it is in no file | The `note` intent writes an **expiring `note` row** (a few days of context for the agent). It is not mirrored to the daily note and not a bug report. The reply wording is misleading. | New `feedback` intent ("note for the dev", "bug:", "idea:") that appends to this backlog file or a `feedback` table mirrored to the daily note, and replies with where it was saved. Rename the reply for ordinary notes: "Remembered for N days — not saved to your notes". |
| ✅ B5 | Protein cannot be incremented through the day | `protein N` sets the day's total (`log_metric`), so each message overwrites. | Store each intake as an entry; the day's total is derived. `protein 26` adds, `protein total 90` sets. Reply shows running total vs the 90–120 band, e.g. `🥩 52 / 90 g`. Last add is undoable. |

| ✅ B6 | Correcting a workout log **duplicated the whole log with double the sets**; a second prompt fixed it | On the model path, `log_workout` carries a guessed `mode` (`append` / `replace`). A correction that restates the log is read as `append`, so every set is added again. Only the chat parser's strict path is always `append`. | See **N2**: the model returns the *intended state*, code diffs it against the session, so restating is idempotent. Interim guard: if an `append` repeats ≥50% of existing sets for an exercise, treat it as a correction (reconcile) and say so. |

### P2 — fitness model (one change set)

| ID | Problem | Fix idea |
|---|---|---|
| F1 | Agent expects the scheduled focus group and keeps asking, even after a different session was logged (e.g. 5 km run + biceps only on trainer's orders) | **Any logged fitness activity completes the day.** Nothing owed; stop asking. |
| F2 | Rotation is a fixed pointer through Biceps/Back → Shoulder/Triceps → Legs → Chest | Replace with **weekly coverage**: track which muscle groups were trained this week, suggest the most overdue one. Legs ≈ once a week, soft. Pattern (Mon–Wed distinct, Thu–Fri repeat, Sat CrossFit) is a default suggestion, not an obligation. |
| F3 | Runs and CrossFit are not first-class | Activity types: lift / run / crossfit / mobility, each loggable (run: distance, time). All count toward the fitness slot. |
| F4 | Trainer changes the plan on the day | "Trainer says biceps only" becomes today's session; tomorrow's suggestion recomputes from coverage. |
| F5 | "Skipping the gym today" → "couldn't find gym in the plan" on a day with no gym item | Say "No gym planned today (rest day per your pattern)" and offer to log an unplanned session. |

### P3 — quality of life

| ID | Problem | Fix idea |
|---|---|---|
| Q1 | "Today's status", "What's workout log for today" get placeholder replies ("Here is your status for today.") | Route read-only questions (status, plan, gym log, protein, sleep, reminders) to deterministic handlers; the model only classifies. |
| Q2 | "sleep log" → "No nights recorded yet" (**verify** whether earlier "good night"/"up" were recorded) | Show the last 7 nights; say how to log one. |
| Q3 | Near-duplicate overdue reminders (switches + cement) both nag every morning | Detect near-duplicates when creating; show an overdue reminder at most twice, then ask once "still needed?" and auto-close. Fits the no-debt rule. |
| Q4 | Morning footer always says "done with gym…" even with no gym planned | Make the tip depend on what is actually in today's plan. |

---

## Features and ideas

| ID | Idea | Priority |
|---|---|---|
| D1 | **Easy access to logged data**: read-only `GET /admin/table/<name>?limit=&date=` behind `ADMIN_TOKEN` (named tables, no raw SQL), plus a `scripts/` helper that dumps to CSV/JSON. Do this first: it unblocks verifying B3 and Q2. | P1 |
| D2 | Telegram `/log <thing> [date]` views for protein, sleep, workouts, reminders | P3 |
| ✅ P-1 | **Protein presets**: "whey" = 26 g, "soy chunks" = 50 g, user-editable. Reply `🥩 whey +26 → 52 / 90`. Warn gently at >120. | P3 |
| ✅ P-2 | Evening protein prompt only if below 90 g (already asks in the evening; make it conditional) | P3 |
| P-3 | Estimate protein from a food description ("dal, 2 rotis, paneer") | P4 |
| F6 | Weekly fitness summary: groups covered, runs, protein days in band | P4 |
| F7 | Activity trends (run pace, lift progression per exercise) | P4 |

---

## Design direction — natural language first (added 2026-11-09)

*Status after Phase 16: N1 (conversation state), N2 (restating a log is idempotent per exercise; edits as typed operations), N3 (the diff in replies) and N5 for exercise names are built. N4, N6 and N7 are not.*

Goal: you never need a command or a magic phrase. Commands stay as shortcuts only. The bot should understand "no, face pull", "make that 10 reps", "both", "that was yesterday", "undo that", "how's my protein?" in context.

| ID | Change | Why it helps |
|---|---|---|
| N1 | **Conversation state** (tiny working memory): the last bot action (revision id + what it changed), any pending question with its options, and the last entity mentioned (exercise, plan item, reminder). Included in every understanding call and checked first by code. | Lets short replies refer to something. Fixes B1; makes "no, face pull", "that was yesterday", "undo that" resolvable without commands. |
| N2 | **Declarative workout edits.** The model sees today's session (exercises with set numbers) and returns *the intended state for the exercises mentioned*. Code diffs it against the session: add missing sets, change differing ones, leave equal ones. Plus semantic ops: `add_sets`, `amend_set`, `rename_exercise`, `remove_exercise`, `set_meta`. No `append`/`replace` flag to guess. | Restating a log twice changes nothing (idempotent). Fixes B6 and B3, and covers "set 2 was 10 not 12". |
| N3 | **Show the diff, not "Logged".** Reply with what changed: `Bench set 2: 12 → 10 reps · Face Full → Face Pull (3 sets moved)`. | You catch a wrong parse at a glance, with `/undo` or "undo that" one step away. |
| N4 | **Act, show, allow undo** for reversible changes; **ask** only when the change is destructive or truly ambiguous (e.g. would delete sets, or two plausible matches). Confidence is the model's, but the threshold lives in code. | Fewer prompts, and still safe. |
| N5 | **One shared entity resolver** (exercises, plan items, reminders, reading items): alias → fuzzy/sound-alike → ask. Corrections teach new aliases. Currently `resolvePlanItem` and the exercise matcher are separate and exact-ish. | "Face full", "gym", "the scalability one" all resolve the same way. Fixes B2 and F5. |
| N6 | **Questions answered from data.** Anything that reads like a question about your own state routes to deterministic views (plan, gym log, protein, sleep, reminders); the model only phrases it if needed. | Fixes Q1; "how's my protein?" just works. |
| N7 | **Eval set from real messages.** Every message that landed in the inbox or needed a correction goes into `tests/` as `text + context → expected ops`, including the cases from this document. Run before changing prompts. | Natural language regresses silently; this is how it stays fixed. |

Keep deterministic fast paths (cheap, instant, no model call) for the unambiguous forms — they just stop being the *only* way.

---

## Direction — Dashboard (added 2026-11-09, to flesh out)

**Hosting.** Same Worker project: static assets served by the Worker (`assets` in `wrangler.jsonc`), plus read-only JSON routes under `/api/*` that read the Durable Object. No new service; static assets are free, API calls are a few hundred a day against the free request limit.

**Privacy rules (decide before any code):**
1. **Private by default, from the first deploy.** A `workers.dev` URL is reachable by anyone, so no data route exists without auth.
2. **Auth, v1:** the bot sends a short-lived signed link ("open dashboard" → DM) that sets a session cookie. No passwords, nothing new to host. Later option: Cloudflare Access in front of a custom domain (free plan covers a handful of users — verify current limits).
3. **No raw tables.** Every view is a named, hand-written query with an explicit field allowlist. Same routes serve D1 (data access for me) and the dashboard.
4. **Per-section visibility:** each section is `private` (default), `link` (read-only token link, can be revoked, shows only that section) or `public` (aggregates only, separate endpoint, never the private query). Health, protein, sleep, reminders, tasks, jots and the inbox are never eligible for `public`.
5. Everything read-only in v1.

**Sections (simple first):**

| Section | Shows | Notes |
|---|---|---|
| Today | locked plan, what's done, open reminders and tasks, protein so far | the home page; mobile first |
| Week | gym coverage (groups, runs, CrossFit), protein days in band, study blocks, reading progress | replaces the Sunday summary reading |
| Fitness | sessions, per-lift progression chart, PRs, weekly volume per muscle group, runs | edit-ready later |
| Protein & sleep | daily protein vs the 90–120 g band, source breakdown, sleep hours trend | |
| Study | each track's pointer and % done, DSA solved by pattern against the 450 goal | |
| Reading | active book/manga/articles, progress, jots per item, library backlog | |
| Agent log | recent messages, what each one changed, inbox of unparsed messages | debugging; feeds the N7 test set |

**Later ideas:** one-click "add this misparse to the test set"; CSV export per section; limited actions that call the same ops as chat (mark done, rename an exercise, merge duplicates); a shareable fitness view for a trainer; a public portfolio-style progress card (counts only).

**Phases:** D-0 read API (= D1) → D-1 shell, signed-link auth, Today and Week → D-2 Fitness, Protein, Sleep → D-3 Study, Reading → D-4 Agent log → D-5 sharing (`link` sections) → D-6 actions. Public views only if still wanted after D-5.

**Decided:** responsive for phone and desktop (one layout that adapts); charts use a small library (Chart.js or uPlot) since it's quicker to start, swappable later; sharing with others is deferred — v1 is for you only, and `link`/`public` sections stay a later option (D-5).

---

## Suggested order

1. **D1** data access → use it to verify **B3**, **Q2**.
2. **N1** conversation state first (it unlocks B1, B2 and most corrections), then **N2/N3** for workouts (**B6**, **B3**), **N5** resolver (**B2**), and **B5** protein.
3. **B4** feedback intent, so the next round of notes lands somewhere.
4. **F1–F5** as one fitness change set.
5. **Q1**, **Q3**, **Q4**, then **P-1**, **P-2**, **D2**.
6. P4 items after a few clean weeks.
