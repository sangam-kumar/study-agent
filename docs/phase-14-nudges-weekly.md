# Phase 14: Reminders v2, nudges, weekly, jots — Implementation Guide

> **Goal:** the last pieces of daily use: reminders you can answer, a hard limit on how often the agent speaks unasked, the week in one message, and a place for what you think while reading.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §12 (reminders and nudges), §5b (weekly), §15b stage 1 (jots). Reform-plan steps **W6, W7, W8, J1**.

## 1. Reminders v2 (14.2)

| You say | What happens |
|---|---|
| "remind me Friday 4pm to call the bank" | Fires at that instant with **✅ Done · ⏰ 1h · 📅 Tomorrow**. No answer → **one** repeat after 30 min, then "still open" in that evening's recap. No more pings. |
| "every Monday 9am review the week", "weekdays 7:30 stretch", "daily at 8pm" | A repeating reminder. Code computes the first firing; each firing schedules the next. Cancelling stops the chain. |
| "submit the form by Friday" (a day, no time) | A **task**: no ping. It's in the morning brief from that day on (`overdue` after), and in the evening recap the day before. |
| "cancel the bank reminder", `/cancel 4`, `/done 4` | Found by its words (or id) among open reminders; several matches → it asks which. |
| the same reminder twice | "Already set" instead of a second one. |

Reminders are commitments you made: never capped, never silenced by an override or a pause. Data: the v1 `reminders` table, extended (migration v7: `text`, `due_date`, `repeat_rule`, `fired_at`, `repeats`, `message_id`, `done_at`). Status `pending → dispatched → done | cancelled`. Snooze / Tomorrow move it back to `pending` at the new time; a stale alarm from before the move is ignored.

**Buttons** are Telegram inline keyboards; a tap arrives as a `callback_query`, goes through the same one-at-a-time queue and duplicate check as messages, and the message is edited to show the outcome (buttons removed).

## 2. Agent nudges and the message budget (14.1)

* **Budget:** at most **3 agent-started messages a day** (morning fallback, evening, ≤ 1 nudge). The evening slot is always kept. Messages that answer you, and your reminders, don't count. Config: `nudge_cap_per_day`.
* **Quiet:** nothing before you're up (a wake event today) or after 22:30 (`quiet_hours_start`); nothing within 90 min of another agent message; nothing on a day with an override; nothing while paused.
* **The one nudge built — closure:** at **18:00** (`nudge_time`), the first planned, non-optional gym or study item still open gets one message: *"Gym: Back / Biceps is still open for today. Did it happen?"* **Done · Skip · Later**. Done/Skip apply the change (undoable); Later just leaves it for the evening recap.
* **Ignored:** a nudge with no tap by the evening counts as ignored; **two ignored in a row → no nudges until next Monday**.
* **Silence:** 2 days without a word from you → one *"I haven't heard from you in 2 days, so I'll go quiet… keep going?"* with **Keep going · Pause a week**. Then quiet until you write (any message ends it). The plan still locks itself and reminders still fire.
* `/nudges` shows today's count and why a nudge would or wouldn't go out; `/nudges off|on`. `/testcue nudge`.

Not built (spec types, deliberately left out until the loop has run): *cue* (block start), *drift* (behind on a weekly target), *decision* (deferred ≥ 3×). The gate, the budget and the ignored-twice rule are shared, so each is a small addition.

## 3. Sunday summary (14.3)

Sunday's evening message carries the week; `/week` shows it any day. Also written into Sunday's daily note.

```
📊 Week of Mon 2 Nov – Sun 8 Nov
🏋️ lifts 3/3 · mobility 1/2 · protein 96 g a day over 5 days (aim 120)
😴 sleep 7 h 10 min a night over 6 nights
📚 7 study units: DSA +5, System design +2
📖 finished The Hundred-Page ML Book · read on 4 days
📋 kept 17 of 21 planned, plus 3 optional
⏰ reminders: 4 done · 1 still open
```

* Study units come from the **undo history** (pointer moves), so "did 3 DSA problems" and ticking off plan items both count, and an undone change doesn't.
* **First Sunday of a month** adds the month just gone: `🗓 October: 12 lifts · 31 study units · 2 finished · kept 70 of 88 planned`.
* The office-day line for next week follows (Phase 11).

## 4. Jots and progress (14.4, stage 1: just store it)

| You send | What happens |
|---|---|
| `ch3: leader-based replication, lag breaks read-your-writes` | A jot on the book you're reading, at ch3. Code only, when exactly one book is on the go. |
| `jot: consistency is a spectrum` / `p120: why not 2PC?` | Same; no place, or a page. Kind from the text: quote (in quotes), question (`?`), todo, connection, point. |
| `finished ch3` / `on p140` | That book's progress; also ticks off today's reading item for it. |
| "DDIA ch5: quorums…", "finished chapter 4 of Shoe Dog", "interesting point about quorums" | The model path (intents `jot`, `progress`): it names the book, code finds it. Two books on the go and none named → it asks. |

* `/jots` (the current book) or `/jots sicp` shows them.
* **`study/notes/<book>.md`** in study-repo is regenerated from the jots at each lock (same commit as the daily notes, only when changed), grouped by chapter, quotes as quotes. One-way: edits there are overwritten.
* Data: `jot` table, `reading_item.progress` (migration v8). `reset?scope=shelf` also clears jots and progress.
* Stage 2 (cards, spaced review) waits until reading + jots have run 14 days, as the spec says. Jots on study units (a DSA insight) are in the table (`unit_id`) but not wired yet.

## 5. Sub-steps

- [x] 14.1 Nudge budget (≤ 3/day, quiet 22:30 → wake, 90 min apart, quiet-after-2-ignored, "pause or resume?"); one nudge type (closure).
- [x] 14.2 Reminders v2: buttons, one repeat then evening recap, repeat rule, date-only tasks, cancel/done, duplicate check.
- [x] 14.3 Sunday weekly summary (+ month on the first Sunday), in the message and the daily note; `/week`.
- [x] 14.4 `jot` + `progress` intents and fast path; `study/notes/<slug>.md` projection; `/jots`.

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
npm run live-check -- --only reminder,jot,reading
```

Covered: repeat phrases and occurrences; duplicates; cancel by words / id / ambiguity; fired → unanswered → once in the evening; snooze resets; Tomorrow keeps the clock; tasks in brief and recap (overdue too); task / repeat / cancel through the model; the nudge gate (wake, quiet hours, budget with the evening slot, 90 min, override, pause, off, once a day, ignored twice → stop, new week resets, an answer resets); pick only non-optional items; silence → ask once, again only after you've written; nudge job time; weekly counts (study units from history, undone excluded, reminders) and the month line; Sunday daily note; jot / progress parsing and kinds; book choice; jot + progress undo and the reading tick; notes markdown; notes in the mirror commit only when changed; shelf reset; jot / progress through the model.

Live (gemini-3.5-flash-lite): all 34 phrasings pass, including the new reminder (task, repeat ×2, cancel) and jot/progress cases, and the older lanes after adding two intents to the classifier.

**After deploy:**
1. "remind me in 2 minutes to test" → tap **1h**, then `/reminders`; another one → leave it → the repeat after 30 min.
2. "submit the form by tomorrow" → tomorrow's brief shows it; `/done <id>`.
3. "every day at 9pm remind me to stretch" → `/reminders` shows *every day*; `/cancel <id>`.
4. `/nudges`, then `/testcue nudge` after you're up (with something open).
5. `/week`.
6. With one book started: `ch1: a first jot` → `/jots`; after the next lock, `study/notes/<book>.md` in study-repo.
