# Phase 10: The day loop — Implementation Guide

> **Goal:** you can live on it. Every evening you get today's recap and tomorrow's plan; silence locks it; the morning just delivers it. Changes are one message away and always undoable.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §4, §5, §5c, §7. Reform-plan steps **W3, W4**.

## 1. A day

| When (IST) | What happens | Code |
|---|---|---|
| **21:30** | Recap of today (✅ / ⏭ / ⬜ per item, a weekly line only if a floor is at risk) + tomorrow's draft + bedtime line on gym days ("Back / Biceps tomorrow, up by 07:00 → lights out ~23:00") | `jobEvening` → `ensureDraft` + `renderEvening` |
| any time before 23:00 | Reply to change it ("skip gym", "add call mom", "travelling Fri–Sun") or **ok** to lock | `understand` → ops → `replanAfterChange` |
| **23:00** | Tomorrow locks itself if you said nothing. Nothing is sent. | `jobLock` → `lockDay(…, "auto")` |
| **morning** | Your first message (or **up**) after 04:30 sends today's plan. If you say nothing: 09:30 weekdays, 10:30 weekends. | `noteWake` / `jobMorning` → `sendMorning` |
| during the day | "done with gym", "skip reading", "did the DSA problem" | `plan` intent → `set_item_status` |

The day turns over at **03:00**, so a 01:00 message still belongs to the previous day.

## 2. How a day is drafted (`src/plan.ts`, pure)

1. **Kind** from the weekly pattern: GYM / MOBILITY / REST (Sunday always REST).
2. **Overrides** covering the date (precedence SICK > LOW_MOOD > TRAVEL > OUT):

   | Override | Gym | Study | Reading |
   |---|---|---|---|
   | SICK | off | off | off |
   | LOW_MOOD | 10-min walk | open one DSA problem | one page |
   | TRAVEL | off | one fragment | allowed |
   | OUT | unchanged | one shorter fragment | off |

3. **Fitness:** a GYM day takes the **next rotation split** (Chest/Triceps → Back/Biceps → Legs/Shoulders) and sets `wake_by` (config `gym_wake_by`, 07:00). A REST or MOBILITY day (never Sunday) is **upgraded to GYM only when the weekly lift floor can no longer be reached otherwise** — a slipped lift is offered again, nothing else moves.
4. **Study** from the pointers:
   * every day: the next **DSA** unit (fragment);
   * remote, non-gym weekday: + an **optional block**, alternating system design / frontier lab by day;
   * Saturday: a **system-design** block, Sunday: a **frontier-lab** block, each + an optional DSA fragment;
   * gym day or office day: the fragment only.
5. **Reading:** the book you're reading (alternating if you have two), else the next queue article. Always optional.

**Finishing an item moves its source, inside the same undoable op:** a DSA/system-design/frontier item advances that list's pointer; a gym item advances the rotation; a queue article is marked read. A **skip moves nothing**, so the same unit is offered again the next day.

## 3. Drafts, locks and edits

* Drafts are written directly (no revision), so they never clutter `/undo`. Re-drafting is idempotent: it replaces only the auto items still `planned`, and keeps anything you added, did, skipped or moved.
* A locked day is never re-drafted, except when you tell it about an override ("sick today") — then today and tomorrow are re-planned and the reply shows the new plan.
* After any change, tomorrow's unlocked draft is refreshed (a unit you just finished doesn't reappear).
* A moved item becomes yours (`source='user'`), so neither day's draft deletes or duplicates it.

## 4. Commands

| Command | |
|---|---|
| `/plan`, `/plan tomorrow` | see a day |
| `/up` | today's plan now |
| `/lock` | lock tomorrow now (same as replying **ok** after the evening message) |
| `/office tue thu` | office days for the coming week; others are remote (study routing follows) |
| `/jobs` | when the three jobs fire next |
| `/testcue evening\|lock\|morning` | run a job now (testing) |

Natural language: see `/help` (done / skip / add / move, travelling / sick / out / feeling low).

## 5. Scheduling

Three one-shot schedules (`jobEvening`, `jobLock`, `jobMorning`), each re-registered after it runs and on every Durable Object start (`ensureJobs`). A schedule that is due right now is never cancelled (it may be the alarm that woke the object). Times come from `config` (`evening_cue`, `auto_lock`, `morning_fallback_weekday`, `morning_fallback_weekend`). The v1 cron cues (08:15 morning, 17:00 commute, 21:30 synthesis) are cancelled on start and their code is gone. Snooze still silences the evening and fallback-morning messages; the lock always runs.

## 6. Sub-steps

- [x] 10.1 `plan.ts` pure `draftDay`.
- [x] 10.2 Evening recap + tomorrow + bedtime line.
- [x] 10.3 23:00 auto-lock; edits after the lock still apply as ops.
- [x] 10.4 Wake-triggered morning with weekday/weekend fallback.
- [x] 10.5 Scheduler: three self-re-arming jobs; v1 cues removed.
- Pulled forward from Phase 11: `plan` intent (done/skip/add/move), `override` intent (TRAVEL/SICK/OUT/LOW_MOOD) with re-planning, LOW_MOOD minimum items, `/office` + `set_place`.

## 7. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Covered: time helpers and the 03:00 boundary; every planner rule (kinds, overrides, office/remote, weekends, slipped-lift upgrade, determinism); drafts idempotent and keeping user items; locks never redrafted; done advancing pointer/rotation/article with undo; skip not advancing; moves not duplicated; evening/morning rendering; job times; a full week from the real seeds; plan and override extraction.

**Not exercised live yet.** After deploy: `/jobs` (three jobs listed), `/testcue evening` (recap + tomorrow), reply "skip gym" then "ok", `/plan tomorrow`, `/testcue morning`, "done with gym" → `/plan`, `/undo`.
