import { RATE_LIMIT_SECONDS } from "../config.js";
import { sendTelegramMessage } from "../services/telegram.js";
import { processMessage } from "./message.js";

const activeRateLimits = new Set();

export async function handleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  try {
    const payload = await request.json();
    const message = payload.message || payload.edited_message;
    if (!message || !message.chat || !message.chat.id) {
      return new Response("OK", { status: 200 });
    }
    const chatId = String(message.chat.id);
    console.log(`Incoming message from chat: ${chatId}`);

    if (chatId !== String(env.ALLOWED_USER_ID)) {
      console.warn(`Unauthorized access attempt: ${chatId}. Expected: ${env.ALLOWED_USER_ID}`);
      return new Response("OK", { status: 200 });
    }
    const lockKey = `lock:${chatId}`;
    const isLocked = await env.CHAT_HISTORY.get(lockKey);
    if (isLocked) {
      console.log(`Chat ${chatId} is locked, skipping processing.`);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Eh, sebentar ya! Aku masih proses yang tadi, tunggu bentar lagi ya.",
      );
      return new Response("OK", { status: 200 });
    }
    await env.CHAT_HISTORY.put(lockKey, "1", { expirationTtl: 60 });
    if (activeRateLimits.has(chatId)) {
      console.log(`Chat ${chatId} hit rate limit, skipping.`);
      await env.CHAT_HISTORY.delete(lockKey);
      return new Response("OK", { status: 200 });
    }
    activeRateLimits.add(chatId);
    setTimeout(
      () => activeRateLimits.delete(chatId),
      RATE_LIMIT_SECONDS * 1000,
    );
    const text = message.text || message.caption || "";
    console.log(`Processing message: ${text.substring(0, 50)}...`);

    const normalizedText = text.trim().toLowerCase();
    if (normalizedText === "/start" || normalizedText === "/reset") {
      await env.CHAT_HISTORY.delete(chatId);
      await env.CHAT_HISTORY.delete(lockKey);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "Oke, memorinya udah aku hapus ya. Sekarang kita mulai obrolan baru lagi, mau bahas apa nih?",
      );
      return new Response("OK", { status: 200 });
    }
    if (normalizedText === "/help") {
      const helpMsg =
        "<b>Bisa apa aja?</b>\n" +
        "/start atau /reset - Hapus memori biar kita mulai dari awal lagi\n" +
        "/help - Lihat daftar ini\n\n" +
        "Selain ngobrol santai, aku juga bisa bantu kamu cek issue di GitHub, review PR, atau liat-liat foto dan dengerin pesan suara kamu. Kasih tau aja ya!";
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg);
      await env.CHAT_HISTORY.delete(lockKey);
      return new Response("OK", { status: 200 });
    }
    ctx.waitUntil(processMessage(message, env));
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Critical Webhook Error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
