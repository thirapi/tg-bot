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
        description: "MENULIS file baru atau MENIMPA file yang sudah ada. Untuk file BESAR (>2000 chars), tulis dalam beberapa bagian: panggil pertama dengan append=false (atau tanpa append dulu), lalu panggil berikutnya dengan append=true untuk menambahkan sisanya.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file." },
            content: { type: "STRING", description: "Isi file yang baru atau yang akan ditambahkan." },
            append: { type: "BOOLEAN", description: "Set ke true untuk menambahkan ke file yang sudah ada (append mode). Default false (tulis dari awal)." }
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
        name: "searchInFiles",
        description: "Mencari teks/kata kunci di seluruh file dalam proyek (grep global). Gunakan ini untuk melacak di file dan baris mana suatu fungsi, variabel, atau kode tertentu berada. Mengecualikan node_modules, .next, dist, build.",
        parameters: {
          type: "OBJECT",
          properties: {
            keyword: { type: "STRING", description: "Kata kunci atau pola regex yang ingin dicari." }
          },
          required: ["keyword"]
        }
      },
      {
        name: "patchFile",
        description: "Mengganti sebagian kode (searchBlock) dalam file yang sudah ada dengan kode baru (replaceBlock). Alternatif yang LEBIH AMAN daripada writeFile jika hanya perlu mengedit beberapa baris pada file yang sudah ada. Gunakan ini ALIH-ALIH writeFile untuk perubahan kecil/lokal.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING", description: "Path lengkap ke file yang akan dimodifikasi." },
            searchBlock: { type: "STRING", description: "Kode/teks yang ada di file saat ini dan ingin diganti. HARUS cocok persis (termasuk indentasi/spasi)." },
            replaceBlock: { type: "STRING", description: "Kode/teks baru sebagai pengganti." }
          },
          required: ["path", "searchBlock", "replaceBlock"]
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
        description: "Panggil ini setelah semua tugas selesai. Di mode 'analysis': isi parameter analysis dengan laporan. Di mode 'code': ini akan trigger commit dan PR.",
        parameters: {
          type: "OBJECT",
          properties: {
            commitMessage: { type: "STRING", description: "Pesan commit (opsional di mode analysis)." },
            branchName: { type: "STRING", description: "Nama branch (opsional di mode analysis)." },
            prTitle: { type: "STRING", description: "Judul Pull Request (opsional di mode analysis)." },
            prBody: { type: "STRING", description: "Deskripsi Pull Request atau laporan singkat (opsional di mode analysis)." },
            hasModifications: { type: "BOOLEAN", description: "Set ke true jika ada perubahan file. Di mode code, ini WAJIB true kecuali emang gak ada yg perlu diubah. Di mode analysis, selalu false." },
            analysis: { type: "STRING", description: "Mode analysis: laporan analisis lengkap. Mode code: gausa diisi." }
          },
          required: ["hasModifications"]
        }
      }
    ]
  }
];

