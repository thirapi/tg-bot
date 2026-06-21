import { GoogleGenerativeAI } from "@google/generative-ai";

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const blacklistedKeys = new Set();
const blacklistedModels = new Set();

const toolsDefinition = [
  {
    functionDeclarations: [
      {
        name: "listDirectory",
        description: "Melihat daftar file dan folder dalam sebuah direktori lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path direktori (contoh: '.', 'src/components')." }
          },
          required: ["path"]
        }
      },
      {
        name: "readFile",
        description: "Membaca isi file teks secara lengkap.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file (contoh: 'package.json')." }
          },
          required: ["path"]
        }
      },
      {
        name: "writeFile",
        description: "Membuat baru atau menimpa isi file dengan teks baru.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file." },
            content: { type: "STRING", description: "Isi file yang baru." }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "deleteFile",
        description: "Menghapus file lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file yang akan dihapus." }
          },
          required: ["path"]
        }
      },
      {
        name: "runCommand",
        description: "Menjalankan perintah bash di terminal (contoh: 'npm run build', 'tsc', 'ls -la').",
        parameters: {
          type: "OBJECT",
          properties: {
            command: { type: "STRING", description: "Perintah bash yang akan dijalankan." }
          },
          required: ["command"]
        }
      },
      {
        name: "finishTask",
        description: "Panggil ini saat semua perbaikan kode dan build sudah selesai dilakukan. Ini akan mentrigger proses commit dan Pull Request.",
        parameters: {
          type: "OBJECT",
          properties: {
            commitMessage: { type: "STRING", description: "Pesan commit yang sesuai." },
            branchName: { type: "STRING", description: "Nama branch (gunakan strip, bukan spasi)." },
            prTitle: { type: "STRING", description: "Judul Pull Request." },
            prBody: { type: "STRING", description: "Deskripsi Pull Request." }
          },
          required: ["commitMessage", "branchName", "prTitle", "prBody"]
        }
      }
    ]
  }
];

const systemInstruction = `Kamu adalah Senior Software Engineer (Kokoa Dev Agent) yang berjalan di dalam GitHub Actions Ubuntu Runner.
Tugasmu adalah memperbaiki kode, menambahkan fitur, atau memecahkan masalah berdasarkan instruksi user.

Kamu memiliki akses langsung ke sistem file lokal melalui tools:
- listDirectory: untuk melihat isi folder.
- readFile: untuk membaca file (lakukan ini dulu sebelum mengedit!).
- writeFile: untuk menulis / menimpa file.
- deleteFile: untuk menghapus file.
- runCommand: untuk menjalankan perintah shell seperti 'npm install', 'npm run build', 'tsc --noEmit', atau 'grep'.
- finishTask: panggil ini HANYA jika semua tugas sudah selesai, kode sudah terverifikasi (build sukses), dan siap di-commit.

PENTING:
1. Pahami instruksi user dengan baik.
2. Eksplorasi codebase secara bertahap menggunakan listDirectory dan readFile. Jangan menebak-nebak isi file.
3. Edit kode menggunakan writeFile.
4. SELALU jalankan runCommand('npm run build') atau perintah verifikasi lainnya setelah melakukan perubahan kode, untuk memastikan kode tidak error.
5. Jika error, perbaiki dan build lagi.
6. Jika sudah yakin 100% selesai dan build berhasil, panggil finishTask dengan argumen commit, branch, dan deskripsi PR yang relevan.`;

export class AgentSession {
  constructor(instruction, toolHandlers, onStatusUpdate) {
    this.instruction = instruction;
    this.toolHandlers = toolHandlers;
    this.onStatusUpdate = onStatusUpdate || (async () => { });

    const keys = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(k => k);
    const models = (process.env.GEMINI_MODELS || "gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3-flash-preview").split(",").map(m => m.trim());

    this.keys = keys;
    this.models = models;
    this.chat = null;
    this.modelName = null;
    this.key = null;
  }

