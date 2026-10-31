import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/github/client.ts";
import { applyOp } from "../src/ops.ts";
import { ensureDraft, loadItems, lockDay } from "../src/day.ts";
import { BLOCK_END, dailyPath, mergeIntoNote, mirrorDays, renderDailyBlock } from "../src/mirror.ts";
import { loadConfigSeed } from "../src/seed-config.ts";
import { loadStudySeed } from "../src/seed.ts";
import { istWallToMs } from "../src/time.ts";
import { migratedDb } from "./helpers.ts";

const MON = "2026-11-02";
const TUE = "2026-11-03";
const nowMs = istWallToMs(MON, "23:00");
const now = () => new Date(nowMs);

// ------------------------------------------------------------- a tiny fake GitHub

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function fakeGitHub(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  let head = "c0";
  let n = 0;
  const trees = new Map<string, { path: string; content: string }[]>();
  const commits = new Map<string, string>(); // commit -> tree
  const state = { files, commitsMade: 0, calls: 0, raceOnce: false };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    state.calls++;
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/me\/study-repo/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (method === "GET" && path === "/git/ref/heads/master") return json({ object: { sha: head } });
    if (method === "GET" && path.startsWith("/contents/")) {
      const p = decodeURIComponent(path.slice("/contents/".length));
      return files.has(p) ? json({ content: b64(files.get(p)!), encoding: "base64" }) : json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && path.startsWith("/git/commits/")) return json({ tree: { sha: `t-${path.split("/").pop()}` } });
    if (method === "POST" && path === "/git/trees") {
      const sha = `tree-${++n}`;
      trees.set(sha, body.tree);
      return json({ sha });
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = `c-${++n}`;
      commits.set(sha, body.tree);
      return json({ sha });
    }
    if (method === "PATCH" && path === "/git/refs/heads/master") {
      if (state.raceOnce) {
        // Someone (the repo's own Actions) committed in between: the branch moved.
        state.raceOnce = false;
        head = `other-${++n}`;
        files.set("tracker/progress.json", "{}");
        return json({ message: "Update is not a fast forward" }, 422);
      }
      for (const f of trees.get(commits.get(body.sha)!)!) files.set(f.path, f.content);
      head = body.sha;
      state.commitsMade++;
      return json({ object: { sha: head } });
    }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  };
  return { state, client: new GitHubClient("token", "me/study-repo", "master", fetchImpl) };
}

// ------------------------------------------------------------- a planned world

function world() {
  const db = migratedDb();
  loadConfigSeed(db, {
    pattern: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, kind: weekday === 0 ? "GYM" : "REST" })),
    rotation: [{ lane: "fitness", ordinal: 1, label: "Chest / Triceps" }, { lane: "fitness", ordinal: 2, label: "Back / Biceps" }],
  }, now);
  loadStudySeed(db, {
    tracks: [{ id: "i", title: "Interview", lane: "study", lists: [{ id: "dsa", title: "DSA", units: [{ ordinal: 1, title: "Two Sum" }, { ordinal: 2, title: "3Sum" }] }] }],
  }, now);
  lockDay(db, MON, "auto", nowMs);
  ensureDraft(db, TUE, nowMs);
  return db;
}

// ------------------------------------------------------------------------ tests

test("daily notes follow the repo's existing path convention", () => {
  assert.equal(dailyPath("2026-11-02"), "daily/2026/November/02-11-2026.md");
  assert.equal(dailyPath("2026-07-13"), "daily/2026/July/13-07-2026.md");
});

