const KV_TTL = 3600;
const MAX_HISTORY = 10;
const RATE_LIMIT_SECONDS = 3;
const MAX_AGENT_ITERATIONS = 5;
const activeRateLimits = new Set();

const githubTools = [
  {
    functionDeclarations: [
      {
        name: "listGitHubIssues",
        description: "Mengambil daftar issue dari repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username atau organisasi pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            state: { type: "STRING", description: "Status issue: 'open', 'closed', atau 'all'.", enum: ["open", "closed", "all"] },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "getPRDiff",
        description: "Mengambil diff (perubahan kode) mentah dari Pull Request di GitHub.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username atau organisasi pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            pull_number: { type: "NUMBER", description: "Nomor Pull Request." },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "createGitHubIssue",
        description: "Membuat issue baru di repositori GitHub tertentu.",
        parameters: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING", description: "Username atau organisasi pemilik repo." },
            repo: { type: "STRING", description: "Nama repositori." },
            title: { type: "STRING", description: "Judul issue." },
            body: { type: "STRING", description: "Isi atau deskripsi issue." },
            labels: { type: "ARRAY", items: { type: "STRING" }, description: "Daftar label untuk issue." },
          },
          required: ["owner", "repo", "title"],
        },
      },
    ],
  },
];

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    try {
      const payload = await request.json();
      const message = payload.message || payload.edited_message;
      if (!message || !message.chat || !message.chat.id) return new Response("OK", { status: 200 });
      const chatId = String(message.chat.id);
      if (chatId !== String(env.ALLOWED_USER_ID)) return new Response("OK", { status: 200 });

      const lockKey = `lock:${chatId}`;
      const isLocked = await env.CHAT_HISTORY.get(lockKey);
      if (isLocked) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Sabar ya, aku masih memproses permintaanmu sebelumnya! ⏳");
        return new Response("OK", { status: 200 });
      }
      await env.CHAT_HISTORY.put(lockKey, "1", { expirationTtl: 60 });

      if (activeRateLimits.has(chatId)) {
        await env.CHAT_HISTORY.delete(lockKey);
        return new Response("OK", { status: 200 });
      }
      activeRateLimits.add(chatId);
      setTimeout(() => activeRateLimits.delete(chatId), RATE_LIMIT_SECONDS * 1000);

      const text = message.text || message.caption || "";
      const normalizedText = text.trim().toLowerCase();
      if (normalizedText === "/start" || normalizedText === "/reset") {
        await env.CHAT_HISTORY.delete(chatId);
        await env.CHAT_HISTORY.delete(lockKey);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Memori telah dibersihkan. Cocoa siap membantu! 🚀");
        return new Response("OK", { status: 200 });
      }

      if (normalizedText === "/help") {
        const helpIR = {
          blocks: [
            { type: "heading", text: "Daftar Perintah" },
            { type: "list", items: ["/start - Memulai bot", "/reset - Menghapus riwayat", "/help - Bantuan"] },
            { type: "heading", text: "Kemampuan Cocoa" },
            { type: "list", items: ["📂 Kelola Issue GitHub", "🔍 Review Pull Request", "💬 Chat Semantic & Aman"] }
          ]
        };
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpIR);
        await env.CHAT_HISTORY.delete(lockKey);
        return new Response("OK", { status: 200 });
      }

      ctx.waitUntil(processMessage(message, env));
      return new Response("OK", { status: 200 });
    } catch (err) {
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

async function processMessage(message, env) {
  const chatId = String(message.chat.id);
  const lockKey = `lock:${chatId}`;
  let isProcessing = true;
  const sendTyping = async () => {
    if (!isProcessing) return;
    try { await sendTelegramAction(env.TELEGRAM_BOT_TOKEN, chatId, "typing"); } catch (e) {}
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
      mediaData = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, message.photo[message.photo.length - 1].file_id, "image/jpeg");
      if (!userPrompt) userPrompt = "Apa yang ada di foto ini?";
    } else if (message.voice) {
      mediaData = await prepareMediaPart(env.TELEGRAM_BOT_TOKEN, message.voice.file_id, "audio/ogg");
      if (!userPrompt) userPrompt = "Jelaskan isi suara ini.";
    }

    if (!userPrompt && !mediaData) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Maaf, Cocoa bingung harus merespon apa. 😅");
      return;
    }

    const keys = env.GEMINI_API_KEYS.split(",").map(k => k.trim());
    const models = (env.GEMINI_MODELS || "gemini-2.0-flash-exp").split(",").map(m => m.trim());
    let userParts = [{ text: userPrompt }];
    if (mediaData) userParts.push(mediaData);
    let currentContents = [...history, { role: "user", parts: userParts }];

    let iteration = 0;
    let finalGeminiIR = null;
    while (iteration < MAX_AGENT_ITERATIONS) {
      iteration++;
      let geminiResponse = null;
      let lastError = null;
      outerLoop: for (const model of models) {
        for (const key of shuffleArray(keys)) {
          try {
            geminiResponse = await fetchGeminiGenerate(model, key, currentContents, env);
            if (geminiResponse) break outerLoop;
          } catch (err) { lastError = err; }
        }
      }

      if (!geminiResponse) throw lastError || new Error("Gemini API failed.");
      const candidate = geminiResponse.candidates?.[0];
      const modelContent = candidate?.content;
      if (!modelContent) throw new Error("Empty content.");
      currentContents.push(modelContent);

      const parts = modelContent.parts || [];
      const functionCalls = parts.filter(p => p.functionCall);
      const textPart = parts.find(p => p.text);

      if (functionCalls.length > 0) {
        const functionResponses = [];
        for (const call of functionCalls) {
          const { name, args } = call.functionCall;
          let result;
          try { result = await executeTool(name, args, env); } catch (e) { result = { error: e.message }; }
          functionResponses.push({ functionResponse: { name, response: { content: result } } });
        }
        currentContents.push({ role: "tool", parts: functionResponses });
        continue;
      }

      if (textPart) {
        try {
          const cleanJson = textPart.text.replace(/```json\n?|\n?```/g, "").trim();
          finalGeminiIR = JSON.parse(cleanJson);
        } catch (e) {
          finalGeminiIR = { blocks: [{ type: "paragraph", text: textPart.text }] };
        }
        break;
      }
      break;
    }

    if (finalGeminiIR) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, finalGeminiIR);
      let newHistory = currentContents.slice(-(MAX_HISTORY * 4));
      while (newHistory.length > 0 && newHistory[0].role !== "user") newHistory.shift();
      await env.CHAT_HISTORY.put(chatId, JSON.stringify(newHistory), { expirationTtl: KV_TTL });
    }
  } catch (err) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Aduh, sepertinya ada gangguan teknis. 🙏");
  } finally {
    isProcessing = false;
    await env.CHAT_HISTORY.delete(lockKey).catch(() => {});
  }
}

