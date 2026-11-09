# Phase 15: Data access — read-only views — Implementation Guide

> **Goal:** look at what the agent has logged without opening the Cloudflare dashboard or guessing: named, read-only views over the Durable Object's SQLite, over HTTP, as JSON or CSV, plus a script that dumps them to files.
>
> **Source:** `docs/backlog.md` item **D1**. It unblocks verifying **B3** (duplicate sets) and **Q2** (sleep), and it is the read API the dashboard (Phase 18) will use.

## 1. Rules

1. **Read-only.** Nothing here writes. Every view is one `SELECT` written by hand.
2. **Named views, not SQL.** No query text comes from the caller. Parameters are validated (dates, small enums, a row limit) and passed as bound values.
3. **Allowlist of fields.** A view returns the columns written in it. `bot_state`, `config`, `processed_update` and `mirror_state` are not exposed.
4. **Same auth as the other admin routes:** `Authorization: Bearer <ADMIN_TOKEN>`; 503 when no token is configured (admin off, also locally).
5. **Dates are the user's days** (IST, day turns at 03:00), the same as `dayKey` — so `from=2026-11-05` starts at 03:00 IST on the 5th.

## 2. Routes

| Route | Returns |
|---|---|
| `GET /admin/view` | the list of views: name, description, parameters |
| `GET /admin/view/<name>?from=&to=&limit=&…` | `{ ok, view, params, count, truncated, rows }` |
| `…&format=csv` | the same rows as CSV (`text/csv`), header row first |

Status codes: `200`, `400` (unknown view, bad parameter), `401`, `405` (not GET), `503`.

`limit` defaults to 100 and is capped at 1000. `truncated: true` means more rows exist than were returned.

## 3. Views

| View | Parameters | Columns (summary) |
|---|---|---|
| `events` | `from`, `to`, `type`, `limit` | id, ts, type, lane, source, raw, payload_json |
| `revisions` | `from`, `to`, `limit` | id, ts, summary, op_json, undone_at |
| `messages` | `from`, `to`, `limit` | id, source, raw_content, parsed_json, created_at (the v1 interaction log: what you sent and how it was read) |
| `inbox` | `status` (open/resolved/dropped, default open), `limit` | id, ts, raw, status |
| `plan` | `from`, `to` (default last 7 days), `limit` | date, day status, locked_by, place, item id/lane/title/status/optional |
| `sessions` | `from`, `to` (default last 14 days), `limit` | one row per set: date, session, exercise, set_no, weight_kg, reps, duration_s, rest_s, bw, set kind, notes |
| `metrics` | `from`, `to` (default last 30 days), `metric`, `limit` | date, metric, value, ts |
| `reminders` | `status`, `limit` | id, text, due_at, due_date, status, repeat_rule, repeats, fired_at, done_at |
| `reading` | `state`, `limit` | id, title, kind, author, state, slot, progress, started_at, ended_at |
| `jots` | `limit` | id, created_at, item, locator, kind, text |
| `pointers` | — | list_id, list, ordinal, total, current unit |
| `overrides` | `limit` | id, type, start_date, end_date, scope, note, revoked_at |
| `notes` | `limit` | id, lane, text, created_at, expires_at, resolved_at |

## 4. Export script

```
npm run export -- --url https://study-agent.<you>.workers.dev --view sessions --from 2026-11-01 --to 2026-11-09
npm run export -- --url https://… --all --from 2026-11-01        # every view into exports/<date>/<view>.csv
```

* Reads `ADMIN_TOKEN` from `.dev.vars` (or the `ADMIN_TOKEN` environment variable); never prints it.
* `--url` defaults to `http://localhost:8787` (`npm run dev`), or `STUDY_AGENT_URL`.
* Writes to `exports/`, which is gitignored: it holds personal data.

## 5. Sub-steps

- [x] 15.1 `src/views.ts`: the view registry, parameter validation, `readView`, `toCsv`.
- [x] 15.2 `tests/views.test.ts`.
- [x] 15.3 `StudyAgent.readView` (RPC) and the `GET /admin/view…` routes behind the existing guard.
- [x] 15.4 `scripts/export-data.ts`, `npm run export`, `exports/` in `.gitignore`.
- [x] 15.5 Docs: this file, plan, README.

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Covered: every view runs on a migrated empty database; with one row in every table, each view returns exactly the columns it declares; filters (date range at the 03:00 boundary for both ISO and SQLite timestamps, type, status, state, metric); date defaults move with "today"; limit default / cap / `truncated`; unknown view, unknown parameter, bad dates and bad enum values are errors; values that look like SQL are only bound values; `bot_state`, `config`, `processed_update`, `mirror_state` and `sqlite_master` cannot be named as views; the sessions view returns one row per set in order and keeps exercises with no sets; CSV quoting of commas, quotes and newlines, with a leading apostrophe on text that a spreadsheet would run as a formula.

Also run once against `npx wrangler dev` (real Durable Object): 401 without a token, 405 for a non-GET, 400 for a bad view or parameter, JSON and CSV output, and `npm run export -- --all`.

No `/help` change: this phase adds no chat command.

## 7. After deploy

1. `npx wrangler deploy` (the `ADMIN_TOKEN` secret already exists from Phase 8).
2. `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/view` → the list.
3. `npm run export -- --url https://<worker> --view messages --from <the day of the duplicate sets>` → the raw messages for **B3**.
4. `npm run export -- --url https://<worker> --view sessions --from <same day>` → the sets as stored.
