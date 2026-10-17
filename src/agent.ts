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
import { getLLMProvider } from "./ai/provider";

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
      const llm = getLLMProvider(this.env);

      if (message.voice) {
        // Voice memo: in-memory download & zero-storage processing
        const fileId = message.voice.file_id;
        console.log(`Processing voice memo [${fileId}]...`);

        const audioBuffer = await telegram.downloadFileAsBuffer(fileId);
        const result = await llm.processAudio(audioBuffer, message.voice.mime_type || "audio/ogg");

        // 1. Log to SQLite interaction_logs
        this.logInteraction("telegram_voice", result.transcript, result);

        // 2. Dispatch based on extracted intent
        if (result.intent === "workout_log" && result.workout) {
          const today = new Date().toISOString().slice(0, 10);
          this.sql`INSERT INTO workout_logs (date, workout_type, exercises_json, notes)
                   VALUES (${today}, ${result.workout.workout_type}, ${JSON.stringify(result.workout.exercises)}, ${result.workout.notes ?? null})`;

          const exercisesList = result.workout.exercises
            .map((e) => `• <b>${e.name}</b>: ${e.sets}x${e.reps}${e.weight_kg ? ` @ ${e.weight_kg}kg` : ""}`)
            .join("\n");

          await telegram.sendMessage(
            chatId,
            `🏋️ <b>Workout Logged (${result.workout.workout_type})</b>\n\n${exercisesList}${result.workout.notes ? `\n\n<i>Note: ${result.workout.notes}</i>` : ""}\n\n<i>Transcript: "${result.transcript}"</i>`
          );
        } else if (result.intent === "study_note" && result.note) {
          const takeaways = result.note.key_takeaways.map((t) => `• ${t}`).join("\n");
          await telegram.sendMessage(
            chatId,
            `🧠 <b>Study Note Captured: ${result.note.topic}</b>\n\n${result.note.summary}\n\n<b>Key Takeaways:</b>\n${takeaways}\n\n<i>Transcript: "${result.transcript}"</i>`
          );
        } else {
          await telegram.sendMessage(
            chatId,
            `🎙️ <b>Transcribed Voice Note:</b>\n\n<i>"${result.transcript}"</i>`
          );
        }
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
          // Natural language text: analyze via LLM
          const parsed = await llm.parseText(text);
          this.logInteraction("telegram_text", text, parsed);

          if (parsed.intent === "workout_log" && parsed.workout) {
            const today = new Date().toISOString().slice(0, 10);
            this.sql`INSERT INTO workout_logs (date, workout_type, exercises_json, notes)
                     VALUES (${today}, ${parsed.workout.workout_type}, ${JSON.stringify(parsed.workout.exercises)}, ${parsed.workout.notes ?? null})`;

            const exercisesList = parsed.workout.exercises
              .map((e) => `• <b>${e.name}</b>: ${e.sets}x${e.reps}${e.weight_kg ? ` @ ${e.weight_kg}kg` : ""}`)
              .join("\n");

            await telegram.sendMessage(
              chatId,
              `🏋️ <b>Workout Logged (${parsed.workout.workout_type})</b>\n\n${exercisesList}${parsed.workout.notes ? `\n\n<i>Note: ${parsed.workout.notes}</i>` : ""}`
            );
          } else if (parsed.intent === "snooze" && parsed.snooze) {
            const hours = parsed.snooze.duration_hours ?? 2;
            const untilMs = this.setSnooze(hours, parsed.snooze.reason);
            const untilDate = new Date(untilMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
            await telegram.sendMessage(
              chatId,
              `😴 <b>Snooze Activated!</b> Ambient cues paused until <b>${untilDate} IST</b> (${hours}h).\n<i>Reason: ${parsed.snooze.reason}</i>`
            );
          } else if (parsed.intent === "study_note" && parsed.note) {
            const takeaways = parsed.note.key_takeaways.map((t) => `• ${t}`).join("\n");
            await telegram.sendMessage(
              chatId,
              `🧠 <b>Study Note Captured: ${parsed.note.topic}</b>\n\n${parsed.note.summary}\n\n<b>Key Takeaways:</b>\n${takeaways}`
            );
          } else {
            await telegram.sendMessage(
              chatId,
              parsed.replyText ?? "📝 <b>Note logged in SQLite!</b>"
            );
          }
        }
      }
    } catch (err) {
      console.error("Error handling telegram update:", err);
      await telegram.sendMessage(chatId, "⚠️ Error processing your request with AI pipeline.");
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
          "• <code>/remind &lt;minutes&gt; &lt;text&gt;</code> - Set a reminder (e.g. <code>/remind 5 Take a break</code>)",
          "• <code>/reminders</code> - List upcoming pending reminders",
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

      case "/remind": {
        const minutes = parseFloat(args[0] ?? "");
        const reminderText = args.slice(1).join(" ").trim();

        if (isNaN(minutes) || minutes <= 0 || !reminderText) {
          await telegram.sendMessage(
            chatId,
            "⚠️ <b>Usage:</b> <code>/remind &lt;minutes&gt; &lt;message&gt;</code>\n\n<i>Example:</i> <code>/remind 5 Take a quick break</code>"
          );
          return;
        }

        const delaySeconds = Math.max(1, Math.round(minutes * 60));
        const triggerAtMs = Date.now() + delaySeconds * 1000;

        // 1. Insert into SQLite table
        this.sql`INSERT INTO reminders (reminder_type, trigger_at, payload_json, status)
                 VALUES ('adhoc', ${triggerAtMs}, ${JSON.stringify({ text: reminderText })}, 'pending')`;
        const reminderId = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`[0]?.id;

        // 2. Schedule via Agents SDK
        await this.schedule(delaySeconds, "triggerReminder", JSON.stringify({ reminderId, text: reminderText }));

        // 3. Confirm to user
        const triggerTimeStr = new Date(triggerAtMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
        await telegram.sendMessage(
          chatId,
          `⏰ <b>Reminder scheduled!</b>\n\n• <b>Message:</b> "${reminderText}"\n• <b>Fires at:</b> ${triggerTimeStr} IST (${minutes} min)`
        );
        break;
      }

      case "/reminders": {
        const pending = this.sql<ReminderRow>`SELECT id, reminder_type, trigger_at, payload_json, status, created_at 
                                              FROM reminders WHERE status = 'pending' ORDER BY trigger_at ASC LIMIT 5`;
        if (pending.length === 0) {
          await telegram.sendMessage(chatId, "📭 No pending reminders.");
          return;
        }

        const lines = pending.map((r, i) => {
          const timeStr = new Date(r.trigger_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
          let note = "Reminder";
          try {
            if (r.payload_json) {
              const parsed = JSON.parse(r.payload_json);
              note = parsed.text ?? note;
            }
          } catch {}
          return `${i + 1}. [${timeStr} IST] <i>${note}</i>`;
        });
        await telegram.sendMessage(chatId, `⏰ <b>Upcoming Reminders:</b>\n\n${lines.join("\n")}`);
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

  /**
   * Invoked by Agents SDK scheduler when a reminder alarm fires.
   */
  async triggerReminder(payloadStr: string): Promise<void> {
    try {
      const payload = JSON.parse(payloadStr) as { reminderId?: number; text: string };
      const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
      const chatId = this.env.USER_TELEGRAM_CHAT_ID;

      if (payload.reminderId) {
        this.sql`UPDATE reminders SET status = 'dispatched' WHERE id = ${payload.reminderId}`;
      }

      if (chatId) {
        await telegram.sendMessage(
          chatId,
          `⏰ <b>Reminder:</b>\n\n${payload.text}`
        );
      }
    } catch (err) {
      console.error("Error triggering reminder:", err);
    }
  }
}
