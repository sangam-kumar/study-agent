import { Agent } from "agents";
import { TelegramClient } from "./telegram/bot";
import {
  BotStateRow,
  InteractionLogRow,
  ReadingQueueRow,
  ReminderRow,
  WorkoutLogRow,
} from "./db/schema";
import { getLLMProvider } from "./ai/provider";
import { doDb } from "./db/db.ts";
import { runMigrations } from "./db/migrations.ts";
import { OpError, applyOp, undoLast } from "./ops.ts";
import { parseBookCommand, renderShelf } from "./reading.ts";
import type { ApplyOptions, ApplyResult, UndoResult } from "./ops.ts";
import { SerialQueue } from "./queue.ts";
import { SeedError, loadStudySeed, queryPlan } from "./seed.ts";
import { ResetError, parseScopes, resetData as resetRows } from "./reset.ts";
import { loadConfigSeed } from "./seed-config.ts";
import { loadReadingSeed } from "./seed-reading.ts";
import { ReminderTimeError, resolveDelayMinutes } from "./reminder-time.ts";
import type { ReminderExtraction } from "./ai/schemas";

/** Processed-update rows older than this are pruned; replays beyond it are not a concern. */
const PROCESSED_UPDATE_TTL_MS = 7 * 24 * 3600 * 1000;

export class StudyAgent extends Agent<Env> {
  // One message at a time: an await on the LLM must not let a second message read stale state.
  private readonly messageQueue = new SerialQueue();

  // Initialized once when the Durable Object wakes up
  override async onStart(): Promise<void> {
    this.initDatabase();
    await this.registerAmbientCues();
    console.log("StudyAgent initialized with SQLite schema and ambient cue schedules");
  }

  /**
   * Register the 3 daily ambient cue cron schedules.
   * Idempotent — Agents SDK deduplicates by callback+cron expression, safe to call on every DO wake.
   * All times in UTC (IST = UTC+5:30):
   *   08:15 IST → 02:45 UTC  cron: "45 2 * * *"
   *   17:00 IST → 11:30 UTC  cron: "30 11 * * *"
   *   21:30 IST → 16:00 UTC  cron: "0 16 * * *"
   */
  private async registerAmbientCues(): Promise<void> {
    await this.schedule("45 2 * * *",  "morningCue",       "daily-morning");
    await this.schedule("30 11 * * *", "commuteCue",       "daily-commute");
    await this.schedule("0 16 * * *",  "eveningSynthesis", "daily-evening");
    console.log("Ambient cue schedules registered");
  }

  /**
   * Run idempotent SQLite migrations/DDL.
   */
  private initDatabase(): void {
    // v1 tables (SCHEMA_SQL) are migration 1; the product-loop tables are migration 2.
    const applied = runMigrations(doDb(this.ctx));
    if (applied.length > 0) console.log(`Applied DB migrations: ${applied.join(", ")}`);
  }

  // --- Plan state changes (all go through ops.ts) ---

  applyPlanOp(op: unknown, opts: ApplyOptions = {}): ApplyResult {
    return applyOp(doDb(this.ctx), op, opts);
  }

  undoLastOp(): UndoResult {
    return undoLast(doDb(this.ctx), { source: "telegram" });
  }

  // --- Clearing test data (called by POST /admin/reset) ---

  /**
   * Dry run unless confirm is true. Clearing `reminders` also cancels the matching delayed
   * alarms, otherwise a deleted row would still fire its message. The three daily cue
   * schedules are never touched.
   */
  async resetData(
    scope: string,
    confirm: boolean,
  ): Promise<{ ok: true; dryRun: boolean; affected: Record<string, number>; alarms?: number } | { ok: false; error: string }> {
    try {
      const scopes = parseScopes(scope);
      const dryRun = !confirm;
      const affected = resetRows(doDb(this.ctx), scopes, dryRun);

      let alarms: number | undefined;
      if (scopes.includes("reminders")) {
        const pending = (await this.listSchedules({ type: "delayed" })).filter((s) => s.callback === "triggerReminder");
        alarms = pending.length;
        if (!dryRun) for (const s of pending) await this.cancelSchedule(s.id);
      }
      return { ok: true, dryRun, affected, ...(alarms === undefined ? {} : { alarms }) };
    } catch (err) {
      if (err instanceof ResetError) return { ok: false, error: err.message };
      console.error("Reset failed:", err);
      return { ok: false, error: "reset failed (see worker logs)" };
    }
  }

  // --- Seeding (called by POST /admin/seed) ---

