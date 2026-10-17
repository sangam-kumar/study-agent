export interface WorkoutExercise {
  name: string;
  sets: number;
  reps: number;
  weight_kg?: number;
}

export interface WorkoutExtraction {
  workout_type: string;
  exercises: WorkoutExercise[];
  notes?: string;
}

export interface ScheduleOverrideExtraction {
  action: "snooze" | "cancel" | "skip_day";
  duration_hours?: number;
  reason: string;
}

export interface StudyNoteExtraction {
  topic: string;
  summary: string;
  key_takeaways: string[];
}

export interface TextParseResult {
  intent: "workout_log" | "study_note" | "snooze" | "general";
  workout?: WorkoutExtraction;
  snooze?: ScheduleOverrideExtraction;
  note?: StudyNoteExtraction;
  replyText?: string;
}

export interface AudioProcessingResult {
  transcript: string;
  intent: "workout_log" | "study_note" | "general";
  workout?: WorkoutExtraction;
  note?: StudyNoteExtraction;
}

export interface UrlClassification {
  category: "eng" | "watch" | "design" | "cs" | "ml" | "general";
  estimated_minutes: number;
  title: string;
  summary: string;
}

export interface LLMProvider {
  parseText(text: string): Promise<TextParseResult>;
  processAudio(audioBuffer: ArrayBuffer, mimeType?: string): Promise<AudioProcessingResult>;
  classifyUrlContent(title: string, content: string): Promise<UrlClassification>;
}

// JSON Schema for Gemini structured output
export const TEXT_PARSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["workout_log", "study_note", "snooze", "general"],
    },
    workout: {
      type: "object",
      properties: {
        workout_type: { type: "string" },
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sets: { type: "number" },
              reps: { type: "number" },
              weight_kg: { type: "number" },
            },
            required: ["name", "sets", "reps"],
          },
        },
        notes: { type: "string" },
      },
      required: ["workout_type", "exercises"],
    },
    snooze: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snooze", "cancel", "skip_day"] },
        duration_hours: { type: "number" },
        reason: { type: "string" },
      },
      required: ["action", "reason"],
    },
    note: {
      type: "object",
      properties: {
        topic: { type: "string" },
        summary: { type: "string" },
        key_takeaways: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["topic", "summary", "key_takeaways"],
    },
    replyText: {
      type: "string",
      description: "A short, friendly, concise acknowledgment or response to the user.",
    },
  },
  required: ["intent", "replyText"],
};

export const AUDIO_PARSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string", description: "Verbatim transcript of the audio" },
    intent: {
      type: "string",
      enum: ["workout_log", "study_note", "general"],
    },
    workout: {
      type: "object",
      properties: {
        workout_type: { type: "string" },
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sets: { type: "number" },
              reps: { type: "number" },
              weight_kg: { type: "number" },
            },
            required: ["name", "sets", "reps"],
          },
        },
        notes: { type: "string" },
      },
      required: ["workout_type", "exercises"],
    },
    note: {
      type: "object",
      properties: {
        topic: { type: "string" },
        summary: { type: "string" },
        key_takeaways: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["topic", "summary", "key_takeaways"],
    },
  },
  required: ["transcript", "intent"],
};

export const URL_CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["eng", "watch", "design", "cs", "ml", "general"],
    },
    estimated_minutes: { type: "number" },
    title: { type: "string" },
    summary: { type: "string" },
  },
  required: ["category", "estimated_minutes", "title", "summary"],
};
