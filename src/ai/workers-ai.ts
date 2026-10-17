import {
  LLMProvider,
  TextParseResult,
  AudioProcessingResult,
  UrlClassification,
} from "./schemas";

export class WorkersAIProvider implements LLMProvider {
  private llamaModel: string;

  constructor(private env: Env) {
    this.llamaModel = env.LLAMA_MODEL || "@cf/meta/llama-3.3-70b-instruct";
  }

  private async generateJson(systemPrompt: string, userPrompt: string): Promise<any> {
    const response = (await this.env.AI.run(this.llamaModel as any, {
      messages: [
        { role: "system", content: `${systemPrompt} Output valid JSON only, without markdown fences or extraneous text.` },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    })) as any;

    const responseText = response?.response ?? response?.text ?? "";
    try {
      return JSON.parse(responseText);
    } catch {
      // Clean potential markdown blocks
      const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleaned);
    }
  }

  async parseText(text: string): Promise<TextParseResult> {
    const systemPrompt = `You are an AI assistant parsing user inputs for a personal tracking system.
Determine intent from: ["workout_log", "study_note", "snooze", "general"].
Return JSON with format:
{
  "intent": "workout_log" | "study_note" | "snooze" | "general",
  "workout": { "workout_type": string, "exercises": [{ "name": string, "sets": number, "reps": number, "weight_kg": number }], "notes": string },
  "snooze": { "action": "snooze" | "cancel" | "skip_day", "duration_hours": number, "reason": string },
  "note": { "topic": string, "summary": string, "key_takeaways": string[] },
  "replyText": "short user-facing reply"
}`;

    return await this.generateJson(systemPrompt, `User message: ${text}`);
  }

  async processAudio(audioBuffer: ArrayBuffer): Promise<AudioProcessingResult> {
    // 1. Transcribe with Whisper on Workers AI
    const whisperResult = (await this.env.AI.run("@cf/openai/whisper", {
      audio: [...new Uint8Array(audioBuffer)],
    })) as { text?: string };

    const transcript = whisperResult?.text?.trim() ?? "";

    if (!transcript) {
      return {
        transcript: "",
        intent: "general",
      };
    }

    // 2. Parse the transcript with Llama 3.3
    const parsed = await this.parseText(transcript);
    return {
      transcript,
      intent: parsed.intent === "snooze" ? "general" : parsed.intent,
      workout: parsed.workout,
      note: parsed.note,
    };
  }

  async classifyUrlContent(title: string, content: string): Promise<UrlClassification> {
    const systemPrompt = `Classify this reading material into one of: ["eng", "watch", "design", "cs", "ml", "general"].
Return JSON with format:
{
  "category": "eng" | "watch" | "design" | "cs" | "ml" | "general",
  "estimated_minutes": number,
  "title": string,
  "summary": string
}`;

    return await this.generateJson(
      systemPrompt,
      `Title: ${title}\nContent:\n${content.slice(0, 3000)}`
    );
  }
}
