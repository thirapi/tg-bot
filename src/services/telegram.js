import { TG_MAX_MESSAGE_LENGTH } from "../config.js";
import { splitIntoChunks, stripHtml } from "../utils/formatter.js";

const TG_API = (token, method) =>
  `https://api.telegram.org/bot${token}/${method}`;

export async function sendTelegramAction(token, chatId, action) {
  return fetch(TG_API(token, "sendChatAction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn("sendTelegramMessage HTML gagal, mencoba plain text fallback...");
      const plainText = stripHtml(chunk);
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: plainText }),
      });
    }
  }
}

export async function sendRichMessage(token, chatId, richHtml) {
  const url = TG_API(token, "sendRichMessage");
  const payload = {
    chat_id: chatId,
    rich_message: { html: richHtml },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn(`sendRichMessage gagal (${res.status}): ${err}`);
    return false;
  }
  return true;
}

export async function sendRichMessageDraft(token, chatId, draftHtml) {
  const url = TG_API(token, "sendRichMessageDraft");
  const payload = {
    chat_id: chatId,
    rich_message: { html: draftHtml },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn(`sendRichMessageDraft gagal (${res.status}): ${err}`);
  }
}