  /** Returns a result object rather than throwing: errors do not cross the RPC boundary reliably. */
  loadSeed(kind: string, body: unknown): { ok: true; report: unknown } | { ok: false; error: string } {
    try {
      const db = doDb(this.ctx);
      if (kind === "study") return { ok: true, report: loadStudySeed(db, body) };
      if (kind === "config") return { ok: true, report: loadConfigSeed(db, body) };
      if (kind === "reading") return { ok: true, report: loadReadingSeed(db, body) };
      return { ok: false, error: `unknown seed kind: ${kind} (supported: study, config, reading)` };
    } catch (err) {
      if (err instanceof SeedError) return { ok: false, error: err.message };
      console.error("Seed load failed:", err);
      return { ok: false, error: "seed load failed (see worker logs)" };
    }
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

  /**
   * Entry point from the Worker. Serialises processing and skips updates we have already
   * handled (Telegram redelivery, manual webhook replay).
   */
  async handleTelegramUpdate(update: any): Promise<void> {
    return this.messageQueue.run(async () => {
      const updateId: number | undefined = typeof update?.update_id === "number" ? update.update_id : undefined;
      const db = doDb(this.ctx);

      if (updateId !== undefined) {
        const seen = db.all<{ update_id: number }>("SELECT update_id FROM processed_update WHERE update_id = ?", updateId);
        if (seen.length > 0) {
          console.log(`Skipping already-processed update ${updateId}`);
          return;
        }
      }

      await this.processTelegramUpdate(update);

      if (updateId !== undefined) {
        const now = Date.now();
        db.run("INSERT OR IGNORE INTO processed_update (update_id, ts) VALUES (?, ?)", updateId, new Date(now).toISOString());
        db.run("DELETE FROM processed_update WHERE ts < ?", new Date(now - PROCESSED_UPDATE_TTL_MS).toISOString());
      }
    });
  }

  private async processTelegramUpdate(update: any): Promise<void> {
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
        } else if (result.intent === "reminder" && result.reminder) {
          const confirmMsg = await this.scheduleExtractedReminder(result.reminder);
          await telegram.sendMessage(
            chatId,
            `${confirmMsg}\n\n<i>Transcript: "${result.transcript}"</i>`
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
          } else if (parsed.intent === "reminder" && parsed.reminder) {
            const confirmMsg = await this.scheduleExtractedReminder(parsed.reminder);
            await telegram.sendMessage(chatId, confirmMsg);
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
          "• <code>/cues</code> - View daily ambient cue schedules & status",
          "• <code>/testcue &lt;morning|commute|evening&gt;</code> - Test fire an ambient cue",
          "• <code>/status</code> - View SQLite database stats & snooze status",
          "• <code>/queue</code> - List pending reading queue items",
          "• <code>/snooze &lt;hours&gt;</code> - Pause ambient reminders for X hours",
          "• <code>/unsnooze</code> - Resume ambient reminders immediately",
          "• <code>/recent</code> - Show last 3 logged interactions",
          "• <code>/undo</code> - Undo the last plan change",
          "• <code>/tracks</code> - Show where each study track pointer is",
          "• <code>/books</code> - What you're reading and what to pick next",
          "• <code>/book add|start|keep|hold|done|drop</code> - Manage the shelf by id or title (drop takes a reason)",
          "",
          "💡 <i>Tip: Send any URL to queue it, or send text/voice to log thoughts & workouts!</i>",
        ].join("\n");
        await telegram.sendMessage(chatId, helpMessage);
        break;
      }

      case "/tracks": {
        const plan = queryPlan(doDb(this.ctx));
        if (plan.length === 0) {
          await telegram.sendMessage(chatId, "No study tracks loaded yet. Seed them with POST /admin/seed.");
          break;
        }
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const lines = plan.map((p) => {
          const where = p.finished ? "✅ finished" : p.next ? `next: ${esc(p.next.title)}${p.next.group ? ` <i>(${esc(p.next.group)})</i>` : ""}` : "empty";
          const pos = p.total > 0 ? `${Math.min(p.ordinal, p.total)}/${p.total}` : "0/0";
          return `• <b>${esc(p.trackTitle)} — ${esc(p.listTitle)}</b> [${pos}]\n  ${where}`;
        });
        await telegram.sendMessage(chatId, `📚 <b>Study tracks</b>\n\n${lines.join("\n")}`);
        break;
      }

      case "/books": {
        await telegram.sendMessage(chatId, renderShelf(doDb(this.ctx), Math.floor(Date.now() / 86_400_000)));
        break;
      }

      case "/book": {
        const cmd = parseBookCommand(doDb(this.ctx), args);
        if ("reply" in cmd) {
          await telegram.sendMessage(chatId, cmd.reply);
          break;
        }
        const safe = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        try {
          const r = this.applyPlanOp(cmd.op, { source: "telegram" });
          await telegram.sendMessage(chatId, `✅ ${safe(r.summary)}
<i>/undo to reverse</i>`);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          await telegram.sendMessage(chatId, `⚠️ ${safe(err.message)}`);
        }
        break;
      }

      case "/undo": {
        const result = this.undoLastOp();
        await telegram.sendMessage(chatId, result.undone ? `↩️ ${result.summary}` : result.summary);
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

        const confirmMsg = await this.scheduleAdhocReminder(minutes, reminderText);
        await telegram.sendMessage(chatId, confirmMsg);
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

      case "/cues": {
        const snooze = this.getSnoozeStatus();
        const snoozeStr = snooze.snoozed
          ? `⏸️ <b>Snoozed until:</b> ${snooze.until}`
          : "▶️ <b>Active</b>";

        const lines = [
          "⏰ <b>Scheduled Daily Ambient Cues (IST)</b>",
          "",
          "• <b>08:15 IST</b> — Morning Focus & Serendipity Read (<code>morningCue</code>)",
          "• <b>17:00 IST</b> — Commute Reading Cue (<code>commuteCue</code>)",
          "• <b>21:30 IST</b> — Evening Synthesis & Daily Summary (<code>eveningSynthesis</code>)",
          "",
          `• <b>Snooze Status:</b> ${snoozeStr}`,
          "",
          "💡 <i>To test right now: <code>/testcue morning</code>, <code>/testcue commute</code>, or <code>/testcue evening</code></i>",
        ];
        await telegram.sendMessage(chatId, lines.join("\n"));
        break;
      }

      case "/testcue": {
        const target = (args[0] ?? "").toLowerCase();
        if (target === "morning") {
          await telegram.sendMessage(chatId, "🧪 <i>Triggering test morning cue...</i>");
          await this.morningCue("manual-test");
        } else if (target === "commute") {
          await telegram.sendMessage(chatId, "🧪 <i>Triggering test commute cue...</i>");
          await this.commuteCue("manual-test");
        } else if (target === "evening") {
          await telegram.sendMessage(chatId, "🧪 <i>Triggering test evening synthesis...</i>");
          await this.eveningSynthesis("manual-test");
        } else {
          await telegram.sendMessage(
            chatId,
            "⚠️ <b>Usage:</b> <code>/testcue &lt;morning|commute|evening&gt;</code>"
          );
        }
        break;
      }

      default: {
        await telegram.sendMessage(chatId, `❓ Unknown command <code>${command}</code>. Type <code>/help</code> for available commands.`);
        break;
      }
    }
  }

