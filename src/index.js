const KV_TTL = 3600;
const MAX_HISTORY = 15;
const RATE_LIMIT_SECONDS = 3;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await request.json();
      const message = payload.message || payload.edited_message;

      if (!message?.chat?.id) return new Response("OK", { status: 200 });

      const chatId = String(message.chat.id);

      if (chatId !== String(env.ALLOWED_USER_ID)) {
        console.warn(`Unauthorized: ${chatId}`);
        return new Response("OK", { status: 200 });
      }

      const rateKey = `rl:${chatId}`;
      if (await env.CHAT_HISTORY.get(rateKey)) {
        return new Response("OK", { status: 200 });
      }
      await env.CHAT_HISTORY.put(rateKey, "1", { expirationTtl: RATE_LIMIT_SECONDS });

      const normalized = (message.text || message.caption || "").trim().toLowerCase();

      if (["/start", "/reset"].includes(normalized)) {
        await env.CHAT_HISTORY.delete(chatId);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "✅ *Memori dibersihkan.* Siap obrolan baru!", "Markdown");
        return new Response("OK", { status: 200 });
      }

      if (normalized === "/help") {
        const help = `*Bot Personal AI*\n\n/start atau /reset - Bersihkan memori\n/help - Bantuan\n\n*Bisa menerima:*\n• Teks\n• Foto + caption\n• Voice message`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, help, "Markdown");
        return new Response("OK", { status: 200 });
      }

      ctx.waitUntil(processMessage(message, env));

    } catch (err) {
      console.error("Critical Fetch Error:", err);
    }

    return new Response("OK", { status: 200 });
  }
};

async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  let isProcessing = true;

  const typingLoop = async () => {
    while (isProcessing) {
      await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
      await new Promise(r => setTimeout(r, 3500));
    }
  };
  typingLoop();

  try {
    let history = [];
    const stored = await env.CHAT_HISTORY.get(chatId);
    if (stored) {
      try { history = JSON.parse(stored); } catch (e) {}
    }

    let userPrompt = message.text || message.caption || "";
    let mediaPart = null;

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      mediaPart = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, fileId, "image/jpeg");
      if (!userPrompt) userPrompt = "Deskripsikan gambar ini dengan detail.";
    } else if (message.voice) {
      mediaPart = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, message.voice.file_id, "audio/ogg");
      if (!userPrompt) userPrompt = "Transkrip dan jawab pesan suara ini.";
    }

    if (!userPrompt && !mediaPart) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Kirim teks, foto, atau voice ya 😊", null);
      return;
    }

    const keys = (env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    const models = (env.GEMINI_MODELS || "gemini-2.5-flash,gemini-1.5-flash").split(",").map(m => m.trim()).filter(Boolean);

    if (keys.length === 0) throw new Error("No API Key");

    let geminiReply = null;

    for (const model of models) {
      for (const key of shuffleArray(keys)) {
        try {
          geminiReply = await fetchGeminiContent(model, key, userPrompt, mediaPart, history, env);
          if (geminiReply) break;
        } catch (e) {
          console.error(`Failed ${model}:`, e.message);
        }
      }
      if (geminiReply) break;
    }

    if (geminiReply) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, geminiReply, "Markdown");

      const updatedHistory = [
        ...history,
        { role: "user", parts: [{ text: userPrompt }] },
        { role: "model", parts: [{ text: geminiReply }] }
      ].slice(-MAX_HISTORY);

      await env.CHAT_HISTORY.put(chatId, JSON.stringify(updatedHistory), { expirationTtl: KV_TTL });
    } else {
      throw new Error("All models failed");
    }

  } catch (err) {
    console.error("Process Error:", err);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Maaf ya, sedang ada gangguan. Coba lagi sebentar 🙏", null);
  } finally {
    isProcessing = false;
  }
}

async function fetchGeminiContent(model, key, prompt, mediaPart, history, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const wibTime = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  });

  const systemPersona = env.GEMINI_SYSTEM_PERSONA || "";
  const systemInstruction = env.GEMINI_SYSTEM_INSTRUCTION || "";
  const timeContext = `[Sistem: Waktu saat ini ${wibTime} WIB.]`;

  const finalSystem = [systemPersona, systemInstruction, timeContext].filter(Boolean).join("\n\n");

  const userParts = [{ text: prompt }];
  if (mediaPart) userParts.push(mediaPart);

  const payload = {
    contents: [...history, { role: "user", parts: userParts }],
    systemInstruction: { parts: [{ text: finalSystem }] },
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function sendTelegramMessage(token, chatId, text, parseMode = "Markdown") {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let payload = { chat_id: chatId, text };

  if (parseMode) payload.parse_mode = parseMode;

  let res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok && parseMode) {
    delete payload.parse_mode;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
}

async function sendTelegramAction(token, chatId, action) {
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action })
  }).catch(() => {});
}

async function prepareMediaPart(token, fileId, mimeType) {
  const getFile = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await getFile.json();

  if (!fileData.ok) return null;

  const filePath = fileData.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const mediaRes = await fetch(downloadUrl);
  const buffer = await mediaRes.arrayBuffer();
  
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

  return {
    inline_data: {
      mime_type: mimeType,
      data: base64
    }
  };
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}