async function executeTool(name, args, env) {
  switch (name) {
    case "listGitHubIssues": return await callGitHubAPI(env, `repos/${args.owner}/${args.repo}/issues?state=${args.state || "open"}`);
    case "getPRDiff": return await callGitHubAPI(env, `repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`, "GET", null, { Accept: "application/vnd.github.v3.diff" });
    case "createGitHubIssue": return await callGitHubAPI(env, `repos/${args.owner}/${args.repo}/issues`, "POST", { title: args.title, body: args.body, labels: args.labels });
    default: throw new Error(`Tool ${name} not implemented.`);
  }
}

async function fetchGeminiGenerate(model, key, contents, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const systemPersona = env.GEMINI_SYSTEM_PERSONA || "Kamu adalah Cocoa, asisten digital yang ramah.";
  const semanticInstruction = `WAJIB: Kamu harus merespon HANYA dengan format JSON Semantic Document IR. JANGAN GUNAKAN MARKDOWN.
Skema JSON:
{
  "blocks": [
    { "type": "heading", "text": "Judul (Huruf Besar Otomatis)" },
    { "type": "paragraph", "text": "Isi teks polos" },
    { "type": "paragraph", "content": [ { "text": "teks", "bold": true }, { "text": "link", "link": "https://..." } ] },
    { "type": "list", "items": ["poin 1", "poin 2"] },
    { "type": "code", "text": "kode program" },
    { "type": "quote", "text": "kutipan" },
    { "type": "table", "headers": ["Kolom A", "Kolom B"], "rows": [["Data 1", "Data 2"]] }
  ]
}
Gunakan 'heading' untuk judul bagian, 'table' untuk data tabular, dan 'content' array di dalam 'paragraph' jika butuh format bold atau link.`;
  const finalSystemInstruction = [systemPersona, semanticInstruction].join("\n\n");
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: finalSystemInstruction }] },
    tools: githubTools,
    generationConfig: { temperature: 0.5, topP: 0.95, maxOutputTokens: 8192, response_mime_type: "application/json" }
  };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Gemini Error: ${res.status}`);
  return await res.json();
}

async function callGitHubAPI(env, endpoint, method = "GET", body = null, extraHeaders = {}) {
  const url = `https://api.github.com/${endpoint.replace(/^\//, "")}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_PAT_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "Cocoa-Bot", ...extraHeaders };
  const options = { method, headers };
  if (body) { options.body = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`GitHub Error: ${res.status}`);
  const ct = res.headers.get("content-type");
  return ct && ct.includes("application/json") ? await res.json() : await res.text();
}

