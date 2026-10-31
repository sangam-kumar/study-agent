import { Agent } from "agents";
import { TelegramClient } from "./telegram/bot";
import {
  BotStateRow,
  InteractionLogRow,
  ReadingQueueRow,
  ReminderRow,
  WorkoutLogRow,
} from "./db/schema";
import { buildBackends, transcribe } from "./ai/backends.ts";
import { addToInbox, understand } from "./understand.ts";
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
import {
  ensureDraft, eventExists, getConfig, loadDayRow, loadItems, lockDay, recordEvent,
  renderDayBlock, renderEvening, renderMorning, renderPlan,
} from "./day.ts";
import { DEFAULT_TIMES, JOB_CALLBACK, JOB_KINDS, nextRun } from "./jobs.ts";
import type { JobTimes } from "./jobs.ts";
import { WEEKDAY_NAMES, addDays, dateLabel, dayKey, istWallToMs, weekdayIndex } from "./time.ts";
import { formatIn, formatWhen } from "./reminder-time.ts";
import { GitHubClient } from "./github/client.ts";
import { mirrorDays } from "./mirror.ts";

/** Processed-update rows older than this are pruned; replays beyond it are not a concern. */
const PROCESSED_UPDATE_TTL_MS = 7 * 24 * 3600 * 1000;

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class StudyAgent extends Agent<Env> {
  // One message at a time: an await on the LLM must not let a second message read stale state.
  private readonly messageQueue = new SerialQueue();

  // Initialized once when the Durable Object wakes up
  override async onStart(): Promise<void> {
    this.initDatabase();
    await this.retireOldCues();
    await this.ensureJobs();
    console.log("StudyAgent initialized: schema migrated, day-loop jobs scheduled");
  }

  /** The v1 fixed-time cron cues (08:15 / 17:00 / 21:30) are replaced by the day loop. */
  private async retireOldCues(): Promise<void> {
    const old = new Set(["morningCue", "commuteCue", "eveningSynthesis"]);
    for (const sch of await this.listSchedules({ type: "cron" })) {
      if (old.has(sch.callback)) await this.cancelSchedule(sch.id);
    }
  }

  private jobTimes(): JobTimes {
    const db = doDb(this.ctx);
    return {
      evening: getConfig(db, "evening_cue", DEFAULT_TIMES.evening),
      lock: getConfig(db, "auto_lock", DEFAULT_TIMES.lock),
      morningWeekday: getConfig(db, "morning_fallback_weekday", DEFAULT_TIMES.morningWeekday),
      morningWeekend: getConfig(db, "morning_fallback_weekend", DEFAULT_TIMES.morningWeekend),
    };
  }

  /** Exactly one pending one-shot schedule per daily job, at its next due time. Safe to call any time. */
  async ensureJobs(): Promise<void> {
    const now = Date.now();
    const db = doDb(this.ctx);
    const times = this.jobTimes();
    const briefSent = eventExists(db, "morning_brief", dayKey(now));
    const scheduled = await this.listSchedules({ type: "scheduled" });
    for (const kind of JOB_KINDS) {
      const callback = JOB_CALLBACK[kind];
      const due = Math.floor(nextRun(kind, now, times, briefSent) / 1000);
      // Leave anything due now alone: it may be the very alarm that woke this object.
      const mine = scheduled.filter((sch) => sch.callback === callback && sch.time > Math.floor(now / 1000) + 5);
      if (mine.length === 1 && mine[0].time === due) continue;
      for (const sch of mine) await this.cancelSchedule(sch.id);
      await this.schedule(new Date(due * 1000), callback, kind);
    }
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
   * alarms, otherwise a deleted row would still fire its message. The day-loop job
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
        const pending = (await this.listSchedules()).filter((s) => s.callback === "triggerReminder");
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
      // The first message of the morning is the wake signal: it delivers today's plan.
      const raw = typeof message.text === "string" ? (message.text as string).trim() : "";
      if (message.voice || (raw && (!raw.startsWith("/") || /^\/up\b/i.test(raw)))) {
        if (await this.noteWake(telegram, chatId, raw)) return;
      }

      if (message.voice) {
        // Voice memo: in-memory download, transcribe, then the same pipeline as typed text.
        const fileId = message.voice.file_id;
        console.log(`Processing voice memo [${fileId}]...`);
        const audioBuffer = await telegram.downloadFileAsBuffer(fileId);
        const transcript = await transcribe(this.env, audioBuffer, message.voice.mime_type || "audio/ogg");
        if (!transcript) {
          await telegram.sendMessage(chatId, "🎙️ Couldn't transcribe that voice note. Try again or type it.");
        } else {
          this.logInteraction("telegram_voice", transcript, { type: "voice" });
          await this.handleNaturalLanguage(telegram, chatId, transcript, "telegram_voice");
        }
      } else if (message.text) {
        const text = (message.text as string).trim();

        if (text.startsWith("/")) {
          await this.handleCommand(telegram, chatId, text);
        } else if (text.startsWith("http://") || text.startsWith("https://")) {
          this.addToReadingQueue(text);
          this.logInteraction("telegram_text", text, { type: "url", url: text });
          const count = this.getStats().queuedReading;
          await telegram.sendMessage(
            chatId,
            `🔗 <b>URL added to Reading Queue!</b>
<code>${text}</code>
Total queued articles: <b>${count}</b>`
          );
        } else {
          this.logInteraction("telegram_text", text, { type: "text" });
          await this.handleNaturalLanguage(telegram, chatId, text, "telegram_text");
        }
      }
    } catch (err) {
      console.error("Error handling telegram update:", err);
      await telegram.sendMessage(chatId, "⚠️ Error processing your request with AI pipeline.");
    }
  }

  // --- Natural language (classify -> extract -> typed ops; see understand.ts) ---

  private async handleNaturalLanguage(telegram: TelegramClient, chatId: string, text: string, source: string): Promise<void> {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    const tomorrow = addDays(today, 1);

    // "ok" after the evening message locks tomorrow. No model needed.
    if (/^(ok|okay|ok lock|lock|lock it|looks good|sounds good|good|fine|yes|yep|👍)[.!]?$/i.test(text.trim()) && eventExists(db, "evening_recap", today) && loadDayRow(db, tomorrow)?.status === "draft") {
      lockDay(db, tomorrow, "user", nowMs);
      await telegram.sendMessage(chatId, `🔒 Locked ${dateLabel(tomorrow)}. See you in the morning.`);
      await this.mirror();
      return;
    }

    const outcome = await understand({ db, backends: buildBackends(this.env), nowMs }, text);
    const heard = source === "telegram_voice" ? `\n\n<i>Heard: "${escapeHtml(text)}"</i>` : "";

    switch (outcome.kind) {
      case "ops": {
        const lines: string[] = [];
        try {
          for (const op of outcome.ops) lines.push(`✅ ${escapeHtml(this.applyPlanOp(op, { source: "telegram", raw: text }).summary)}`);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          lines.push(`⚠️ ${escapeHtml(err.message)}`);
        }
        const undoable = lines.some((l) => l.startsWith("✅"));
        const replanned = undoable ? this.replanAfterChange(today, outcome.affects) : [];
        const updates = replanned.map((d) => `\n\n<b>${dateLabel(d)} now:</b>\n${renderDayBlock(db, d)}`).join("");
        await telegram.sendMessage(chatId, `${lines.join("\n")}${undoable ? "\n<i>/undo to reverse</i>" : ""}${updates}${heard}`);
        return;
      }
      case "reminder":
        await telegram.sendMessage(chatId, `${await this.scheduleReminderAt(outcome.dueMs, outcome.text)}${heard}`);
        return;
      case "workout": {
        // Legacy v1 table until the fitness lane (Phase 13). Day boundary is 03:00 IST.
        const day = new Date(nowMs + (330 - 180) * 60_000).toISOString().slice(0, 10);
        this.sql`INSERT INTO workout_logs (date, workout_type, exercises_json, notes)
                 VALUES (${day}, ${outcome.workout_type}, ${JSON.stringify(outcome.exercises)}, ${outcome.notes})`;
        // A logged lift completes today's gym item, which moves the rotation on.
        const gym = loadItems(db, today).find((i) => i.lane === "fitness" && i.status === "planned" && i.ref?.startsWith("rotation:"));
        if (gym) this.applyPlanOp({ type: "set_item_status", item_id: gym.id, status: "done" }, { source: "telegram", raw: text });
        const list = outcome.exercises
          .map((e) => `• <b>${escapeHtml(e.name)}</b>: ${e.sets}x${e.reps}${e.weight_kg ? ` @ ${e.weight_kg}kg` : ""}`)
          .join("\n");
        const note = outcome.notes ? `\n\n<i>Note: ${escapeHtml(outcome.notes)}</i>` : "";
        await telegram.sendMessage(chatId, `🏋️ <b>Workout Logged (${escapeHtml(outcome.workout_type)})</b>\n\n${list}${note}${heard}`);
        return;
      }
      case "snooze": {
        const untilMs = this.setSnooze(outcome.hours, outcome.reason);
        const until = new Date(untilMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
        await telegram.sendMessage(chatId, `😴 <b>Snooze Activated!</b> My messages paused until <b>${until} IST</b> (${outcome.hours}h).\n<i>Reason: ${escapeHtml(outcome.reason)}</i>${heard}`);
        return;
      }
      case "reply":
        await telegram.sendMessage(chatId, `${outcome.html}${heard}`);
        return;
      case "inbox":
        addToInbox(db, text, nowMs);
        await telegram.sendMessage(chatId, `🗂 Saved to your inbox — ${escapeHtml(outcome.reason)}. Nothing was changed.${heard}`);
        return;
    }
  }

  // --- Day loop (plan.ts drafts, day.ts stores and renders, jobs.ts times it) ---

  /**
   * After a change: tomorrow's unlocked draft is refreshed (a finished unit should not reappear).
   * An override re-plans the days it covers among today and tomorrow, even when locked.
   * Returns the dates re-planned because of an override, so the reply can show them.
   */
  private replanAfterChange(today: string, affects?: { from: string; to: string }): string[] {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const tomorrow = addDays(today, 1);
    const shown: string[] = [];
    for (const d of [today, tomorrow]) {
      const covered = !!affects && d >= affects.from && d <= affects.to;
      if (covered) {
        ensureDraft(db, d, nowMs, { force: true });
        shown.push(d);
      } else if (d === tomorrow && loadDayRow(db, d)?.status === "draft") {
        ensureDraft(db, d, nowMs);
      }
    }
    return shown;
  }

  /** Records the day's wake and sends the morning brief if it hasn't gone out. True if the message was only a wake word. */
  private async noteWake(telegram: TelegramClient, chatId: string, text: string): Promise<boolean> {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    const wakeWord = /^\/?(up|awake|gm|good morning|morning)[.!]?$/i.test(text);
    // Before ~04:30 a message is more likely a late night than a wake-up.
    const earliest = istWallToMs(today, getConfig(db, "wake_earliest", "04:30"));
    if (nowMs < earliest && !wakeWord) return false;

    if (!eventExists(db, "wake", today)) recordEvent(db, "wake", today, { trigger: wakeWord ? "wake_word" : "first_message" }, nowMs);
    if (!eventExists(db, "morning_brief", today)) {
      await this.sendMorning(telegram, chatId, "wake");
      return wakeWord;
    }
    if (wakeWord) {
      await telegram.sendMessage(chatId, "☀️ Morning. /plan shows today.");
      return true;
    }
    return false;
  }

  private async sendMorning(telegram: TelegramClient, chatId: string, trigger: "wake" | "fallback" | "manual"): Promise<void> {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    // Normally locked last night. If the evening never happened, plan and lock it now.
    if (loadDayRow(db, today)?.status !== "locked") lockDay(db, today, "auto", nowMs);
    await telegram.sendMessage(chatId, renderMorning(db, today));
    if (trigger !== "manual") recordEvent(db, "morning_brief", today, { trigger }, nowMs);
  }

  private telegramAndChat(): { telegram: TelegramClient; chatId: string } | null {
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    return chatId ? { telegram: new TelegramClient(this.env.TELEGRAM_BOT_TOKEN), chatId } : null;
  }

  /**
   * Mirrors yesterday, today and tomorrow into study-repo's daily notes (only days that changed).
   * Never throws: a failure is logged and retried at the next lock. Returns a one-line summary.
   */
  async mirror(): Promise<string> {
    const token = this.env.GITHUB_PAT;
    const repo = this.env.GITHUB_REPO as string | undefined;
    if (!token || !repo) return "Mirror is off: GITHUB_PAT or GITHUB_REPO is not set.";
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    try {
      const gh = new GitHubClient(token, repo, getConfig(db, "mirror_branch", "master"));
      const r = await mirrorDays(db, gh, [addDays(today, -1), today, addDays(today, 1)], nowMs);
      if (r.committed) recordEvent(db, "mirror", null, { paths: r.paths, sha: r.sha }, nowMs);
      return r.committed ? `Wrote ${r.paths.length} daily note(s) to study-repo: ${r.paths.join(", ")}` : "Daily notes are up to date.";
    } catch (err) {
      console.error("mirror failed:", err);
      recordEvent(db, "mirror_failed", null, { error: String(err).slice(0, 300) }, nowMs);
      return `Couldn't write to study-repo (will retry at the next lock): ${String(err).slice(0, 160)}`;
    }
  }

  /** 21:30: recap today, draft tomorrow. */
  async jobEvening(_payload: string): Promise<void> {
    try {
      const t = this.telegramAndChat();
      if (!t || this.isCurrentlySnoozed()) return;
      const db = doDb(this.ctx);
      const nowMs = Date.now();
      const today = dayKey(nowMs);
      ensureDraft(db, addDays(today, 1), nowMs);
      await t.telegram.sendMessage(t.chatId, renderEvening(db, today));
      recordEvent(db, "evening_recap", today, {}, nowMs);
    } catch (err) {
      console.error("jobEvening failed:", err);
    } finally {
      await this.ensureJobs();
    }
  }

  /** 23:00: silence is consent. Tomorrow locks itself; nothing is sent. */
  async jobLock(_payload: string): Promise<void> {
    try {
      const nowMs = Date.now();
      lockDay(doDb(this.ctx), addDays(dayKey(nowMs), 1), "auto", nowMs);
      await this.mirror();
    } catch (err) {
      console.error("jobLock failed:", err);
    } finally {
      await this.ensureJobs();
    }
  }

  /** Fallback morning brief, only if nothing has woken it up yet today. */
  async jobMorning(_payload: string): Promise<void> {
    try {
      const t = this.telegramAndChat();
      const db = doDb(this.ctx);
      if (!t || this.isCurrentlySnoozed() || eventExists(db, "morning_brief", dayKey(Date.now()))) return;
      await this.sendMorning(t.telegram, t.chatId, "fallback");
    } catch (err) {
      console.error("jobMorning failed:", err);
    } finally {
      await this.ensureJobs();
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
          "🤖 <b>Study Agent</b>",
          "",
          "🗓 <b>How the day works</b>",
          "• 21:30 — how today went + tomorrow's plan. Change it, or say <b>ok</b>.",
          "• 23:00 — tomorrow locks itself if you said nothing.",
          "• Morning — say <b>up</b> (or send anything) and you get today's plan. Otherwise it comes at 09:30 (weekends 10:30).",
          "",
          "📋 <b>Plan</b>",
          "• <code>/plan</code> · <code>/plan tomorrow</code> - See a day",
          "• <code>/up</code> - Today's plan now · <code>/lock</code> - Lock tomorrow now",
          "• <code>/office tue thu</code> - Your office days this week (others are remote)",
          "• <code>/undo</code> - Undo the last change",
          "• <code>/mirror</code> - Write yesterday/today/tomorrow to study-repo now (also happens at every lock)",
          "",
          "📚 <b>Study &amp; reading</b>",
          "• <code>/tracks</code> - Where each study track is",
          "• <code>/books</code> - What you're reading and what to pick next",
          "• <code>/book add|start|keep|hold|done|drop</code> - Manage the shelf by id or title",
          "",
          "⏰ <b>Reminders &amp; other</b>",
          "• <code>/remind &lt;minutes&gt; &lt;text&gt;</code> · <code>/reminders</code> (for a date and time, just say it)",
          "• <code>/inbox</code> - Messages I wasn't sure about (<code>/inbox done &lt;id&gt;</code>)",
          "• <code>/snooze &lt;hours&gt;</code> · <code>/unsnooze</code> - Pause my messages",
          "• <code>/jobs</code> · <code>/testcue evening|lock|morning</code> · <code>/status</code> · <code>/queue</code> · <code>/recent</code>",
          "",
          "💬 <b>Or just say it</b> (text or voice):",
          "• <i>done with gym</i> · <i>skip reading today</i> · <i>add call mom tomorrow</i> · <i>move DSA to Saturday</i>",
          "• <i>travelling Fri to Sun</i> · <i>down with a fever</i> · <i>feeling low today</i>",
          "• <i>finished the 100 page ML book</i> · <i>drop Sapiens, boring</i> · <i>did 3 DSA problems</i>",
          "• <i>remind me at 6:30 pm to play ball</i> · <i>remind me Friday at 4pm to submit the form</i>",
          "• <i>knee hurts, go easy on legs</i>",
          "If I'm unsure I save it to /inbox and change nothing. Send a URL to queue it.",
        ].join("\n");
        await telegram.sendMessage(chatId, helpMessage);
        break;
      }

      case "/inbox": {
        const db = doDb(this.ctx);
        if ((args[0] ?? "").toLowerCase() === "done") {
          const id = parseInt(args[1] ?? "", 10);
          const hit = isNaN(id) ? [] : db.all("SELECT 1 FROM inbox WHERE id = ? AND status = 'open'", id);
          if (hit.length === 0) {
            await telegram.sendMessage(chatId, "Usage: <code>/inbox done &lt;id&gt;</code> (see /inbox for ids)");
            break;
          }
          db.run("UPDATE inbox SET status = 'resolved' WHERE id = ?", id);
          await telegram.sendMessage(chatId, `✅ Cleared #${id}`);
          break;
        }
        const open = db.all<{ id: number; raw: string }>("SELECT id, raw FROM inbox WHERE status = 'open' ORDER BY id DESC LIMIT 10");
        if (open.length === 0) {
          await telegram.sendMessage(chatId, "📭 Inbox is empty.");
          break;
        }
        const lines = open.map((i) => `• <code>#${i.id}</code> ${escapeHtml(i.raw.length > 120 ? `${i.raw.slice(0, 119)}…` : i.raw)}`);
        await telegram.sendMessage(chatId, `🗂 <b>Inbox</b>\n\n${lines.join("\n")}\n\n<i>Say it again more clearly, use a command, or /inbox done &lt;id&gt;</i>`);
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
        await telegram.sendMessage(chatId, `😴 <b>Snoozed!</b> My messages paused until <b>${untilDate} IST</b> (${hours}h).`);
        break;
      }

      case "/unsnooze": {
        this.clearSnooze();
        await telegram.sendMessage(chatId, "🔔 <b>Snooze cleared!</b> My messages are back on.");
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

        const confirmMsg = await this.scheduleReminderAt(Date.now() + minutes * 60_000, reminderText);
        await telegram.sendMessage(chatId, confirmMsg);
        break;
      }

      case "/reminders": {
        const pending = this.sql<ReminderRow>`SELECT id, reminder_type, trigger_at, payload_json, status, created_at 
                                              FROM reminders WHERE status = 'pending' ORDER BY trigger_at ASC LIMIT 10`;
        if (pending.length === 0) {
          await telegram.sendMessage(chatId, "📭 No pending reminders.");
          return;
        }

        const nowMs = Date.now();
        const lines = pending.map((r, i) => {
          let note = "Reminder";
          try {
            if (r.payload_json) note = JSON.parse(r.payload_json).text ?? note;
          } catch {}
          return `${i + 1}. <b>${formatWhen(r.trigger_at, nowMs)}</b> — ${escapeHtml(note)} <i>(${formatIn(r.trigger_at, nowMs)})</i>`;
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

      case "/plan": {
        const db = doDb(this.ctx);
        const today = dayKey(Date.now());
        const which = (args[0] ?? "").toLowerCase();
        const date = which === "tomorrow" || which === "tmrw" ? addDays(today, 1) : /^\d{4}-\d{2}-\d{2}$/.test(which) ? which : today;
        if (!loadDayRow(db, date) && date > today) ensureDraft(db, date, Date.now());
        await telegram.sendMessage(chatId, renderPlan(db, date));
        break;
      }

      case "/up": {
        await this.sendMorning(telegram, chatId, "manual");
        break;
      }

      case "/lock": {
        const tomorrow = addDays(dayKey(Date.now()), 1);
        const changed = lockDay(doDb(this.ctx), tomorrow, "user", Date.now());
        await telegram.sendMessage(chatId, changed ? `🔒 Locked ${dateLabel(tomorrow)}.` : `${dateLabel(tomorrow)} is already locked.`);
        if (changed) await this.mirror();
        break;
      }

      case "/office": {
        // "/office tue thu": those days (this week, or next week once they've passed) are office days.
        const idx = args.filter(Boolean).map((a) => WEEKDAY_NAMES.findIndex((w) => w.toLowerCase() === a.slice(0, 3).toLowerCase()));
        if (idx.length === 0 || idx.some((i) => i < 0)) {
          await telegram.sendMessage(chatId, "Usage: <code>/office tue thu</code> (the days you'll be in the office)");
          break;
        }
        const today = dayKey(Date.now());
        const dates = idx.map((w) => addDays(today, (w - weekdayIndex(today) + 7) % 7));
        try {
          const r = this.applyPlanOp({ type: "set_place", dates, place: "OFFICE" }, { source: "telegram" });
          const tomorrow = addDays(today, 1);
          if (loadDayRow(doDb(this.ctx), tomorrow)?.status === "draft") ensureDraft(doDb(this.ctx), tomorrow, Date.now());
          await telegram.sendMessage(chatId, `🏢 ${escapeHtml(r.summary)}\n<i>Other days stay remote. /undo to reverse</i>`);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          await telegram.sendMessage(chatId, `⚠️ ${escapeHtml(err.message)}`);
        }
        break;
      }

      case "/mirror": {
        await telegram.sendMessage(chatId, `📝 ${escapeHtml(await this.mirror())}`);
        break;
      }

      case "/jobs": {
        const lines = (await this.listSchedules({ type: "scheduled" }))
          .filter((sch) => (Object.values(JOB_CALLBACK) as string[]).includes(sch.callback))
          .sort((x, y) => x.time - y.time)
          .map((sch) => `• <b>${sch.callback}</b> — ${new Date(sch.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`);
        const snooze = this.getSnoozeStatus();
        await telegram.sendMessage(
          chatId,
          `⏰ <b>Day-loop jobs</b>\n${lines.join("\n") || "none scheduled"}${snooze.snoozed ? `\n\n⏸️ Snoozed until ${snooze.until}` : ""}\n\n<i>Test now: /testcue evening | lock | morning</i>`,
        );
        break;
      }

      case "/testcue": {
        const target = (args[0] ?? "").toLowerCase();
        if (target === "evening") await this.jobEvening("manual-test");
        else if (target === "lock") {
          await this.jobLock("manual-test");
          await telegram.sendMessage(chatId, "🔒 Ran the lock job. /plan tomorrow");
        } else if (target === "morning") await this.sendMorning(telegram, chatId, "manual");
        else await telegram.sendMessage(chatId, "⚠️ <b>Usage:</b> <code>/testcue evening|lock|morning</code>");
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

  // ─── Ad-hoc Reminder ────────────────────────────────────────────────────────

  /**
   * Stores a reminder and schedules it at its exact due instant (not "N minutes from whenever the
   * model finished"). Returns the confirmation text.
   */
  async scheduleReminderAt(dueMs: number, text: string): Promise<string> {
    const nowMs = Date.now();
    const due = Math.max(Math.round(dueMs), nowMs + 1000);
    this.sql`INSERT INTO reminders (reminder_type, trigger_at, payload_json, status)
             VALUES ('adhoc', ${due}, ${JSON.stringify({ text })}, 'pending')`;
    const reminderId = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`[0]?.id;
    await this.schedule(new Date(due), "triggerReminder", JSON.stringify({ reminderId, text }));
    return `⏰ <b>${escapeHtml(text)}</b>\n${formatWhen(due, nowMs)} <i>(${formatIn(due, nowMs)})</i>`;
  }

  /**
   * Invoked by the scheduler when a reminder is due. It is marked sent only after Telegram accepts
   * it; a failed send throws, so the scheduler retries instead of silently dropping it.
   */
  async triggerReminder(payloadStr: string): Promise<void> {
    let payload: { reminderId?: number; text: string };
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      console.error("Unreadable reminder payload:", payloadStr);
      return;
    }
    if (payload.reminderId) {
      const row = this.sql<{ status: string }>`SELECT status FROM reminders WHERE id = ${payload.reminderId}`[0];
      if (!row || row.status !== "pending") return; // cleared, cancelled or already sent
    }
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;
    await new TelegramClient(this.env.TELEGRAM_BOT_TOKEN).sendMessage(chatId, `⏰ <b>Reminder:</b>\n\n${escapeHtml(payload.text)}`);
    if (payload.reminderId) this.sql`UPDATE reminders SET status = 'dispatched' WHERE id = ${payload.reminderId}`;
  }
}
