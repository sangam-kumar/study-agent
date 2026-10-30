# Phase 8: Seeding — Implementation Guide

> **Phase Goal:** Load the reviewed study plan into the agent so every track has a pointer at unit 1 and the planner (Phase 10) can answer "what's next". Reading, config and gym seeds follow the same path.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §9. Reform-plan steps **W1a–W1c**.

---

## 1. Flow

```
study-repo/scripts/seed_study.py ──► seed/study.json ──► (you skim + fix) ──► POST /admin/seed ──► tables
        deterministic, no LLM           reviewable                                  idempotent upsert
```

* The LLM is not in the load path. It may later *propose* splits for oversized units, but only by editing `seed/study.json`, which you review.
* **Every pointer starts at 1.** Nothing is pre-marked done. Old solutions in `problems/` are attached to units as `prior_solution` references only.

## 2. Loader rules (`src/seed.ts`)

| Rule | Why |
|---|---|
| Whole load is one transaction; validation runs first | a bad file writes nothing |
| Idempotent upsert by `(list_id, ordinal)` | re-running is safe; edited titles update in place |
| **A reload never moves a pointer** | pointers advance only through `advance_pointer` ops |
| Nothing is deleted; units missing from the file are counted as `orphanUnits` | plan items may already reference them |
| One `seed` event with the counts, **no revision** | a 399-row load is not something `/undo` should reverse |

Reordering units in the file changes what an unchanged pointer ordinal means. If you reorder, check `/tracks` afterwards.

## 3. The endpoint

`POST /admin/seed?kind=study` (default kind) — body is the contents of `seed/study.json`.

| Status | Meaning |
|---|---|
| 200 `{ok:true, report}` | loaded; `report` has insert/update/unchanged counts, `pointersCreated`, `orphanUnits` |
| 400 `{ok:false, error}` | invalid JSON, unknown `kind`, or a validation error with the path of the bad field |
| 401 | missing/wrong `Authorization: Bearer <ADMIN_TOKEN>` |
| 405 | not POST |
| 413 | body larger than 5 MB |
| 503 | `ADMIN_TOKEN` is not configured (admin routes are off, including in local dev) |

`ADMIN_TOKEN` is separate from `TELEGRAM_SECRET_TOKEN` so one leak does not grant the other. The comparison is constant-time (digest compare).

## 4. Deploy and load

```powershell
cd C:\study\study-agent
npx wrangler secret put ADMIN_TOKEN        # paste a long random string
npm run deploy

$token = "<the same string>"
curl.exe -X POST https://<your-worker>.workers.dev/admin/seed `
  -H "Authorization: Bearer $token" -H "Content-Type: application/json" `
  --data-binary "@C:\study\study-repo\seed\study.json"
```

Expected first response: `{"ok":true,"report":{"tracks":2,"lists":3,"units":{"inserted":399,...},"pointersCreated":3,"orphanUnits":0}}`. Running it again must give `inserted:0, unchanged:399, pointersCreated:0`.

Then in Telegram: `/tracks` → three lines, each `[1/N]` with its first unit.

For local dev add `ADMIN_TOKEN=...` to `.dev.vars`, or run `wrangler dev --var ADMIN_TOKEN:<x>`. Note that `.dev.vars` also holds the real Telegram token, so a local server can message your chat.

### Loading the other kinds

```powershell
curl.exe -X POST "https://<worker>/admin/seed?kind=config"  -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary "@C:\study\study-repo\seed\config.json"
curl.exe -X POST "https://<worker>/admin/seed?kind=reading" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary "@C:\study\study-repo\seed
eading.json"
```

Expected first responses: config `{pattern:{inserted:7}, rotation:{inserted:3}, config:{inserted:10}, lanes:{inserted:4}, targets:{inserted:5}}`; reading `{items:{inserted:460}}`. Second runs insert nothing.

Ownership on reload: `config`, `lane`, `target` are the user's (set through ops), so a reload only fills in what is missing. `pattern` and `rotation` are seed-owned and are upserted. `reading_item.state`, `slot` and `shortlist` are the user's and are never touched; only metadata refreshes. Not set yet: the weekly **study sessions** target, which waits on the study rhythm decision (reform plan W3).

## 5. Sub-steps