const codeModeInstruction = `Kamu adalah Senior Software Engineer (Kokoa Dev Agent) yang berjalan di dalam GitHub Actions Ubuntu Runner.
Tugasmu adalah memperbaiki kode, menambahkan fitur, atau memecahkan masalah berdasarkan instruksi user.

Kamu memiliki akses langsung ke sistem file lokal melalui tools:
- listDirectory: untuk melihat isi folder.
- readFile: untuk membaca file (lakukan ini dulu sebelum mengedit!).
- searchInFiles: untuk mencari teks/kata kunci di seluruh file proyek (grep global). WAJIB gunakan ini jika ingin mencari fungsi, variabel, atau komponen tertentu.
- writeFile: untuk menulis file baru atau menimpa file yang sudah ada.
- patchFile: untuk mengganti sebagian kode dalam file yang sudah ada. Gunakan ini ALIH-ALIH writeFile jika hanya mengedit beberapa baris pada file yang sudah ada.
- deleteFile: untuk menghapus file.
- runCommand: untuk menjalankan perintah shell seperti 'npm install', 'npm run build', 'npx tsc --noEmit', atau 'grep'.
- finishTask: panggil ini HANYA jika semua tugas sudah selesai, kode sudah diverifikasi (build/compile SUKSES), dan siap di-commit.

PENTING - BACA DENGAN SEKSAMA:
1. LANGKAH 1 (Eksplorasi): Gunakan \`listDirectory\`, \`readFile\`, dan \`searchInFiles\` untuk memahami isi proyek. \`searchInFiles\` WAJIB digunakan untuk mencari fungsi/komponen tertentu.
2. JANGAN PERNAH menginstal dependensi atau melakukan build sebelum memastikan file \`.gitignore\` sudah benar.
3. LANGKAH 2 (Eksekusi): Gunakan \`patchFile\` untuk mengubah sebagian kecil file yang sudah ada. Gunakan \`writeFile\` hanya untuk file baru atau jika perubahan sangat besar. Jangan berhalusinasi telah membuat file jika kamu belum memanggil tool.
4. JANGAN PERNAH memanggil \`finishTask\` jika kamu belum melakukan modifikasi kode.
5. KAMU SUDAH DI ROOT REPO. Langsung buat file di direktori \`./\` (JANGAN gunakan \`mkdir\` atau \`git init\`).
6. JANGAN PERNAH gunakan \`git add\`, \`git commit\`, atau \`git push\`. Executor akan melakukannya otomatis.
7. JANGAN PERNAH menulis file menggunakan \`runCommand\` (seperti \`echo "..." > file\`). Gunakan \`writeFile\` atau \`patchFile\`.
8. Perintah \`cd\` di dalam \`runCommand\` tidak bersifat persisten. Gabungkan dengan '&&' jika perlu (contoh: \`cd folder && npm run build\`).
9. LANGKAH 3 (Verifikasi - WAJIB): SETELAH mengimplementasikan kode, kamu WAJIB menjalankan perintah build/compile (seperti \`npm run build\`, \`npx tsc --noEmit\`, atau perintah yang sesuai) melalui \`runCommand\` UNTUK MEMVERIFIKASI bahwa kode yang kamu tulis tidak mengandung error sintaks atau type error. Jika build gagal, BACA error-nya, perbaiki dengan \`patchFile\` atau \`writeFile\`, dan ulangi build hingga SUKSES. JANGAN LANJUTKAN ke \`finishTask\` sebelum build berhasil.
10. LANGKAH 4 (Selesai): Jika seluruh instruksi user sudah diimplementasikan DAN build/compile sudah sukses, panggil \`finishTask\`.
11. JIKA VALIDASI GAGAL 2 KALI: baca ulang file yang bermasalah, perbaiki, lalu coba finishTask lagi. Jika masih gagal, coba finishTask dengan hasModifications=true (force) — lebih baik push partial daripada stuck selamanya.`;

const analysisModeInstruction = `Kamu adalah Senior Code Analyst (Kokoa Analysis Agent) yang berjalan di dalam GitHub Actions Ubuntu Runner. Tugasmu adalah MEMBACA dan MENGANALISIS kode — BUKAN menulis atau memperbaikinya.

Kamu memiliki akses ke tools:
- listDirectory: melihat isi folder.
- readFile: membaca file.
- runCommand: menjalankan perintah shell untuk eksplorasi (grep, find, git log, dll).
- finishTask: panggil ini dengan \`analysis\` berisi laporan lengkap hasil analisismu.

ATURAN PENTING:
1. JANGAN PERNAH menggunakan \`writeFile\` atau \`deleteFile\` — kamu hanya boleh MEMBACA, bukan menulis.
2. JANGAN PERNAH memodifikasi file apapun.
3. Fokus pada pemahaman arsitektur, struktur folder, alur data, dependensi, dan pola kode.
4. Gunakan \`listDirectory\` untuk navigasi, \`readFile\` untuk baca isi file, \`runCommand\` untuk grep/find/git log.
5. KAMU SUDAH DI ROOT REPO. Tidak perlu clone atau init.
6. JANGAN gunakan \`git add/commit/push\` — executor tidak akan menjalankannya di mode ini.
7. Setelah selesai menganalisis, panggil \`finishTask\` dengan parameter \`analysis\` berisi laporan mendalam. Sertakan juga \`hasModifications: false\`.
8. Laporan analisis harus mencakup: struktur proyek, alur kerja/flow, arsitektur, dependensi, potensi masalah, dan rekomendasi konkret.
9. Kamu bisa mencari file spesifik dengan \`runCommand("find . -name '*.js' | head -30")\` atau \`runCommand("grep -r 'import' src/ --include='*.js' | head -50")\`.`;

function buildSystemInstruction(isAnalysisMode) {
  return isAnalysisMode ? analysisModeInstruction : codeModeInstruction;
}