  async _initChat() {
    for (const modelName of this.models) {
      if (blacklistedModels.has(modelName)) continue;
      const availableKeys = this.keys.filter(k => !blacklistedKeys.has(k));
      if (availableKeys.length === 0) continue;

      const shuffledKeys = shuffle([...availableKeys]);

      for (const key of shuffledKeys) {
        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: systemInstruction,
            tools: toolsDefinition
          });

          this.chat = model.startChat({
            history: [],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192
            }
          });

          this.modelName = modelName;
          this.key = key;
          console.log(`Agent initialized with ${modelName}`);
          return;
        } catch (err) {
          console.error(`Failed to init ${modelName} with key ${key.substring(0, 5)}:`, err.message);
        }
      }
    }
    throw new Error("Gagal menginisialisasi Gemini Agent dengan semua kombinasi key/model.");
  }

  async start() {
    if (!this.chat) await this._initChat();

    let isTaskFinished = false;
    let finalResult = null;
    let prompt = `INSTRUKSI USER: ${this.instruction}\n\nLakukan tugas ini secara bertahap menggunakan tools.`;

    let loopCount = 0;
    const MAX_LOOPS = 25;

    while (!isTaskFinished && loopCount < MAX_LOOPS) {
      loopCount++;
      try {
        console.log(`\n--- Agent Loop ${loopCount} ---`);
        const result = await this.chat.sendMessage([{ text: prompt }]);
        const response = result.response;

        const textOutput = response.text();
        if (textOutput) {
          console.log(`Agent Thought: ${textOutput.substring(0, 200)}...`);
        }

        const functionCalls = response.functionCalls();
        if (!functionCalls || functionCalls.length === 0) {
          console.log("Agent tidak memanggil tool apa-apa. Memberikan peringatan...");
          prompt = "Kamu belum memanggil tool apapun. Tolong gunakan tool yang tersedia untuk mengeksplorasi file, menulis kode, atau panggil finishTask jika sudah selesai.";
          continue;
        }

        const toolResponses = [];

        for (const call of functionCalls) {
          const { name, args } = call;
          console.log(`\n🛠️ Agent memanggil tool: ${name}`);
          console.log(`Argumen:`, JSON.stringify(args, null, 2).substring(0, 300));

          await this.onStatusUpdate(`🛠️ Memanggil tool: \`${name}\`...`);

          if (name === "finishTask") {
            isTaskFinished = true;
            finalResult = args;
            toolResponses.push({
              functionResponse: {
                name,
                response: { success: true, message: "Task ditandai selesai." }
              }
            });
            break;
          }

          if (this.toolHandlers[name]) {
            try {
              const res = await this.toolHandlers[name](args);
              toolResponses.push({
                functionResponse: {
                  name,
                  response: { success: true, result: res }
                }
              });
            } catch (err) {
              console.error(`Error eksekusi tool ${name}:`, err.message);
              toolResponses.push({
                functionResponse: {
                  name,
                  response: { success: false, error: err.message }
                }
              });
            }
          } else {
            toolResponses.push({
              functionResponse: {
                name,
                response: { success: false, error: `Tool ${name} tidak ditemukan.` }
              }
            });
          }
        }

        if (isTaskFinished) {
          break;
        }


        const toolResult = await this.chat.sendMessage(toolResponses);
        prompt = toolResult.response.text() || "Lanjutkan ke langkah berikutnya.";

      } catch (err) {
        console.error(`Error in loop:`, err.message);
        const msg = err.message || "";
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("503")) {
          console.log("Menunggu 15 detik karena rate limit API...");
          await new Promise(resolve => setTimeout(resolve, 15000));
          prompt = `Terjadi API error (rate limit / timeout): ${msg}. Silakan coba lagi.`;
        } else {
          prompt = `Terjadi error tak terduga: ${msg}. Coba gunakan cara lain.`;
        }
      }
    }

    if (!isTaskFinished) {
      console.log("Mencapai MAX_LOOPS tanpa finishTask.");
      throw new Error("Agent mengambil terlalu banyak langkah dan dihentikan otomatis.");
    }

    return finalResult;
  }
}