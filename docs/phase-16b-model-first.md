# Phase 16b: Model-first understanding with conversation context — Implementation Guide

> **Goal:** no message is interpreted by hand-written patterns. The model decides what a message *means*, using the message you replied to and the recent conversation; code decides what that *does*, from tags it wrote itself. Short replies ("ok", "both", "yes", "gn") work because the model can see what they answer.
>
> **Why:** Phase 16 added regex shortcuts (`parseExerciseEdit`, `parseChatWorkout`, …) that duplicate model intents, and a "Today's workout / Legs/Shoulders" message fell to the inbox. Shortcuts are brittle in wording; the model path is not, but only if it has context.

## 1. Principle: the model reads, code decides

| Model decides | Code decides |
|---|---|
| What the message means (intent, fields, "this is an answer to that") | What happens (which row changes), validated and undoable |
| Which of the options was meant | Which options exist, and what each one does |

A reply like "ok" is never turned into an action by the model directly. The model says *affirm*; code looks at the **tag** on the bot message being answered (`evening_recap`, `question:<id>`, `reminder:<id>`) and applies that tag's meaning. This is why the guards stay simple.

## 2. What is parsed by hand today (inventory)

| # | Where | Replaced by |
|---|---|---|
| 1 | `answerChoice` / `answerConfirm` (`convo.ts`) | `answer` intent, with the open question in context |
| 2 | "ok / lock it" regex (`agent.ts`) | `affirm` in `answer` intent, target from the message tag |
| 3 | `BED_RE` (`day.ts`) | `status` intent |
| 4 | `OFFICE_RE` + `parseWeekdays` | `place` intent (op `set_place` already exists) |
| 5 | `parseProtein` | `workout` intent (`protein_g` exists) |
| 6 | `parseJotText` | `jot` / `progress` intents (exist) |
| 7 | `parseChatWorkout` | `workout` intent (exists) |
| 8 | `parseExerciseEdit` | `workout_edit` intent (exists, verified live) |
| 9 | `BED_RE` reuse in the wake check (`agent.ts` ~655) | wake decided after classification (see 16b.8) |

**Kept on purpose:** slash commands (explicit); reminder time arithmetic (model reports "6:30 pm", code does the date maths); catalog name resolution and `suggestExercise` (entity resolution is better in code); `sets.ts` (validates what the model emits); seed parsers.

## 3. What is missing for context (found in the code)

* Only **inbound** messages are logged (`interaction_logs`). The bot's own messages are not stored, and Telegram message IDs are kept only for reminders. So "the message being replied to" cannot be looked up yet.
* Telegram sends `reply_to_message` (`message_id`, `text`) with a swipe-reply; the code never reads it.
* `TelegramClient` is constructed in 5 places; outbound messages need one choke point.

## 4. Design

### 4.1 `chat_log` table
```
chat_log(id, ts, dir 'in'|'out', tg_message_id, reply_to_tg_id, text, tag, parsed_json)
```
* `in`: every inbound text/voice transcript, with `reply_to_tg_id` and the replied-to text when Telegram sent it.
* `out`: every message the bot sends, with its Telegram message ID (from `sendMessage`) and a **tag** the sender chooses: `evening_recap`, `morning_plan`, `question`, `reminder:<id>`, `workout_reply`, `nudge`, or null.
* Pruned to 14 days. Exposed as a `chat_log` view (Phase 15 registry) so conversations can be exported and debugged.
* `interaction_logs` stays (v1 history); `chat_log` is the new source for context.

### 4.2 One sender
`this.telegram()` returns a client wrapped with `onSent(chatId, text, messageId, tag)`; all 5 construction sites use it. Senders pass `{ tag }` where it matters; untagged messages are still logged.

### 4.3 The conversation block (prompt context)
`buildConversation(db, replyTo, nowMs)` returns text for the classifier and every lane:
```
Replying to: [bot, 09:12, evening_recap] "Tomorrow: Gym Legs, DSA ×2, Reading … Reply ok to lock."
Recent:
  [bot 21:02 evening_recap] …
  [you 21:04] ok
Open question: choose_item — "Which one on Tue 3 Nov?" 1. Reading: DDIA  2. Reading: Sapiens
```
* **Replying to**: present only for swipe-replies; takes priority.
* **Recent**: the last 4 messages within 2 hours (both directions), each truncated to ~200 characters.
* **Open question**: from `convo` state if one is open.
* Cards get one rule: *"A short reply ('ok', 'yes', 'both', 'the second') answers the replied-to message, otherwise the most recent bot message. Use it; do not treat it as unclear."*

