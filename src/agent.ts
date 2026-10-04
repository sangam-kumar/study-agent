import { Agent } from "agents";
import { TelegramClient } from "./telegram/bot";

export class StudyAgent extends Agent<Env> {
  // Executed on the very first time the agent boots up
  override async onStart() {
    // We'll initialize the SQLite schema here in Phase 3
    console.log("StudyAgent started");
  }

  async handleTelegramUpdate(update: any): Promise<void> {
    console.log("StudyAgent received Telegram update:", JSON.stringify(update));

    const message = update.message;
    if (!message) {
      console.log("Update does not contain a message, ignoring.");
      return;
    }

    const chatId = message.chat?.id?.toString();
    if (!chatId) return;

    // Security: Only respond to our authorized user
    if (this.env.USER_TELEGRAM_CHAT_ID && chatId !== this.env.USER_TELEGRAM_CHAT_ID) {
      console.warn(`Unauthorized access attempt from chat ID: ${chatId}`);
      return;
    }

    const telegram = new TelegramClient(this.env.TELEGRAM_BOT_TOKEN);

    try {
      if (message.voice) {
        // Handle voice memos
        console.log(`Received voice memo: ${message.voice.file_id}`);
        await telegram.sendMessage(chatId, "🎤 Voice memo received! (Processing coming in Phase 3)");
        
      } else if (message.text) {
        // Handle text or URLs
        const text = message.text as string;
        
        if (text.startsWith("http://") || text.startsWith("https://")) {
           console.log(`Received URL: ${text}`);
           await telegram.sendMessage(chatId, "🔗 URL received! (Workflow coming in Phase 3)");
        } else if (text.startsWith("/")) {
           console.log(`Received command: ${text}`);
           await telegram.sendMessage(chatId, `🤖 Command ${text} recognized.`);
        } else {
           console.log(`Received text: ${text}`);
           await telegram.sendMessage(chatId, "📝 Text log received! (LLM structuring coming in Phase 3)");
        }
      }
    } catch (err) {
      console.error("Error handling telegram update:", err);
      await telegram.sendMessage(chatId, "⚠️ Error processing your request.");
    }
  }
}
