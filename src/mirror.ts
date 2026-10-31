// Mirrors the day plans into study-repo's daily notes (spec §14, Phase 12).
//
//   daily/<year>/<MonthName>/DD-MM-YYYY.md   (the repo's existing convention)
//
// The agent owns ONE marked block per note; everything outside it is yours and is preserved.
// Only days whose block changed since the last successful mirror are written, so re-running
// with nothing new makes no commit. A failed commit records nothing, so the next run retries.

import type { Db } from "./db/db.ts";
import { loadDayRow, loadItems } from "./day.ts";
import type { GitHubClient, CommitResult } from "./github/client.ts";
import { dateLabel } from "./time.ts";

export const BLOCK_START = "<!-- study-agent:start (written by the study agent; edit outside this block) -->";
export const BLOCK_END = "<!-- study-agent:end -->";
const START_RE = /<!-- study-agent:start[^>]*-->/;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function dailyPath(date: string): string {
  const [y, m, d] = date.split("-");
  return `daily/${y}/${MONTHS[Number(m) - 1]}/${d}-${m}-${y}.md`;
}

/** FNV-1a: cheap, stable change detection (not security). */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const OVERRIDE_LABEL: Record<string, string> = { TRAVEL: "travelling", SICK: "sick", OUT: "out", LOW_MOOD: "low day" };

/** The markdown block for a date, or null when the date has no plan. */
export function renderDailyBlock(db: Db, date: string): string | null {
  const row = loadDayRow(db, date);
  if (!row) return null;
  const items = loadItems(db, date);
  const overrides = db
    .all<{ type: string }>("SELECT type FROM override WHERE revoked_at IS NULL AND start_date <= ? AND end_date >= ?", date, date)
    .map((o) => OVERRIDE_LABEL[o.type] ?? o.type.toLowerCase());

  const meta = [row.status === "locked" ? `locked${row.locked_by ? ` (${row.locked_by === "auto" ? "auto" : "by you"})` : ""}` : "draft"];
  if (row.place) meta.push(row.place === "OFFICE" ? "office" : "remote");
  if (row.wake_by) meta.push(`up by ${row.wake_by}`);
  meta.push(...overrides);

  const lines = items.map((i) => {
    const mins = i.est_min ? ` · ${i.est_min} min` : "";
    const opt = i.optional ? " · optional" : "";
    if (i.status === "done") return `- [x] ${i.title}${mins}${opt}`;
    if (i.status === "skipped" || i.status === "dropped") return `- [ ] ~~${i.title}~~ — ${i.status}`;
    return `- [ ] ${i.title}${mins}${opt}`;
  });

  return [BLOCK_START, `## Plan — ${dateLabel(date)}`, `_${meta.join(" · ")}_`, "", ...(lines.length ? lines : ["- Nothing planned."]), BLOCK_END].join("\n");
}

/** Puts the block into a note: replaces the old block, or adds it under the title, or starts a new note. */
export function mergeIntoNote(existing: string | null, date: string, block: string): string {
  const [y, m, d] = date.split("-");
  if (existing === null || existing.trim() === "") return `# ${d}-${m}-${y}\n\n${block}\n\n## Notes\n`;
  const start = existing.search(START_RE);
  const end = existing.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  const lines = existing.split("\n");
  if (lines[0].startsWith("# ")) return [lines[0], "", block, "", ...lines.slice(1)].join("\n").replace(/\n{3,}/g, "\n\n");
  return `${block}\n\n${existing}`;
}

export interface MirrorResult {
  committed: boolean;
  paths: string[];
  sha?: string;
}

/** Writes the changed days among `dates` in one commit and remembers what was written. */
export async function mirrorDays(db: Db, gh: Pick<GitHubClient, "commit">, dates: string[], nowMs: number): Promise<MirrorResult> {
  const pending: { date: string; path: string; block: string; hash: string }[] = [];
  for (const date of dates) {
    const block = renderDailyBlock(db, date);
    if (!block) continue;
    const path = dailyPath(date);
    const hash = contentHash(block);
    const last = db.all<{ hash: string }>("SELECT hash FROM mirror_state WHERE path = ?", path)[0]?.hash;
    if (last !== hash) pending.push({ date, path, block, hash });
  }
  if (pending.length === 0) return { committed: false, paths: [] };

  const result: CommitResult = await gh.commit(async (read) => {
    const files = [];
    for (const p of pending) {
      const before = await read(p.path);
      const after = mergeIntoNote(before, p.date, p.block);
      if (after !== before) files.push({ path: p.path, content: after });
    }
    const message = `daily: ${pending.map((p) => dateLabel(p.date)).join(", ")} [study-agent]`;
    return { message, files };
  });

  const ts = new Date(nowMs).toISOString();
  db.transaction(() => {
    for (const p of pending) {
      db.run(
        "INSERT INTO mirror_state (path, hash, committed_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, committed_at = excluded.committed_at",
        p.path, p.hash, ts,
      );
    }
  });
  return result.committed ? { committed: true, paths: result.paths, sha: result.sha } : { committed: false, paths: [] };
}
