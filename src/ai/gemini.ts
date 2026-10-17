import {
  LLMProvider,
  TextParseResult,
  AudioProcessingResult,
  UrlClassification,
  TEXT_PARSE_JSON_SCHEMA,
  AUDIO_PARSE_JSON_SCHEMA,
  URL_CLASSIFICATION_JSON_SCHEMA,
} from "./schemas";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(private env: Env) {
    this.apiKey = env.GEMINI_API_KEY;
    this.model = env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  private async callGemini(contents: any[], responseSchema?: any): Promise<any> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const body: any = {
      contents,
    };

    if (responseSchema) {
      body.generationConfig = {
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.2,
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API failed [${res.status}]: ${errText}`);
    }

    const data = (await res.json()) as any;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("Gemini returned empty candidate");
    }

    return responseSchema ? JSON.parse(text) : text;
  }

  async parseText(text: string): Promise<TextParseResult> {
    const prompt = `You are an intelligent assistant parsing notes for a personal knowledge base.
Analyze the following user input and determine whether it is:
1. "workout_log": A workout record (exercises, sets, reps, weight in kg, notes).
2. "study_note": Study notes, summaries, or thoughts on a topic.
3. "snooze": A request to snooze, pause notifications, skip study blocks, or reschedule.
4. "reminder": A request to set a reminder, alarm, or task alert at some future time or delay (e.g., "remind me in 30 minutes to drink water", "remind me in 2 hours to call mom", "set a reminder for 15 mins to check email"). Extract reminder_text and calculate delay_minutes (in minutes from now).
5. "general": General conversation or query.

Extract all relevant fields strictly into the schema. For replyText, provide a concise, friendly confirmation.

User message:
${text}`;

    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    return await this.callGemini(contents, TEXT_PARSE_JSON_SCHEMA);
  }

  async processAudio(audioBuffer: ArrayBuffer, mimeType = "audio/ogg"): Promise<AudioProcessingResult> {
    // In-memory base64 encoding (zero disk storage)
    const base64Audio = arrayBufferToBase64(audioBuffer);

    const prompt = `You are an intelligent assistant processing an audio voice memo.
1. Transcribe the audio verbatim.
2. Determine if the speech represents a workout_log, a study_note, a reminder, or general thoughts.
3. If it is a reminder (e.g. "remind me in 15 minutes to call mom"), extract the reminder_text and delay_minutes (in minutes).
4. If it is a workout, extract the exercises, sets, reps, and weights.
5. If it is a study note or thought, extract the topic, summary, and key takeaways.
Output strictly following the JSON schema.`;

    const contents = [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            },
          },
          { text: prompt },
        ],
      },
    ];

    return await this.callGemini(contents, AUDIO_PARSE_JSON_SCHEMA);
  }

  async classifyUrlContent(title: string, content: string): Promise<UrlClassification> {
    const prompt = `Classify this reading material into one of: ["eng", "watch", "design", "cs", "ml", "general"].
Estimate reading time in minutes and provide a 2-sentence summary.

Title: ${title}
Content excerpt:
${content.slice(0, 4000)}`;

    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    return await this.callGemini(contents, URL_CLASSIFICATION_JSON_SCHEMA);
  }
}
