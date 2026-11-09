// Pulls the read-only views (Phase 15) from a running agent into files or the terminal.
//
//   npm run export -- --url https://study-agent.<you>.workers.dev --view sessions --from 2026-11-01 --to 2026-11-09
//   npm run export -- --url https://... --view messages --from 2026-11-05 --json
//   npm run export -- --url https://... --all --from 2026-11-01        # every view into exports/<date>/<view>.csv
//
// ADMIN_TOKEN comes from the environment or .dev.vars and is never printed. --url defaults to
// STUDY_AGENT_URL, then http://localhost:8787 (npm run dev). exports/ is gitignored: it holds personal data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function adminToken(): string {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  if (existsSync(".dev.vars")) {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const m = /^ADMIN_TOKEN=(.*)$/.exec(line.trim());
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return fail("No ADMIN_TOKEN: set it in the environment or in .dev.vars.");
}

const base = (opt("url") ?? process.env.STUDY_AGENT_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const token = adminToken();

async function get(path: string, query: Record<string, string>): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(`${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

const filters = (accepts: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of accepts) {
    const v = opt(key);
    if (v !== undefined) out[key] = v;
  }
  return out;
};

if (flag("all")) {
  const { views } = (await (await get("/admin/view", {})).json()) as { views: { name: string; params: string[] }[] };
  const dir = join("exports", new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  for (const v of views) {
    // Only the filters a view accepts are sent, so --from does not break views that have no dates.
    const query = { limit: "1000", ...filters(v.params), format: "csv" };
    const csv = await (await get(`/admin/view/${v.name}`, query)).text();
    writeFileSync(join(dir, `${v.name}.csv`), csv);
    console.log(`${v.name.padEnd(10)} ~${Math.max(0, csv.split("\n").length - 2)} rows ->${join(dir, `${v.name}.csv`)}`);
  }
} else {
  const view = opt("view");
  if (!view) fail("Usage: npm run export -- --view <name> [--from D] [--to D] [--limit N] [--json]   |   --all   (--url <worker>)");
  const known = ["from", "to", "limit", "type", "status", "state", "metric"];
  const res = await get(`/admin/view/${view}`, { ...filters(known), format: flag("json") ? "json" : "csv" });
  process.stdout.write(flag("json") ? JSON.stringify(await res.json(), null, 2) + "\n" : await res.text());
}