- [x] 8.1: `/admin/seed` endpoint, auth, loader, `/tracks`.
- [~] 8.2: Study seed script written (`study-repo/scripts/seed_study.py`); **review of `seed/study.json` pending**; LLM split proposals not built.
- [x] 8.3: Reading seed (`study-repo/scripts/seed_reading.py` -> `seed/reading.json`, `kind=reading`, migration v3 `reading_item`) and config seed (hand-written `seed/config.json`, `kind=config`).
- [x] 8.4: Gym *structure* (weekly pattern, rotation, targets, lanes) is in `seed/config.json`. **Not done, belongs to Phase 13:** the exercise catalog + backfilling the October sessions from `life/gym-tracking.md` (needs the workout tables), and the rotation pointer.

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Covered by tests: first load, idempotent reload, pointers untouched by reload, edited fields applied, orphans reported not deleted, prior solutions round-trip, `queryPlan` incl. empty/finished lists, invalid seeds write nothing, mid-load failure rolls back everything, and the real `seed/study.json` loads with every pointer at 1.

Also verified once in local `workerd` (real Durable Object SQLite): 401/405/400 paths, first load = 399 inserted, second = 399 unchanged.

## 7. Clearing test data from earlier flows

Migrations only add tables, and seeding never touches the v1 tables, so anything created while testing the v1 bot (logs, workouts, reminders, queued URLs, snooze) stays until you clear it. `POST /admin/reset` does that. **It is a dry run unless you pass `confirm=yes`**, and you choose what to clear:

| `scope` | Clears |
|---|---|
| `logs` | `interaction_logs`, `processed_update` |
| `workouts` | `workout_logs` |
| `reminders` | `reminders` **and** the matching delayed alarms (otherwise a deleted row would still fire) |
| `reading` | `reading_queue` |
| `snooze` | the snooze keys in `bot_state` |
| `plan` | `revision`, `event`, `inbox`, `plan_item`, `day_plan`, `override`, `note` |
| `pointers` | every pointer back to unit 1 (units are kept) |
| `shelf` | reading books back to their seeded state (queued/backlog); books you added by hand are removed |
| `all` | everything above |

Never touched: the schema, seeded tracks/units, `config`, `lane`, `target`, other `bot_state` keys, and the three daily cue schedules.

```powershell
# 1. See what would go (dry run, nothing deleted)
curl.exe -X POST "https://<worker>/admin/reset?scope=all" -H "Authorization: Bearer $token"
# 2. Decide. reading_queue and workout_logs may hold real data - leave them out of scope if so.
curl.exe -X POST "https://<worker>/admin/reset?scope=logs,reminders,snooze,plan,pointers&confirm=yes" -H "Authorization: Bearer $token"
```

Response: `{"ok":true,"dryRun":true,"affected":{"logs":42,...},"alarms":1}` — `alarms` appears when `reminders` is in scope. Deletion is permanent; there is no undo for a reset.

Tested against an in-memory database (dry run deletes nothing; `all` keeps seed content and unrelated state; scopes are independent). **Not yet exercised in workerd:** cancelling the delayed alarms. After deploy: `/remind 60 test`, run the dry run (expect `"alarms":1`), run it with `confirm=yes`, then `/reminders` should be empty.

## 8. The reading shelf

`reading_item` flow: `backlog|queued -> sampling -> active -> done`, with `dropped` as an exit from any open state (revivable, with the reason kept). Each book has a `slot` (technical or narrative/founder); only **one sampling/active book per slot**.

| Command | Op | Effect |
|---|---|---|
| `/books` | - | what is being read + up to 3 picks (next shortlisted book of each free slot, plus a wildcard that rotates by day) |
| `/book add Title \| Author` | `add_reading` | lands in the backlog as your own entry |
| `/book start <id>` | `start_reading` | begins sampling; refused if the slot is busy; also revives a dropped book |
| `/book keep <id>` | `keep_reading` | sampling -> active |
| `/book done <id>` | `finish_reading` | finished |
| `/book drop <id> [reason]` | `drop_reading` | dropped, reason kept; never re-offered unless you start it again |

Every change is an op, so `/undo` reverses it. The shortlist and its order live in `study-repo/scripts/seed_reading.py` (`SHORTLIST_*`). Natural-language ("drop Sapiens, boring") arrives with the inference layer in Phase 9; the sampling check-in prompt arrives with the day loop in Phase 10.
