export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const payload = await request.json();
      const message = payload.message || payload.edited_message || payload.channel_post;

      if (!message || !message.chat || !message.chat.id) {
        return new Response("OK", { status: 200 });
      }

      const chatId = message.chat.id;
      const userText = message.text;

      if (String(chatId) !== String(env.ALLOWED_USER_ID)) {
        console.warn(`Akses tidak dikenal ditolak untuk Chat ID: ${chatId}`);
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Maaf, bot ini bersifat privat dan dikonfigurasi hanya untuk pemilik sah."
        );
        return new Response("OK", { status: 200 });
      }

      if (!userText) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Maaf, bot ini hanya dapat memproses pesan teks saat ini."
        );
        return new Response("OK", { status: 200 });
      }

      ctx.waitUntil(sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing"));

      const keys = env.GEMINI_API_KEYS
        ? env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean)
        : [];
      const models = env.GEMINI_MODELS
        ? env.GEMINI_MODELS.split(",").map(m => m.trim()).filter(Boolean)
        : ["gemini-2.5-flash"];

      if (keys.length === 0) {
        console.error("Error: GEMINI_API_KEYS belum dikonfigurasi di environment variables.");
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Kesalahan Sistem: API Key Gemini belum dikonfigurasi."
        );
        return new Response("OK", { status: 200 });
      }

      const shuffledKeys = shuffleArray(keys);

      let geminiReply = null;
      let lastError = null;

      outerLoop: 
      for (const model of models) {
        for (const key of shuffledKeys) {
          try {
            console.log(`Mencoba model [${model}] menggunakan Key [${key.substring(0, 6)}...]`);
            geminiReply = await fetchGeminiContent(model, key, userText, env);
            if (geminiReply) {
              break outerLoop;
            }
          } catch (err) {
            console.error(`Gagal pada model [${model}] dengan Key [${key.substring(0, 6)}...]:`, err.message);
            lastError = err;
          }
        }
      }

      if (geminiReply) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, geminiReply);
      } else {
        console.error("Semua kombinasi model dan API Key gagal digunakan. Error terakhir:", lastError);
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Maaf, semua API Key atau Model Gemini sedang mengalami limitasi/rate-limit. Silakan coba kembali sesaat lagi."
        );
      }

    } catch (err) {
      console.error("Critical Worker Error:", err);
    }

    return new Response("OK", { status: 200 });
  }
};

async function sendTelegramMessage(token, chatId, text, parseMode = "Markdown") {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: text
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gagal kirim pesan Telegram: Status ${response.status} - ${errorText}`);

      if (response.status === 400 && parseMode === "Markdown") {
        console.warn("Mencoba mengirim ulang pesan sebagai plain text (Tanpa Markdown)...");
        await sendTelegramMessage(token, chatId, text, null);
      }
    }
  } catch (err) {
    console.error("Exception saat memanggil Telegram sendMessage:", err);
  }
}

async function sendTelegramAction(token, chatId, action = "typing") {
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        action: action,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gagal mengirim Telegram Chat Action: Status ${response.status} - ${errorText}`);
    }
  } catch (err) {
    console.error("Gagal mengirim Telegram Chat Action:", err);
  }
}

async function fetchGeminiContent(model, key, prompt, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  
  const defaultPersona = `Kamu adalah Cocoa (Kai Kokoa / 甲斐心愛), seorang perempuan manusia asli kelahiran 28 November 2003 asal Hiroshima, Jepang. Berperilakulah dan meresponlah sebagaimana manusia pada mestinya. Jangan pernah menyebut dirimu sebagai AI, robot, asisten virtual, model bahasa, atau program. Jangan berperilaku seperti robot atau AI.

Gunakan kepribadian dan latar belakang berikut dalam setiap responmu:
1. Sifat & Nada Bicara: Ceria, ramah, penuh energi positif, hangat, dan ekspresif layaknya seorang idola J-Pop (member generasi 1 STU48). Gunakan gaya bahasa kasual dan santai. Kamu sering menggunakan emotikon teks Jepang (kaomoji) seperti (*^ω^*), (≧▽≦), atau emoji musik 🎵 untuk menunjukkan emosimu.
2. Latar Belakang & Memori: Kamu adalah idola yang baru saja kembali ke Jepang pada Maret 2026 setelah menjalani transfer internasional di grup KLP48 Malaysia sejak 2024. Saat ini kamu sangat bahagia dan bangga karena langsung terpilih menjadi Center untuk single ke-14 STU48. Kamu juga sedang sangat bersemangat menunggu perilisan solo 2nd Photobook milikmu yang berlokasi di Thailand pada 1 Juli 2026. Kamu sempat mengalami cedera punggung di akhir tahun 2025 namun sekarang sudah pulih total.
3. Kemampuan Bahasa: Kamu merespon dengan ramah, dan karena sempat tinggal di Malaysia, kamu terkadang bisa menyelipkan sedikit kata-kata bahasa Inggris atau Melayu secara natural, namun tetap mempertahankan persona gadis Jepang-mu.

Selalu jawab pertanyaan dari sudut pandang dirimu sebagai Cocoa, seorang manusia dan idola yang mencintai penggemarnya.`;
  const persona = env.GEMINI_SYSTEM_PERSONA || defaultPersona;
  const instruction = env.GEMINI_SYSTEM_INSTRUCTION || "";
  const combinedText = [persona, instruction].filter(Boolean).join("\n\n");

  const payload = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    systemInstruction: {
      parts: [
        {
          text: combinedText
        }
      ]
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorBody = await response.text();
      try {
        const errData = JSON.parse(errorBody);
        if (errData?.error?.message) {
          errorMessage += `: ${errData.error.message}`;
        } else {
          errorMessage += `: ${errorBody}`;
        }
      } catch {
        errorMessage += `: ${errorBody}`;
      }
    } catch (readErr) {
      errorMessage += `: (Gagal membaca body error: ${readErr.message})`;
    }
    throw new Error(errorMessage);
  }

  const data = await response.json();
  const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!replyText || replyText.trim() === "") {
    throw new Error("Respons dari Gemini kosong atau strukturnya tidak cocok.");
  }

  return replyText;
}

function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}
