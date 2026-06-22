import { GoogleGenerativeAI } from "@google/generative-ai";
import { execSync } from "child_process";

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const blacklistedKeys = new Set();
const blacklistedModels = new Set();
const blacklistedCombos = new Set();

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
            prBody: { type: "STRING", description: "Deskripsi Pull Request." },
            hasModifications: { type: "BOOLEAN", description: "Set ke true jika kamu telah melakukan perubahan file menggunakan writeFile. Set ke false jika tidak ada file yang perlu diubah (misal karena kode sudah benar)." }
          },
          required: ["commitMessage", "branchName", "prTitle", "prBody", "hasModifications"]
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

PENTING - BACA DENGAN SEKSAMA:
1. LANGKAH 1 (Eksplorasi): Gunakan \`listDirectory\` dan \`readFile\` untuk memahami isi proyek.
2. LANGKAH 2 (Eksekusi): Kamu WAJIB menggunakan tool \`writeFile\` untuk membuat atau mengedit file sesuai instruksi user. Jangan berhalusinasi telah membuat file jika kamu belum memanggil tool ini.
3. JANGAN PERNAH memanggil \`finishTask\` jika kamu belum melakukan modifikasi kode menggunakan \`writeFile\`.
4. KAMU SUDAH DI ROOT REPO. Langsung buat file di direktori \`./\` (JANGAN gunakan \`mkdir\` atau \`git init\`).
5. JANGAN PERNAH gunakan \`git add\`, \`git commit\`, atau \`git push\`. Executor akan melakukannya otomatis.
6. JANGAN PERNAH menulis atau mengedit file (terutama berkas konfigurasi panjang atau workflow GitHub Actions) menggunakan tool \`runCommand\` (seperti \`echo "..." > file\`). Gunakan selalu tool \`writeFile\` untuk mencegah pemotongan karakter atau error interpretasi shell (bad substitution).
7. Perintah \`cd\` di dalam \`runCommand\` tidak bersifat persisten ke pemanggilan tool berikutnya. Jika kamu perlu menjalankan perintah di direktori lain, gabungkan dengan operator '&&' (contoh: \`cd folder && npm run build\`).
8. LANGKAH 3 (Verifikasi): Jika memungkinkan, jalankan perintah tes (contoh: \`npm run build\`).
9. LANGKAH 4 (Selesai): Jika seluruh instruksi user sudah diimplementasikan dan diverifikasi, panggil \`finishTask\`.`;

export class AgentSession {
  constructor(instruction, toolHandlers, onStatusUpdate) {
    this.instruction = instruction;
    this.toolHandlers = toolHandlers;
    this.onStatusUpdate = onStatusUpdate || (async () => { });

    const keys = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(k => k);
    
    // Prioritas model yang diutamakan oleh Kokoa runner
    const modelPriority = [
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite"
    ];
    
    const rawModels = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.1-flash-lite").split(",").map(m => m.trim());
    const sortedModels = rawModels.sort((a, b) => {
      let idxA = modelPriority.indexOf(a);
      let idxB = modelPriority.indexOf(b);
      if (idxA === -1) idxA = 999;
      if (idxB === -1) idxB = 999;
      return idxA - idxB;
    });

    this.keys = keys;
    this.models = sortedModels;
    this.chat = null;
    this.modelName = null;
    this.key = null;
  }

