import { MAX_HISTORY, MAX_AGENT_ITERATIONS } from "../config.js";
import { fetchGeminiGenerate } from "../services/gemini.js";
import { fetchGroqGenerate } from "../services/groq.js";
import { prepareMediaPart } from "../services/media.js";
import {
  sendTelegramAction,
  sendTelegramMessage,
} from "../services/telegram.js";
import { executeTool } from "../tools/executor.js";
import { markdownToRichHtml } from "../utils/formatter.js";
import { shuffleArray } from "../utils/array.js";
import {
  getHistory,
  addHistory,
  trimHistory,
  clearHistory,
} from "../db/index.js";

function buildProviderConfigs(env) {
  const configs = [];

  if (env.GEMINI_API_KEYS) {
    configs.push({
      name: "gemini",
      keys: env.GEMINI_API_KEYS.split(",").map((k) => k.trim()),
      models: (env.GEMINI_MODELS || "gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.5-flash")
        .split(",").map((m) => m.trim()),
      callAI: fetchGeminiGenerate,
    });
  }

  if (env.GROQ_API_KEY) {
    configs.push({
      name: "groq",
      keys: env.GROQ_API_KEY.split(",").map((k) => k.trim()),
      models: (env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile,qwen/qwen3.6-27b")
        .split(",").map((m) => m.trim()),
      callAI: fetchGroqGenerate,
    });
  }

  const priority = (env.AI_PROVIDERS || "gemini,groq")
    .split(",").map((s) => s.trim());
  configs.sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name));

  return configs;
}

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
    const maxHistory = MAX_HISTORY;
    let history = await getHistory(env, chatId, maxHistory * 4);

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

    const providerConfigs = buildProviderConfigs(env);
    if (providerConfigs.length === 0) {
      throw new Error("gak ada provider AI yang aktif. cek konfigurasi API key kamu ya!");
    }

    let userParts = [{ text: userPrompt }];
    if (mediaData) userParts.push(mediaData);

    let currentContents = [...history, { role: "user", parts: userParts }];
    let iteration = 0;
    let finalText = null;
    const startTime = Date.now();
    const EXECUTION_TIMEOUT = 23000;

    const failedProviders = new Set();
    let lastError = null;

    while (iteration < MAX_AGENT_ITERATIONS) {
      iteration++;

      if (Date.now() - startTime > EXECUTION_TIMEOUT) {
        throw new Error(
          "duh, sori ya prosesnya kelamaan nih, keburu kehabisan batas waktu. coba pecah pertanyaannya biar lebih simpel aja ya!",
        );
      }

      let response = null;
      let providerUsed = null;
      lastError = null;

      for (const provider of providerConfigs) {
        if (failedProviders.has(provider.name)) continue;
        if (Date.now() - startTime > EXECUTION_TIMEOUT) break;

        const { name, keys, models, callAI } = provider;
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

        let activeModels = models.filter((m) => !blacklistedModels.has(m));
        if (activeModels.length === 0) continue;

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
              const fetchPromise = callAI(model, key, currentContents, env, chatId);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("TIMEOUT_TRIGGER: Request Timeout (5s)")), 5000)
              );

              response = await Promise.race([fetchPromise, timeoutPromise]);
              if (response) {
                providerUsed = name;
                break outerLoop;
              }
            } catch (err) {
              console.error(`[${name}] Error model ${model} [Key: ${keyShort}...]:`, err.message);
              lastError = err;
              globalFailures++;

              if (globalFailures >= 3) {
                break outerLoop;
              }

              const errMsg = err.message;

              if (errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("SERVICE_UNAVAILABLE")) {
                blacklistedModels.add(model);
                break;
              }

              const isRetryable = errMsg.includes("TIMEOUT_TRIGGER") ||
                errMsg.includes("GEMINI_RETRY_TRIGGER") ||
                errMsg.includes("GROQ_RATE_LIMIT") ||
                errMsg.includes("429") ||
                errMsg.includes("RESOURCE_EXHAUSTED") ||
                errMsg.includes("GROQ_TIMEOUT");
              if (isRetryable) {
                blacklistedKeysGlobal.add(key);
                blacklistedKeysPerModel.add(`${model}:${key}`);

                let expirationTtl = 60;
                const match = errMsg.match(/"retryDelay":\s*"(\d+)s"/);
                if (match && match[1]) expirationTtl = parseInt(match[1], 10) + 5;
                await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl });

                consecutiveFailures++;
                if (consecutiveFailures >= MAX_FAILURES_BEFORE_SKIP) break;
                continue;
              }

              const isKeyInvalid = errMsg.includes("GEMINI_KEY_INVALID") ||
                errMsg.includes("GEMINI_KEY_BLOCKED") ||
                errMsg.includes("GROQ_KEY_INVALID");
              if (isKeyInvalid) {
                blacklistedKeysGlobal.add(key);
                await env.CHAT_HISTORY.put(`cooldown:${keyShort}`, "1", { expirationTtl: 600 });
                continue;
              }

              if (errMsg.includes("GEMINI_MODEL_NOT_FOUND") || errMsg.includes("GROQ_MODEL_NOT_FOUND") || errMsg.includes("404")) {
                blacklistedModels.add(model);
                break;
              }
            }
          }
        }

        if (response) break;
        failedProviders.add(name);
      }

      if (!response) {
        if (failedProviders.size >= providerConfigs.length) {
          throw lastError || new Error("duh, semua provider AI lagi error atau kena limit nih. coba beberapa saat lagi ya");
        }
        throw lastError || new Error("Semua AI endpoint gagal merespon atau kehabisan waktu eksekusi.");
      }

      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;
      if (!modelContent) throw new Error("AI mengembalikan konten kosong.");

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
                "gagal akses karena masalah izin. coba cek token github kamu ya!",
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
        finalText = dynamicTextPart;
        break;
      }

      if (functionCalls.length === 0) break;
    }

    if (finalText) {
      const richHtml = markdownToRichHtml(finalText);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, richHtml);

      const newContent = currentContents.slice(history.length);
      if (newContent.length > 0) {
        const cleaned = newContent.map(content => ({
          role: content.role,
          parts: content.parts.map(part => {
            if (part.inline_data) {
              return { text: `[Media: ${part.inline_data.mime_type}]` };
            }
            return part;
          })
        }));
        await addHistory(env, chatId, cleaned);
        await trimHistory(env, chatId, maxHistory);
      }
    } else {
      console.warn("AI did not provide final text output.");
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "tugasnya udah aku jalanin ya! tp aku ga dapet respons teks penutup dr sistem. coba cek repo kamu deh, harusnya kodenya udh ke-update",
      );
    }
    } catch (err) {
    console.error("processMessage Error:", err);
    const userMsg = err.message.startsWith("duh,") || err.message.startsWith("server") || err.message.startsWith("gagal")
      ? err.message
      : "yah eror... coba kirim lagi ya, moga abis ini lancar!";
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      userMsg,
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
