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

      if (!message || !message.chat || !message.chat.id) {
        return new Response("OK", { status: 200 });
      }

      const chatId = String(message.chat.id);

      if (chatId !== String(env.ALLOWED_USER_ID)) {
        console.warn(`Unauthorized access attempt: ${chatId}`);
        return new Response("OK", { status: 200 });
      }

      const rateLimitKey = `rl:${chatId}`;
      const isRateLimited = await env.CHAT_HISTORY.get(rateLimitKey);
      if (isRateLimited) {
        return new Response("OK", { status: 200 });
      }
      await env.CHAT_HISTORY.put(rateLimitKey, "1", { expirationTtl: RATE_LIMIT_SECONDS });

      const text = message.text || message.caption || "";
      const normalizedText = text.trim().toLowerCase();

      if (normalizedText === "/start" || normalizedText === "/reset") {
        await env.CHAT_HISTORY.delete(chatId);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Memori telah dibersihkan\\. Siap memulai obrolan baru\\! 🚀");
        return new Response("OK", { status: 200 });
      }

      if (normalizedText === "/help") {
        const helpMsg = `*Daftar Perintah:*
/start \\- Memulai bot
/reset \\- Menghapus riwayat obrolan
/help \\- Bantuan

*Kemampuan:*
💬 Kirim pesan teks
📸 Kirim foto \\+ caption
🎙️ Kirim pesan suara \\(Voice\\)`;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMsg);
        return new Response("OK", { status: 200 });
      }

      ctx.waitUntil(processMessage(message, env));

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Critical Fetch Error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};

async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  let isProcessing = true;

  const typingInterval = setInterval(() => {
    if (isProcessing) sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
    else clearInterval(typingInterval);
  }, 4000);
  sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");

  try {
    let history = [];
    const stored = await env.CHAT_HISTORY.get(chatId);
    if (stored) history = JSON.parse(stored);

    let mediaData = null;
    let userPrompt = message.text || message.caption || "";

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      mediaData = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, fileId, "image/jpeg");
      if (!userPrompt) userPrompt = "Apa yang ada di foto ini?";
    } else if (message.voice) {
      mediaData = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, message.voice.file_id, "audio/ogg");
      if (!userPrompt) userPrompt = "Tolong jelaskan/jawab pesan suara ini.";
    }

    if (!userPrompt && !mediaData) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Maaf, aku bingung harus merespon apa\\. Coba kirim teks, foto, atau suara ya\\! 😅");
      return;
    }

    const keys = env.GEMINI_API_KEYS.split(",").map(k => k.trim());
    const models = (env.GEMINI_MODELS || "gemini-1.5-flash,gemini-2.0-flash-exp").split(",").map(m => m.trim());
    
    let geminiReply = null;
    let lastError = null;

    outerLoop:
    for (const model of models) {
      for (const key of shuffleArray(keys)) {
        try {
          geminiReply = await fetchGeminiContent(model, key, userPrompt, mediaData, history, env);
          if (geminiReply) break outerLoop;
        } catch (err) {
          console.error(`Error with model ${model}:`, err.message);
          lastError = err;
        }
      }
    }

    if (geminiReply) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, geminiReply);

      const newHistory = [
        ...history,
        { role: "user", parts: [{ text: userPrompt }, ...(mediaData ? [mediaData] : [])].filter(p => p.text || p.inline_data) },
        { role: "model", parts: [{ text: geminiReply }] }
      ].slice(-(MAX_HISTORY * 2));

      await env.CHAT_HISTORY.put(chatId, JSON.stringify(newHistory), { expirationTtl: KV_TTL });
    } else {
      throw lastError || new Error("All keys failed");
    }

  } catch (err) {
    console.error("Process Message Error:", err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN, 
      chatId, 
      "Aduh, maaf ya, sepertinya ada gangguan teknis sebentar\\. Boleh coba lagi nanti? 🙏"
    );
  } finally {
    isProcessing = false;
    clearInterval(typingInterval);
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
  const timeContext = `[Sistem: Waktu saat ini di Jakarta/WIB adalah ${wibTime}. Gunakan ini untuk konteks waktu.]`;
  
  const finalSystemInstruction = [systemPersona, systemInstruction, timeContext].filter(Boolean).join("\n\n");

  const userParts = [{ text: prompt }];
  if (mediaPart) userParts.push(mediaPart);

  const contents = [
    ...history,
    { role: "user", parts: userParts }
  ];

  const payload = {
    contents,
    systemInstruction: { parts: [{ text: finalSystemInstruction }] },
    generationConfig: {
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
    ]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "MarkdownV2"
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text })
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
  const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const fileRes = await fetch(getFileUrl);
  const fileData = await fileRes.json();
  
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

function escapeMarkdownV2(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