  // ─── Snooze Guard Helper ────────────────────────────────────────────────────

  /**
   * Returns true if there is an active snooze — callers should bail out early.
   */
  private isCurrentlySnoozed(): boolean {
    return this.getSnoozeStatus().snoozed;
  }

  // ─── Ambient Cue Handlers ────────────────────────────────────────────────────

  /**
   * 08:15 IST daily — sends daily focus + a serendipitous reading queue item.
   * Invoked by Agents SDK cron scheduler.
   */
  async morningCue(_payload: string): Promise<void> {
    if (this.isCurrentlySnoozed()) {
      console.log("[morningCue] Skipped — snooze active");
      return;
    }

    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;

    const items = this.getReadingQueue("queued", 1);
    const stats = this.getStats();

    const parts: string[] = [
      "☀️ <b>Good morning! Here's your morning brief.</b>",
      "",
    ];

    if (items.length > 0) {
      const item = items[0];
      const label = item.category ? `[${item.category}]` : "";
      const title = item.title ?? item.url;
      parts.push(`📖 <b>Serendipity Read ${label}:</b>`);
      parts.push(`<a href="${item.url}">${title}</a>`);
      if (item.estimated_minutes) parts.push(`⏱ ~${item.estimated_minutes} min read`);
      // Mark as served
      this.sql`UPDATE reading_queue SET status = 'served' WHERE id = ${item.id}`;
    } else {
      parts.push("📭 Reading queue is empty — drop a link today!");
    }

    parts.push("");
    parts.push(`🗂 <b>Today's stats:</b> ${stats.totalWorkouts} workouts · ${stats.totalLogs} interactions logged`);
    parts.push("");
    parts.push("<i>Reply with a text or voice memo to log workouts, thoughts, or use /help.</i>");

    this.logInteraction("system_cron", "morning_cue_fired");
    await telegram.sendMessage(chatId, parts.join("\n"));
  }

