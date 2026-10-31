// Real model backends behind infer(). Gemini first (stronger structured output, native audio),
// Workers AI as the fallback (stays inside Cloudflare). Model names come from config.

import type { InferBackend, JsonSchema } from "../infer.ts";

const TIMEOUT_MS = 25_000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(binary);
}

/** Each model has its own free daily quota, so GEMINI_MODEL is an ordered, comma-separated list. */
export function geminiModels(env: Env): string[] {
  const list = String(env.GEMINI_MODEL || "gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length > 0 ? list : ["gemini-3.5-flash-lite"];
}

/** "429 quota 20/day (gemini-2.5-flash)" instead of a wall of JSON. */
function describeError(status: number, body: string): string {
  try {
    const err = (JSON.parse(body) as { error?: { message?: string; details?: { violations?: { quotaId?: string; quotaValue?: string }[] }[] } }).error;
    const v = err?.details?.flatMap((d) => d.violations ?? [])[0];
    if (v?.quotaId) return `HTTP ${status} quota ${v.quotaValue ?? "?"} (${v.quotaId})`;
    return `HTTP ${status}: ${(err?.message ?? body).slice(0, 160)}`;
  } catch {
    return `HTTP ${status}: ${body.slice(0, 160)}`;
  }
}

export class GeminiBackend implements InferBackend {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.name = `gemini:${model}`;
  }

  private async call(body: unknown): Promise<string> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${this.name} ${describeError(res.status, await res.text())}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned an empty answer");
    return text;
  }

  async json(req: { system: string; user: string; schema: JsonSchema }): Promise<unknown> {
    const text = await this.call({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: req.schema, temperature: 0.1 },
    });
    return JSON.parse(text);
  }

  async transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
    const text = await this.call({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: arrayBufferToBase64(audio) } },
            { text: "Transcribe this voice memo verbatim. Output only the transcript, nothing else." },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    });
    return text.trim();
  }
}

/** Runs a Workers AI model. In the Worker it is the AI binding; scripts can pass the REST API instead. */
export type AiRunner = (model: string, input: Record<string, unknown>) => Promise<unknown>;

export class WorkersAiBackend implements InferBackend {
  readonly name = "workers-ai";
  private readonly run: AiRunner;
  private readonly model: string;

  constructor(run: AiRunner, model = "@cf/meta/llama-3.3-70b-instruct") {
    this.run = run;
    this.model = model;
  }

  static fromEnv(env: Env): WorkersAiBackend {
    return new WorkersAiBackend((m, input) => env.AI.run(m as any, input as any) as Promise<unknown>, env.LLAMA_MODEL || undefined);
  }

  async json(req: { system: string; user: string; schema: JsonSchema }): Promise<unknown> {
    // Llama has no response schema: describe the shape in the prompt and ask for bare JSON.
    const system = `${req.system}\n\nReply with a single JSON object matching this JSON schema and nothing else:\n${JSON.stringify(req.schema)}`;
    const out = (await this.run(this.model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
    })) as { response?: unknown; text?: string };

    // Some models return the object already parsed.
    if (typeof out?.response === "object" && out.response !== null) return out.response;
    const text = String(out?.response ?? out?.text ?? "");
    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
    }
  }

  async transcribe(audio: ArrayBuffer): Promise<string> {
    const r = (await this.run("@cf/openai/whisper", { audio: [...new Uint8Array(audio)] })) as { text?: string };
    return r?.text?.trim() ?? "";
  }
}

const useGemini = (env: Env) => (env.LLM_PROVIDER as string) !== "cloudflare" && !!env.GEMINI_API_KEY;

/**
 * Ordered by preference: every configured Gemini model (each with its own free quota), then
 * Workers AI. infer() moves down the list on any error, including a 429.
 * LLM_PROVIDER=cloudflare forces Workers AI only.
 */
export function buildBackends(env: Env): InferBackend[] {
  const workers = WorkersAiBackend.fromEnv(env);
  if (!useGemini(env)) return [workers];
  return [...geminiModels(env).map((m) => new GeminiBackend(env.GEMINI_API_KEY, m)), workers];
}

/** Voice -> text. Gemini hears audio natively (each model in turn); Whisper is the fallback. Returns "" if all fail. */
export async function transcribe(env: Env, audio: ArrayBuffer, mimeType: string): Promise<string> {
  if (useGemini(env)) {
    for (const model of geminiModels(env)) {
      try {
        const t = await new GeminiBackend(env.GEMINI_API_KEY, model).transcribe(audio, mimeType);
        if (t) return t;
      } catch (err) {
        console.warn(`Gemini transcription failed on ${model}:`, err);
      }
    }
  }
  try {
    return await WorkersAiBackend.fromEnv(env).transcribe(audio);
  } catch (err) {
    console.error("Whisper transcription failed:", err);
    return "";
  }
}
