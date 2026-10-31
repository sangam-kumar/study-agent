# Phase 9: Understanding — Implementation Guide

> **Goal:** plain text or voice becomes a typed, validated change. The model only classifies and extracts; code resolves ids, does arithmetic and decides. Nothing the model says is applied without passing a validator.
>
> **Spec of record:** `study-repo/projects/study-agent-spec.md` §10, §11, §13. Reform-plan step **W2**.

## 1. Flow

```
message (text, or voice -> transcript)
   │
   ▼
classify  ── confidence < 0.6 ──────────────┐
   │  (base card + classify card + tiny snapshot)
   ▼                                          ▼
lane extractor (base card + ONE lane card    inbox  (saved, nothing changed)
   + snapshot for that lane)
   │  validate → one retry with the reason → next backend
   ▼
map in code ──► ops (reading / study / note) · reminder · workout · snooze · reply
```

| File | Role |
|---|---|
| `src/infer.ts` | `infer(backends, request)`: failover on any transport error (incl. 429), one validation retry per backend, `InferError` lists every attempt |
| `src/ai/backends.ts` | One Gemini backend **per model in `GEMINI_MODEL`** (comma-separated, tried in order), then Workers AI. `transcribe` tries the same Gemini models, then Whisper. `LLM_PROVIDER=cloudflare` forces Workers AI only |
| `src/cards.ts` | `BASE_CARD`, `CLASSIFY_CARD`, one `LANE_CARDS` entry per intent |
| `src/snapshot.ts` | `buildSnapshot(db, intent, now)`: IST time, active overrides, unexpired notes, plus the lane's slice (shelf titles, study lists, recent events) |
| `src/understand.ts` | the pipeline, the per-lane validators and the mapping to outcomes |

## 2. Intents

| Intent | Model extracts | Code does |
|---|---|---|
| `reading` | action (add/start/keep/hold/done/drop), title fragment, author, reason | resolves the book (`parseBookCommand`); ambiguous → asks, never guesses |
| `study_done` | list id, count | checks the id exists, computes the new pointer position, clamps at "finished" |
| `reminder` | text, `delay_minutes` **or** `at_time` (+ `on_date`) | converts the clock time to minutes (`reminder-time.ts`); a time in the past fails validation |
| `note` | text, ttl | clamps the TTL to 1–30 days → `add_note` |
| `workout` | type, exercises | legacy `workout_logs` insert until Phase 13 (day boundary 03:00 IST) |
| `snooze` | hours, reason | legacy snooze until Phase 11 |
| `chat` | a short reply | HTML-escapes it; changes nothing |

## 3. Failure behaviour

* Gemini 429/5xx/timeout → Workers AI, automatically.
* Invalid answer → one retry with the rejection reason, then the next backend.
* Everything fails → the message is saved to `inbox` with an honest reason ("the AI is unavailable" vs "I couldn't make sense of that"). **No message is lost and nothing is half-applied.**
* `/inbox` lists open items; `/inbox done <id>` clears one.

## 4. Size budget

A lane call is base card + lane card + snapshot. A test builds the packet for every intent against the **real** seeds and asserts it stays under 4000 characters (~1k tokens). The study snapshot is the largest because it lists every list's position.

## 5. Sub-steps

- [x] 9.1 `infer()` with failover and retry; backends.
- [x] 9.2 Base card + lane cards.
- [x] 9.3 `snapshot.ts`.
- [x] 9.4 Text and voice go through `understand()`; low confidence and total failure go to `inbox`. The old `parseText` / `processAudio` / provider layer is deleted (it carried the stale reminder prompt that caused the 6:30 pm bug on the fallback path).

## 6. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
```

Tests use scripted fake backends (no network): failover, retry-then-succeed, retry-then-fail, ambiguous reference, clock-time reminder, past-time reminder, invented list id, TTL clamp, low confidence, all-backends-down, context size.

**Not yet exercised against the live models.** After deploy, try in Telegram: *"finished the 100 page ML book"*, *"drop Sapiens, boring"*, *"remind me at 6:30 pm to play ball"*, *"did 3 DSA problems"*, a voice note, and something vague (should land in `/inbox`). Then `/books`, `/tracks`, `/undo`.

## 7. Live check against the real models (`npm run live-check`)

`scripts/live-check.ts` sends 21 example phrases through a real model against the real seeds in an in-memory database (clock frozen at Mon 2 Nov 10:00 IST, a gym day) and checks each outcome. Nothing is applied, nothing is sent to Telegram, the deployed agent is not touched. Keys come from `.dev.vars` and are never printed.

```
npm run live-check                                    # gemini-3.5-flash-lite, all phrases
npm run live-check -- --model gemini-3.5-flash --gap 13
npm run live-check -- --only reading,plan
npm run live-check -- --workers                       # needs a Cloudflare token with Workers AI permission
```

**Findings (31 Oct 2026):**

* `gemini-3.5-flash-lite`: **21/21** after two fixes below. Its free quota took 50+ calls in a row.
* `gemini-2.5-flash` free tier is **20 requests/day per project** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). At 2 calls per message that is ~10 messages a day. Hence the model chain: `gemini-3.5-flash-lite,gemini-3.5-flash,gemini-2.5-flash`, then Workers AI. Each model has its own daily quota; a 429 on one simply moves to the next. Quotas reset at midnight Pacific (13:30 IST).
* `gemini-2.5-flash-lite` is no longer available to new users (404).
* Fixed: book lookup was a plain substring match, so "the 100 page ml book" missed "The Hundred-Page Machine Learning Book" and "pause DDIA" was ambiguous with the queue line "DDIA - pick a chapter". Lookup now normalises punctuation, matches acronyms and shortenings (ml, 100), and only considers books in a state the action applies to. The reading snapshot also lists the shortlist so the model can expand vague references.
* Fixed: Gemini omits optional schema fields, so "move DSA to Saturday" came back without a date. `date` is now required for plan edits.
* Not covered locally: Workers AI (the `.dev.vars` token lacks the Workers AI permission; the deployed Worker uses its AI binding instead), and voice transcription (needs an audio file).
