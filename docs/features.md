# Dokumentasi Fitur & Implementasi Gemini Telegram Bot

Dokumen ini berisi analisis detail mengenai fitur-fitur yang dimiliki oleh Gemini Telegram Bot, detail teknis implementasinya di lingkungan Cloudflare Workers, masalah-masalah yang ditemukan, serta perbaikan yang telah diterapkan.

---

## 1. Arsitektur & Teknologi Utama

Bot ini berjalan di platform **Cloudflare Workers** (tanpa server VPS/Docker tradisional) dengan memori penyimpanan sementara/status obrolan menggunakan **Cloudflare KV (CHAT_HISTORY)**.

### Alur Kerja Utama:
1. **Webhook Fast-Path:** Menerima pesan dari Telegram Webhook, memeriksa otorisasi pengirim, menyimpan status `lock` obrolan di KV, lalu langsung mengembalikan respons `200 OK` ke Telegram.
2. **Pemrosesan Asinkron (`ctx.waitUntil`):** Logika pemrosesan pesan utama dijalankan di latar belakang agar webhook tidak mengalami timeout.
3. **Agentic Tool Calling (Gemini):** Bot memanggil Gemini API dengan membawa sekumpulan perkakas (tools) GitHub. Gemini dapat memutuskan untuk memanggil tools ini secara berulang hingga target/jawaban tercapai sebelum memberikan teks final ke pengguna.

---

## 2. Analisis Fitur & Detail Implementasi

### A. Obrolan Interaktif dengan Persona "Cocoa"
*   **Deskripsi:** Bot memiliki kepribadian/persona sebagai "Cocoa", seorang mantan idola STU48 yang ramah, hangat, dan berbahasa santai (kasual).
*   **Detail Implementasi:** 
    *   Sistem instruksi persona digabungkan dari `GEMINI_SYSTEM_PERSONA` dan `GEMINI_SYSTEM_INSTRUCTION` di `wrangler.jsonc`.
    *   Waktu Jakarta (WIB) ditambahkan secara dinamis di setiap request agar model mengetahui waktu terkini.
    *   Format keluaran teks bot diubah dari Markdown biasa ke **Telegram Rich HTML** menggunakan modul `formatter.js` untuk mendukung tebal, miring, coret, quote, tautan, dan blok kode (`<pre><code>`).

### B. Pemrosesan Media (Foto & Suara)
*   **Deskripsi:** Bot dapat menerima input foto (untuk analisis gambar) dan pesan suara (voice message).
*   **Detail Implementasi:**
    *   File media diunduh dari server Telegram menggunakan API `getFile` dan token bot.
    *   Media dikonversi ke format Base64 dan dikirimkan sebagai bagian dari `inline_data` di payload Gemini API.
    *   Telah dioptimalkan menggunakan fungsi **`bufferToBase64`** berbasis chunking untuk menghindari kelelahan CPU (CPU limit exceeded) pada Cloudflare Workers.

### C. Integrasi GitHub API (Agentic Tools)
*   **Deskripsi:** Bot bertindak sebagai agen pengembang yang dapat mengelola repositori GitHub pengguna secara remote.
*   **Daftar Perkakas (Tools):**
    *   **Issues:** `listGitHubIssues`, `createGitHubIssue`, `createIssueComment`, `updateIssueState`.
    *   **Pull Requests (PR):** `getPRDiff`, `createPullRequest`, `mergePullRequest`, `updatePRState`.
    *   **File Manager:** `getFileContent`, `createOrUpdateFile`, `deleteFile`, `listDirectoryContents`.
    *   **Search & Workflow:** `searchInFiles`, `triggerDeveloperWorkflow` (memicu GitHub Actions runner untuk tugas berat di backend).

### D. Manajemen Rotasi API Key & Model (Key & Model Rolling)
*   **Deskripsi:** Bot membawa beberapa API Key Gemini (`GEMINI_API_KEYS`) dan beberapa model fallback (`GEMINI_MODELS`). Jika salah satu key mengalami limit/error, bot otomatis berputar mencari key/model yang aktif.
*   **Detail Implementasi:**
    *   Membawa set memori lokal `blacklistedKeysGlobal` untuk memblokir key yang rusak/limit secara instan di dalam satu siklus request.
    *   Menyimpan status cooldown key ke Cloudflare KV (`cooldown:keyShort`) selama 5 menit (untuk rate limit) atau 10 menit (untuk bad/invalid key) agar request berikutnya langsung melewati key bermasalah tersebut.

### E. Pengecekan Kuota Key & Model (/quota)
*   **Deskripsi:** Perintah `/quota` atau `/keys` untuk mengetahui status keaktifan masing-masing API Key terhadap setiap model terdaftar.
*   **Detail Implementasi:**
    *   Melakukan ping request dengan `maxOutputTokens: 1` secara paralel (`Promise.all`) untuk memangkas waktu respons dari belasan detik menjadi di bawah 2 detik.

---

## 3. Masalah yang Diidentifikasi & Langkah Perbaikan

Berikut adalah rincian masalah teknis yang ditemukan dalam analisis mendalam dan solusi yang telah diimplementasikan ke dalam kode:

