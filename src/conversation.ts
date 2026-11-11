// The block of context that lets the model read a short message ("ok", "both", "yes") against what it answers:
// the message you swipe-replied to, the last few messages, and any question the bot is waiting on.

import { byTgId, plain, recent } from "./chatlog.ts";
import type { ChatRow } from "./chatlog.ts";
import type { Db } from "./db/db.ts";
import { getPending } from "./convo.ts";
import type { Pending } from "./convo.ts";

const IST_MS = 330 * 60_000;
const hhmm = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(11, 16);

const line = (r: ChatRow) => `  [${r.dir === "out" ? `bot ${hhmm(r.ts)}${r.tag ? ` ${r.tag}` : ""}` : `you ${hhmm(r.ts)}`}] ${plain(r.text)}`;

function describePending(p: Pending): string {
  switch (p.kind) {
    case "choose_item":
      return `Open question (which plan item to ${p.action}): ${p.options.map((o, i) => `${i + 1}. ${plain(o.title, 80)}`).join("  ")}`;
    case "confirm_exercise":
      return `Open question (is this the exercise?): ${p.asked.map((a) => `"${plain(a.typed, 40)}" = "${plain(a.suggestion, 40)}"?`).join("  ")}`;
    case "repeat_workout":
      return "Open question: the same workout is already logged; log it again?";
  }
}

export interface ConversationOpts {
  /** The message the user swipe-replied to, as Telegram sent it. */
  replyTo?: { tgId: number; text: string } | null;
  /** The log row of the message being understood, left out of "Recent". */
  excludeLogId?: number | null;
}

/** Empty string when there is nothing to show. */
export function buildConversation(db: Db, nowMs: number, opts: ConversationOpts = {}): string {
  const out: string[] = [];
  if (opts.replyTo) {
    const known = byTgId(db, opts.replyTo.tgId);
    const text = known?.text ?? opts.replyTo.text;
    if (text) out.push(`Replying to${known?.tag ? ` [bot ${known.tag}]` : known ? " [bot]" : ""}: "${plain(text, 400)}"`);
  }
  const rows = recent(db, nowMs, { excludeId: opts.excludeLogId ?? undefined });
  if (rows.length > 0) out.push(`Recent:\n${rows.map(line).join("\n")}`);
  const pending = getPending(db, nowMs);
  if (pending) out.push(describePending(pending));
  return out.length > 0 ? `Conversation:\n${out.join("\n")}` : "";
}