test("the block shows statuses as a checklist", () => {
  const db = world();
  const [gym, dsa] = loadItems(db, MON);
  applyOp(db, { type: "set_item_status", item_id: gym.id, status: "done" }, { now });
  applyOp(db, { type: "set_item_status", item_id: dsa.id, status: "skipped" }, { now });
  const block = renderDailyBlock(db, MON)!;
  assert.match(block, /## Plan — Mon 2 Nov/);
  assert.match(block, /_locked \(auto\) · up by 07:00_/);
  assert.match(block, /- \[x\] Gym: Chest \/ Triceps · 105 min/);
  assert.match(block, /- \[ \] ~~DSA: Two Sum~~ — skipped/);
  assert.equal(renderDailyBlock(db, "2026-12-25"), null, "no plan, no block");
});

test("merging keeps everything you wrote and is idempotent", () => {
  const block = `<!-- study-agent:start (x) -->\nPLAN\n${BLOCK_END}`;
  const fresh = mergeIntoNote(null, MON, block);
  assert.equal(fresh, `# 02-11-2026\n\n${block}\n\n## Notes\n`);
  const mine = "# 02-11-2026\n## Tasks\n- [ ] my own task\n\n## Notes\nwrote this myself\n";
  const merged = mergeIntoNote(mine, MON, block);
  assert.match(merged, /^# 02-11-2026\n\n<!-- study-agent:start/);
  assert.ok(merged.includes("- [ ] my own task") && merged.includes("wrote this myself"));
  const block2 = block.replace("PLAN", "PLAN v2");
  const again = mergeIntoNote(merged, MON, block2);
  assert.ok(again.includes("PLAN v2") && !again.includes("PLAN\n"), "the old block is replaced, not duplicated");
  assert.equal(mergeIntoNote(again, MON, block2), again, "idempotent");
  assert.ok(again.includes("wrote this myself"));
});

test("client: one commit for several files, UTF-8 safe, missing files read as null", async () => {
  const { state, client } = fakeGitHub({ "a.md": "café ☕ — ok" });
  const seen: (string | null)[] = [];
  const r = await client.commit(async (read) => {
    seen.push(await read("a.md"), await read("missing.md"));
    return { message: "m", files: [{ path: "a.md", content: "naïve 🏋️" }, { path: "b.md", content: "new" }] };
  });
  assert.deepEqual(seen, ["café ☕ — ok", null]);
  assert.equal(r.committed, true);
  assert.equal(state.commitsMade, 1);
  assert.equal(state.files.get("a.md"), "naïve 🏋️");
  assert.equal(state.files.get("b.md"), "new");
});

test("client: when the branch moves underneath, it rebuilds on the new head and retries", async () => {
  const { state, client } = fakeGitHub();
  state.raceOnce = true;
  let builds = 0;
  const r = await client.commit(async () => {
    builds++;
    return { message: "m", files: [{ path: "x.md", content: "x" }] };
  });
  assert.equal(r.committed, true);
  assert.equal(builds, 2);
  assert.equal(state.files.get("tracker/progress.json"), "{}", "the other commit is kept");
  assert.equal(state.files.get("x.md"), "x");
});

test("client: nothing to write makes no commit", async () => {
  const { state, client } = fakeGitHub();
  assert.deepEqual(await client.commit(async () => null), { committed: false });
  assert.equal(state.commitsMade, 0);
});

test("mirror: both days in one commit, then nothing until something changes, then only that day", async () => {
  const db = world();
  const { state, client } = fakeGitHub({ [dailyPath(MON)]: "# 02-11-2026\n## Notes\nmine\n" });

  const first = await mirrorDays(db, client, [MON, TUE], nowMs);
  assert.equal(first.committed, true);
  assert.deepEqual(first.paths.sort(), [dailyPath(MON), dailyPath(TUE)].sort());
  assert.equal(state.commitsMade, 1);
  assert.ok(state.files.get(dailyPath(MON))!.includes("mine"), "your note survives");
  assert.ok(state.files.get(dailyPath(TUE))!.startsWith("# 03-11-2026"));

  const callsBefore = state.calls;
  const second = await mirrorDays(db, client, [MON, TUE], nowMs);
  assert.deepEqual(second, { committed: false, paths: [] });
  assert.equal(state.calls, callsBefore, "no change: GitHub is not even contacted");

  const gym = loadItems(db, MON).find((i) => i.lane === "fitness")!;
  applyOp(db, { type: "set_item_status", item_id: gym.id, status: "done" }, { now });
  const third = await mirrorDays(db, client, [MON, TUE], nowMs);
  assert.deepEqual(third.paths, [dailyPath(MON)], "only the changed day");
  assert.match(state.files.get(dailyPath(MON))!, /- \[x\] Gym/);
  assert.equal(state.commitsMade, 2);
});

test("mirror: a failed commit records nothing, so the next run retries", async () => {
  const db = world();
  const failing = { commit: async () => { throw new Error("GitHub update branch failed [500]"); } };
  await assert.rejects(() => mirrorDays(db, failing, [MON], nowMs));
  const { state, client } = fakeGitHub();
  const r = await mirrorDays(db, client, [MON], nowMs);
  assert.equal(r.committed, true);
  assert.equal(state.commitsMade, 1);
});
