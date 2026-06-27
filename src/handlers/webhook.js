import { RATE_LIMIT_SECONDS } from "../config.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { processMessage } from "./message.js";
import { checkGeminiQuota } from "../services/gemini.js";
import { checkGroqQuota } from "../services/groq.js";
import { clearHistory } from "../db/index.js";

export async function handleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const payload = await request.json();
    const message = payload.message || payload.edited_message;
    const updateId = payload.update_id;

    if (!message || !message.chat || !message.chat.id) {
      return new Response("OK", { status: 200 });
    }

    const chatId = String(message.chat.id);
    const lockKey = `lock:${chatId}`;
    const rateLimitKey = `rate_limit:${chatId}`;
    const lastUpdateKey = `last_update:${chatId}`;

    if (chatId !== String(env.ALLOWED_USER_ID)) {
      console.warn(`Unauthorized access: ${chatId}. Expected: ${env.ALLOWED_USER_ID}`);
      return new Response("OK", { status: 200 });
    }

    const lastUpdateId = await env.CHAT_HISTORY.get(lastUpdateKey);
    if (lastUpdateId === String(updateId)) {
      console.log(`Duplicate update ${updateId} for chat ${chatId}, skipping.`);
      return new Response("OK", { status: 200 });
    }

    const text = message.text || message.caption || "";
    const normalizedText = text.trim().toLowerCase();

    if (normalizedText === "/start" || normalizedText === "/reset") {
      ctx.waitUntil((async () => {
        await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
        await clearHistory(env, chatId);
        await env.CHAT_HISTORY.delete(lockKey).catch(() => { });
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "oke, memorinya udh aku hapus ya. yuk kita mulai obrolan baru lagi, mau bahas apa nih?",
        );
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/help") {
      ctx.waitUntil((async () => {
        await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
        const helpMsg =
          "<b>bisa apa aja?</b>\n" +
          "/start atau /reset - hapus memori biar kita mulai dr awal lagi\n" +
          "/help - lihat daftar ini\n" +
          "/unblock - reset kalo tiba-tiba macet\n" +
          "/quota atau /keys - cek status koneksi\n\n" +
          "selain ngobrol, aku jg bisa bantu urusan github, cari info di internet, bikin pengingat, atau liat foto dan dengerin voice note kamu. tinggal bilang aja!";
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg);
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/unblock") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          const geminiKeys = (env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
          const groqKeys = (env.GROQ_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
          const allKeys = [...geminiKeys, ...groqKeys];
          const deletePromises = allKeys.map(key => env.CHAT_HISTORY.delete(`cooldown:${key.slice(-6)}`));
          await Promise.all([
            ...deletePromises,
            env.CHAT_HISTORY.delete(lockKey).catch(() => { })
          ]);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "oke, semua status yang macet udh direset ya! aku siap lagi nih",
          );
        } catch (err) {
          console.error("Unblock Error:", err);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "aduh, gagal reset blacklist nih...");
        }
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/quota" || normalizedText === "/keys") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 });
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "sip, tunggu bentar ya! aku cek dulu status koneksinya...");
          const geminiStatus = env.GEMINI_API_KEYS ? await checkGeminiQuota(env) : "";
          const groqStatus = env.GROQ_API_KEY ? await checkGroqQuota(env) : "";
          const quotaStatus = [geminiStatus, groqStatus].filter(Boolean).join("\n\n");
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, quotaStatus);
        } catch (err) {
          console.error("Quota Check Error:", err);
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "aduh, ada eror pas lagi cek kuota. coba lagi nanti ya!");
        }
      })());
      return new Response("OK", { status: 200 });
    }

    const lastReqTimeStr = await env.CHAT_HISTORY.get(rateLimitKey);
    const now = Date.now();
    if (lastReqTimeStr) {
      const lastReqTime = parseInt(lastReqTimeStr);
      if (now - lastReqTime < RATE_LIMIT_SECONDS * 1000) {
        console.log(`Chat ${chatId} hit rate limit cooldown, skipping.`);
        return new Response("OK", { status: 200 });
      }
    }

    const isLocked = await env.CHAT_HISTORY.get(lockKey);
    if (isLocked) {
      console.log(`Chat ${chatId} is currently locked (processing), skipping.`);
      ctx.waitUntil(sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "eh sebentar ya! aku masih proses chat yg tadi nih, tunggu bentar lagi yaa",
      ));
      return new Response("OK", { status: 200 });
    }

    await Promise.all([
      env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 }),
      env.CHAT_HISTORY.put(rateLimitKey, String(now), { expirationTtl: 60 }),
      env.CHAT_HISTORY.put(lockKey, "1", { expirationTtl: 60 })
    ]);

    ctx.waitUntil(processMessage(message, env));

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("Critical Webhook Error:", err);
    return new Response("OK", { status: 200 });
  }
}