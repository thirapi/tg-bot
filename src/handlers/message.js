import { KV_TTL, MAX_HISTORY, MAX_AGENT_ITERATIONS } from "../config.js";
import { fetchGeminiGenerate } from "../services/gemini.js";
import { prepareMediaPart } from "../services/media.js";
import {
  sendTelegramAction,
  sendTelegramMessage,
} from "../services/telegram.js";
import { executeTool } from "../tools/executor.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { shuffleArray } from "../utils/array.js";

export async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  const lockKey = `lock:${chatId}`;
  let isProcessing = true;

  const sendTyping = async () => {
    if (!isProcessing) return;
    try {
      await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
    } catch (_) { }
    setTimeout(sendTyping, 4000);
  };
  sendTyping();

  try {
    let history = [];
    const stored = await env.CHAT_HISTORY.get(chatId);
    if (stored) history = JSON.parse(stored);

    let mediaData = null;
    let userPrompt = message.text || message.caption || "";

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      mediaData = await prepareMediaPart(
        env.TELEGRAM_BOT_TOKEN,
        fileId,
        "image/jpeg",
      );
      if (!userPrompt) userPrompt = "Apa yang ada di foto ini?";
    } else if (message.voice) {
      mediaData = await prepareMediaPart(
        env.TELEGRAM_BOT_TOKEN,
        message.voice.file_id,
        "audio/ogg",
      );
      if (!userPrompt) userPrompt = "Tolong jelaskan/jawab pesan suara ini.";
    }

    if (!userPrompt && !mediaData) {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Maaf, aku bingung harus merespon apa. Coba kirim teks, foto, atau suara ya! 😅",
      );
      return;
    }

    const keys = env.GEMINI_API_KEYS.split(",").map((k) => k.trim());
    const models = (env.GEMINI_MODELS || "gemini-2.0-flash-exp,gemini-1.5-flash")
      .split(",")
      .map((m) => m.trim());

    let userParts = [{ text: userPrompt }];
    if (mediaData) userParts.push(mediaData);

    let currentContents = [...history, { role: "user", parts: userParts }];
    let iteration = 0;
    let finalGeminiText = null;

    while (iteration < MAX_AGENT_ITERATIONS) {
      iteration++;
      let geminiResponse = null;
      let lastError = null;

      outerLoop: for (const model of models) {
        for (const key of shuffleArray(keys)) {
          try {
            geminiResponse = await fetchGeminiGenerate(
              model,
              key,
              currentContents,
              env,
            );
            if (geminiResponse) break outerLoop;
          } catch (err) {
            console.error(`Error dengan model ${model}:`, err.message);
            lastError = err;
          }
        }
      }

      if (!geminiResponse) {
        throw lastError || new Error("Semua Gemini API endpoint gagal merespon.");
      }

      const candidate = geminiResponse.candidates?.[0];
      const modelContent = candidate?.content;
      if (!modelContent) throw new Error("Gemini mengembalikan konten kosong.");

      currentContents.push(modelContent);
      const parts = modelContent.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall);
      const textPart = parts.find((p) => p.text);

      if (functionCalls.length > 0) {
        const functionResponses = [];
        for (const call of functionCalls) {
          const { name, args } = call.functionCall;
          console.log(`Executing Tool: ${name}`, args);
          let result;
          try {
            result = await executeTool(name, args, env);
          } catch (toolErr) {
            console.error(`Tool "${name}" gagal:`, toolErr);
            result = { error: toolErr.message };
          }
          functionResponses.push({
            functionResponse: {
              name,
              response: { content: result },
            },
          });
        }
        currentContents.push({
          role: "tool",
          parts: functionResponses,
        });
        continue;
      }

      if (textPart) {
        finalGeminiText = textPart.text;
        break;
      }
      break;
    }

    if (finalGeminiText) {
      const richHtml = markdownToRichHtml(finalGeminiText);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);

      let newHistory = currentContents.slice(-(MAX_HISTORY * 4));
      while (newHistory.length > 0 && newHistory[0].role !== "user") {
        newHistory.shift();
      }

      await env.CHAT_HISTORY.put(chatId, JSON.stringify(newHistory), {
        expirationTtl: KV_TTL,
      });
    } else {
      console.warn("Gemini did not provide final text output.");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Maaf, aku tidak bisa memberikan jawaban teks untuk permintaan itu, tapi aku sudah mencoba menjalankan instruksimu. Ada lagi yang bisa kubantu? 😊",
      );
    }
  } catch (err) {
    console.error("processMessage Error:", err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Aduh, sepertinya ada gangguan teknis: ${err.message}. Coba lagi ya! 🙏`,
    );
  } finally {
    isProcessing = false;
    await env.CHAT_HISTORY.delete(lockKey).catch(() => { });
  }
}
