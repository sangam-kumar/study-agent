export class TelegramClient {
  constructor(private token: string) {}

  async sendMessage(chatId: number | string, text: string, parseMode: "HTML" | "MarkdownV2" = "HTML"): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram sendMessage failed [${res.status}]: ${err}`);
    }
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
}
