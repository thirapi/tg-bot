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
        "Aduh, maaf ya, aku kurang ngerti maksudnya. Coba kirim teks, foto, atau suara gitu biar aku paham!",
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
    const startTime = Date.now();
    const EXECUTION_TIMEOUT = 20000;

    const blacklistedModels = new Set();
    const blacklistedKeys = new Set();

    while (iteration < MAX_AGENT_ITERATIONS) {
      iteration++;

      if (Date.now() - startTime > EXECUTION_TIMEOUT) {
        throw new Error(
          "Duh, maaf ya, ini kayaknya kepanjangan deh prosesnya. Coba deh pecah pertanyaannya biar lebih simpel, nanti aku bantu lagi!",
        );
      }

      let geminiResponse = null;
      let lastError = null;

      const activeModels = models.filter((m) => !blacklistedModels.has(m));
      if (activeModels.length === 0) {
        throw new Error(
          "Seluruh model Gemini tidak dapat digunakan (terkena blacklist atau limit).",
        );
      }

      outerLoop: for (const model of activeModels) {
        const availableKeys = keys.filter(k => !blacklistedKeys.has(k));
        const shuffledKeys = shuffleArray(availableKeys);
        
        if (shuffledKeys.length === 0) {
          console.warn(`Semua API Key untuk model ${model} sudah dicoba dan gagal/limit.`);
          continue;
        }

        for (const key of shuffledKeys) {
          try {
            geminiResponse = await fetchGeminiGenerate(
              model,
              key,
              currentContents,
              env,
            );
            if (geminiResponse) break outerLoop;
          } catch (err) {
            console.error(`Error dengan model ${model} [Key: ${key.slice(0, 6)}...]:`, err.message);
            lastError = err;

            if (err.message.includes("GEMINI_RETRY_TRIGGER")) {
              console.warn(`[Fallback Triggered] Key ${key.substring(0, 6)}... terkena limit/timeout. Beralih ke key berikutnya.`);
              blacklistedKeys.add(key);
              continue;
            }

            if (err.message.includes("404") || err.message.includes("400")) {
              console.warn(`Model ${model} dimasukkan ke blacklist sesi karena error fatal.`);
              blacklistedModels.add(model);
              break;
            }
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

      if (functionCalls.length > 0) {
        const functionResponses = [];
        for (const call of functionCalls) {
          const { name, args } = call.functionCall;
          console.log(`Executing Tool: ${name}`, args);
          let result;
          try {
            result = await executeTool(name, args, env, chatId);
          } catch (toolErr) {
            console.error(`Tool "${name}" gagal:`, toolErr);
            if (
              toolErr.message.includes("403") ||
              toolErr.message.includes("401") ||
              toolErr.message.includes("Resource not accessible")
            ) {
              throw new Error(
                "Gagal menjalankan tool karena masalah otentikasi (403/401). Mohon periksa token API/PAT GitHub!",
              );
            }
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
          role: "function",
          parts: functionResponses,
        });
        continue;
      }

      const dynamicTextPart = parts.map(p => p.text).filter(Boolean).join("\n");

      if (dynamicTextPart) {
        finalGeminiText = dynamicTextPart;
        break;
      }

      if (functionCalls.length === 0) {
        break;
      }
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
        "Tugasnya udah aku jalanin ya! Tapi aku nggak dapet respons teks penutup dari sistem nih. Coba cek repo kamu, harusnya kodenya udah ke-update!",
      );
    }
  } catch (err) {
    console.error("processMessage Error:", err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `Yah, kok ada error ya... ${err.message}. Coba kirim lagi ya, moga-moga habis ini lancar!`,
    );
  } finally {
    isProcessing = false;
    console.log(`Releasing lock for chat: ${chatId}`);

    await env.CHAT_HISTORY.delete(lockKey).catch((e) => {
      console.error(`Gagal menghapus lockKey ${lockKey}:`, e);
    });
  }
}