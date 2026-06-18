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
  const models = (process.env.GEMINI_MODELS || "gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.5-flash").split(",").map(m => m.trim());

  const prompt = `
Kamu adalah Senior Software Engineer yang membantu memperbaiki kode di GitHub Actions.

INSTRUKSI USER:
${instruction}

ERROR LOG:
\`\`\`
${errorLog || "Tidak ada error log"}
\`\`\`

KONTEKS FILE SAAT INI:
${fileContexts.map(f => `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}

ATURAN OUTPUT (WAJIB):
Jawab HANYA dengan JSON murni tanpa teks tambahan apapun, tanpa markdown, tanpa \`\`\`json.
Gunakan format berikut persis:

{
  "explanation": "Penjelasan singkat tentang apa yang dilakukan",
  "needsBuild": true/false,
  "changes": [
    {
      "path": "path/ke/file.js",
      "content": "isi lengkap file yang sudah diperbaiki atau dibuat"
    }
  ]
}

Catatan: needsBuild = true jika perubahan mempengaruhi kode .js/.ts, package.json atau build. needsBuild = false jika hanya dokumentasi atau tidak mempengaruhi kode.
`;

  const blacklistedKeys = new Set();
  const blacklistedModels = new Set();

  for (const modelName of models) {
    if (blacklistedModels.has(modelName)) continue;

    const availableKeys = keys.filter(k => !blacklistedKeys.has(k));
    if (availableKeys.length === 0) continue;

    const shuffledKeys = shuffle([...availableKeys]);

    for (const key of shuffledKeys) {
      try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          }
        });

        const response = await result.response;
        let text = response.text().trim();

        text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

        const parsed = JSON.parse(text);

        if (!parsed.explanation || !Array.isArray(parsed.changes)) {
          throw new Error("JSON format tidak sesuai");
        }

        return parsed;

      } catch (error) {
        const msg = error.message || "";
        console.error(`Error dengan ${modelName} [${key.substring(0, 6)}...]: ${msg}`);

        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("timeout") || msg.includes("503") || msg.includes("500")) {
          blacklistedKeys.add(key);
          continue;
        }
        if (msg.includes("404") || msg.includes("400") || msg.includes("not found")) {
          blacklistedModels.add(modelName);
          break;
        }
        blacklistedKeys.add(key);
      }
    }
  }

  throw new Error("Seluruh model dan kunci Gemini gagal merespon setelah mencoba seluruh kombinasi.");
}