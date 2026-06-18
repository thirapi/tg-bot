# Dokumentasi Fitur & Implementasi Gemini Telegram Bot

Dokumen ini berisi analisis detail mengenai fitur-fitur yang dimiliki oleh Gemini Telegram Bot, detail teknis implementasinya di lingkungan Cloudflare Workers, masalah-masalah yang ditemukan, serta perbaikan yang telah diterapkan.

---

## 1. Arsitektur & Teknologi Utama

Bot ini berjalan di platform **Cloudflare Workers** (tanpa server VPS/Docker tradisional) dengan memori penyimpanan sementara/status obrolan menggunakan **Cloudflare KV (CHAT_HISTORY)**.

### Alur Kerja Utama:
1. **Webhook Fast-Path:** Menerima pesan dari Telegram Webhook, memeriksa otorisasi pengirim, memproses command langsung, lalu mengembalikan respons `200 OK` ke Telegram.
2. **Pemrosesan Asinkron (`ctx.waitUntil`):** Logika pemrosesan pesan utama dijalankan di latar belakang agar webhook tidak mengalami timeout.
3. **Agentic Tool Calling (Gemini):** Bot memanggil Gemini API dengan membawa sekumpulan perkakas (tools) GitHub. Gemini dapat memutuskan untuk memanggil tools ini secara berulang hingga target/jawaban tercapai sebelum memberikan teks final ke pengguna.

### Batasan Cloudflare Workers Free Tier:
| Batasan | Nilai |
| :--- | :--- |
| Wall-clock time (maks. eksekusi per request) | **30 detik** |
| CPU time (maks. komputasi per request) | **10 ms** |
| Koneksi keluar bersamaan per host | **6 koneksi** |
| Cloudflare KV write consistency | **Eventually consistent** (bisa 60 detik) |

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
    *   Telah dioptimalkan menggunakan fungsi **`bufferToBase64`** berbasis chunking untuk menghindari kelelahan CPU.
    *   Proses download file diberi timeout (5 detik untuk `getFile`, 10 detik untuk download konten).

### C. Integrasi GitHub API (Agentic Tools)
*   **Deskripsi:** Bot bertindak sebagai agen pengembang yang dapat mengelola repositori GitHub pengguna secara remote.
*   **Daftar Perkakas (Tools):**
    *   **Issues:** `listGitHubIssues`, `createGitHubIssue`, `createIssueComment`, `updateIssueState`.
    *   **Pull Requests (PR):** `getPRDiff`, `createPullRequest`, `mergePullRequest`, `updatePRState`.
    *   **File Manager:** `getFileContent`, `createOrUpdateFile`, `deleteFile`, `listDirectoryContents`.
    *   **Search & Workflow:** `searchInFiles`, `triggerDeveloperWorkflow` (memicu GitHub Actions runner untuk tugas berat di backend).
*   **Timeout:** Semua panggilan ke GitHub API memiliki timeout 15 detik via `AbortController`.

### D. Manajemen Rotasi API Key & Model (Key & Model Rolling)
*   **Deskripsi:** Bot membawa beberapa API Key Gemini (`GEMINI_API_KEYS`) dan beberapa model fallback (`GEMINI_MODELS`). Jika salah satu key mengalami limit/error, bot otomatis berputar mencari key/model yang aktif.
*   **Detail Implementasi:**
    *   **`blacklistedKeysPerModel`** — Menonaktifkan key hanya untuk model tertentu. Digunakan saat terjadi rate limit (429) atau server sibuk (503). Key tetap bisa digunakan untuk model fallback lain.
    *   **`blacklistedKeysGlobal`** — Menonaktifkan key untuk semua model. Digunakan saat API key tidak valid (400) atau diblokir (403).
    *   **Cooldown di KV** — Menyimpan status cooldown key ke Cloudflare KV (`cooldown:keyShort`) selama 10 menit untuk key invalid/blocked, agar request dari invokasi Worker berikutnya langsung melewati key bermasalah.
    *   **Pre-fetch KV** — Status cooldown semua key dibaca secara paralel (`Promise.all`) di awal fungsi `processMessage` untuk menghindari pembacaan KV sekuensial di dalam loop.

### E. Pengecekan Kuota Key & Model (/quota)
*   **Deskripsi:** Perintah `/quota` atau `/keys` untuk mengetahui status keaktifan masing-masing API Key terhadap setiap model terdaftar.
*   **Detail Implementasi:**
    *   Menggunakan sistem **chunked concurrency** — mengirim maksimal 5 request bersamaan agar tidak melebihi batas koneksi Cloudflare (6 per host).
    *   Memiliki **Global Timeout 25 detik** — jika proses keseluruhan sudah mendekati batas waktu Worker, sisa pengecekan akan ditandai `⏳ SKIPPED` dan hasil yang sudah terkumpul langsung dikirim.

