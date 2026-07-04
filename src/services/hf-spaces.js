import { getHistory, getAllMemories, getTasks, addHistory, trimHistory } from "../db/index.js";
import { sendTelegramMessage } from "./telegram.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { MAX_HISTORY } from "../config.js";

export async function processViaSpaces(env, chatId, userPrompt, mediaData, history) {
  const maxHistory = MAX_HISTORY;
  const memories = await getAllMemories(env, chatId);
  const tasks = await getTasks(env, chatId);

  const userParts = [{ text: userPrompt }];
  if (mediaData) userParts.push(mediaData);

  const currentContents = [...history, { role: "user", parts: userParts }];

  const response = await fetch(`${env.HF_SPACES_URL}/api/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId,
      userPrompt,
      currentContents,
      memories,
      tasks,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`HF Spaces error (${response.status}): ${errBody}`);
  }

  const result = await response.json();

  if (result.escalationTriggered) {
    const newContent = currentContents.slice(history.length);
    if (newContent.length > 0) {
      const cleaned = newContent.map(c => ({
        role: c.role,
        parts: c.parts.map(p => {
          if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
          return p;
        })
      }));
      await addHistory(env, chatId, cleaned);
      await trimHistory(env, chatId, maxHistory);
    }
  } else if (result.finalText) {
    const richHtml = markdownToRichHtml(result.finalText);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);

    const newContent = currentContents.slice(history.length);
    if (newContent.length > 0) {
      const cleaned = newContent.map(c => ({
        role: c.role,
        parts: c.parts.map(p => {
          if (p.inline_data) return { text: `[Media: ${p.inline_data.mime_type}]` };
          return p;
        })
      }));
      await addHistory(env, chatId, cleaned);
      await trimHistory(env, chatId, maxHistory);
    }
  } else {
    console.warn("Spaces did not provide final text output.");
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
    );
  }

  return result;
}
