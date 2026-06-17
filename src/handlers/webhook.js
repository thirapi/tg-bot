import { RATE_LIMIT_SECONDS } from "../config.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { processMessage } from "./message.js";

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
        "Eh, sebentar ya! Aku masih proses yang tadi, tunggu bentar lagi ya.",
      ));
      return new Response("OK", { status: 200 });
    }

    await Promise.all([
      env.CHAT_HISTORY.put(lastUpdateKey, String(updateId), { expirationTtl: 300 }),
      env.CHAT_HISTORY.put(rateLimitKey, String(now), { expirationTtl: 60 }),
      env.CHAT_HISTORY.put(lockKey, "1", { expirationTtl: 60 })
    ]);

    const text = message.text || message.caption || "";
    const normalizedText = text.trim().toLowerCase();

    if (normalizedText === "/start" || normalizedText === "/reset") {
      ctx.waitUntil((async () => {
        try {
          await env.CHAT_HISTORY.delete(chatId);
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "Oke, memorinya udah aku hapus ya. Sekarang kita mulai obrolan baru lagi, mau bahas apa nih?",
          );
        } finally {
          await env.CHAT_HISTORY.delete(lockKey).catch(() => {});
        }
      })());
      return new Response("OK", { status: 200 });
    }

    if (normalizedText === "/help") {
      ctx.waitUntil((async () => {
        try {
          const helpMsg =
            "<b>Bisa apa aja?</b>\n" +
            "/start atau /reset - Hapus memori biar kita mulai dari awal lagi\n" +
            "/help - Lihat daftar ini\n\n" +
            "Selain ngobrol santai, aku juga bisa bantu kamu cek issue di GitHub, review PR, atau liat-liat foto dan dengerin pesan suara kamu. Kasih tau aja ya!";
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg);
        } finally {
          await env.CHAT_HISTORY.delete(lockKey).catch(() => {});
        }
      })());
      return new Response("OK", { status: 200 });
    }

    ctx.waitUntil(processMessage(message, env));
    
    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("Critical Webhook Error:", err);
    return new Response("OK", { status: 200 });
  }
}