import { Agent } from "agents";
import { TelegramClient } from "./telegram/bot";
import {
  BotStateRow,
  InteractionLogRow,
  ReadingQueueRow,
  ReminderRow,
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
  BED_RE, OFFICE_RE, ensureDraft, eventExists, formatHours, getConfig, lastWeeksOfficeDays, loadDayRow, loadItems, lockDay,
  officeWindow, parseWeekdays, recordEvent, renderDayBlock, renderEvening, renderMorning, renderPlan, sleepNights,
  weekdayNames,
} from "./day.ts";
import { DEFAULT_TIMES, JOB_CALLBACK, JOB_KINDS, nextRun } from "./jobs.ts";
import type { JobTimes } from "./jobs.ts";
import { WEEKDAY_NAMES, addDays, dateLabel, dayKey, istWallToMs, weekdayIndex } from "./time.ts";
import { formatIn, formatWhen } from "./reminder-time.ts";
import {
  REMINDER_BUTTONS, describeRepeat, findDuplicate, getReminder, insertReminder, markCancelled, markDone, markFired, nextOccurrence,
  renderReminderList, reschedule, resolveReminder, tomorrowAt,
} from "./reminders.ts";
import { GitHubClient } from "./github/client.ts";
import { mirrorDays } from "./mirror.ts";
import {
  closeOpenSessions, findRepeat, importGymLog, parseChatWorkout, parseProtein, renderGymWeek, renderLiftHistory, renderSession,
} from "./fitness.ts";
import type { LogWorkoutOp } from "./fitness.ts";
import {
  NUDGE_BUTTONS, PAUSE_BUTTONS, SILENT_MUTE_DAYS, closeIgnoredNudge, nudgeGate, nudgeStatus, nudgeText, pauseQuestion, pickNudge,
  recordAgentMessage, recordNudgeAnswer, recordNudgeSent, shouldAskPause,
} from "./nudge.ts";
import { renderWeekly } from "./weekly.ts";
import { booksWithJots, findBook, jotKind as jotKindOf, notesPath, parseJotText, renderJots, renderNotesMarkdown, soleCurrentBook } from "./jots.ts";

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

  /** The v1 fixed-time cron cues (08:15 / 17:00 / 21:30) are replaced by the day loop; v1 snooze keys by config "mute". */
  private async retireOldCues(): Promise<void> {
    this.sql`DELETE FROM bot_state WHERE key IN ('snooze_until', 'snooze_reason')`;
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
      nudge: getConfig(db, "nudge_time", DEFAULT_TIMES.nudge),
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
        const pending = (await this.listSchedules()).filter((s) => s.callback === "triggerReminder" || s.callback === "reminderFollowup");
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
      if (kind === "fitness") {
        // The body is life/gym-tracking.md as text (index.ts wraps it as { markdown }).
        const md = (body as { markdown?: unknown } | null)?.markdown;
        if (typeof md !== "string" || !md.trim()) return { ok: false, error: "fitness seed needs the markdown of life/gym-tracking.md as the body" };
        return { ok: true, report: importGymLog(db, md, Date.now()) };
      }
      return { ok: false, error: `unknown seed kind: ${kind} (supported: study, config, reading, fitness)` };
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

  // --- Pausing my messages ("snooze") ---
  // Stored as one config value set through an op, so /undo works. It pauses only messages the agent
  // starts (the evening message and the fallback morning brief); reminders you set still fire.

  setSnooze(durationHours: number, reason = "paused"): number {
    const untilMs = Date.now() + durationHours * 3600 * 1000;
    this.applyPlanOp({ type: "set_config", key: "mute", value: JSON.stringify({ until: untilMs, reason }) }, { source: "telegram" });
    return untilMs;
  }

  clearSnooze(): void {
    if (this.getSnoozeStatus().snoozed) {
      this.applyPlanOp({ type: "set_config", key: "mute", value: JSON.stringify({ until: 0 }) }, { source: "telegram" });
    }
  }

  getSnoozeStatus(): { snoozed: boolean; until?: string; reason?: string } {
    let mute: { until?: number; reason?: string } = {};
    try {
      mute = JSON.parse(getConfig(doDb(this.ctx), "mute", "{}"));
    } catch {}
    if (!mute.until || Date.now() > mute.until) return { snoozed: false };
    return { snoozed: true, until: new Date(mute.until).toISOString(), reason: mute.reason ?? "paused" };
  }

  // --- Statistics Helper ---

  getStats() {
    const totalLogs = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM interaction_logs`[0]?.count ?? 0;
    const queuedReading = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM reading_queue WHERE status = 'queued'`[0]?.count ?? 0;
    const totalWorkouts = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM workout_session`[0]?.count ?? 0;
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

    this.endSilentQuiet();

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

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

    // "sleeping" / "good night": a bedtime. No model needed.
    if (BED_RE.test(text.trim())) {
      recordEvent(db, "bed", today, {}, nowMs);
      const wakeBy = loadDayRow(db, tomorrow)?.wake_by;
      const until = wakeBy ? istWallToMs(tomorrow, wakeBy) : null;
      const hint = until && until > nowMs ? ` Up by ${wakeBy} — that's ${formatHours((until - nowMs) / 3_600_000)} from now.` : "";
      await telegram.sendMessage(chatId, `🌙 Good night.${hint}`);
      return;
    }

    // "office tue thu" / "in office monday and wednesday": the coming week's office days.
    const office = OFFICE_RE.exec(text.trim());
    const officeDays = office ? parseWeekdays(office[1]) : null;
    if (officeDays) {
      await telegram.sendMessage(chatId, this.applyOfficeDays(officeDays));
      return;
    }

    // "add again" after a repeat was held back.
    if (/^(?:add (?:it |them )?again|log (?:it |them )?anyway|again)[.!]?$/i.test(text.trim())) {
      const pending = this.takePendingWorkout(nowMs);
      if (pending) {
        await telegram.sendMessage(chatId, this.logWorkout(pending, text, { allowRepeat: true }));
        return;
      }
    }

    // "protein 110": one number a day, no model needed.
    const protein = parseProtein(text);
    if (protein !== null) {
      this.applyPlanOp({ type: "log_metric", date: today, metric: "protein_g", value: protein }, { source: "telegram", raw: text });
      await telegram.sendMessage(chatId, `🥩 Protein today: <b>${protein} g</b>\n<i>/undo to reverse · /gym for the week</i>`);
      return;
    }

    // "ch3: …" / "jot: …" / "finished ch3" / "on p140" about the one book being read: no model.
    const jot = parseJotText(text);
    const sole = jot ? soleCurrentBook(db) : null;
    if (jot && sole) {
      const op = jot.kind === "jot"
        ? { type: "add_jot", reading_id: sole.id, text: jot.text, locator: jot.locator ?? undefined, kind: jotKindOf(jot.text) }
        : { type: "set_progress", reading_id: sole.id, locator: jot.locator, date: today };
      try {
        const res = this.applyPlanOp(op, { source: "telegram", raw: text });
        await telegram.sendMessage(chatId, `📝 ${escapeHtml(res.summary)}\n<i>/jots to see them · /undo to reverse</i>`);
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        await telegram.sendMessage(chatId, `⚠️ ${escapeHtml(err.message)}`);
      }
      return;
    }

    // Sets typed in the notation ("bench 20x15, 22.5x12"): read by code, no model.
    const typed = parseChatWorkout(db, text, nowMs);
    if (typed) {
      await telegram.sendMessage(chatId, this.logWorkout(typed, text));
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
        await telegram.sendMessage(chatId, `${await this.scheduleReminderAt(outcome.dueMs, outcome.text, outcome.repeat)}${heard}`);
        return;
      case "task":
        await telegram.sendMessage(chatId, `${this.addTask(outcome.text, outcome.dueDate)}${heard}`);
        return;
      case "reminder_action":
        await telegram.sendMessage(chatId, `${await this.closeReminder(outcome.id, outcome.action)}${heard}`);
        return;
      case "workout": {
        let extra = "";
        if (outcome.protein) {
          this.applyPlanOp({ type: "log_metric", date: outcome.op.date, metric: "protein_g", value: outcome.protein }, { source: "telegram", raw: text });
          extra = `\n🥩 Protein: ${outcome.protein} g`;
        }
        await telegram.sendMessage(chatId, `${this.logWorkout(outcome.op, text)}${extra}${heard}`);
        return;
      }
      case "snooze": {
        const untilMs = this.setSnooze(outcome.hours, outcome.reason);
        const until = new Date(untilMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
        await telegram.sendMessage(chatId, `😴 <b>Paused</b> until <b>${until} IST</b> (${outcome.hours}h). Reminders you set still fire.\n<i>/unsnooze to resume · /undo to reverse</i>${heard}`);
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

  // --- Fitness (fitness.ts reads and renders, the log_workout op writes) ---

  /**
   * Applies one chunk and replies with the day's session. The same sets sent again within 15 minutes
   * are held back with a question ("add again" logs them) instead of being counted twice.
   */
  private logWorkout(op: LogWorkoutOp, raw: string, opts: { allowRepeat?: boolean } = {}): string {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const firstAt = opts.allowRepeat ? null : findRepeat(db, op, nowMs);
    if (firstAt) {
      this.setBotConfig("fitness_pending", JSON.stringify({ op, until: nowMs + 15 * 60_000 }));
      const at = new Date(firstAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
      return `🤔 That's the same as what you sent at ${at}, so I didn't add it again.\nSay <b>add again</b> if you really did those sets twice.`;
    }
    let summary: string;
    try {
      summary = this.applyPlanOp(op, { source: "telegram", raw }).summary;
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      return `⚠️ ${escapeHtml(err.message)}`;
    }
    // The rotation may have moved on: tomorrow's draft should offer the next split.
    this.replanAfterChange(dayKey(nowMs));
    return `✅ ${escapeHtml(summary)}\n\n${renderSession(db, op.date)}\n<i>/undo to reverse</i>`;
  }

  private takePendingWorkout(nowMs: number): LogWorkoutOp | null {
    const raw = this.getBotConfig("fitness_pending");
    if (!raw) return null;
    this.setBotConfig("fitness_pending", "");
    try {
      const p = JSON.parse(raw) as { op: LogWorkoutOp; until: number };
      return p.until > nowMs ? p.op : null;
    } catch {
      return null;
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
    // A bedtime is never a wake-up, even if it's the first message of the day.
    if (BED_RE.test(text.trim())) return false;
    // Before ~04:30 a message is more likely a late night than a wake-up.
    const earliest = istWallToMs(today, getConfig(db, "wake_earliest", "04:30"));
    if (nowMs < earliest && !wakeWord) return false;

    // An explicit "up" is the real wake time (sleep is measured from it), even after an earlier message.
    const hasExplicit = db.all(
      "SELECT 1 FROM event WHERE type = 'wake' AND ref_id = ? AND json_extract(payload_json, '$.trigger') = 'wake_word'", today,
    ).length > 0;
    if (wakeWord ? !hasExplicit : !eventExists(db, "wake", today)) {
      recordEvent(db, "wake", today, { trigger: wakeWord ? "wake_word" : "first_message" }, nowMs);
    }
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
    if (trigger === "fallback") recordAgentMessage(db, "morning", nowMs);
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
      const notes = booksWithJots(db).flatMap((b) => {
        const content = renderNotesMarkdown(db, b.id);
        return content ? [{ path: notesPath(b.title), label: b.title, content }] : [];
      });
      const r = await mirrorDays(db, gh, [addDays(today, -1), today, addDays(today, 1)], nowMs, notes);
      if (r.committed) recordEvent(db, "mirror", null, { paths: r.paths, sha: r.sha }, nowMs);
      return r.committed ? `Wrote ${r.paths.length} file(s) to study-repo: ${r.paths.join(", ")}` : "study-repo is up to date.";
    } catch (err) {
      console.error("mirror failed:", err);
      recordEvent(db, "mirror_failed", null, { error: String(err).slice(0, 300) }, nowMs);
      return `Couldn't write to study-repo (will retry at the next lock): ${String(err).slice(0, 160)}`;
    }
  }

  /** Sets the next 7 days: these weekdays in the office, the other weekdays remote. Returns the reply. */
  private applyOfficeDays(weekdays: number[]): string {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const today = dayKey(nowMs);
    try {
      this.applyPlanOp({ type: "set_places", places: officeWindow(today, weekdays) }, { source: "telegram" });
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      return `⚠️ ${escapeHtml(err.message)}`;
    }
    const tomorrow = addDays(today, 1);
    if (loadDayRow(db, tomorrow)?.status === "draft") ensureDraft(db, tomorrow, nowMs);
    return weekdays.length
      ? `🏢 Office: <b>${weekdayNames(weekdays)}</b> · other weekdays remote.\n<i>/undo to reverse</i>`
      : "🏠 All remote this week.";
  }

  /**
   * Sunday evening: next week's office days default to last week's (silence keeps them, like the lock).
   * Only days you haven't set already are touched. Returns the line to add to the evening message.
   */
  private officeDefaultForNextWeek(today: string): string {
    const db = doDb(this.ctx);
    const last = lastWeeksOfficeDays(db, addDays(today, 1));
    if (last.length === 0) return "🏢 Which days are you in the office this week? Reply e.g. <b>office tue thu</b>.";
    const places = officeWindow(addDays(today, 1), last).filter((p) => !loadDayRow(db, p.date)?.place);
    if (places.length > 0) applyOp(db, { type: "set_places", places }, { source: "system" });
    return `🏢 Office this week: <b>${weekdayNames(last)}</b>, same as last week. Reply e.g. <b>office mon wed</b> to change.`;
  }

  /** 21:30: recap today, draft tomorrow. */
  async jobEvening(_payload: string): Promise<void> {
    try {
      const db = doDb(this.ctx);
      const nowMs = Date.now();
      const today = dayKey(nowMs);
      closeIgnoredNudge(db, today, nowMs);
      const t = this.telegramAndChat();
      if (!t || this.isCurrentlySnoozed()) return;
      ensureDraft(db, addDays(today, 1), nowMs);

      // Two days without a word: ask once, then go quiet until you write (the day loop keeps running).
      if (shouldAskPause(db, nowMs)) {
        await t.telegram.sendMessage(t.chatId, pauseQuestion(db, nowMs), "HTML", PAUSE_BUTTONS);
        recordAgentMessage(db, "pause_check", nowMs);
        this.setSnooze(SILENT_MUTE_DAYS * 24, "silent");
        return;
      }

      const sunday = weekdayIndex(today) === 6;
      const officeLine = sunday ? this.officeDefaultForNextWeek(today) : "";
      const weekly = sunday ? `\n\n${renderWeekly(db, today)}` : "";
      await t.telegram.sendMessage(t.chatId, `${renderEvening(db, today)}${weekly}${officeLine ? `\n\n${officeLine}` : ""}`);
      recordEvent(db, "evening_recap", today, {}, nowMs);
      recordAgentMessage(db, "evening", nowMs);
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
      const db = doDb(this.ctx);
      lockDay(db, addDays(dayKey(nowMs), 1), "auto", nowMs);
      closeOpenSessions(db, dayKey(nowMs), nowMs);
      await this.mirror();
    } catch (err) {
      console.error("jobLock failed:", err);
    } finally {
      await this.ensureJobs();
    }
  }

  /** 18:00: one check-in on the first open gym/study item, only if the budget and quiet rules allow it. */
  async jobNudge(_payload: string): Promise<void> {
    try {
      const t = this.telegramAndChat();
      if (!t) return;
      const db = doDb(this.ctx);
      const nowMs = Date.now();
      const gate = nudgeGate(db, nowMs);
      if (!gate.ok) {
        console.log(`nudge skipped: ${gate.reason}`);
        return;
      }
      const item = pickNudge(db, dayKey(nowMs));
      if (!item) return;
      await t.telegram.sendMessage(t.chatId, nudgeText(item), "HTML", NUDGE_BUTTONS(item.id));
      recordNudgeSent(db, item, nowMs);
    } catch (err) {
      console.error("jobNudge failed:", err);
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
          "• <code>/office tue thu</code> - Office days for the coming week (others remote). On Sunday I keep last week's unless you change them.",
          "• <code>/sleep</code> - Last 7 nights. Say <b>good night</b> at bedtime and <b>up</b> when you wake.",
          "• <code>/undo</code> - Undo the last change",
          "• <code>/mirror</code> - Write yesterday/today/tomorrow to study-repo now (also happens at every lock)",
          "",
          "🏋️ <b>Gym</b>",
          "• Type sets as you go: <i>bench 20x15, 22.5x12, 25x8F</i> (kg × reps; <i>BWx20</i>, <i>30s</i>, <i>7kg</i>, <i>15 reps</i>; <i>(1m)</i> = rest). Voice works too.",
          "• Several messages make one session for the day. Fix one: <i>actually bench was 22.5x10</i>. Logging ticks off the gym item and moves the split on.",
          "• <code>/gym</code> - This week (lifts, mobility, protein) and the last session · <code>/gym yesterday</code>",
          "• <code>/lift bench</code> - Last few times and your best set",
          "• <i>protein 110</i> or <code>/protein 110</code> - Today's protein (I ask in the evening)",
          "",
          "📚 <b>Study &amp; reading</b>",
          "• <code>/tracks</code> - Where each study track is",
          "• <code>/books</code> - What you're reading and what to pick next",
          "• <code>/book add|start|keep|hold|done|drop</code> - Manage the shelf by id or title",
          "• While reading: <i>ch3: lag breaks read-your-writes</i> (a jot) · <i>on p140</i> · <i>finished ch3</i>. <code>/jots</code> shows them; they're also written to study/notes/&lt;book&gt;.md",
          "",
          "⏰ <b>Reminders &amp; other</b>",
          "• <i>remind me Friday 4pm to call the bank</i> · <i>every Monday 9am review the week</i> · <i>submit the form by Friday</i> (no time = on your list, no ping)",
          "• When one fires: ✅ Done · ⏰ 1h · 📅 Tomorrow. No answer → one repeat after 30 min, then it's in the evening recap.",
          "• <code>/reminders</code> · <code>/done &lt;id&gt;</code> · <code>/cancel &lt;id&gt;</code> (or <i>cancel the bank reminder</i>) · <code>/remind &lt;minutes&gt; &lt;text&gt;</code>",
          "• <code>/inbox</code> - Messages I wasn't sure about (<code>/inbox done &lt;id&gt;</code>)",
          "• <code>/snooze &lt;hours&gt;</code> · <code>/unsnooze</code> - Pause my messages (your reminders still fire)",
          "• <code>/week</code> - The week so far (Sunday's evening message has the full one) · <code>/nudges</code> - What I send on my own, <code>/nudges off</code>",
          "• <code>/jobs</code> · <code>/testcue evening|lock|morning|nudge</code> · <code>/status</code> · <code>/queue</code> · <code>/recent</code>",
          "",
          "💬 <b>Or just say it</b> (text or voice):",
          "• <i>done with gym</i> · <i>skip reading today</i> · <i>add call mom tomorrow</i> · <i>move DSA to Saturday</i>",
          "• <i>travelling Fri to Sun</i> · <i>down with a fever</i> · <i>feeling low today</i> · <i>office tue thu</i>",
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
          `• <b>Workouts:</b> ${stats.totalWorkouts}`,
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
        await telegram.sendMessage(chatId, `😴 <b>Paused</b> until <b>${untilDate} IST</b> (${hours}h). Reminders you set still fire.\n<i>/unsnooze to resume · /undo to reverse</i>`);
        break;
      }

      case "/unsnooze": {
        this.clearSnooze();
        await telegram.sendMessage(chatId, "🔔 My messages are back on.");
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
        await telegram.sendMessage(chatId, renderReminderList(doDb(this.ctx), Date.now()));
        break;
      }

      case "/done":
      case "/cancel": {
        const ref = args.join(" ").trim();
        const action = command === "/done" ? "done" : "cancel";
        if (!ref) {
          await telegram.sendMessage(chatId, `Usage: <code>${command} &lt;id&gt;</code> (ids are in /reminders), or <code>${command} bank</code>`);
          break;
        }
        const found = resolveReminder(doDb(this.ctx), ref);
        await telegram.sendMessage(chatId, "reply" in found ? found.reply : await this.closeReminder(found.reminder.id, action));
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
        // "/office tue thu": in the next 7 days those weekdays are office days, the others remote.
        const days = parseWeekdays(args.join(" "));
        if (!days) {
          await telegram.sendMessage(chatId, "Usage: <code>/office tue thu</code> (the days you'll be in the office). You can also just say <i>office tue thu</i>.");
          break;
        }
        await telegram.sendMessage(chatId, this.applyOfficeDays(days));
        break;
      }

      case "/jots": {
        const db = doDb(this.ctx);
        const ref = args.join(" ").trim();
        const sole = soleCurrentBook(db);
        const book = ref ? findBook(db, ref) : sole ? { id: sole.id, title: sole.title } : null;
        if (!book) {
          const any = booksWithJots(db);
          await telegram.sendMessage(chatId, any.length
            ? `📝 Jots on: ${any.map((b) => escapeHtml(b.title)).join(" · ")}\n<i>/jots &lt;part of the title&gt;</i>`
            : "📝 No jots yet. While reading, send <i>ch3: what struck you</i>.");
          break;
        }
        await telegram.sendMessage(chatId, "reply" in book ? book.reply : renderJots(db, book.id));
        break;
      }

      case "/nudges": {
        const db = doDb(this.ctx);
        const want = (args[0] ?? "").toLowerCase();
        if (want === "on" || want === "off") this.applyPlanOp({ type: "set_config", key: "nudges", value: want }, { source: "telegram" });
        await telegram.sendMessage(chatId, nudgeStatus(db, Date.now()));
        break;
      }

      case "/week": {
        const db = doDb(this.ctx);
        const today = dayKey(Date.now());
        // This week so far, or a full week when it's Sunday.
        await telegram.sendMessage(chatId, renderWeekly(db, addDays(today, 6 - weekdayIndex(today))));
        break;
      }

      case "/gym": {
        const db = doDb(this.ctx);
        const today = dayKey(Date.now());
        const when = (args[0] ?? "").toLowerCase();
        if (when === "yesterday" || when === "today") {
          await telegram.sendMessage(chatId, renderSession(db, when === "today" ? today : addDays(today, -1)));
          break;
        }
        await telegram.sendMessage(chatId, renderGymWeek(db, today));
        break;
      }

      case "/lift": {
        const name = args.join(" ").trim();
        if (!name) {
          await telegram.sendMessage(chatId, "Usage: <code>/lift bench</code> (the last few times and your best set)");
          break;
        }
        await telegram.sendMessage(chatId, renderLiftHistory(doDb(this.ctx), name));
        break;
      }

      case "/protein": {
        const grams = Number(args[0]);
        if (!Number.isFinite(grams) || grams <= 0 || grams > 400) {
          await telegram.sendMessage(chatId, "Usage: <code>/protein 110</code> (grams today). You can also just say <i>protein 110</i>.");
          break;
        }
        this.applyPlanOp({ type: "log_metric", date: dayKey(Date.now()), metric: "protein_g", value: Math.round(grams) }, { source: "telegram" });
        await telegram.sendMessage(chatId, `🥩 Protein today: <b>${Math.round(grams)} g</b>`);
        break;
      }

      case "/sleep": {
        const db = doDb(this.ctx);
        const today = dayKey(Date.now());
        const nights = sleepNights(db, addDays(today, -6), today);
        if (nights.length === 0) {
          await telegram.sendMessage(chatId, "😴 No nights recorded yet. Say <b>good night</b> when you go to bed and <b>up</b> when you wake.");
          break;
        }
        const avg = nights.reduce((x, n) => x + n.hours, 0) / nights.length;
        const lines = nights.map((n) => `• ${dateLabel(n.date)} — ${formatHours(n.hours)}`);
        await telegram.sendMessage(chatId, `😴 <b>Last 7 days</b>\n${lines.join("\n")}\n\nAverage ${formatHours(avg)} over ${nights.length} night${nights.length === 1 ? "" : "s"}.`);
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
        else if (target === "nudge") {
          const gate = nudgeGate(doDb(this.ctx), Date.now());
          if (!gate.ok) await telegram.sendMessage(chatId, `📣 No nudge right now: ${escapeHtml(gate.reason)}.`);
          else await this.jobNudge("manual-test");
        } else await telegram.sendMessage(chatId, "⚠️ <b>Usage:</b> <code>/testcue evening|lock|morning|nudge</code>");
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
   * model finished"). The same reminder twice is refused. Returns the confirmation text.
   */
  async scheduleReminderAt(dueMs: number, text: string, repeat?: string | null): Promise<string> {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    const dup = findDuplicate(db, text, { dueMs });
    if (dup) return `⏰ Already set: <b>${escapeHtml(dup.text)}</b>, ${formatWhen(dup.trigger_at, nowMs)} <code>#${dup.id}</code>`;
    const id = insertReminder(db, { text, dueMs, repeat }, nowMs);
    const due = getReminder(db, id)!.trigger_at;
    await this.schedule(new Date(due), "triggerReminder", JSON.stringify({ reminderId: id, dueMs: due }));
    const rep = repeat ? ` · ${describeRepeat(repeat)}` : "";
    return `⏰ <b>${escapeHtml(text)}</b>¶${formatWhen(due, nowMs)} <i>(${formatIn(due, nowMs)})</i>${rep}¶<i>/cancel ${id} to cancel</i>`;
  }

  /** A day with no time: no ping, it shows in the morning brief and the evening recap until done. */
  private addTask(text: string, dueDate: string): string {
    const db = doDb(this.ctx);
    const dup = findDuplicate(db, text, { dueDate });
    if (dup) return `📌 Already on your list: <b>${escapeHtml(dup.text)}</b> by ${dateLabel(dueDate)} <code>#${dup.id}</code>`;
    const id = insertReminder(db, { text, dueDate }, Date.now());
    return `📌 <b>${escapeHtml(text)}</b> by ${dateLabel(dueDate)}¶<i>It'll be in your morning brief and evening recap. /done ${id} when it's done.</i>`;
  }

  /** Done or cancelled: the row is closed and any alarm still waiting for it is removed. */
  private async closeReminder(id: number, action: "done" | "cancel"): Promise<string> {
    const db = doDb(this.ctx);
    const r = getReminder(db, id);
    if (!r || r.status === "done" || r.status === "cancelled") return `Reminder #${id} is already closed.`;
    if (action === "done") markDone(db, id, Date.now());
    else markCancelled(db, id);
    await this.cancelReminderAlarms(id);
    return action === "done" ? `✅ Done: <b>${escapeHtml(r.text)}</b>` : `🗑 Cancelled: <b>${escapeHtml(r.text)}</b>${r.repeat_rule ? ` (${describeRepeat(r.repeat_rule)})` : ""}`;
  }

  private async cancelReminderAlarms(id: number): Promise<void> {
    for (const sch of await this.listSchedules()) {
      if (sch.callback !== "triggerReminder" && sch.callback !== "reminderFollowup") continue;
      try {
        if (JSON.parse(String(sch.payload)).reminderId === id) await this.cancelSchedule(sch.id);
      } catch {}
    }
  }

  /**
   * Invoked by the scheduler when a reminder is due. It is marked sent only after Telegram accepts
   * it; a failed send throws, so the scheduler retries instead of silently dropping it.
   * Sent with Done / 1h / Tomorrow; a repeating one schedules its next firing.
   */
  async triggerReminder(payloadStr: string): Promise<void> {
    let payload: { reminderId?: number; text?: string; dueMs?: number };
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      console.error("Unreadable reminder payload:", payloadStr);
      return;
    }
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;
    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
    if (!payload.reminderId) {
      await telegram.sendMessage(chatId, `⏰ <b>Reminder:</b>¶¶${escapeHtml(payload.text ?? "Reminder")}`);
      return;
    }
    const db = doDb(this.ctx);
    const r = getReminder(db, payload.reminderId);
    if (!r || r.status !== "pending") return; // done, cancelled or already sent
    // Snoozed since this alarm was set: the newer alarm will fire it.
    if (payload.dueMs !== undefined && Math.abs(r.trigger_at - payload.dueMs) > 1000) return;

    const nowMs = Date.now();
    const messageId = await telegram.sendMessage(chatId, `⏰ <b>${escapeHtml(r.text)}</b>`, "HTML", REMINDER_BUTTONS(r.id));
    markFired(db, r.id, nowMs, messageId ?? null);
    await this.schedule(30 * 60, "reminderFollowup", JSON.stringify({ reminderId: r.id, firedAt: getReminder(db, r.id)!.fired_at }));

    if (r.repeat_rule) {
      const next = nextOccurrence(r.repeat_rule, r.trigger_at, nowMs);
      const id = insertReminder(db, { text: r.text, dueMs: next, repeat: r.repeat_rule }, nowMs);
      // The chain moves to the new row, so snoozing this one never starts a second chain.
      db.run("UPDATE reminders SET repeat_rule = NULL WHERE id = ?", r.id);
      await this.schedule(new Date(next), "triggerReminder", JSON.stringify({ reminderId: id, dueMs: next }));
    }
  }

  /** 30 minutes after firing with no answer: one repeat. After that it waits for the evening recap. */
  async reminderFollowup(payloadStr: string): Promise<void> {
    let payload: { reminderId: number; firedAt: string | null };
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return;
    }
    const db = doDb(this.ctx);
    const r = getReminder(db, payload.reminderId);
    if (!r || r.status !== "dispatched" || r.repeats > 0 || r.fired_at !== payload.firedAt) return;
    const chatId = this.env.USER_TELEGRAM_CHAT_ID;
    if (!chatId) return;
    const messageId = await new TelegramClient(this.env.TELEGRAM_BOT_TOKEN).sendMessage(
      chatId, `⏰ Still on: <b>${escapeHtml(r.text)}</b>`, "HTML", REMINDER_BUTTONS(r.id),
    );
    db.run("UPDATE reminders SET repeats = repeats + 1, message_id = COALESCE(?, message_id) WHERE id = ?", messageId ?? null, r.id);
  }

  // ─── Buttons ────────────────────────────────────────────────────────────────

  /** A tap on an inline button. Data is "<area>:<action>:<id>". */
  private async handleCallback(cq: any): Promise<void> {
    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);
    const chatId = String(cq.message?.chat?.id ?? cq.from?.id ?? "");
    if (this.env.USER_TELEGRAM_CHAT_ID && chatId !== this.env.USER_TELEGRAM_CHAT_ID) return;
    const [area, action, rawId] = String(cq.data ?? "").split(":");
    let result: { toast: string; text?: string } = { toast: "That button has expired." };
    try {
      if (area === "r") result = await this.reminderButton(action, Number(rawId));
      else result = await this.otherButton(area, action, rawId);
    } catch (err) {
      console.error("button failed:", err);
      result = { toast: "Something went wrong." };
    }
    await telegram.answerCallbackQuery(cq.id, result.toast);
    const messageId = cq.message?.message_id;
    if (messageId && result.text) await telegram.editMessageText(chatId, messageId, result.text).catch((e) => console.warn("edit failed:", e));
  }

  /** Done / Snooze 1h / Tomorrow on a fired reminder. Returns the toast and the message's new text (buttons removed). */
  private async reminderButton(action: string, id: number): Promise<{ toast: string; text?: string }> {
    const db = doDb(this.ctx);
    const r = getReminder(db, id);
    if (!r) return { toast: "That reminder is gone." };
    if (r.status === "done" || r.status === "cancelled") return { toast: `Already ${r.status}.`, text: `⏰ ${escapeHtml(r.text)}¶<i>${r.status}</i>` };
    const nowMs = Date.now();
    if (action === "done") {
      markDone(db, id, nowMs);
      await this.cancelReminderAlarms(id);
      return { toast: "Done ✅", text: `✅ <s>${escapeHtml(r.text)}</s>` };
    }
    if (action === "snooze" || action === "tmrw") {
      const due = action === "snooze" ? nowMs + 3600_000 : tomorrowAt(r, nowMs);
      await this.cancelReminderAlarms(id);
      reschedule(db, id, due);
      await this.schedule(new Date(due), "triggerReminder", JSON.stringify({ reminderId: id, dueMs: Math.round(due) }));
      return { toast: action === "snooze" ? "In 1 hour" : "Tomorrow", text: `⏰ ${escapeHtml(r.text)}¶<i>moved to ${formatWhen(due, nowMs)}</i>` };
    }
    return { toast: "That button has expired." };
  }

  /** Buttons that are not reminders: the check-in nudge (n:done|skip|later:<item>) and the pause question (p:resume|week). */
  private async otherButton(area: string, action: string, id: string): Promise<{ toast: string; text?: string }> {
    const db = doDb(this.ctx);
    const nowMs = Date.now();
    if (area === "n") {
      const itemId = Number(id);
      const item = loadItems(db, dayKey(nowMs)).find((i) => i.id === itemId);
      if (!item) return { toast: "That was for another day." };
      recordNudgeAnswer(db, nowMs, action, itemId);
      if (action === "later") return { toast: "OK", text: `${escapeHtml(item.title)}\n<i>Later. It'll be in the evening recap.</i>` };
      if (item.status !== "planned") return { toast: `Already ${item.status}.`, text: `${escapeHtml(item.title)}\n<i>${item.status}</i>` };
      const status = action === "done" ? "done" : "skipped";
      this.applyPlanOp({ type: "set_item_status", item_id: itemId, status }, { source: "telegram" });
      this.replanAfterChange(dayKey(nowMs));
      return { toast: status === "done" ? "Done ✅" : "Skipped", text: `${status === "done" ? "✅" : "⏭"} ${escapeHtml(item.title)}\n<i>/undo to reverse</i>` };
    }
    if (area === "p") {
      if (action === "resume") {
        this.clearSnooze();
        return { toast: "Back on", text: "👋 OK, I'll keep going. Talk soon." };
      }
      if (action === "week") {
        this.setSnooze(7 * 24, "paused a week");
        return { toast: "Paused", text: "😴 Paused for a week. Your plan still locks itself and reminders still fire. /unsnooze any time." };
      }
    }
    return { toast: "That button has expired." };
  }

  /** The quiet after "pause or keep going?" lasts only until you write again. */
  private endSilentQuiet(): void {
    const db = doDb(this.ctx);
    try {
      const m = JSON.parse(getConfig(db, "mute", "{}")) as { until?: number; reason?: string };
      if (m.reason === "silent" && m.until && m.until > Date.now()) {
        db.run("UPDATE config SET value = ? WHERE key = 'mute'", JSON.stringify({ until: 0 }));
      }
    } catch {}
  }
}
