// Export classes bound in wrangler.jsonc
export { StudyAgent } from "./agent";
export { MediaIngestionWorkflow } from "./workflows/media-ingestion";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

    // Telegram webhook endpoint stub (implemented in Phase 2)
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

      return new Response(JSON.stringify({ ok: true, status: "stub_acknowledged" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
