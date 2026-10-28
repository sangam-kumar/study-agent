import { routeAgentRequest, getAgentByName } from "agents";

import { StudyAgent } from "./agent";
import { isAdminAuthorized } from "./admin";

// Export classes bound in wrangler.jsonc
export { StudyAgent };
export { MediaIngestionWorkflow } from "./workflows/media-ingestion";

const MAX_SEED_BYTES = 5_000_000;

/** Null when the caller may proceed; otherwise the response to send. */
async function adminGuard(request: Request, env: Env): Promise<Response | null> {
  if (!env.ADMIN_TOKEN) {
    return Response.json({ ok: false, error: "admin disabled: ADMIN_TOKEN is not set" }, { status: 503 });
  }
  if (!(await isAdminAuthorized(request.headers.get("Authorization"), env.ADMIN_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Let SDK handle /agents/* routes (admin UI, WebSocket, etc.)
    if (url.pathname.startsWith("/agents/")) {
      return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
    }

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "study-agent",
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Telegram webhook endpoint
    if (url.pathname === "/webhook/telegram") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (env.TELEGRAM_SECRET_TOKEN) {
        // Production: enforce the secret header
        if (secretToken !== env.TELEGRAM_SECRET_TOKEN) {
          return new Response("Unauthorized", { status: 401 });
        }
      } else {
        // Local dev: secret not configured — warn and allow through
        console.warn("[dev] TELEGRAM_SECRET_TOKEN not set — skipping webhook auth");
      }

      // Forward to the Durable Object Agent via RPC
      const agent = await getAgentByName<Env, StudyAgent>(env.STUDY_AGENT, "singleton");
      const update = await request.json();
      
      // Process asynchronously so we can quickly ack the webhook
      ctx.waitUntil(agent.handleTelegramUpdate(update));

      return new Response(JSON.stringify({ ok: true, status: "acknowledged" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin: load reviewed seed JSON (study-repo/scripts/seed_*.py -> seed/*.json)
    if (url.pathname === "/admin/seed") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const denied = await adminGuard(request, env);
      if (denied) return denied;

      const body = await request.text();
      if (body.length > MAX_SEED_BYTES) {
        return Response.json({ ok: false, error: `body larger than ${MAX_SEED_BYTES} bytes` }, { status: 413 });
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return Response.json({ ok: false, error: "body is not valid JSON" }, { status: 400 });
      }

      const kind = url.searchParams.get("kind") ?? "study";
      const agent = await getAgentByName<Env, StudyAgent>(env.STUDY_AGENT, "singleton");
      const result = await agent.loadSeed(kind, json);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    // Admin: clear test data. Dry run unless confirm=yes.  POST /admin/reset?scope=logs,workouts&confirm=yes
    if (url.pathname === "/admin/reset") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      const denied = await adminGuard(request, env);
      if (denied) return denied;

      const agent = await getAgentByName<Env, StudyAgent>(env.STUDY_AGENT, "singleton");
      const result = await agent.resetData(url.searchParams.get("scope") ?? "", url.searchParams.get("confirm") === "yes");
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
