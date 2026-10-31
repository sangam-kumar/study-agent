# Phase 12: Repo mirror — Implementation Guide

> **Goal:** every planned day also exists as a daily note in `study-repo`, written by the agent, without ever touching what you write yourself.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §14. Reform-plan step **M1**.

## 1. What gets written

`daily/<year>/<MonthName>/DD-MM-YYYY.md` — the repo's existing convention (e.g. `daily/2026/November/02-11-2026.md`).

The agent owns **one marked block** per note:

```markdown
# 02-11-2026

<!-- study-agent:start (written by the study agent; edit outside this block) -->
## Plan — Mon 2 Nov
_locked (auto) · office · up by 07:00_

- [x] Gym: Chest / Triceps · 105 min
- [ ] ~~DSA: Two Sum~~ — skipped
- [ ] Read: DDIA · 20 min · optional
<!-- study-agent:end -->

## Notes
```

* No note yet → it is created with a title, the block and an empty `## Notes`.
* A note you already wrote → the block goes under the title; **everything else is preserved**.
* Later runs replace only the block. Edits *inside* the block are overwritten; write outside it.

## 2. When

| Trigger | |
|---|---|
| 23:00 lock job | always (after locking tomorrow) |
| "ok" after the evening message, `/lock` | after the reply |
| `/mirror` | on demand; replies with what was written |

Each run looks at **yesterday, today and tomorrow** and writes only the days whose block changed since the last successful write (`mirror_state`, migration v5). All changed days go in **one commit** ("daily: Mon 2 Nov, Tue 3 Nov [study-agent]"). Nothing changed → GitHub is not contacted at all. Because yesterday is included, a late "done" after 23:00 still reaches yesterday's note at the next lock.

## 3. Safety

* **One commit, never a force-push.** Git Data API: tree → commit → move `master` with `force: false`. `study-repo`'s own GitHub Actions commit to `master` several times a day; if the branch moved in between (HTTP 422), the change is rebuilt on the new head and retried (up to 3 times).
* **Failure never blocks a reply.** The mirror runs after the reply is sent and never throws; a failure is logged as a `mirror_failed` event and nothing is recorded as written, so the next lock retries it.
* UTF-8 safe (the old client decoded with `atob`, which garbles emoji and dashes).
* Config: `GITHUB_PAT` (secret), `GITHUB_REPO` (var), `mirror_branch` (config, default `master`).

## 4. Sub-steps

- [x] 12.1 GitHub client (read with UTF-8, multi-file single commit, retry on a moved branch); one commit per lock for `daily/…`.
- [ ] 12.2 Regenerate `study/reading/reading-queue.md` from the reading items — **deliberately not done**, see §5.
- [x] 12.3 Failure policy: never blocks the reply; retried at the next lock.

## 5. Why `reading-queue.md` is not regenerated (yet)

Regenerating it from the database would (a) overwrite the file you edit by hand, (b) re-number the queue lines, and `seed_reading.py` keys queue items by **position** (`queue:001` …), so a later reseed would attach the wrong states to the wrong items, and (c) only matters to `scripts/daily_reminder.py`, the old GitHub-Issue notifier the agent replaces. Decide first whether that notifier stays (reform plan); if it goes, 12.2 is unnecessary. If it stays, switch queue keys to content-based slugs before regenerating.

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Covered with an in-memory fake GitHub: path convention; block rendering (done / skipped / optional, meta line); merge into a new note, into your own note, replacing an old block, idempotence; one commit for several files; UTF-8 round-trip; missing file reads as null; branch moved → rebuilt and retried, the other commit kept; nothing to write → no commit; unchanged days → GitHub not contacted; only the changed day written; a failed commit records nothing and the next run retries.

Checked live (read-only): the PAT in `.dev.vars` sees `sangam-kumar/study-repo`, default branch `master`. **Write access is first exercised by `/mirror` after deploy** (a fine-grained token also needs "Contents: Read and write" on that repo).
