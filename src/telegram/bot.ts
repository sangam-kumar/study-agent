/** Rows of inline buttons; data comes back as a callback_query (max 64 bytes). */
export type Buttons = { text: string; data: string }[][];

const keyboard = (buttons: Buttons) => ({ inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });

export class TelegramClient {
  constructor(private token: string) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram ${method} failed [${res.status}]: ${err}`);
    }
    return ((await res.json()) as { result: T }).result;
  }

  /** Returns the sent message's id (used to edit it later, e.g. to remove buttons once tapped). */
  async sendMessage(chatId: number | string, text: string, parseMode: "HTML" | "MarkdownV2" = "HTML", buttons?: Buttons): Promise<number | undefined> {
    const msg = await this.call<{ message_id?: number } | undefined>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
    });
    return msg?.message_id;
  }

  /** Replace a message's text; without buttons the keyboard is removed. */
  async editMessageText(chatId: number | string, messageId: number, text: string, buttons?: Buttons): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
    });
  }

  /** Stops the button's spinner; text shows as a small toast. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async getFileDownloadUrl(fileId: string): Promise<string> {
    const url = `https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Telegram getFile failed [${res.status}]`);
    }
    const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!data.ok || !data.result?.file_path) {
      throw new Error("Telegram getFile returned invalid result");
    }
    return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
  }

  async downloadFileAsBuffer(fileId: string): Promise<ArrayBuffer> {
    const downloadUrl = await this.getFileDownloadUrl(fileId);
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Failed to download Telegram file [${res.status}]`);
    }
    return await res.arrayBuffer();
  }
}
