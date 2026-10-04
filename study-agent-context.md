# Cloudflare AI Personal Assistant — System Context & Project Blueprint

> This document contains the full strategic context, historical lessons, architectural decisions, and operational blueprint for the standalone `study-agent` repository.

---

## 1. Background & Why Past Systems Failed

Over 6 months of daily tracking experiments in `study-repo` revealed critical human-behavior insights:

### The "Record Beside the Work" Anti-Pattern
* **`tracker/inbox.md` & `daily/` notes:** Died because they required 7 manual taps (open app $\rightarrow$ navigate $\rightarrow$ format markdown $\rightarrow$ commit $\rightarrow$ push).
* **`tracker/progress.json`:** Froze at `plan_week: 1` for 4 months because manual advancement was required.
* **`scripts/daily_reminder.py`:** Hardcoded static phases (`PHASE_A_END`, `PHASE_B_END`) and 5-application daily quotas that broke when real-life schedules shifted.

### The Winning Principle: "The Artifact IS the Record"
* In contrast, the resume pipeline (`resumes/` + `r.ps1`) succeeded because creating the resume `.tex` file was both the actual work and the record simultaneously.
* **Core Rule for the Agent:** The user must never be forced to format a markdown file or log manually. The assistant must accept raw, unstructured voice notes, mobile link shares, and short chat messages, synthesizing them automatically into Git commits.

---

## 2. The Cloudflare SWE Assignment Alignment

Cloudflare's SWE opening invites candidates to build an AI-powered application on Cloudflare featuring:
1. **LLM:** Llama 3.3 on Workers AI.
2. **Workflow / Coordination:** Cloudflare Workflows or Durable Objects.
3. **User Input:** Chat or voice (via Telegram webhook + Whisper on Workers AI).
4. **Memory / State:** Durable Objects with embedded SQLite storage.

This project is architected so that **the exact assistant running daily life operations is simultaneously the production submission for Cloudflare**.

---

## 3. Detailed Operational Schedule & Workflows

### A. Morning Cue (08:15 IST / 02:45 UTC)
* **Goal:** Zero decision fatigue. Know the one priority before opening a laptop.
* **Routing Rule:**
  * **Fragment Days (Mon–Wed):** Fast 30–60m items (DSA / quick review). Proactive suggestion.
  * **Block Days (Thu–Sun):** 3h+ deep blocks (Frontier lab, projects, writing). Prompts user for focus.
* **Serendipity Delivery:** Serves 1 engaging 10-minute item from `study/reading/reading-queue.md` with direct link.

### B. Commute / Transition Ping (17:00 IST / 11:30 UTC)
* Serves a single, non-CS / engaging read or watch item to recharge without cognitive fatigue.

### C. Evening Ambient Check-in (21:30 IST / 16:00 UTC)
* **Context Gathering:** Agent fetches today's commits from GitHub API + today's workout logs and links saved via Telegram.
* **Pre-filled Prompt:** Sends an ambient summary:
  > *"Evening! Caught 1 commit in `resumes/`, 1 workout logged. Anything else to add before closing the day?"*
* **Auto-Commit:** If ignored $\rightarrow$ finalizes the day note. If user sends a short voice or text note $\rightarrow$ appends bullet and pushes commit.

---

## 4. Ingestion & Content Strategy

### Reading & Media Queue ([study/reading/reading-queue.md](file:///c:/study/study-repo/study/reading/reading-queue.md))
* Mobile Share $\rightarrow$ Telegram Bot $\rightarrow$ Cloudflare Workflow.
* Scrapes metadata $\rightarrow$ classifies category (`📖 eng`, `🎬 watch`, `🏗️ design`, `🧠 cs`, `🤖 ml`, `📜 fiction`, `🎵 music`, `🏃 health`, `🌍 random`).
* Appends formatted line to `study/reading/reading-queue.md` and commits.

### Fitness / Workout Logging
* Voice memo from gym $\rightarrow$ Transcribed via Whisper $\rightarrow$ Structured by Llama 3.3 $\rightarrow$ Committed to `life/fitness.md` and persisted in SQLite.

### Dynamic Rescheduling & Snooze
* Natural language commands (*"Working late"*, *"Sick today"*, *"Snooze till Monday"*) update SQLite state and silence scheduled alerts without accumulating guilt backlogs.

---

## 5. Standalone Repo Structure (`study-agent`)

```
study-agent/
├── .github/
│   └── workflows/
│       └── deploy.yml              # Cloudflare Worker CI/CD deployment
├── src/
│   ├── index.ts                    # Worker entrypoint & Telegram Webhook router
│   ├── agent.ts                    # Durable Object Agent (State, SQLite, Alarms)
│   ├── workflows/
│   │   └── media-ingestion.ts      # Multi-step URL scraping & summarization workflow
│   ├── ai/
│   │   ├── llama.ts                # Workers AI Llama 3.3 inference & structured parsing
│   │   └── whisper.ts              # Workers AI Whisper audio transcription
│   ├── github/
│   │   └── client.ts               # GitHub REST API client (commits, reading/writing files)
│   └── telegram/
│       ├── bot.ts                  # Telegram API client (sendMessage, getFile, buttons)
│       └── handlers.ts             # Intent routing (voice, text, URL, commands)
├── wrangler.jsonc                  # Cloudflare configuration (Workers AI, DO, Workflows)
├── package.json
├── tsconfig.json
└── README.md                       # Comprehensive Cloudflare assignment submission write-up
```

---

## 6. Required Secrets & Configuration

| Variable | Source | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `@BotFather` | Authenticating Telegram Bot API |
| `TELEGRAM_SECRET_TOKEN` | Custom string | Validating incoming Telegram webhooks |
| `GITHUB_PAT` | GitHub Settings | Fine-grained token to read/commit to `study-repo` |
| `GITHUB_REPO` | Config (`sangam-kumar/study-repo`) | Target repository for markdown sync |
| `USER_TELEGRAM_CHAT_ID`| Telegram ID | Restricting bot access to the authorized user only |
