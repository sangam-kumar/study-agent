export interface WorkoutExtraction {
  workout_type: string;
  exercises: Array<{
    name: string;
    sets: number;
    reps: number;
    weight_kg?: number;
  }>;
  notes?: string;
}

export interface UrlClassification {
  category: string;
  estimated_minutes: number;
  title: string;
  summary: string;
}

export interface LLMProvider {
  classifyIntent(text: string): Promise<string>;
  extractWorkout(input: string | ArrayBuffer): Promise<WorkoutExtraction>;
  classifyUrlContent(title: string, content: string): Promise<UrlClassification>;
}

export function getLLMProvider(env: Env): LLMProvider {
  // Stub for Phase 1 - will be implemented in Phase 4
  throw new Error(`LLMProvider not implemented yet for provider ${env.LLM_PROVIDER} - scheduled for Phase 4`);
}
