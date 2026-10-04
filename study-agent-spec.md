# Cloudflare AI Personal Assistant — System Requirements & Architecture Spec

> **Project Name:** `study-agent` (Cloudflare AI Assistant)  
> **Target Platform:** Cloudflare Workers, Agents SDK, Workers AI, Workflows, Durable Objects  
> **Interface:** Telegram Bot (Text + Voice Audio) + Webhook  
> **Data Sink / Memory:** Cloudflare Durable Object (SQLite) + GitHub REST API (syncing to `study-repo`)  
> **Cost Model:** 100% Free Tier ($0/month)  
> **Dual Purpose:** Personal Daily Operational Engine & Cloudflare SWE Fast-Track Portfolio Artifact

---

## 1. Executive Summary & Goals

The `study-agent` is an autonomous, serverless AI companion designed to eliminate friction in personal tracking, content ingestion, workout logging, and daily planning. It acts as the intelligent orchestration layer between the user (via Telegram) and their private knowledge repository (`study-repo`).

### The Two Core Objectives:
1. **Zero-Friction Daily Operations:** Completely replace dead manual logs (`inbox.md`, manual markdown editing) with voice/chat capture, pre-filled ambient check-ins, dynamic rescheduling, and automated Git commits.
2. **Cloudflare SWE Challenge Submission:** Demonstrate production-grade mastery of Cloudflare's serverless AI stack:
   - **LLM:** Llama 3.3 / 3.1 on Cloudflare Workers AI.
   - **Workflow / Coordination:** Cloudflare Workflows & Cloudflare Agents SDK.
   - **User Input:** Telegram Chat + Voice Memos (via `@cf/openai/whisper` on Workers AI).
   - **Memory & State:** Durable Objects with embedded SQLite storage + GitHub REST API integration.

---

## 2. Cloudflare Component Mapping

```
                                  TELEGRAM MESSAGING LAYER
                  ┌───────────────────────────────────────────────────────┐
                  │ • Text Messages (Chat, Commands, Rescheduling)        │
                  │ • Voice Memos (Audio OGG/Opus)                        │
                  │ • URL Shares (YouTube, Twitter/X, Blog Articles)      │
                  └──────────────────────────┬────────────────────────────┘
                                             │ HTTPS Webhook (Instant <500ms)
                                             ▼
                                CLOUDFLARE WORKERS GATEWAY
                  ┌───────────────────────────────────────────────────────┐
                  │ • Request Validation & Telegram Secret Auth           │
                  │ • Route to Agent Durable Object                       │
                  └──────────────────────────┬────────────────────────────┘
                                             │
                                             ▼
                        CLOUDFLARE AGENTS SDK (DURABLE OBJECT)
                  ┌───────────────────────────────────────────────────────┐
                  │ • Singleton state per user (Durable Object)           │
                  │ • Embedded SQLite Database (State, History, Queues)   │
                  │ • Scheduled Alarms (08:15 IST, 17:00 IST, 21:30 IST)  │
                  └─────────┬─────────────────┬───────────────────┬───────┘
                            │                 │                   │
             ┌──────────────┘                 │                   └──────────────┐
             ▼                                ▼                                  ▼
    WORKERS AI INFERENCE             CLOUDFLARE WORKFLOWS               GITHUB REST API
┌─────────────────────────┐     ┌────────────────────────────┐    ┌───────────────────────────┐
│ • Whisper (Voice -> Text│     │ • Multi-step URL Ingestion │    │ • Direct commit to        │
│ • Llama 3.3 (Structured │     │ • Article Scrape & Summary │    │   study-repo:             │
│   Extraction & Prompts) │     │ • Resilient Error Retries  │    │   - reading-queue.md      │
│ • Embeddings (Optional) │     │ • Long-running Async Jobs  │    │   - daily/ & tracker/     │
└─────────────────────────┘     └────────────────────────────┘    └───────────────────────────┘
```

---

## 3. Functional Specifications & Core Workflows

### Workflow 1: Voice & Free-Text Workout Logging
* **Trigger:** User sends a Telegram voice memo or unstructured text (e.g., *"Chest & tris: bench 80kg 3x8, db incline 28kg 3x10, felt shoulder pain on last set"*).
* **Processing:**
  1. If voice: Download audio file via Telegram Bot API $\rightarrow$ invoke Workers AI `@cf/openai/whisper` $\rightarrow$ produce text transcript.
  2. Invoke Workers AI `@cf/meta/llama-3.3-70b-instruct` with JSON schema enforcement:
     ```json
     {
       "type": "workout_log",
       "workout_type": "Upper Push",
       "exercises": [
         {"name": "Bench Press", "sets": 3, "reps": 8, "weight_kg": 80},
         {"name": "Incline DB Press", "sets": 3, "reps": 10, "weight_kg": 28}
       ],
       "notes": "Felt shoulder pain on last set"
     }
     ```
  3. Store record in Durable Object SQLite table `workout_logs`.
  4. Format clean markdown $\rightarrow$ commit to `study-repo/life/fitness.md` via GitHub API.
  5. Reply to Telegram instantly: *"✅ Logged Upper Push (Bench 80kg, DB Press 28kg)"*.