export class AgentSession {
  constructor(instruction, toolHandlers, onStatusUpdate, analysisMode = false) {
    this.instruction = instruction;
    this.toolHandlers = toolHandlers;
    this.onStatusUpdate = onStatusUpdate || (async () => { });
    this.analysisMode = analysisMode;

    const keys = (process.env.GEMINI_API_KEYS || "").split(",").map(k => k.trim()).filter(k => k);

    const rawModels = (process.env.GEMINI_MODELS || "gemini-3.1-flash-lite,gemini-3-flash-preview,gemini-3.5-flash")
      .split(",")
      .map(m => m.trim())
      .filter(m => m);

    this.keys = keys;
    this.models = rawModels;
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
            systemInstruction: buildSystemInstruction(this.analysisMode),
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

          let rawHistory = [];
          if (this.chat) {
            try {
              rawHistory = await this.chat.getHistory();
            } catch (histErr) {
              rawHistory = [];
            }
          }

          const cleanHistory = rawHistory.map(h => ({
            role: h.role,
            parts: h.parts.map(p => {
              const cleanedPart = {};
              if (p.text !== undefined) cleanedPart.text = p.text;
              if (p.functionCall !== undefined) cleanedPart.functionCall = p.functionCall;
              if (p.functionResponse !== undefined) cleanedPart.functionResponse = p.functionResponse;
              return Object.keys(cleanedPart).length > 0 ? cleanedPart : null;
            }).filter(Boolean)
          })).filter(h => h.parts.length > 0);

          // Hapus entri model di akhir (functionCall yang belum sempat direspon)
          while (cleanHistory.length > 0 && cleanHistory[cleanHistory.length - 1].role === 'model') {
            cleanHistory.pop();
          }
          // Pastikan history dimulai dengan role user
          if (cleanHistory.length > 0 && cleanHistory[0].role === 'model') {
            cleanHistory.shift();
          }

          console.log("Menunggu 10 detik sebelum rotasi key/model...");
          await new Promise(resolve => setTimeout(resolve, 10000));

          try {
            await this._initChat(cleanHistory);
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
    const MAX_LOOPS = 30;
    let validationFailCount = 0;
    let lastNonFinishTool = null;

    console.log(`\n--- Agent Loop Start ---`);
    let response = await this._sendWithRetry([{ text: nextMessage }]);

    while (!isTaskFinished && loopCount < MAX_LOOPS) {
      loopCount++;
      try {
        console.log(`\n--- Agent Loop ${loopCount} ---`);

        await new Promise(resolve => setTimeout(resolve, 3000));

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

          lastNonFinishTool = name;

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

          if (this.analysisMode) {
            console.log("Mode analysis: langsung selesai tanpa validasi git.");
            isTaskFinished = true;
            finalResult = args;
            toolResponses.push({
              functionResponse: {
                name,
                response: { success: true, message: "Analisis selesai." }
              }
            });
          } else {
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
                validationFailCount++;
                console.log(`Validasi GAGAL (ke-${validationFailCount}): ${validation.reason}`);

                if (validationFailCount >= 2) {
                  console.log("Validasi gagal 2 kali. Force-finish dengan hasil yang ada...");
                  isTaskFinished = true;
                  finalResult = {
                    ...args,
                    commitMessage: args.commitMessage || "chore: partial changes",
                    branchName: args.branchName || `auto-fix/${Date.now()}`,
                    prTitle: args.prTitle || "Auto-fix (partial)",
                    prBody: (args.prBody || "") + `\n\n⚠️ Catatan: tugas force-finish karena stuck setelah ${loopCount} langkah. Mungkin ada yang terlewat.`,
                    hasModifications: args.hasModifications || !!lastNonFinishTool,
                  };
                  toolResponses.push({
                    functionResponse: {
                      name,
                      response: { success: true, message: "Task dipaksa selesai (2x validasi gagal). Push partial changes." }
                    }
                  });
                } else {
                  toolResponses.push({
                    functionResponse: {
                      name,
                      response: {
                        success: false,
                        error: `TUGAS BELUM LENGKAP! Berdasarkan analisis repositori: ${validation.reason}. Silakan selesaikan sisa tugas, terutama pastikan file besar ditulis dalam beberapa bagian (chunk) pakai append=true.`
                      }
                    }
                  });
                }
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
      const partial = {
        commitMessage: "chore: partial changes from agent",
        branchName: `auto-fix/${Date.now()}`,
        prTitle: "Auto-fix (partial — max loops)",
        prBody: `Agent berhenti setelah ${MAX_LOOPS} langkah (validasi gagal ${validationFailCount}x). Mungkin ada bagian yang terlewat.`,
        hasModifications: true,
      };
      console.log("Force-finish dengan partial result...");
      return partial;
    }

    return finalResult;
  }
}