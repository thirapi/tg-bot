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

  let typingTimer = null;
  const sendTyping = async () => {
    if (!isProcessing) return;
    try {
      await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
    } catch (_) { }
    if (isProcessing) {
      typingTimer = setTimeout(sendTyping, 4000);
    }
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
        "aduh, sori ya ga ngerti maksudnya... coba kirim teks, foto, atau voice note aja biar aku paham!",
      );
      return;
    }

    const keys = env.GEMINI_API_KEYS.split(",").map((k) => k.trim());
    const models = (env.GEMINI_MODELS || "gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.5-flash")
      .split(",")
      .map((m) => m.trim());

    let userParts = [{ text: userPrompt }];
    if (mediaData) userParts.push(mediaData);

    let currentContents = [...history, { role: "user", parts: userParts }];
    let iteration = 0;
    let finalGeminiText = null;
    const startTime = Date.now();
    const EXECUTION_TIMEOUT = 23000;

    const blacklistedModels = new Set();
    const blacklistedKeysGlobal = new Set();
    const blacklistedKeysPerModel = new Set();
    let globalFailures = 0;

    const cooldownStatuses = await Promise.all(
      keys.map(async (key) => {
        const keyShort = key.slice(-6);
        const isGloballyDown = await env.CHAT_HISTORY.get(`cooldown:${keyShort}`);
        return { key, isGloballyDown: !!isGloballyDown };
      })
    );
    const kvCooldownedKeys = new Set(
      cooldownStatuses.filter(item => item.isGloballyDown).map(item => item.key)
    );

    while (iteration < MAX_AGENT_ITERATIONS) {
      iteration++;

      if (Date.now() - startTime > EXECUTION_TIMEOUT) {
        throw new Error(
          "duh, sori ya prosesnya kelamaan nih, keburu kehabisan batas waktu. coba pecah pertanyaannya biar lebih simpel aja ya!",
        );
      }

      let geminiResponse = null;
      let lastError = null;

      let activeModels = models.filter((m) => !blacklistedModels.has(m));
      if (activeModels.length === 0) {
        throw new Error(
          "duh, semua model gemini lagi eror atau kena limit nih. coba beberapa saat lagi ya",
        );
      }

      outerLoop: for (const model of activeModels) {
        if (Date.now() - startTime > EXECUTION_TIMEOUT) break outerLoop;

        const availableKeys = [];
        for (const key of keys) {
          const isLocallyDown = blacklistedKeysPerModel.has(`${model}:${key}`);
          const isGloballyDown = blacklistedKeysGlobal.has(key) || kvCooldownedKeys.has(key);
          if (!isLocallyDown && !isGloballyDown) {
            availableKeys.push(key);
            if (availableKeys.length >= 3) break;
          }
        }

        if (availableKeys.length === 0) continue;

        const shuffledKeys = shuffleArray(availableKeys);

        let consecutiveFailures = 0;
        const MAX_FAILURES_BEFORE_SKIP = 2;

        for (const key of shuffledKeys) {
          if (Date.now() - startTime > EXECUTION_TIMEOUT) break outerLoop;

          const keyShort = key.slice(-6);
          try {
            const fetchPromise = fetchGeminiGenerate(model, key, currentContents, env);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("GEMINI_RETRY_TRIGGER: Request Timeout (5s)")), 5000));

            geminiResponse = await Promise.race([fetchPromise, timeoutPromise]);
            if (geminiResponse) break outerLoop;
          } catch (err) {
            console.error(`Error dengan model ${model} [Key: ${keyShort}...]:`, err.message);
            lastError = err;
            globalFailures++;

            if (globalFailures >= 3) {
              throw new Error("server google ai lagi down parah nih. coba kirim ulang chatnya bentar lagi ya!");
            }

            if (err.message.includes("503") || err.message.includes("UNAVAILABLE")) {
              blacklistedModels.add(model);
              break;
            }

            if (err.message.includes("GEMINI_RETRY_TRIGGER") || err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED")) {
              blacklistedKeysGlobal.add(key);
              blacklistedKeysPerModel.add(`${model}:${key}`);

              let expirationTtl = 60;
              const match = err.message.match(/"retryDelay":\s*"(\d+)s"/);
              if (match && match[1]) expirationTtl = parseInt(match[1], 10) + 5;
              await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl });

              consecutiveFailures++;
              if (consecutiveFailures >= MAX_FAILURES_BEFORE_SKIP) break;
              continue;
            }

            if (err.message.includes("GEMINI_KEY_INVALID") || err.message.includes("GEMINI_KEY_BLOCKED")) {
              blacklistedKeysGlobal.add(key);
              await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl: 600 });
              continue;
            }

            if (err.message.includes("GEMINI_MODEL_NOT_FOUND") || err.message.includes("404")) {
              blacklistedModels.add(model);
              break;
            }
          }
        }
      }

      if (!geminiResponse) {
        throw lastError || new Error("Semua Gemini API endpoint gagal merespon atau kehabisan waktu eksekusi.");
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
                "gagal jalanin tool karena masalah otentikasi (403/401). coba cek token api/pat github kamu ya!",
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

      if (functionCalls.length === 0) break;
    }

    if (finalGeminiText) {
      const richHtml = markdownToRichHtml(finalGeminiText);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);

      const cleanedHistory = currentContents.map(content => ({
        role: content.role,
        parts: content.parts.map(part => {
          if (part.inline_data) {
            return { text: `[Media: ${part.inline_data.mime_type}]` };
          }
          return part;
        })
      }));

      let newHistory = cleanedHistory.slice(-(MAX_HISTORY * 4));
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
        "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
      );
    }
  } catch (err) {
    console.error("processMessage Error:", err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `yah eror... ${err.message}. coba kirim lagi ya, moga abis ini lancar!`,
    );
  } finally {
    isProcessing = false;
    clearTimeout(typingTimer);
    console.log(`Releasing lock for chat: ${chatId}`);

    await env.CHAT_HISTORY.delete(lockKey).catch((e) => {
      console.error(`Gagal menghapus lockKey ${lockKey}:`, e);
    });
  }
}