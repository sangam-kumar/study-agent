# Phase 11: Overrides, place, sleep — Implementation Guide

> **Goal:** the plan bends around your life: travel, illness, low days, office days and sleep, without debt or nagging.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §5, §5b, §5c. Reform-plan step **W5**.

Most of this landed in Phase 10 (overrides, plan edits, LOW_MOOD minimum, `/office`). This phase finishes it.

## 1. Overrides (done in Phase 10)

"travelling Fri to Sun", "down with a fever", "out all day tomorrow", "feeling low today" → `set_override` → today/tomorrow re-planned even if locked → `/undo` reverses. See `docs/phase-10-day-loop.md` §2 for what each one does to the day.

## 2. Office days

| You say | Effect |
|---|---|
| `office tue thu`, `in office monday and wednesday`, `wfo: thu, fri`, `/office tue thu` | In the **next 7 days**, those weekdays are office days and the **other weekdays remote** (one `set_places` op, one `/undo`). Weekends untouched. |
| nothing, on a Sunday | Sunday's evening message sets next week to **last week's office days** (only days you haven't set) and says so: *"Office this week: Tue, Thu, same as last week. Reply office mon wed to change."* With no history it asks instead. |

Office-day phrases are recognised in code (`OFFICE_RE` + `parseWeekdays`), no model call. Anything that isn't plain weekday names ("in office tomorrow") goes to the model as usual. Study routing follows `place`: office day → one fragment.

Fixed on the way: `/office` used to set the named days to office but never reset the others, so an old office day lingered.

## 3. Sleep

* **Bedtime:** "good night", "sleeping", "gn", "off to bed" (`BED_RE`, no model) → a `bed` event. Reply: *"Good night. Up by 07:00 — that's 7 h 20 min from now."* on a gym day.
* **Wake:** "up" (or "gm", "awake", "good morning") → a `wake` event with `trigger: wake_word`. A first message of the day also records a wake (for the morning brief) but **not as a wake time**: you may have been up for hours. A later explicit "up" still counts.
* **Hours slept** = explicit wake − latest bedtime before it; gaps under 2 h or over 14 h are ignored.
* **Where you see it:** the morning brief shows *"slept 7 h 20 min"*; the evening recap mentions the weekly average **only when it is below your floor** (7 h): *"sleep 6.2 h a night (aim 7+)"*. `/sleep` lists the last 7 nights. No bedtime nagging.
* A bedtime message is never treated as the day's wake-up (it would have sent a morning brief at 23:30).

## 4. Pausing messages (v1 snooze, retired)

The v1 snooze lived in `bot_state` (`snooze_until`, `snooze_reason`). It is now one config value `mute` set through `set_config`, so **`/undo` works** on it, and the v1 keys are deleted on start. It stays an hours-long pause rather than an override, because overrides are whole days and "pause your messages for 3 hours" is not. It silences only messages the agent starts (the evening message and the fallback morning brief); **reminders you set still fire**, and the 23:00 lock still runs.

## 5. Sub-steps

- [x] 11.1 Overrides, skip, move, add (Phase 10).
- [x] 11.2 LOW_MOOD minimum (Phase 10).
- [x] 11.3 Place per date; Sunday default = last week's office days, with the question.
- [x] 11.4 `bed` / `wake` events; nightly hours and weekly average derived.
- [x] 11.5 v1 snooze retired into an undoable config value.

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Covered: weekday parsing; office window (rolls into next week, weekends untouched); `set_places` replaces a week and undoes in one step; last week's office days as the default; office phrases caught in code vs left to the model; bedtime phrases (and non-bedtime look-alikes); sleep pairing (explicit up only, latest bedtime wins, implausible gaps ignored); morning "slept" line; evening weekly average only when below the floor.

After deploy: say **good night** tonight and **up** tomorrow → the brief shows "slept …"; `/sleep`; **office tue thu** → `/plan tomorrow`; on Sunday evening, the office line.
