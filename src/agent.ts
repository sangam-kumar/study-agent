import { Agent } from "agents";

export class StudyAgent extends Agent<Env> {
  // Stub for Phase 1 - will be populated in Phase 3
  async handleTelegramUpdate(update: unknown): Promise<void> {
    console.log("StudyAgent received Telegram update:", JSON.stringify(update));
  }
}