### F. Perintah Bot (Commands)

| Perintah | Deskripsi |
| :--- | :--- |
| `/start` atau `/reset` | Menghapus riwayat obrolan dan lock pemrosesan. |
| `/help` | Menampilkan daftar perintah yang tersedia. |
| `/unblock` | Menghapus semua status blacklist/cooldown API Key dan lock pemrosesan dari KV. Gunakan ini jika bot terasa "stuck" dan tidak merespons. |
| `/quota` atau `/keys` | Mengecek status keaktifan API Key dan model Gemini secara real-time. |

> **Penting:** Semua perintah di atas dieksekusi **sebelum** pengecekan lock pemrosesan, sehingga Anda selalu bisa mengirim `/unblock` atau `/reset` meskipun bot sedang dalam kondisi terkunci/stuck.

---

## 3. Masalah yang Diidentifikasi & Langkah Perbaikan

Berikut adalah rincian masalah teknis yang ditemukan dalam analisis mendalam dan solusi yang telah diimplementasikan ke dalam kode:

### 3.1 Bug Kritis: Blacklist Model Akibat API Key Bermasalah
*   **Masalah:** Jika salah satu API Key tidak valid (HTTP 400 `API_KEY_INVALID`), kode mendeteksi string `"400"` dan langsung mem-blacklist **seluruh model** (menonaktifkan `gemini-3.5-flash` sepenuhnya untuk sesi tersebut), padahal modelnya sendiri tidak bermasalah.
*   **Solusi:** Memisahkan deteksi error secara terperinci di `fetchGeminiGenerate`:
    *   Error `GEMINI_KEY_INVALID` (400) dan `GEMINI_KEY_BLOCKED` (403) → hanya menonaktifkan **key** tersebut secara global.
    *   Error `GEMINI_MODEL_NOT_FOUND` (404) → hanya menonaktifkan **model** tersebut.
    *   Error `GEMINI_RETRY_TRIGGER` (429/503) → hanya menonaktifkan **key untuk model tertentu** (per-model blacklist), sehingga key masih bisa dicoba pada model fallback.

### 3.2 Bug Kritis: Rate Limit (503) Mem-blacklist Key Secara Global
*   **Masalah:** Saat model `gemini-3.5-flash` mengembalikan error 503 (High Demand), bot memasukkan API Key ke `blacklistedKeysGlobal` **dan** menulis cooldown ke KV. Akibatnya, saat bot hendak mencoba model fallback (`gemini-3.1-flash-lite`), semua key sudah di-blacklist global sehingga bot langsung menyerah tanpa mencoba fallback sama sekali.
*   **Solusi:** Error rate limit / high demand (`GEMINI_RETRY_TRIGGER`) kini hanya memasukkan key ke `blacklistedKeysPerModel` (per-model), bukan ke global blacklist. Key tersebut bebas digunakan pada model lain.

### 3.3 Silent Worker Death: Perintah `/quota` Tanpa Respon
*   **Masalah:** Pengecekan `/quota` sebelumnya mengirim seluruh request secara bersamaan (`Promise.all` untuk 6 key × 3 model = 18 request). Cloudflare membatasi 6 koneksi keluar per host. Sisanya mengantre dan melebihi timeout 5 detik, lalu totalnya melebihi batas 30 detik Worker, sehingga Worker dibunuh paksa tanpa sempat mengirim pesan.
*   **Solusi:** Menggunakan chunked concurrency (maks 5 request bersamaan) dengan global timeout 25 detik yang menjamin bot selalu mengirim respon sebelum batas 30 detik.

### 3.4 Silent Worker Death: Perintah Terblokir oleh Lock
*   **Masalah:** Semua perintah (`/quota`, `/unblock`, `/reset`, `/help`) dieksekusi **setelah** pengecekan lock. Jika proses sebelumnya macet dan lock belum dihapus, seluruh perintah akan ditolak dengan pesan "masih proses yang tadi" — termasuk perintah darurat `/unblock` yang seharusnya bisa memperbaiki situasi.
*   **Solusi:** Memindahkan parsing dan eksekusi perintah ke **sebelum** pengecekan lock dan rate limit. Perintah utilitas selalu bisa dijalankan kapan saja. Lock dan rate limit hanya berlaku untuk pesan obrolan biasa.

