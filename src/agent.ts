import { Agent } from "agents";
import { TelegramClient } from "./telegram/bot";
import {
  SCHEMA_SQL,
  BotStateRow,
  InteractionLogRow,
  ReadingQueueRow,
  ReminderRow,
  WorkoutLogRow,
} from "./db/schema";

export class StudyAgent extends Agent<Env> {
  // Initialized once when the Durable Object wakes up
  override async onStart(): Promise<void> {
    this.initDatabase();
    console.log("StudyAgent initialized with SQLite schema");
  }

  /**
   * Run idempotent SQLite migrations/DDL.
   */
  private initDatabase(): void {
    // Durable Object embedded SQLite execution
    this.ctx.storage.sql.exec(SCHEMA_SQL);
  }

  // --- State Key-Value Helpers ---

  getBotConfig(key: string): string | null {
    const rows = this.sql<BotStateRow>`SELECT key, value, updated_at FROM bot_state WHERE key = ${key} LIMIT 1`;
    return rows.length > 0 ? rows[0].value : null;
  }

  setBotConfig(key: string, value: string): void {
    this.sql`INSERT INTO bot_state (key, value, updated_at) VALUES (${key}, ${value}, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value = ${value}, updated_at = CURRENT_TIMESTAMP`;
  }

  // --- Interaction Log Helpers ---

  logInteraction(
    source: InteractionLogRow["source"],
    rawContent: string | null,
    parsedJson: any = null
  ): void {
    const parsedStr = parsedJson ? JSON.stringify(parsedJson) : null;
    this.sql`INSERT INTO interaction_logs (source, raw_content, parsed_json) VALUES (${source}, ${rawContent}, ${parsedStr})`;
  }

  getRecentLogs(limit = 5): InteractionLogRow[] {
    return this.sql<InteractionLogRow>`SELECT id, source, raw_content, parsed_json, created_at FROM interaction_logs ORDER BY id DESC LIMIT ${limit}`;
  }

  // --- Reading Queue Helpers ---

  addToReadingQueue(url: string, title: string | null = null, category: string = "general"): boolean {
    try {
      this.sql`INSERT INTO reading_queue (url, title, category, status) VALUES (${url}, ${title}, ${category}, 'queued')
               ON CONFLICT(url) DO NOTHING`;
      return true;
    } catch (err) {
      console.error("Error adding to reading queue:", err);
      return false;
    }
  }

  getReadingQueue(status: ReadingQueueRow["status"] = "queued", limit = 10): ReadingQueueRow[] {
    return this.sql<ReadingQueueRow>`SELECT id, url, title, category, estimated_minutes, status, created_at 
           FROM reading_queue WHERE status = ${status} ORDER BY id ASC LIMIT ${limit}`;
  }

  // --- Snooze / Dynamic Rescheduling Helpers ---

  setSnooze(durationHours: number, reason = "User requested snooze"): number {
    const untilMs = Date.now() + durationHours * 3600 * 1000;
    this.setBotConfig("snooze_until", untilMs.toString());
    this.setBotConfig("snooze_reason", reason);
    return untilMs;
  }

  clearSnooze(): void {
    this.sql`DELETE FROM bot_state WHERE key IN ('snooze_until', 'snooze_reason')`;
  }

  getSnoozeStatus(): { snoozed: boolean; until?: string; reason?: string } {
    const untilStr = this.getBotConfig("snooze_until");
    if (!untilStr) return { snoozed: false };

    const untilMs = parseInt(untilStr, 10);
    if (Date.now() > untilMs) {
      this.clearSnooze();
      return { snoozed: false };
    }

    return {
      snoozed: true,
      until: new Date(untilMs).toISOString(),
      reason: this.getBotConfig("snooze_reason") ?? "Unknown",
    };
  }

  // --- Statistics Helper ---

