# Phase 3: Durable Object Agent & SQLite State Layer — Implementation Guide

> **Phase Goal:** Equip the `StudyAgent` Durable Object with a persistent, embedded SQLite database. Establish schemas for state configuration, interaction logs, reading queue, workout logs, and reminders. Implement typed state accessors and Telegram commands (`/status`, `/queue`, `/snooze`) to query and manipulate state.

---

## 1. Overview & Architecture

Each user is backed by a singleton `StudyAgent` Durable Object with dedicated, co-located zero-latency SQLite storage.

```
                    ┌────────────────────────────────────────────────────────┐
                    │               StudyAgent (Durable Object)               │
                    │                                                        │
                    │   ┌────────────────────────────────────────────────┐   │
                    │   │       SQLite Embedded Storage (this.sql)       │   │
                    │   │                                                │   │
                    │   │  • bot_state         (KV config, snoozes)      │   │
                    │   │  • interaction_logs  (raw & parsed history)    │   │
                    │   │  • reading_queue     (ingested URLs & tags)    │   │
                    │   │  • workout_logs      (structured fitness data) │   │
                    │   │  • reminders         (alarm queue)             │   │
                    │   └────────────────────────────────────────────────┘   │
                    │                          │                             │
                    │      ┌───────────────────┴───────────────────┐         │
                    │      ▼                                       ▼         │
                    │  Telegram Gateway                     DO Alarms        │
                    │  (/status, /queue, /snooze)     (08:15, 17:00, 21:30)  │
                    └────────────────────────────────────────────────────────┘
```

---

## 2. SQLite Database Schema

### 1. `bot_state`
Key-value store for singleton configuration, dynamic scheduling flags, and snooze states.
```sql
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2. `interaction_logs`
Audit log of all inbound and outbound interactions for daily synthesis and evening check-ins.
```sql
CREATE TABLE IF NOT EXISTS interaction_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  raw_content TEXT,
  parsed_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 3. `reading_queue`
Articles and media links ingested for serendipitous cues.
```sql
CREATE TABLE IF NOT EXISTS reading_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  category TEXT,
  estimated_minutes INTEGER DEFAULT 5,
  status TEXT DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4. `workout_logs`
Structured exercise tracking entries.
```sql
CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  exercises_json TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5. `reminders`
Scheduled cues and custom reminder items for the alarm dispatcher.
```sql
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_type TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  payload_json TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 3. Sub-Steps Breakdown

| Step | Action | Target Files | Validation Criteria |
|---|---|---|---|
| **3.1** | Define SQLite DDL schema and TypeScript repository interfaces | `src/db/schema.ts` | Complete typed interfaces for all 5 tables |
| **3.2** | Implement database migration & initialization in `StudyAgent.onStart()` | `src/agent.ts` | Schema tables created idempotently on boot |
| **3.3** | Implement typed database methods (CRUD for state, logs, queue, snooze) | `src/agent.ts` | Queries compile cleanly using `this.sql` / `this.ctx.storage.sql` |
| **3.4** | Wire inbound Telegram updates to `interaction_logs` | `src/agent.ts` | Every update saved to SQLite immediately |
| **3.5** | Implement Telegram commands (`/status`, `/queue`, `/snooze`) | `src/agent.ts` | Commands return live data from SQLite |
| **3.6** | Validate via `npm run typecheck` and test live via Telegram | Cloudflare Edge | Commands reply with SQLite state |

---

## 4. Current Status: Ready to Execute
Proceeding with Step 3.1.