---

### Workflow 2: Media & Reading Queue Ingestion ("Drop & Forget")
* **Trigger:** User shares a URL (YouTube, Substack, ArXiv, Tech Blog, Wikipedia) to the bot.
* **Processing:**
  1. Worker acknowledges Telegram within 200ms and triggers a **Cloudflare Workflow** `MediaIngestionWorkflow`.
  2. Workflow Step 1: Fetch metadata / HTML text from URL.
  3. Workflow Step 2: Pass content to Workers AI Llama 3.3 to classify tag (`📖 eng`, `🎬 watch`, `🏗️ design`, `🧠 cs`, `🤖 ml`, `📜 fiction`) and estimate read/watch duration.
  4. Workflow Step 3: Fetch current `study/reading/reading-queue.md` from GitHub $\rightarrow$ append new item $\rightarrow$ commit update via GitHub API.
  5. Workflow Step 4: Send Telegram confirmation: *"Added to queue: `📖 eng | High Scalability - Discord Architecture (12 min)`"*.

---

### Workflow 3: Context-Aware Ambient Check-Ins & Evening Synthesis
* **Schedule:**
  * **08:15 IST (Post-Gym Morning Cue):** Proposes the single focus topic based on day type (Fragment vs Block day) + serves 1 serendipitous 10-minute read from the reading queue.
  * **17:00 IST (Commute / Transition Cue):** Serves one quick engageable item from `reading-queue.md`.
  * **21:30 IST (Pre-filled Evening Check-in):** 
    1. Agent queries GitHub API for today's commit activity & touched files.
    2. Combines with workouts and links logged during the day.
    3. Sends Telegram prompt:
       > *"Evening check-in! Today I see:*  
       > *• 💻 1 commit (`resumes/amazon-ads.tex`)*  
       > *• 🏋️ Upper Push workout (80kg bench)*  
       > *• 📖 1 reading item completed*  
       > *Anything else to add before closing the day?"*
    4. If user ignores $\rightarrow$ auto-commits the day note.
    5. If user replies $\rightarrow$ appends bullet and commits.

---

### Workflow 4: Conversational Dynamic Rescheduling & Adaptive Snooze
* **Trigger:** User chats natural language updates (e.g., *"Working late tonight, skip study block"*, *"Snooze reminders until Monday"*, *"Traveling"*).
* **Processing:**
  1. Llama 3.3 identifies intent: `INTENT_RESCHEDULE` or `INTENT_SNOOZE`.
  2. Agent updates Durable Object SQLite state:
     - `snooze_until: TIMESTAMP`
     - `day_override: "LATE_WORK"`
  3. Adjusts subsequent alarms and pre-fills the evening log with `"Late work day / rest day"` rather than generating missed backlog debt.

---

## 4. Data Storage & Schema Design

### Durable Object Embedded SQLite Tables

```sql
-- 1. Bot State & Configuration
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Daily Interaction Logs
CREATE TABLE IF NOT EXISTS interaction_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT CHECK(source IN ('telegram_text', 'telegram_voice', 'system_cron', 'workflow')),
  raw_content TEXT,
  parsed_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Ingested Media / Reading Queue Cache
CREATE TABLE IF NOT EXISTS reading_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE,
  title TEXT,
  category TEXT,
  estimated_minutes INTEGER,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'served', 'completed', 'dropped')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Workout Logs
CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  workout_type TEXT,
  exercises_json TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Security & Free Tier Economics

1. **Telegram Webhook Security:** `X-Telegram-Bot-Api-Secret-Token` header validated on all incoming requests.
2. **GitHub API Auth:** Fine-grained GitHub Personal Access Token (PAT) with `contents:write` scoped only to `study-repo`.
3. **Usage Economics:**
   - **Workers Requests:** ~60/day (Limit: 100,000/day $\rightarrow$ **0.06% utilized**).
   - **Workers AI Neurons:** ~1,200/day (Limit: 10,000/day $\rightarrow$ **12% utilized**).
   - **Durable Objects / Workflows:** Well within free tier allowances.
   - **Total Operational Cost:** **$0.00 / month**.