### 3.5 Silent Worker Death: Telegram API Tanpa Timeout
*   **Masalah:** Fungsi `sendTelegramMessage` dan `sendTelegramAction` memanggil `fetch()` tanpa `AbortController`. Jika server Telegram lambat atau tidak merespon, Worker menggantung hingga batas 30 detik dan mati tanpa mengirim apapun.
*   **Solusi:** Menambahkan helper `fetchWithTimeout` di `telegram.js`:
    *   `sendTelegramAction` (typing indicator): timeout 5 detik.
    *   `sendTelegramMessage` (kirim pesan): timeout 10 detik.

### 3.6 Silent Worker Death: Download Media Tanpa Timeout
*   **Masalah:** `prepareMediaPart` mengunduh file dari server Telegram tanpa timeout. File besar (foto resolusi tinggi, voice panjang) bisa memakan waktu lama dan Worker mati paksa.
*   **Solusi:** Menambahkan `AbortController` timeout:
    *   `getFile` API call: timeout 5 detik.
    *   Download konten file: timeout 10 detik.

### 3.7 Memory Leak: Typing Timer Tidak Dihentikan
*   **Masalah:** `sendTyping` menggunakan `setTimeout` secara rekursif tetapi referensi timer tidak pernah dibersihkan. Meskipun flag `isProcessing` dicek, timer yang sudah terjadwal tetap akan berjalan sekali lagi setelah proses selesai.
*   **Solusi:** Menyimpan referensi `typingTimer` dan menambahkan `clearTimeout(typingTimer)` di blok `finally` dari `processMessage`.

### 3.8 Bottleneck CPU: Konversi Base64 Per-Byte
*   **Masalah:** Konversi ArrayBuffer ke Base64 menggunakan `for` loop per byte karakter. Untuk gambar 1 MB, loop berjalan 1 juta kali dan pasti memicu CPU limit exceeded.
*   **Solusi:** Fungsi `bufferToBase64` di `src/utils/array.js` menggunakan chunking 8KB dengan `String.fromCharCode.apply` dan `subarray`.

---

## 4. Timeout Budget Keseluruhan

Ringkasan alokasi timeout di seluruh sistem untuk memastikan total eksekusi tidak melebihi 30 detik (batas Cloudflare Workers Free Tier):

| Komponen | Timeout | Keterangan |
| :--- | :--- | :--- |
| `fetchGeminiGenerate` | 8 detik | Per-request ke Gemini API |
| `callGitHubAPI` | 15 detik | Per-request ke GitHub API |
| `sendTelegramMessage` | 10 detik | Per-pengiriman pesan ke Telegram |
| `sendTelegramAction` | 5 detik | Per-pengiriman typing indicator |
| `prepareMediaPart` (getFile) | 5 detik | Mendapatkan info file dari Telegram |
| `prepareMediaPart` (download) | 10 detik | Download konten media dari Telegram |
| `processMessage` (total) | **25 detik** | Batas total eksekusi pemrosesan pesan |
| `checkGeminiQuota` (total) | **25 detik** | Batas total eksekusi pengecekan kuota |
| `lockKey` TTL | 60 detik | Auto-expire lock jika Worker crash |

---

## 5. Panduan Variabel Lingkungan (Environment Variables)

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

---

## 6. Struktur Direktori Proyek

```
tg-bot/
├── src/
│   ├── config.js              # Konstanta konfigurasi (TTL, limit, dll.)
│   ├── handlers/
│   │   ├── webhook.js          # Entry point Cloudflare Worker, command routing
│   │   └── message.js          # Logika pemrosesan pesan utama & agent loop
│   ├── services/
│   │   ├── gemini.js           # Integrasi Gemini API & pengecekan kuota
│   │   ├── github.js           # REST client helper untuk GitHub API
│   │   ├── media.js            # Download & konversi media Telegram ke Base64
│   │   └── telegram.js         # Pengiriman pesan & typing indicator ke Telegram
│   ├── tools/
│   │   ├── definitions.js      # Definisi tool schema untuk Gemini function calling
│   │   └── executor.js         # Eksekutor tool calls dari Gemini
│   └── utils/
│       ├── array.js            # Utilitas array (shuffle, bufferToBase64)
│       └── formatter.js        # Konversi Markdown ke Telegram Rich HTML
├── docs/
│   └── features.md             # Dokumentasi ini
└── wrangler.jsonc              # Konfigurasi Cloudflare Workers & env variables
```