### 4.4 Intents added
* **`answer`** — the message answers something the bot said. Fields: `kind` (`affirm` | `deny` | `choose` | `name`), `ids[]` for choose, `name` for name. Code resolves the target from the tag of the replied-to (or last) bot message and runs the matching handler: lock the plan, mark a reminder done, resolve the pending question, confirm an exercise. A tag with no handler → the model's answer is ignored and the message is treated as chat.
* **`status`** — `kind: bed` (later `wake`, sleep notes). Replaces `BED_RE`.
* **`place`** — office/remote for dates (the model gets the calendar, as the plan lane does) → existing `set_place` op.

### 4.5 Guards (replace the old narrow matches)
* Mutating `answer`s need confidence ≥ 0.8; below that, the agent asks ("Lock tomorrow's plan?").
* Every change still replies with what changed; `/undo` reverses.
* If **all** model backends fail, the reply says so and lists the commands that still work (`/lock`, `/protein`, `/lift`, …). Offline, "ok" no longer locks; this is the one capability traded away.

## 5. Sub-steps (in order)

Each step is test-first, ends with `typecheck`, `typecheck:tests`, `npm test` green, and is committed separately.

**Part A — cleanup (no new context needed)**
- [ ] **16b.1 Baseline.** Add `live-check` cases for every phrase the regexes catch today (protein, jot/progress, typed sets, 4 edits, "ok", "gn", "office tue thu"). They run through `understand()` directly, so they show what the model does *without* the shortcuts. Record pass/fail and latency per phrase in this doc. **Gate:** a shortcut is only deleted once its phrases pass.
- [ ] **16b.2 Delete duplicates (#5–#8).** Remove the fast paths for protein, jot/progress, typed sets and exercise edits from `handleNaturalLanguage`, and the parse functions with their tests. Tests that checked *parsing* become `understand` tests with a fake model that check *mapping* (the existing `reconcile` / op tests are unaffected). `/protein`, `/lift`, `/jots` commands stay. Resolve the jot "which book" rule inside the `jot` lane (snapshot lists the current book; one book → no question).
- [ ] **16b.3 Prompt rules for short and ambiguous messages.** Examples in the classify card for: workout focus with no sets, "done", "ok". Re-run the baseline.

**Part B — conversation context**
- [ ] **16b.4 `chat_log`.** Table, `logIn`/`logOut`/`recent`, 14-day prune, `chat_log` view. Wrapped `TelegramClient`; all 5 sites switched; `reply_to_message` read in the webhook handler and stored.
- [ ] **16b.5 Tags.** Evening recap, morning plan, nudges, reminders and questions send with their tag.
- [ ] **16b.6 `buildConversation`.** Used in `classify` and in each lane's user prompt; `understand(deps, text, { replyTo })`. `live-check` gains a way to supply a conversation, and cases for "ok" after a recap, "both" after a question, "done" after a reminder.

**Part C — intents that need the context**
- [ ] **16b.7 `answer` intent.** Replaces `answerChoice` / `answerConfirm` word lists and the "ok" regex; `convo.ts` keeps only the *state* (pending question, last action).
- [ ] **16b.8 `status` and `place` intents.** Remove `BED_RE` and `OFFICE_RE`. The first-message-of-the-morning wake check (`noteWake`) currently runs before understanding; it moves to run *after*, so a late "gn" is a bedtime and not a wake.
- [ ] **16b.9 Guards and offline fallback** (section 4.5); latency logged per message in `chat_log.parsed_json`.

**Part D — measured experiment**
- [ ] **16b.10 One call instead of two.** Behind a config flag, a single call with the snapshot, conversation and a union schema, versus today's classify-then-extract. Compare accuracy (`live-check`) and latency on the same phrases; keep it only if it is not worse.
- [ ] **16b.11 Docs.** `/help` text, this doc's results table, plan, backlog (N4/N6 notes).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Short messages ("ok", "gn") are where a model is least certain | Examples in the card; tag-based targets; confidence ≥ 0.8 to mutate; baseline gate before deleting any shortcut |
| More model calls on a free tier (rate limits) | Fallback backend already exists; measure in 16b.1 and 16b.10; the experiment may remove a call |
| Latency | Logged per message; the single-call experiment targets it |
| Prompt grows | Truncate each message to ~200 chars, 4 messages, 2 hours |
| A swipe-reply to an old message is misread as a reply to the latest | Replied-to message has priority and carries its own tag |
| Offline "ok" no longer locks | Replies name the slash commands that still work |

## 7. Validation

```
npm run typecheck && npm run typecheck:tests && npm test
npm run live-check            # all groups, including the new context cases
```

After deploy: reply "ok" (swipe and plain) to the evening recap; "both" to a question; "done" to a reminder; "gn" at night; "protein 110"; `bench 20x15, 22.5x12`; "face full should be face pull"; "Today's workout / Legs, Shoulders". Then `npm run export -- --view chat_log` to read the conversation the model actually saw.

## 8. Baseline results (16b.1, Gemini flash-lite, model alone)

| Phrase | Result without the shortcut | Latency |
|---|---|---|
| `protein 110`, `had about 95g protein today` | **Failed at first**: replied "Logged." and changed nothing (a false claim). Fixed by a new `metric` intent (log_metric); now passes | 8–13 s |
| `ch3: leader replication lag …` | pass: add_jot on the one current book, locator ch3 | 13 s |
| `finished ch3`, `on p140` | pass: set_progress | 15–19 s |
| `bench 20x15, 22.5x12` | pass | 8 s |
| `lat pulldown 25x15, row 30x12 and 30x10` | pass | 22 s |
| `face fll should be face pull`, set amend, remove, "last set" | pass 4/4 (one run hit a transient "AI unavailable" rate-limit and passed on retry) | 8–19 s |

Latencies include the live-check's 6.5 s gap between calls, so real latency is lower; measured properly in 16b.9.
Not yet baselined (no intent exists, so they cannot pass until Part C): `ok`/`lock it`, `gn`, `office tue thu`, answers to a question.

## 9. What was built (differs from the plan above where noted)

* **Intents added:** `metric` (protein; `log_metric`), `answer`, `status` (bed | wake), `office` (weekday names → `officeWindow`). `office` replaces the planned `place` because the existing flow sets a whole week's pattern, not single dates.
* **`chat_log`** (migration 9): both directions, Telegram ids, tag, replied-to id, and the model's decision + latency in `parsed_json` (`outcome`, `ms`). Pruned at 14 days; cleared by `/reset logs`; exported as the `chat_log` view.
* **Tags in use:** `evening_recap`, `morning_plan`, `pause_question`, `question`, `nudge:<id>`, `reminder:<id>`. `applyAnswer` acts on `question` (open pending), `evening_recap` (lock), `reminder:<id>` (done); a reply to anything else gets a friendly acknowledgement and changes nothing.
* **Priority for an answer:** the swipe-replied message → the open question → the latest bot message within 6 hours.
* **Wake:** only `/up` is handled before the model. Any other first message wakes you *after* understanding, unless the model said it was a bedtime. URLs also count as a first message.
* **Guards:** answers that change something need classifier confidence ≥ 0.8; below that the agent asks. If every backend fails, the reply says so and lists the commands that still work (`down` flag on the inbox outcome).
* **Kept (not message parsing):** slash-command arguments (`parseWeekdays` for `/office`), reminder time arithmetic, catalog name resolution.

### Measured (Gemini flash-lite only, throttle off)

* A message takes **8–13 s** end to end (classify call + extract call). Two sequential calls is the cost of the model-first design.
* One in roughly eight calls fails transiently ("AI unavailable") on the single lite model; the results differ run to run. Production tries three Gemini models and then Workers AI, so this is absorbed there, at the price of more latency when it happens.

### 16b.10 (one call instead of two): not done

It needs real numbers from `chat_log.parsed_json.ms` after a few days of use, and it trades accuracy for speed. Decide with that data. The cheapest first candidate is fusing classify and extract for the tiny intents (`answer`, `status`, `office`, `metric`).

## 10. Progress notes

* **16b.2 done.** Removed from `src/`: `parseProtein`, `parseChatWorkout`, `parseExerciseEdit`, `amendValue`, `parseJotText`. `parseChatWorkout` lives on in `tests/helpers.ts` as a fixture (notation → op) for the fitness tests. Tests of the removed parsers were deleted; the mapping is covered by `understand` tests. `/protein` and `/lift` commands are unchanged.
* The "last action" in `convo` (used only by the removed "no, face pull" pattern) is still recorded; the conversation block in 16b.6 supersedes it.
