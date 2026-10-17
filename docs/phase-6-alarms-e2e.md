# Phase 6: Alarms, Ambient Cues & End-to-End Validation — Implementation Guide

> **Phase Goal:** Register three recurring cron-based ambient cues using the Cloudflare Agents SDK scheduler. Each cue fires at a fixed IST time daily, respects the active snooze state, and sends a personalized Telegram message based on the user's SQLite state.

---

## 1. Cue Schedule (All Times IST = UTC+5:30)

| Cue | IST Time | UTC Cron | Callback |
|---|---|---|---|
| Morning Focus Cue | 08:15 IST | `45 2 * * *` | `morningCue` |
| Commute Read Cue | 17:00 IST | `30 11 * * *` | `commuteCue` |
| Evening Synthesis | 21:30 IST | `0 16 * * *` | `eveningSynthesis` |

All three are registered in `onStart()` using `this.schedule("cron", ...)` which is **idempotent by default** — calling it on every DO restart does not create duplicate schedules.

---

## 2. Architecture

```
onStart()
   │
   ├── this.schedule("45 2 * * *",  "morningCue")
   ├── this.schedule("30 11 * * *", "commuteCue")
   └── this.schedule("0 16 * * *",  "eveningSynthesis")

       ↓ Cloudflare physical DO alarm (managed by Agents SDK) ↓

morningCue()          commuteCue()         eveningSynthesis()
     │                     │                       │
  snooze check?         snooze check?           snooze check?
     │                     │                       │
  Send daily focus     Serve next item        Query today's
  + serendipity read   from reading_queue     workout_logs
  from reading_queue   to Telegram            + interaction_logs
  to Telegram                                 → send summary
```

---

## 3. Sub-Steps Breakdown

| Step | Action | Status | Notes |
|---|---|---|---|
| **6.1** | Register 3 idempotent cron schedules in `onStart()` | ✅ Done | `registerAmbientCues()` in `src/agent.ts` |
| **6.2** | Implement `morningCue()` — daily focus cue + serendipity read | ✅ Done | 08:15 IST / 02:45 UTC, serves 1 queue item & today's stats |
| **6.3** | Implement `commuteCue()` — commute reading cue | ✅ Done | 17:00 IST / 11:30 UTC, marks queued item as served |
| **6.4** | Implement `eveningSynthesis()` — daily activity summary | ✅ Done | 21:30 IST / 16:00 UTC, compiles today's workout logs & interactions |
| **6.5** | Snooze guard in all 3 handlers | ✅ Done | Bails out gracefully if `isCurrentlySnoozed()` is true |
| **6.6** | Test commands (`/cues`, `/testcue <cue>`) & live validation | ✅ Done | Added `/cues` and `/testcue morning|commute|evening` for immediate Telegram validation |

---

## 4. Verification & Testing Commands

Telegram commands available for end-to-end testing:
- `/cues` — Review all 3 registered daily cues, schedules, and active snooze status.
- `/testcue morning` — Trigger a test execution of `morningCue()`.
- `/testcue commute` — Trigger a test execution of `commuteCue()`.
- `/testcue evening` — Trigger a test execution of `eveningSynthesis()`.
- `/snooze <hours>` — Verify snooze suppression on test cues.
- `/unsnooze` — Clear snooze and re-enable cues.
- `/remind <minutes> <text>` — Test arbitrary future ad-hoc reminder scheduler.