  async _initChat(history = []) {
    for (const modelName of this.models) {
      if (blacklistedModels.has(modelName)) continue;
      const availableKeys = this.keys.filter(k => !blacklistedKeys.has(k));
      if (availableKeys.length === 0) continue;

      const shuffledKeys = shuffle([...availableKeys]);

      for (const key of shuffledKeys) {
        const comboId = `${key}:${modelName}`;
        if (blacklistedCombos.has(comboId)) continue;

        try {
          const genAI = new GoogleGenerativeAI(key);
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: systemInstruction,
            tools: toolsDefinition
          });

          this.chat = model.startChat({
            history: history,
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

  async validateTaskCompletion() {
    try {
      // Stage untracked files sebagai intent-to-add agar muncul di git diff
      try {
        execSync('git add -N .', { encoding: 'utf8' });
      } catch (e) {
        console.warn("Gagal menjalankan git add -N:", e.message);
      }
      const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      const gitDiff = execSync('git diff', { encoding: 'utf8' }).trim();

      const prompt = `Kamu adalah sistem validator independen. Tugasmu adalah memeriksa apakah Agen Pengembang (Kokoa Dev Agent) telah menyelesaikan instruksi pengguna secara lengkap dan benar.

Instruksi Pengguna:
"${this.instruction}"

Status Git Workspace Saat Ini (git status):
${status || "(tidak ada perubahan file)"}

Detail Perubahan (git diff):
${gitDiff.substring(0, 10000) || "(tidak ada perbedaan/file baru)"}

Analisis apakah seluruh file, konfigurasi, dan modifikasi yang diminta atau tersirat dalam instruksi pengguna telah diimplementasikan dengan benar.
Khususnya, pastikan tidak ada file utama yang terlewat (misal: jika diminta membuat landing page React, pastikan file index.html atau App.jsx/App.tsx benar-benar dibuat dan diubah, bukan hanya file style/css saja).
Pastikan juga konfigurasi eksternal (seperti GitHub Actions workflow jika diminta) sudah dibuat dengan lengkap.

Format keluaran kamu harus berupa JSON dengan skema berikut:
{
  "isComplete": boolean,
  "reason": "Penjelasan detail mengapa belum lengkap, sebutkan file atau bagian kode yang kurang jika isComplete bernilai false. Jika isComplete bernilai true, berikan penjelasan singkat keberhasilan."
}`;

      const genAI = new GoogleGenerativeAI(this.key);
      const model = genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        }
      });

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const validation = JSON.parse(responseText);
      return validation;
    } catch (error) {
      console.error("Gagal menjalankan validasi LLM:", error);
      const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
      return {
        isComplete: !!status,
        reason: status ? "Validasi LLM gagal, menggunakan fallback git status." : "Tidak ada perubahan terdeteksi di git status."
      };
    }
  }

  async _sendWithRetry(messageInput) {
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const result = await this.chat.sendMessage(messageInput);
        return result.response;
      } catch (err) {
        const msg = err.message || "";
        const isRateLimit = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("503") || msg.includes("quota");

        if (isRateLimit && attempts < maxAttempts) {
          console.log(`[Rate Limit / API Error] Gagal menggunakan ${this.modelName} dengan key ${this.key.substring(0, 5)}: ${msg}`);
          console.log(`Menambahkan combo ${this.key.substring(0, 5)}:${this.modelName} ke blacklist.`);
          blacklistedCombos.add(`${this.key}:${this.modelName}`);

          const history = this.chat ? [...this.chat.history] : [];
          if (history.length > 0 && history[history.length - 1].role === 'user') {
            console.log("Menghapus turn user yang belum terkirim dari history...");
            history.pop();
          }

          console.log("Menunggu 5 detik sebelum rotasi key/model...");
          await new Promise(resolve => setTimeout(resolve, 5000));

          try {
            await this._initChat(history);
            console.log(`Rotasi sukses. Melakukan percobaan ulang (${attempts}/${maxAttempts})...`);
            continue;
          } catch (rotateErr) {
            console.error("Gagal melakukan rotasi key/model:", rotateErr.message);
          }
        }

        throw err;
      }
    }
    throw new Error("Gagal mengirim pesan setelah beberapa kali percobaan rotasi key/model.");
  }

  async start() {
    if (!this.chat) await this._initChat();

    let isTaskFinished = false;
    let finalResult = null;
    let nextMessage = `INSTRUKSI USER: ${this.instruction}\n\nLakukan tugas ini secara bertahap menggunakan tools.`;

    let loopCount = 0;
    const MAX_LOOPS = 25;

    console.log(`\n--- Agent Loop Start ---`);
    let response = await this._sendWithRetry([{ text: nextMessage }]);

    while (!isTaskFinished && loopCount < MAX_LOOPS) {
      loopCount++;
      try {
        console.log(`\n--- Agent Loop ${loopCount} ---`);

        const textOutput = response.text();
        if (textOutput) {
          console.log(`Agent Thought: ${textOutput.substring(0, 200)}...`);
        }

        const functionCalls = response.functionCalls();
        if (!functionCalls || functionCalls.length === 0) {
          console.log("Agent tidak memanggil tool apa-apa. Memberikan peringatan...");
          const nudge = "Kamu belum memanggil tool apapun. Tolong gunakan tool yang tersedia untuk mengeksplorasi file, menulis kode, atau panggil finishTask jika sudah selesai.";
          response = await this._sendWithRetry([{ text: nudge }]);
          continue;
        }

        const toolResponses = [];
        let finishTaskCall = null;

        for (const call of functionCalls) {
          const { name, args } = call;
          console.log(`\n🛠️ Agent memanggil tool: ${name}`);
          console.log(`Argumen:`, JSON.stringify(args, null, 2).substring(0, 300));

          await this.onStatusUpdate(`🛠️ Memanggil tool: \`${name}\`...`);

          if (name === "finishTask") {
            finishTaskCall = { name, args };
            continue;
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

        if (finishTaskCall) {
          const { name, args } = finishTaskCall;
          console.log("Menjalankan validasi LLM dinamis untuk finishTask...");

          const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
          if (args.hasModifications && !status) {
            console.log("Validasi GAGAL: Agen mengklaim ada modifikasi, tapi git status kosong.");
            toolResponses.push({
              functionResponse: {
                name,
                response: {
                  success: false,
                  error: "TUGAS BELUM SELESAI! Kamu mengklaim telah melakukan modifikasi (hasModifications: true), tetapi tidak ada file yang dibuat atau diedit di git status. Kamu WAJIB memanggil writeFile untuk melakukan tugas coding sebelum memanggil finishTask."
                }
              }
            });
          } else {
            const validation = await this.validateTaskCompletion();
            if (!validation.isComplete) {
              console.log(`Validasi GAGAL: ${validation.reason}`);
              toolResponses.push({
                functionResponse: {
                  name,
                  response: {
                    success: false,
                    error: `TUGAS BELUM LENGKAP! Berdasarkan analisis repositori: ${validation.reason}. Silakan selesaikan sisa tugas sebelum memanggil finishTask kembali.`
                  }
                }
              });
            } else {
              console.log("Validasi SUKSES! Mengakhiri tugas.");
              isTaskFinished = true;
              finalResult = args;
              toolResponses.push({
                functionResponse: {
                  name,
                  response: { success: true, message: "Task ditandai selesai." }
                }
              });
            }
          }
        }

        response = await this._sendWithRetry(toolResponses);

      } catch (err) {
        console.error(`Error in loop:`, err.message);
        try {
          response = await this._sendWithRetry([{ text: `Terjadi error tak terduga: ${err.message}. Coba gunakan cara lain.` }]);
        } catch (innerErr) {
          console.error("Gagal memulihkan dari error tak terduga:", innerErr.message);
          throw err;
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