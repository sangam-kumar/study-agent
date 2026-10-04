// Secrets that augment the generated global Env interface from worker-configuration.d.ts.
// wrangler.jsonc vars (LLM_PROVIDER, GEMINI_MODEL, etc.) are in the generated file.
// These secrets are set via `wrangler secret put` and never appear in wrangler.jsonc.
declare global {
  interface Env {
    GEMINI_API_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_SECRET_TOKEN: string;
    USER_TELEGRAM_CHAT_ID: string;
    GITHUB_PAT: string;
  }
}

export interface MediaIngestionParams {
  url: string;
  chatId: number;
}
