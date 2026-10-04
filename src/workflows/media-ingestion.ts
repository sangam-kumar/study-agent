import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { MediaIngestionParams } from "../types";

export class MediaIngestionWorkflow extends WorkflowEntrypoint<Env, MediaIngestionParams> {
  async run(event: WorkflowEvent<MediaIngestionParams>, step: WorkflowStep) {
    const { url, chatId } = event.payload;

    await step.do("log-ingestion-started", async () => {
      console.log(`Starting media ingestion for URL: ${url}, chatId: ${chatId}`);
      return { status: "received", url };
    });
  }
}
