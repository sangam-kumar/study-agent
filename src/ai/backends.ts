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

export class GeminiBackend implements InferBackend {
  readonly name = "gemini";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(env: Env) {
    this.apiKey = env.GEMINI_API_KEY;
    this.model = env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  private async call(body: unknown): Promise<string> {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

export class WorkersAiBackend implements InferBackend {
  readonly name = "workers-ai";
  private readonly model: string;

  constructor(private readonly env: Env) {
    this.model = env.LLAMA_MODEL || "@cf/meta/llama-3.3-70b-instruct";
  }

  async json(req: { system: string; user: string; schema: JsonSchema }): Promise<unknown> {
    // Llama has no response schema: describe the shape in the prompt and ask for bare JSON.
    const system = `${req.system}\n\nReply with a single JSON object matching this JSON schema and nothing else:\n${JSON.stringify(req.schema)}`;
    const out = (await this.env.AI.run(this.model as any, {
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
    const r = (await this.env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(audio)] })) as { text?: string };
    return r?.text?.trim() ?? "";
  }
}

/** Ordered by preference. LLM_PROVIDER=cloudflare forces Workers AI only. */
export function buildBackends(env: Env): InferBackend[] {
  const workers = new WorkersAiBackend(env);
  if ((env.LLM_PROVIDER as string) === "cloudflare" || !env.GEMINI_API_KEY) return [workers];
  return [new GeminiBackend(env), workers];
}

/** Voice -> text. Gemini hears audio natively; Whisper is the fallback. Returns "" if both fail. */
export async function transcribe(env: Env, audio: ArrayBuffer, mimeType: string): Promise<string> {
  if ((env.LLM_PROVIDER as string) !== "cloudflare" && env.GEMINI_API_KEY) {
    try {
      const t = await new GeminiBackend(env).transcribe(audio, mimeType);
      if (t) return t;
    } catch (err) {
      console.warn("Gemini transcription failed, falling back to Whisper:", err);
    }
  }
  try {
    return await new WorkersAiBackend(env).transcribe(audio);
  } catch (err) {
    console.error("Whisper transcription failed:", err);
    return "";
  }
}
