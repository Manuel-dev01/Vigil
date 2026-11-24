/**
 * Telegram delivery. The bot token is a secret service variable and is never logged. The chat id can
 * be configured, or found from the bot's updates: whoever pressed Start on the bot most recently.
 */
export interface Notifier {
  readonly enabled: boolean;
  send(text: string): Promise<void>;
}

const API = "https://api.telegram.org";

export async function telegram(token: string | undefined, chatId: string | undefined, log: (e: string, f?: Record<string, unknown>) => void): Promise<Notifier> {
  if (!token) {
    log("telegram-off", { reason: "no TELEGRAM_BOT_TOKEN; alerts go to the log only" });
    return { enabled: false, send: async () => {} };
  }
  let chat = chatId;
  if (!chat) {
    const r = await fetch(`${API}/bot${token}/getUpdates?limit=100`);
    const j = (await r.json()) as { ok: boolean; result?: { message?: { chat?: { id: number; type: string } } }[] };
    const chats = (j.result ?? []).map((u) => u.message?.chat).filter((c): c is { id: number; type: string } => !!c && c.type === "private");
    chat = chats.length ? String(chats[chats.length - 1]!.id) : undefined;
    if (!chat) {
      log("telegram-off", { reason: "no chat yet: open the bot in Telegram and press Start, then restart the sentinel (or set TELEGRAM_CHAT_ID)" });
      return { enabled: false, send: async () => {} };
    }
    log("telegram-chat", { found: "from the bot's updates" });
  }
  const target = chat;
  return {
    enabled: true,
    async send(text: string) {
      const r = await fetch(`${API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: target, text, disable_web_page_preview: true }),
      });
      if (!r.ok) throw new Error(`telegram sendMessage answered HTTP ${r.status}`);
    },
  };
}