  /**
   * 17:00 IST daily — serves the next unread item from the reading queue.
   * Invoked by Agents SDK cron scheduler.
   */
  async commuteCue(_payload: string): Promise<void> {
    if (this.isCurrentlySnoozed()) {
      console.log("[commuteCue] Skipped — snooze active");
      return;
    }

    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;

    const items = this.getReadingQueue("queued", 1);

    if (items.length === 0) {
      await telegram.sendMessage(chatId, "🚌 <b>Commute time!</b> Your reading queue is clear. Drop a link to queue something.");
      return;
    }

    const item = items[0];
    const label = item.category ? ` [${item.category}]` : "";
    const title = item.title ?? item.url;
    const mins = item.estimated_minutes ? ` · ⏱ ~${item.estimated_minutes} min` : "";

    // Mark as served
    this.sql`UPDATE reading_queue SET status = 'served' WHERE id = ${item.id}`;
    this.logInteraction("system_cron", "commute_cue_fired");

    await telegram.sendMessage(
      chatId,
      `🚌 <b>Commute read${label}${mins}:</b>\n\n<a href="${item.url}">${title}</a>`
    );
  }

  /**
   * 21:30 IST daily — pre-filled evening synthesis from today's workout logs & interactions.
   * Invoked by Agents SDK cron scheduler.
   */
  async eveningSynthesis(_payload: string): Promise<void> {
    if (this.isCurrentlySnoozed()) {
      console.log("[eveningSynthesis] Skipped — snooze active");
      return;
    }

    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;

    // Query today's workout logs (date = YYYY-MM-DD in IST)
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
    const todayWorkouts = this.sql<WorkoutLogRow>` 
      SELECT id, date, workout_type, exercises_json, notes, created_at
      FROM workout_logs WHERE date = ${today} ORDER BY id DESC`;

    // Count today's interactions (logged since midnight IST)
    const todayInteractions = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM interaction_logs
      WHERE created_at >= ${today}`;
    const interactionCount = todayInteractions[0]?.count ?? 0;

    const parts: string[] = [
      "🌙 <b>Evening check-in — here's your day:</b>",
      "",
    ];

    if (todayWorkouts.length > 0) {
      todayWorkouts.forEach((w) => {
        let exercises: Array<{ name: string; sets: number; reps: number; weight_kg?: number }> = [];
        try { exercises = JSON.parse(w.exercises_json); } catch {}
        const exerciseStr = exercises.map((e) =>
          `${e.name} ${e.sets}x${e.reps}${e.weight_kg ? ` @ ${e.weight_kg}kg` : ""}`
        ).join(", ");
        parts.push(`🏋️ <b>${w.workout_type}:</b> ${exerciseStr}`);
      });
    } else {
      parts.push("🏋️ No workout logged today.");
    }

    parts.push(`💬 ${interactionCount} interaction${interactionCount !== 1 ? "s" : ""} logged today.`);
    parts.push("");
    parts.push("<i>Anything to add before closing the day? Reply with a note or voice memo — or send /status to review your full state.</i>");

    this.logInteraction("system_cron", "evening_synthesis_fired");
    await telegram.sendMessage(chatId, parts.join("\n"));
  }

  // ─── Ad-hoc Reminder ────────────────────────────────────────────────────────

  /**
   * Schedule an ad-hoc reminder via Agents SDK alarm scheduler and insert into SQLite.
   * Returns a formatted confirmation string.
   */
  /** Resolves the LLM's extraction (relative delay or clock time) in code, then schedules. */
  async scheduleExtractedReminder(r: ReminderExtraction): Promise<string> {
    try {
      return await this.scheduleAdhocReminder(resolveDelayMinutes(r, Date.now()), r.reminder_text);
    } catch (err) {
      if (err instanceof ReminderTimeError) {
        return `⚠️ Couldn't schedule "${r.reminder_text}": ${err.message}. Try <code>/remind &lt;minutes&gt; &lt;text&gt;</code>.`;
      }
      throw err;
    }
  }

  async scheduleAdhocReminder(minutes: number, reminderText: string): Promise<string> {
    const validMinutes = isNaN(minutes) || minutes <= 0 ? 5 : minutes;
    const delaySeconds = Math.max(1, Math.round(validMinutes * 60));
    const triggerAtMs = Date.now() + delaySeconds * 1000;

    // 1. Insert into SQLite table
    this.sql`INSERT INTO reminders (reminder_type, trigger_at, payload_json, status)
             VALUES ('adhoc', ${triggerAtMs}, ${JSON.stringify({ text: reminderText })}, 'pending')`;
    const reminderId = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`[0]?.id;

    // 2. Schedule via Agents SDK
    await this.schedule(delaySeconds, "triggerReminder", JSON.stringify({ reminderId, text: reminderText }));

    // 3. Formatted confirmation string
    const triggerTimeStr = new Date(triggerAtMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
    return `⏰ <b>Reminder scheduled!</b>\n\n• <b>Message:</b> "${reminderText}"\n• <b>Fires at:</b> ${triggerTimeStr} IST (${validMinutes} min)`;
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
