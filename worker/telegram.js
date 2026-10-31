import { sleep } from "./util.js";
import { channelButton } from "./messages.js";

export async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN غير مضبوط");

  const delay = Number(env.RETRY_DELAY_MS ?? 1000);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        }
      );

      const result = await response.json();
      if (response.ok && result.ok) return result.result;

      lastError = new Error(
        `TELEGRAM_HTTP_${response.status}: ${result.description || "Telegram error"}`
      );

      // أخطاء دائمة (توكن/صلاحيات/chat id): لا فائدة من الإعادة
      if (response.status !== 429 && response.status < 500) throw lastError;

      await sleep(Math.min((result.parameters?.retry_after || attempt) * 1000, 8000));
    } catch (error) {
      const m = String(error.message);
      if (m.startsWith("TELEGRAM_HTTP_4") && !m.startsWith("TELEGRAM_HTTP_429")) throw error;
      lastError = error;
      await sleep(attempt * delay);
    }
  }

  throw lastError;
}

export function sendMessage(env, ch, text) {
  const payload = {
    chat_id: ch.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  const kb = channelButton(ch);
  if (kb) payload.reply_markup = kb;
  return telegramCall(env, "sendMessage", payload);
}

export function sendPlain(env, chatId, text) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}