### 1. Bug Kritis Blacklist Model Akibat API Key Bermasalah (Telah Diperbaiki)
*   **Masalah:** Sebelumnya, jika salah satu API Key Anda tidak valid atau dinonaktifkan (menghasilkan error HTTP 400 `API_KEY_INVALID`), kode akan mendeteksi string `"400"` dan langsung mem-blacklist **seluruh model** (misalnya menonaktifkan `gemini-3.5-flash` sepenuhnya untuk sesi tersebut).
*   **Solusi:** Memisahkan deteksi error secara terperinci di `fetchGeminiGenerate`:
    *   Error status 400 dengan pesan invalid key dilempar sebagai `GEMINI_KEY_INVALID`.
    *   Error status 403 dilempar sebagai `GEMINI_KEY_BLOCKED`.
    *   Error status 404 dilempar sebagai `GEMINI_MODEL_NOT_FOUND`.
    *   Di bagian loop penangkap error, error terkait key hanya akan menonaktifkan key tersebut (masuk cooldown), sedangkan model hanya akan dinonaktifkan jika terjadi error `GEMINI_MODEL_NOT_FOUND`.

### 2. Bottleneck Latensi KV pada Loop Key Rolling (Telah Diperbaiki)
*   **Masalah:** Sebelumnya, bot membaca status cooldown KV secara sekuensial untuk setiap key di dalam loop pencarian model. Jika ada 5 key dan 3 model, bot berpotensi melakukan hingga 15 operasi pembacaan KV berurutan yang sangat membebani latensi.
*   **Solusi:** Di awal fungsi `processMessage`, seluruh status cooldown dari semua key dibaca secara paralel menggunakan `Promise.all` dan disimpan di cache memory lokal (`kvCooldownedKeys`). Pembacaan di dalam loop kini instan dari memori.

### 3. Risiko Kelelahan CPU (CPU Limit Exceeded) pada Pemrosesan Media & File Besar (Telah Diperbaiki)
*   **Masalah:** Konversi ArrayBuffer/Uint8Array ke Base64 pada `prepareMediaPart` dan `createOrUpdateFile` sebelumnya menggunakan `for` loop tradisional per byte karakter:
    ```javascript
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    ```
    Untuk gambar berukuran 1 MB atau teks file besar, loop ini berjalan 1 juta kali. Pada Cloudflare Workers Free Tier, komputasi seberat ini pasti memicu pembatasan CPU (CPU limit exceeded) dan mematikan Worker seketika.
*   **Solusi:** Dibuat fungsi utilitas `bufferToBase64` baru di `src/utils/array.js` menggunakan metode chunking berbasis `subarray` dan `String.fromCharCode.apply`:
    ```javascript
    export function bufferToBase64(buffer) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      let binary = "";
      const len = bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(binary);
    }
    ```
    Metode ini sangat efisien, cepat, dan aman terhadap batas CPU Workers.

### 4. Risiko Silent Failure Akibat Worker Dipaksa Berhenti (Telah Diperbaiki)
*   **Masalah:** Nilai `EXECUTION_TIMEOUT` bot sebelumnya diatur 90 detik. Padahal batas wall-clock time Workers di Free Tier dibatasi 30 detik. Jika bot kehabisan waktu di 30 detik, bot akan dihentikan paksa tanpa mengirimkan respons error ke pengguna. Selain itu, request GitHub API tidak memiliki timeout sehingga bisa menggantung.
*   **Solusi:** 
    *   Menurunkan `EXECUTION_TIMEOUT` di handler pesan menjadi **25 detik** sehingga bot sempat mengirimkan pesan peringatan ramah ke pengguna sebelum mati.
    *   Menurunkan lock TTL menjadi **60 detik** agar bot tidak terkunci terlalu lama jika terjadi kegagalan sistem.
    *   Menambahkan timeout **15 detik** dengan `AbortController` di `callGitHubAPI` agar bot langsung membatalkan request dan melakukan penanganan error jika GitHub API lambat.

---

## 4. Panduan Variabel Lingkungan (Environment Variables)

Berikut variabel konfigurasi di `wrangler.jsonc` atau dashboard Cloudflare yang penting untuk operasional bot ini:

| Variabel | Deskripsi | Contoh Nilai |
| :--- | :--- | :--- |
| `GEMINI_API_KEYS` | Daftar API Key Gemini dari Google AI Studio (pisahkan dengan koma). | `AIzaSyA..., AIzaSyB...` |
| `GEMINI_MODELS` | Daftar model Gemini yang digunakan untuk rotasi (pisahkan dengan koma). | `gemini-3.5-flash,gemini-3.1-flash-lite` |
| `TELEGRAM_BOT_TOKEN` | Token Bot Telegram Anda dari @BotFather. | `123456789:ABCDefGh...` |
| `ALLOWED_USER_ID` | Telegram User ID Anda agar bot hanya merespon Anda (keamanan). | `987654321` |
| `GITHUB_PAT_TOKEN` | Personal Access Token GitHub dengan hak akses repositori yang sesuai. | `ghp_abc123...` |
| `GEMINI_SYSTEM_PERSONA`| Perilaku dan kepribadian Cocoa. | *(Lihat wrangler.jsonc)* |
| `GEMINI_SYSTEM_INSTRUCTION`| Instruksi teknis untuk tinjauan kode / PR GitHub. | *(Lihat wrangler.jsonc)* |
