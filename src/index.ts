import { routeAgentRequest, getAgentByName } from "agents";

// Export classes bound in wrangler.jsonc
export { StudyAgent } from "./agent";
export { MediaIngestionWorkflow } from "./workflows/media-ingestion";

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
      const agent = await getAgentByName(env.STUDY_AGENT, "singleton");
      const update = await request.json();
      
      // Process asynchronously so we can quickly ack the webhook
      ctx.waitUntil(agent.handleTelegramUpdate(update));

      return new Response(JSON.stringify({ ok: true, status: "acknowledged" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