function generateASCIITable(headers, rows) {
  if (!headers || headers.length === 0) return "";
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || "").length)));
  const separator = "+" + colWidths.map(w => "-".repeat(w + 2)).join("+") + "+";
  const formatRow = (row) => "| " + row.map((cell, i) => String(cell || "").padEnd(colWidths[i])).join(" | ") + " |";
  let table = separator + "\n" + formatRow(headers) + "\n" + separator + "\n";
  rows.forEach(row => { table += formatRow(row) + "\n"; });
  return table + separator;
}

function renderSemanticIR(ir) {
  let finalText = "";
  const entities = [];
  const addText = (text, type, data = {}) => {
    if (!text) return;
    const startOffset = finalText.length;
    finalText += text;
    if (type) entities.push({ type, offset: startOffset, length: text.length, ...data });
  };

  if (!ir || !ir.blocks) return { text: typeof ir === "string" ? ir : JSON.stringify(ir), entities: [] };
  ir.blocks.forEach(block => {
    switch (block.type) {
      case "heading": addText(block.text.toUpperCase(), "bold"); finalText += "\n\n"; break;
      case "paragraph":
        if (Array.isArray(block.content)) {
          block.content.forEach(span => {
            let type = span.bold ? "bold" : (span.italic ? "italic" : (span.link ? "text_link" : null));
            addText(span.text, type, span.link ? { url: span.link } : {});
          });
        } else addText(block.text || "");
        finalText += "\n\n"; break;
      case "table": addText(generateASCIITable(block.headers, block.rows), "pre"); finalText += "\n\n"; break;
      case "code": addText(block.text, "pre"); finalText += "\n\n"; break;
      case "quote": addText("> " + block.text); finalText += "\n\n"; break;
      case "list": (block.items || []).forEach(item => addText("• " + item + "\n")); finalText += "\n"; break;
    }
  });
  return { text: finalText.trim(), entities };
}

async function sendTelegramMessage(token, chatId, ir) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const { text, entities } = renderSemanticIR(ir);
  const MAX_LENGTH = 4000;
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunkText = text.substring(i, i + MAX_LENGTH);
    const chunkEntities = entities.filter(e => e.offset >= i && e.offset < i + MAX_LENGTH).map(e => ({ ...e, offset: e.offset - i }));
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunkText, entities: chunkEntities }) });
    if (!res.ok) await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: chunkText }) });
  }
}

async function sendTelegramAction(token, chatId, action) {
  return fetch(`https://api.telegram.org/bot${token}/sendChatAction`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, action }) });
}

async function prepareMediaPart(token, fileId, mimeType) {
  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) return null;
  const mediaRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`);
  const buffer = await mediaRes.arrayBuffer();
  return { inline_data: { mime_type: mimeType, data: btoa(String.fromCharCode(...new Uint8Array(buffer))) } };
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