  getStats() {
    const totalLogs = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM interaction_logs`[0]?.count ?? 0;
    const queuedReading = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM reading_queue WHERE status = 'queued'`[0]?.count ?? 0;
    const totalWorkouts = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM workout_logs`[0]?.count ?? 0;
    const snooze = this.getSnoozeStatus();

    return {
      totalLogs,
      queuedReading,
      totalWorkouts,
      snooze,
    };
  }

  // --- Telegram Update Handler ---

  async handleTelegramUpdate(update: any): Promise<void> {
    console.log("StudyAgent received Telegram update:", JSON.stringify(update));

    const message = update.message;
    if (!message) {
      console.log("Update does not contain a message, ignoring.");
      return;
    }

    const chatId = message.chat?.id?.toString();
    if (!chatId) return;

    // Security: Only respond to our authorized user
    if (this.env.USER_TELEGRAM_CHAT_ID && chatId !== this.env.USER_TELEGRAM_CHAT_ID) {
      console.warn(`Unauthorized access attempt from chat ID: ${chatId}`);
      return;
    }

    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);

    try {
      if (message.voice) {
        // Voice memo
        const fileId = message.voice.file_id;
        this.logInteraction("telegram_voice", `voice_file_id:${fileId}`);
        await telegram.sendMessage(
          chatId,
          "🎤 <b>Voice memo saved to SQLite log!</b>\n<i>(Audio transcription & AI parsing coming in Phase 4)</i>"
        );
      } else if (message.text) {
        const text = (message.text as string).trim();

        if (text.startsWith("/")) {
          // Handle commands
          await this.handleCommand(telegram, chatId, text);
        } else if (text.startsWith("http://") || text.startsWith("https://")) {
          // Handle URL
          this.addToReadingQueue(text);
          this.logInteraction("telegram_text", text, { type: "url", url: text });
          const count = this.getStats().queuedReading;
          await telegram.sendMessage(
            chatId,
            `🔗 <b>URL added to Reading Queue!</b>\n<code>${text}</code>\nTotal queued articles: <b>${count}</b>`
          );
        } else {
          // General text note
          this.logInteraction("telegram_text", text);
          const stats = this.getStats();
          await telegram.sendMessage(
            chatId,
            `📝 <b>Logged in SQLite!</b> (Total interactions: <b>${stats.totalLogs}</b>)\n<i>(LLM structured extraction coming in Phase 4)</i>`
          );
        }
      }
    } catch (err) {
      console.error("Error handling telegram update:", err);
      await telegram.sendMessage(chatId, "⚠️ Error processing your request.");
    }
  }

  // --- Command Processor ---

  private async handleCommand(telegram: TelegramClient, chatId: string, commandText: string): Promise<void> {
    const parts = commandText.split(" ");
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    this.logInteraction("telegram_text", commandText, { type: "command", command, args });

    switch (command) {
      case "/start":
      case "/help": {
        const helpMessage = [
          "🤖 <b>Study Agent Commands</b>",
          "",
          "• <code>/status</code> - View SQLite database stats & snooze status",
          "• <code>/queue</code> - List pending reading queue items",
          "• <code>/snooze &lt;hours&gt;</code> - Pause ambient reminders for X hours",
          "• <code>/unsnooze</code> - Resume ambient reminders immediately",
          "• <code>/recent</code> - Show last 3 logged interactions",
          "",
          "💡 <i>Tip: Send any URL to queue it, or send text/voice to log thoughts & workouts!</i>",
        ].join("\n");
        await telegram.sendMessage(chatId, helpMessage);
        break;
      }

      case "/status": {
        const stats = this.getStats();
        const snoozeInfo = stats.snooze.snoozed
          ? `⏸️ <b>Active until:</b> ${stats.snooze.until}\n<i>Reason:</i> ${stats.snooze.reason}`
          : "▶️ <b>Active</b> (no snooze)";

        const statusMessage = [
          "📊 <b>Study Agent State (Durable Object SQLite)</b>",
          "",
          `• <b>Total Interactions:</b> ${stats.totalLogs}`,
          `• <b>Reading Queue:</b> ${stats.queuedReading} pending`,
          `• <b>Workout Logs:</b> ${stats.totalWorkouts}`,
          `• <b>Snooze Status:</b>\n  ${snoozeInfo}`,
        ].join("\n");
        await telegram.sendMessage(chatId, statusMessage);
        break;
      }

      case "/queue": {
        const items = this.getReadingQueue("queued", 5);
        if (items.length === 0) {
          await telegram.sendMessage(chatId, "📭 Reading queue is currently empty.");
          return;
        }

        const lines = items.map((item, idx) => `${idx + 1}. 🔗 <a href="${item.url}">${item.title ?? item.url}</a>`);
        await telegram.sendMessage(chatId, `📚 <b>Pending Reading Queue:</b>\n\n${lines.join("\n")}`);
        break;
      }

      case "/snooze": {
        const hours = parseFloat(args[0] ?? "2");
        if (isNaN(hours) || hours <= 0) {
          await telegram.sendMessage(chatId, "⚠️ Please specify hours, e.g. <code>/snooze 4</code>");
          return;
        }

        const reason = args.slice(1).join(" ") || "User requested snooze";
        const untilMs = this.setSnooze(hours, reason);
        const untilDate = new Date(untilMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
        await telegram.sendMessage(chatId, `😴 <b>Snoozed!</b> Ambient cues paused until <b>${untilDate} IST</b> (${hours}h).`);
        break;
      }

      case "/unsnooze": {
        this.clearSnooze();
        await telegram.sendMessage(chatId, "🔔 <b>Snooze cleared!</b> Ambient cues resumed.");
        break;
      }

      case "/recent": {
        const logs = this.getRecentLogs(3);
        if (logs.length === 0) {
          await telegram.sendMessage(chatId, "No interactions recorded yet.");
          return;
        }

        const logLines = logs.map((l) => `• [${l.source}] ${l.raw_content ?? "<i>no content</i>"} (<code>${l.created_at}</code>)`);
        await telegram.sendMessage(chatId, `🕒 <b>Recent Logs:</b>\n\n${logLines.join("\n")}`);
        break;
      }

      default: {
        await telegram.sendMessage(chatId, `❓ Unknown command <code>${command}</code>. Type <code>/help</code> for available commands.`);
        break;
      }
    }
  }
}
