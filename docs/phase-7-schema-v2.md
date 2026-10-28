# Phase 7: Schema v2, Op Applier, Serial Queue — Implementation Guide

> **Phase Goal:** Give the agent a durable, auditable state layer for the product loop: new tables, a single place where state changes (`applyOp`), exactly-once handling of Telegram updates, serialised message processing, and undo. No product behaviour yet — Phases 8–11 build on this.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §6, §11. Reform-plan step: **W0**.

---

## 1. Design

```
Telegram update ──► SerialQueue ──► dedupe (processed_update) ──► [later: LLM → Op] ──► applyOp
                                                                                           │
                                         one SQLite transaction ◄──────────────────────────┘
                                         ├─ handler mutates rows via Recorder (records before/after)
                                         ├─ event    (append-only ground truth, idempotency_key UNIQUE)
                                         └─ revision (diff = row-level before/after → undo)
```

* **Everything that changes plan state goes through `applyOp`.** The LLM (Phase 9) only ever produces an `Op`; code validates and applies it.
* **Row-level undo.** Handlers write through a `Recorder` that captures `before`/`after` for every row touched. Undo replays the diff backwards, so no handler needs to write its own inverse.
* **Undo is a stack:** only the most recent non-undone revision can be undone. This avoids reasoning about overlapping edits.
* **Idempotency, two layers.**
  1. `processed_update(update_id)` — a replayed Telegram update is skipped at the top of the handler.
  2. `event.idempotency_key` (`<update_id>#<n>`, UNIQUE) — if processing fails halfway and the update is retried, ops that already applied return their stored result instead of applying twice.
* **Serial queue.** A promise chain in the Durable Object. Without it, an `await` on the LLM lets a second message read the same state and clobber the first.
* **Optimistic version check.** `day_plan.version` is bumped by any change to that day's items. A caller that read the plan before an `await` can pass `expectVersions`; a mismatch throws `VersionConflictError` so the caller can re-read and retry once (used from Phase 9).
* **Testability.** All DB access goes through a 4-method `Db` interface. Production uses the Durable Object adapter; tests use Node's built-in `node:sqlite`. No test framework dependency.

## 2. Files

| File | Purpose |
|---|---|
| `src/db/db.ts` | `Db` interface + Durable Object adapter |
| `src/db/migrations.ts` | versioned migrations; v1 = existing schema, v2 = product-loop tables |
| `src/ops.ts` | op types, validators, `Recorder`, `applyOp`, `undoLast` |
| `src/queue.ts` | `SerialQueue` |
| `src/agent.ts` | wires migrations, queue, dedupe, `/undo` |
| `tests/*.test.ts` | `npm test` (Node ≥ 24, `node:sqlite`) |

## 3. Tables added (migration v2)

`schema_migrations`, `processed_update`, `event`, `revision`, `inbox`, `config`, `lane`, `target`, `pattern`, `rotation`, `track`, `unit_list`, `unit`, `pointer`, `override`, `note`, `day_plan`, `plan_item`.

Differences from the spec's shorthand: `unit_list` sits between `track` and `unit` (the seed has several ordered lists per track, e.g. DSA and system design inside *Interview prep*); `pointer` is keyed by list, not lane; `plan_item.unit_id` links an item to the unit it came from; `revision` carries a `summary`.

v1 tables (`bot_state`, `interaction_logs`, `reading_queue`, `workout_logs`, `reminders`) are untouched.

## 4. Ops in this phase

Enough to exercise every generic path (insert, update, delete-by-undo, multi-row, versioned):

`add_item` · `set_item_status` · `move_item` · `set_override` · `revoke_override` · `add_note` · `resolve_note` · `advance_pointer` · `set_config` · `note`

More ops arrive with their lanes (reminders, fitness, reading).

## 5. Sub-steps

- [x] 7.1: Migration v2.
- [x] 7.2: `ops.ts` — validators, `applyOp`, `Recorder`.
- [x] 7.3: Idempotency (`processed_update` + `event.idempotency_key`).
- [x] 7.4: `SerialQueue` around `handleTelegramUpdate`; version check.
- [x] 7.5: `undoLast` + `/undo`.

## 6. Validation

```
npm run typecheck
npm test
```

Checks that must pass:

- Migrations run twice without error; all v2 tables exist.
- `add_item` creates a `day_plan` + item + event + revision; `undoLast` removes all three effects of the change.
- Same `idempotencyKey` twice → second call returns `duplicate: true`, no second row.
- Undo is stack-ordered; nothing to undo is reported, not thrown.
- Invalid ops (unknown type, bad date, `end < start`, note with no TTL) are rejected before touching the DB.
- Stale `expectVersions` → `VersionConflictError`, nothing written.
- `SerialQueue` runs tasks strictly in submission order even when earlier tasks await longer; a failing task does not stall the queue.

## 7. Manual check after deploy

1. Send any message twice using Telegram's webhook replay (or `curl` the same JSON with the same `update_id`) → one response.
2. `/undo` with nothing to undo → "Nothing to undo."
