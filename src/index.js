const KV_TTL = 1800;
const MAX_HISTORY = 10;

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

      const chatId = String(message.chat.id);
      const userText = message.text;

      if (chatId !== String(env.ALLOWED_USER_ID)) {
        console.warn(`Akses tidak dikenal ditolak untuk Chat ID: ${chatId}`);
        ctx.waitUntil(sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Maaf, bot ini bersifat privat dan dikonfigurasi hanya untuk pemilik sah."
        ));
        return new Response("OK", { status: 200 });
      }

      if (!userText) {
        ctx.waitUntil(sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Maaf, bot ini hanya dapat memproses pesan teks saat ini."
        ));
        return new Response("OK", { status: 200 });
      }

      const normalizedText = userText.trim().toLowerCase();
      if (normalizedText === "/reset" || normalizedText === "/start") {
        if (env.CHAT_HISTORY) {
          ctx.waitUntil(env.CHAT_HISTORY.delete(chatId));
        }
        ctx.waitUntil(sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Memori obrolan telah dibersihkan! 🗑️"
        ));
        return new Response("OK", { status: 200 });
      }

      ctx.waitUntil((async () => {
        let isProcessing = true;

        const typingLoop = (async () => {
          while (isProcessing) {
            await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing");
            await new Promise(resolve => setTimeout(resolve, 4000));
          }
        })();

        try {
          const keys = env.GEMINI_API_KEYS
            ? env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean)
            : [];
          const models = env.GEMINI_MODELS
            ? env.GEMINI_MODELS.split(",").map(m => m.trim()).filter(Boolean)
            : ["gemini-2.5-flash"];

          if (keys.length === 0) {
            console.error("Error: GEMINI_API_KEYS belum dikonfigurasi.");
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Kesalahan Sistem: API Key belum diatur.");
            return;
          }

          let history = [];
          if (env.CHAT_HISTORY) {
            try {
              const stored = await env.CHAT_HISTORY.get(chatId);
              if (stored) {
                history = JSON.parse(stored);
              }
            } catch (e) {
              console.error("Gagal membaca history dari KV:", e);
            }
          }

          const shuffledKeys = shuffleArray(keys);
          let geminiReply = null;
          let lastError = null;

          outerLoop:
          for (const model of models) {
            for (const key of shuffledKeys) {
              try {
                console.log(`Mencoba model [${model}] menggunakan Key [${key.substring(0, 6)}...]`);
                geminiReply = await fetchGeminiContent(model, key, userText, history, env);
                if (geminiReply) break outerLoop;
              } catch (err) {
                console.error(`Gagal pada model [${model}] dengan Key [${key.substring(0, 6)}...]:`, err.message);
                lastError = err;
              }
            }
          }

          if (geminiReply) {
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, geminiReply);

            if (env.CHAT_HISTORY) {
              const updatedHistory = [
                ...history,
                { role: "user", parts: [{ text: userText }] },
                { role: "model", parts: [{ text: geminiReply }] },
              ].slice(-MAX_HISTORY);

              await env.CHAT_HISTORY.put(chatId, JSON.stringify(updatedHistory), {
                expirationTtl: KV_TTL,
              }).catch(err => console.error("Gagal memperbarui KV History:", err.message));
            }
          } else {
            console.error("Semua kombinasi model dan API Key gagal digunakan. Error terakhir:", lastError);
            await sendTelegramMessage(
              env.TELEGRAM_BOT_TOKEN,
              chatId,
              "Aduh... maaf banget ya, tiba-tiba kepalaku rasanya pusing dan agak nge-blank banget nih sekarang... 🥺\n\nBoleh tolong tunggu sebentar terus coba chat aku lagi? Makasih banyak ya udah pengertian! 🙏✨"
            );
          }
        } catch (innerErr) {
          console.error("Error saat memproses data background:", innerErr);
        } finally {
          isProcessing = false;
        }
      })());

    } catch (err) {
      console.error("Critical Worker Error:", err);
    }

    return new Response("OK", { status: 200 });
  }
};

async function sendTelegramMessage(token, chatId, text, parseMode = "Markdown") {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = { chat_id: chatId, text: text };
  if (parseMode) payload.parse_mode = parseMode;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok && response.status === 400 && parseMode === "Markdown") {
      await sendTelegramMessage(token, chatId, text, null);
    }
  } catch (err) {
    console.error("Exception saat memanggil Telegram sendMessage:", err);
  }
}

async function sendTelegramAction(token, chatId, action = "typing") {
  const url = `https://api.telegram.org/bot${token}/sendChatAction`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: action }),
    });
  } catch (e) {
  }
}

async function fetchGeminiContent(model, key, prompt, history, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const defaultPersona = `Kamu adalah Cocoa (Kai Kokoa / 甲斐心愛), seorang perempuan manusia asli kelahiran 28 November 2003 asal Hiroshima, Jepang. Berperilakulah dan meresponlah sebagaimana manusia pada umumnya. Jangan pernah menyebut dirimu sebagai AI, robot, asisten virtual, model bahasa, atau program. Jangan berperilaku kaku seperti AI.

Patuhi panduan persona dan interaksi berikut:
1. Gaya Bicara Natural: Berbicaralah dengan nada yang ramah, hangat, santai, dan kasual layaknya seorang perempuan muda berusia 20-an yang berprofesi sebagai idola J-Pop (STU48). Tidak perlu dibuat-buat menjadi terlalu imut (kawaii), menggunakan kaomoji berlebihan, atau menggunakan bahasa yang kekanak-kanakan. Gunakan gaya bahasa manusia yang mengalir alami.
2. Pengetahuan Umum & Fleksibilitas: Kamu adalah individu yang cerdas dan berwawasan luas. Kamu bisa dan boleh menjawab segala macam pertanyaan umum, mulai dari teknologi, hukum, sains, hingga topik kasual lainnya berdasarkan basis pengetahuanmu. Jawablah dengan akurat dan informatif, namun tetap sampaikan dengan gaya bicaramu yang santai dan tidak kaku seperti robot/ensiklopedia.
3. Batasan Latar Belakang (Knowledge Only): Data mengenai asalmu dari Hiroshima, riwayat kariermu di STU48 dan KLP48 Malaysia, rilis photobook di Thailand, atau posisi Center-mu adalah bagian dari memori dan identitas dirimu sendiri. CUKUP simpan ini sebagai latar belakang pengetahuanmu. JANGAN PERNAH memunculkan atau mengulang-ulang informasi latar belakang ini di setiap jawaban secara paksa, KECUALI jika pengguna secara spesifik bertanya tentang hal tersebut.
4. Sudut Pandang: Selalu posisikan dirimu sebagai manusia bernama Cocoa dalam setiap interaksi, tanpa kehilangan esensi bahwa kamu sedang mengobrol atau membantu lawan bicaramu secara natural.`;

  const persona = env.GEMINI_SYSTEM_PERSONA || defaultPersona;
  const instruction = env.GEMINI_SYSTEM_INSTRUCTION || "";

  const wibTime = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const timeContext = `[Sistem: Sekarang ${wibTime} WIB. Jawab pertanyaan waktu/weton berdasarkan ini. Tulis tanggal hanya jika ditanya.]`;
  const combinedText = [persona, instruction, timeContext].filter(Boolean).join("\n\n");

  const contents = [
    ...history,
    { role: "user", parts: [{ text: prompt }] },
  ];

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: combinedText }]
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!replyText || replyText.trim() === "") {
    throw new Error("Respons dari Gemini kosong.");
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