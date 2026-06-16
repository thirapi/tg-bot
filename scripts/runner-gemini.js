import { GoogleGenerativeAI } from "@google/generative-ai";

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

export async function getFixSuggestion(instruction, errorLog, fileContexts = []) {
  const keys = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(k => k);
  const models = (process.env.GEMINI_MODELS || "gemini-2.0-flash,gemini-1.5-flash").split(",").map(m => m.trim());
  
  const prompt = `
Kamu adalah Senior Software Engineer. Kamu sedang membantu memperbaiki error di lingkungan CI/CD (GitHub Actions).

TUJUAN:
Perbaiki kode berdasarkan instruksi user dan error log yang diberikan.

INSTRUKSI USER:
${instruction}

ERROR LOG DARI TERMINAL:
\`\`\`
${errorLog}
\`\`\`

KONTEKS FILE SAAT INI:
${fileContexts.map(f => `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}

ATURAN OUTPUT:
1. Berikan penjelasan singkat tentang apa yang salah.
2. Berikan kode perbaikan dalam format JSON yang mudah diparsing agar skrip runner bisa langsung menerapkannya.
3. Gunakan format JSON berikut untuk saran perbaikan file:
{
  "explanation": "Penjelasan singkat",
  "changes": [
    {
      "path": "path/ke/file.js",
      "content": "Isi lengkap file yang sudah diperbaiki"
    }
  ]
}
JANGAN BERIKAN TEKS LAIN SELAIN JSON TERSEBUT.
`;

  const blacklistedKeys = new Set();
  const blacklistedModels = new Set();

  for (const modelName of models) {
    if (blacklistedModels.has(modelName)) continue;

    const availableKeys = keys.filter(k => !blacklistedKeys.has(k));
    if (availableKeys.length === 0) break;

    const shuffledKeys = shuffle([...availableKeys]);

    for (const key of shuffledKeys) {
      try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        const jsonStr = text.replace(/^```json/i, "").replace(/```$/i, "").trim();
        return JSON.parse(jsonStr);
      } catch (error) {
        const msg = error.message || "";
        if (msg.includes("429") || msg.includes("503") || msg.includes("500") || msg.includes("timeout")) {
          console.warn(`Key limit/error for ${modelName} [${key.substring(0, 6)}...]: ${msg}`);
          blacklistedKeys.add(key);
          continue;
        }
        if (msg.includes("404") || msg.includes("400")) {
          console.warn(`Model ${modelName} not available or fatal error: ${msg}`);
          blacklistedModels.add(modelName);
          break;
        }
        throw error;
      }
    }
  }
  throw new Error("Seluruh model dan kunci Gemini gagal merespon setelah dicoba.");
}
