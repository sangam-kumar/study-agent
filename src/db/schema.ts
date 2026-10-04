export interface BotStateRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface InteractionLogRow {
  id: number;
  source: "telegram_text" | "telegram_voice" | "system_cron" | "workflow";
  raw_content: string | null;
  parsed_json: string | null;
  created_at: string;
}

export interface ReadingQueueRow {
  id: number;
  url: string;
  title: string | null;
  category: string | null;
  estimated_minutes: number;
  status: "queued" | "served" | "completed" | "dropped";
  created_at: string;
}

export interface WorkoutLogRow {
  id: number;
  date: string;
  workout_type: string;
  exercises_json: string;
  notes: string | null;
  created_at: string;
}

export interface ReminderRow {
  id: number;
  reminder_type: string;
  trigger_at: number;
  payload_json: string | null;
  status: "pending" | "dispatched" | "cancelled";
  created_at: string;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interaction_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  raw_content TEXT,
  parsed_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reading_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  category TEXT,
  estimated_minutes INTEGER DEFAULT 5,
  status TEXT DEFAULT 'queued',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workout_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  workout_type TEXT NOT NULL,
  exercises_json TEXT NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_type TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  payload_json TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;
