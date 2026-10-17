import {
  LLMProvider,
  TextParseResult,
  AudioProcessingResult,
  UrlClassification,
} from "./schemas";
import { GeminiProvider } from "./gemini";
import { WorkersAIProvider } from "./workers-ai";

export class FallbackLLMProvider implements LLMProvider {
  private gemini: GeminiProvider;
  private workersAi: WorkersAIProvider;

  constructor(private env: Env) {
    this.gemini = new GeminiProvider(env);
    this.workersAi = new WorkersAIProvider(env);
  }

  async parseText(text: string): Promise<TextParseResult> {
    try {
      if (this.env.GEMINI_API_KEY) {
        return await this.gemini.parseText(text);
      }
    } catch (err) {
      console.warn("Gemini parseText failed, falling back to Workers AI:", err);
    }
    return await this.workersAi.parseText(text);
  }

  async processAudio(audioBuffer: ArrayBuffer, mimeType?: string): Promise<AudioProcessingResult> {
    try {
      if (this.env.GEMINI_API_KEY) {
        return await this.gemini.processAudio(audioBuffer, mimeType);
      }
    } catch (err) {
      console.warn("Gemini processAudio failed, falling back to Workers AI:", err);
    }
    return await this.workersAi.processAudio(audioBuffer);
  }

  async classifyUrlContent(title: string, content: string): Promise<UrlClassification> {
    try {
      if (this.env.GEMINI_API_KEY) {
        return await this.gemini.classifyUrlContent(title, content);
      }
    } catch (err) {
      console.warn("Gemini classifyUrlContent failed, falling back to Workers AI:", err);
    }
    return await this.workersAi.classifyUrlContent(title, content);
  }
}

export function getLLMProvider(env: Env): LLMProvider {
  const provider = (env.LLM_PROVIDER as string) || "gemini";
  if (provider === "cloudflare") {
    return new WorkersAIProvider(env);
  }
  return new FallbackLLMProvider(env);
}

export * from "./schemas";
export type { LLMProvider } from "./schemas";

