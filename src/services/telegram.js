import { TG_MAX_MESSAGE_LENGTH } from "../config.js";
import { splitIntoChunks, stripHtml } from "../utils/formatter.js";

const TG_API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .then(res => { clearTimeout(timeoutId); return res; })
    .catch(err => { clearTimeout(timeoutId); throw err; });
}

export async function sendTelegramAction(token, chatId, action) {
  return fetchWithTimeout(TG_API(token, "sendChatAction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  }, 5000);
}

export async function sendTelegramMessage(token, chatId, htmlText) {
  const url = TG_API(token, "sendMessage");
  const chunks = splitIntoChunks(htmlText, TG_MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
    };
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const plainText = stripHtml(chunk);
      await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plainText }),
      });
    }
  }
}
