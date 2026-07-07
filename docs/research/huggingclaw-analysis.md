# Analisis HuggingClaw: Connection Strategy & Perbandingan Arsitektur

**Repo:** https://github.com/somratpro/huggingclaw
**Tanggal:** 2026-07-07

---

## 1. Ringkasan Arsitektur HuggingClaw

HuggingClaw menggunakan pendekatan **forward proxy** — semua traffic outbound dari HF Spaces (ke Telegram API, Discord, WhatsApp, dll.) dialihkan ke Cloudflare Worker yang bertindak sebagai proxy. HF Spaces **tidak pernah** connect langsung ke API eksternal, melainkan selalu melalui Worker.

```
HF Space (OpenClaw)
  └─ https.request / fetch / undici → cloudflare-proxy.js
       └─ Deteksi: hostname di BLOCKED_DOMAINS?
            ├─ Ya:   rewrite → Cloudflare Worker → API eksternal
            └─ Tidak: pass-through langsung
```

### Perbedaan Fundamental dengan Arsitektur Kita

| Aspek | HuggingClaw | Kita (tg-bot) |
|-------|-------------|---------------|
| **Direction of communication** | Space → Worker (Space initiate all outbound via proxy) | Worker → Spaces (submit task), Spaces → Worker (callback result) |
| **Main challenge** | Outbound HTTP dari Space diblokir HF | **Callback** dari Space ke Worker diblokir HF NAT |
| **Solution** | Route ALL traffic through Cloudflare Worker proxy | Persistent keepAlive + heartbeat untuk maintain NAT mapping |
| **Telegram API access** | Via Cloudflare Worker proxy | Langsung dari Worker (Worker → Telegram works) |

---

## 2. Mekanisme Proxy: `cloudflare-proxy.js`

File di-load via `NODE_OPTIONS="--require /opt/cloudflare-proxy.js"` di Dockerfile, jalan **sebelum** kode aplikasi apapun.

### 2a. Layer yang di-patch

| Layer | Primitive | Metode |
|-------|-----------|--------|
| Node `https.request` | Function | `patch(originalHttpsRequest, "https")` |
| Node `http.request` | Function | `patch(originalHttpRequest, "http")` |
| Web API `fetch` | Global | Replace `globalThis.fetch` |
| Undici `.dispatch` | Prototype | Patch `Pool.prototype.dispatch`, `Client.prototype.dispatch`, `Agent.prototype.dispatch`, `getGlobalDispatcher()` |
| Module loader | `require()` | Hook `Module.prototype.require` untuk catch undici kapanpun di-load |

### 2b. Algoritma Proxy

Untuk setiap request:

```
1. Extract hostname dari options / URL
2. Cek: hostname ∈ BLOCKED_DOMAINS?
     - Default: api.telegram.org, discord.com, web.whatsapp.com, googleapis.com
3. Jika ya DAN belum di-proxy:
     a. Rewrite hostname → worker-name.subdomain.workers.dev
     b. Rewrite protocol → https:
     c. Tambah header:
        - x-target-host: <original-hostname>
        - x-proxy-key: <shared-secret>
     d. Delete newOptions.host (raw host field)
     e. Delete newOptions.agent        ← KRUSIAL
     f. Forward ke Worker proxy
4. Jika tidak: pass-through unchanged
```

### 2c. Kenapa `delete newOptions.agent`?

Ketika hostname di-rewrite dari `api.telegram.org` ke `my-worker.workers.dev`, **agent yang terikat ke hostname asal akan bermasalah**:

- TLS sessions tersimpan untuk SNI yang salah
- Connection pools指向 origin yang salah
- Sertifikat TLS tidak cocok

Dengan `delete newOptions.agent`, setiap proxied request **memaksa fresh connection** tanpa keepAlive ke Worker proxy. Ini bukan "menghapus connection pool" — ini mencegah agent lama dipakai dengan hostname baru.

### 2d. Fetch handling

Tidak seperti `https.request` yang di-patch dengan rewrite options, `fetch` di-handle dengan **tidak me-spread `init`**:

```javascript
// JANGAN spread init — bisa bawa dispatcher/client yang terikat ke
// connection pool asal, menyebabkan undici throw UND_ERR_INVALID_ARG
const newInit = {
  method: init?.method || "GET",
  headers: mergedHeaders,
  body: init?.body,
};
// Hanya copy field yang aman secara eksplisit
```

Ini penting karena `RequestInit` bisa bawa `dispatcher` (undici) yang terikat ke origin asal.

---

## 3. KeepAlive Strategy

### 3a. Untuk Inbound (Health Server)

```javascript
// health-server.js
server.timeout = 0;
server.keepAliveTimeout = 65000;  // 65 detik untuk incoming connections
```

Ini untuk koneksi **masuk** ke Spaces (dashboard, webhook dari Worker). Bukan untuk outbound.

### 3b. Untuk Outbound (Proxy)

**TIDAK ADA keepAlive untuk outbound proxied connections.** Setiap request dapet fresh connection karena `delete newOptions.agent`.

### 3c. KeepAlive Spaces Container (Agar tidak sleep)

Terpisah dari proxy — menggunakan **Cloudflare Worker cron** yang ping `/health` Spaces setiap 10 menit:

```bash
# cloudflare-keepalive-setup.py
# Auto-create Worker script dengan cron trigger every 10 minutes
# Worker → GET https://<space>.hf.space/health
# Tujuannya: cegah HF Spaces sleep karena idle
```

Ini mirip dengan heartbeat kita, tapi:
- Dilakukan oleh **external** Cloudflare Worker (bukan dari dalam Spaces)
- Interval 10 menit (vs 5 detik kita)
- Tujuan: **cegah sleep**, bukan maintain NAT mapping

### 3d. Kesimpulan KeepAlive

| Aspek | HuggingClaw | Kita |
|-------|-------------|------|
| **Untuk proxy connections** | No keepAlive (fresh connection tiap request) | KeepAlive agent (+ heartbeat) |
| **Untuk Spaces container** | External Cloudflare cron (10 menit) | Internal heartbeat dari Spaces (5 detik) |
| **Tujuan utama** | Cegah Spaces sleep | Maintain NAT mapping + cegah sleep |

Ini perbedaan krusial: HuggingClaw **tidak perlu** heartbeat untuk NAT mapping karena setiap request udah lewat Worker proxy (yang tidak diblokir). Mereka cuma perlu cegah Spaces sleep.

---

## 4. Telegram Integration

### 4a. Mode: Long-Polling vs Webhook

Dual mode, dikontrol via OpenClaw config:

```bash
# start.sh
if TELEGRAM_MODE=polling:
  - Space actively polls Telegram via getUpdates
  - Request melalui cloudflare-proxy.js → Worker → Telegram API
  - Polling interval: ~2 detik (default OpenClaw)

if TELEGRAM_MODE=webhook (default):
  - Telegram kirim update ke Worker → Worker forward ke Space
  - Space tidak perlu polling
```

### 4b. API Root Override

Kunci penting — OpenClaw dikonfigurasi dengan `apiRoot`指向 Worker proxy:

```bash
TELEGRAM_API_ROOT="$(resolve_telegram_api_root)"
# apiRoot = https://my-worker.workers.dev/telegram

CONFIG_JSON=$(echo "$CONFIG_JSON" | jq --arg proxy_url "$TELEGRAM_API_ROOT" '
    .channels.telegram.apiRoot = $proxy_url
')
```

Ini membuat OpenClaw **secara native** mengirim request Telegram ke Worker proxy (bukan api.telegram.org). cloudflare-proxy.js jadi **lapisan kedua** (fallback jika ada kode lain yang panggil Telegram langsung).

### 4c. IPv4 Force

```bash
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
export OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY=1
export OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first
```

---

## 5. Perbandingan Detail: HuggingClaw vs Kita

### 5a. Diagram Alur

**HuggingClaw:**
```
Telegram → Cloudflare Worker (proxy) → HF Space (OpenClaw)
                                           ↓
HF Space (OpenClaw) → Cloudflare Worker (proxy) → Telegram API
                                           ↓
HF Space (OpenClaw) → GitHub API (direct, tidak diblokir)
```

Keterangan:
- Semua komunikasi HF Spaces → Dunia luar melalui Worker proxy
- Worker proxy → Telegram API (direct, works)
- Worker proxy juga handle webhook inbound (Telegram → Space)
- **Tidak ada callback dari Space ke Worker** — Space selalu initiate

**Kita (tg-bot):**
```
Telegram → Cloudflare Worker (webhook)
              ↓
Worker → HF Spaces (POST /api/process) → proses task
              ↓
HF Spaces → Worker (callback POST /api/spaces-callback) ← PROBLEMATIK
              ↓
Worker → Telegram (send response)
```

Keterangan:
- Worker initiate komunikasi ke Spaces (inbound Spaces, works)
- Spaces perlu callback ke Worker (outbound → diblokir HF NAT)
- Heartbeat 5s untuk maintain NAT mapping agar callback works
- Short-poll + Cron sebagai fallback jika callback gagal

### 5b. Kenapa HuggingClaw Tidak Perlu Heartbeat untuk NAT

HF Spaces memblokir outbound ke domain tertentu (api.telegram.org, IP Cloudflare tertentu). Tapi **tidak semua** outbound diblokir — khususnya:

1. **Google API (Gemini, dll.)** — Tidak diblokir. Google punya IP range besar dan relasi bisnis dengan HF.
2. **Cloudflare Worker proxy** — IP Worker termasuk dalam range Cloudflare (104.x, 172.67.x) yang SEBAGIAN diblokir HF. Tapi HuggingClaw's proxy Worker mungkin di-deploy di IP/region yang tidak terkena blokir, atau HF hanya blokir IP spesifik tertentu.

Faktanya, dari log kita sendiri: **Callback kedua dan seterusnya yang gagal**, bukan callback pertama. Ini menunjukkan HF NAT mengizinkan koneksi pertama (yang dibuat segera setelah Worker→Spaces), tapi memblokir koneksi berikutnya. Ini konsisten dengan NAT gateway yang membatasi 1 koneksi aktif per origin dalam window waktu.

HuggingClaw mem-bypass masalah ini dengan TIDAK PERNAH perlu koneksi Spaces→Worker dalam arah callback. Semua komunikasi Spaces→Worker melalui proxy request (Space initiate), yang selalu inbound-friendly.

### 5c. Implikasi untuk Arsitektur Kita

| Skenario | Bisakah kita adopsi pendekatan HuggingClaw? |
|----------|---------------------------------------------|
| Spaces → Worker (callback result) | **Tidak relevan** — HuggingClaw tidak punya pola ini |
| Spaces → Worker (proxy outbound) | **Tidak perlu** — Worker kita sudah bisa akses Telegram langsung |
| Worker → Telegram | **Sama-sama works** — langsung dari Worker |
| Worker → Spaces (submit task) | **Sama-sama works** — inbound ke Spaces |

Pola HuggingClaw tidak bisa langsung diterapkan karena masalah kita berbeda:
- Kita butuh **Spaces mengirim hasil balik ke Worker** (callback)
- HuggingClaw butuh **akses ke API dari Spaces** (proxy)

**Alternatif yang bisa kita adopsi dari HuggingClaw:**
- `apiRoot` pattern — jika kita bisa buat Spaces mengirim response Telegram langsung melalui Worker proxy, kita tidak perlu callback Spaces→Worker sama sekali. Tapi ini butuh Spaces punya akses ke Worker proxy yang tidak diblokir — kita sudah buktikan bahwa Spaces→Worker intermittent gagal.

---

## 6. Evaluasi `workerAgent.destroy()` di Kode Kita

```javascript
const workerAgent = new https.Agent({ keepAlive: true, maxSockets: 1, ... });
// ...
// Di error handler:
req.on('error', (e) => {
  workerAgent.destroy();
  reject(e);
});
```

### 6a. Apa yang terjadi saat `agent.destroy()`?

Menurut Node.js docs:

> `agent.destroy()` — Destroy any sockets that are currently in use by the agent.

- Socket yang sedang dipakai diputus
- **Agent tetap hidup** dengan konfigurasinya (keepAlive, maxSockets)
- Request berikutnya dengan `agent: workerAgent` akan **buat socket baru**
- Socket baru ini juga keepAlive (karena config agent)

**Kesimpulan: Tidak bertentangan dengan konsep 1 persistent connection.** Connection-nya yang berganti (karena yang lama rusak), tapi agent persistence-nya tetap. Setelah `destroy()`, agent siap buat koneksi baru dengan konfigurasi yang sama.

### 6b. Analogi

Bayangkan agent sebagai **operator telepon** (orang), socket sebagai **saluran telepon** (kabel):

- `new https.Agent({keepAlive: true})` = Merekrut operator yang ditugaskan menjaga 1 saluran tetap tersambung
- `agent.destroy()` = Kabel putus → operator putuskan sambungan, bersihkan ujung kabel
- Setelah `destroy()` = Operator siap sambungkan kabel baru (masih operator yang sama, masih keepAlive)
- `delete newOptions.agent` (HuggingClaw) = Pecat operator, rekrut operator baru tiap kali nelpon

### 6c. Risiko

1. **Window tanpa koneksi:** Antara `destroy()` dan request berikutnya, tidak ada socket aktif. Jika callback tiba di window ini, perlu bikin koneksi baru (TLS handshake ulang). Dengan heartbeat 5s, window maksimal ~5 detik.

2. **maxSockets: 1 + queue:** Jika ada request pending di queue saat `destroy()` dipanggil, request pending akan dapat error atau butuh reschedule. Namun, di kasus kita, callback dan heartbeat tidak overlap (proses callback > menit, heartbeat < 1 detik).

3. **False positive destroy:** Jika error sementara (misal timeout karena Worker sedang sibuk), `destroy()` putuskan koneksi yang sebenarnya masih bisa dipakai. Tapi lebih baik rebuild koneksi daripada pakai koneksi tidak stabil.

### 6d. Rekomendasi

`workerAgent.destroy()` adalah **recovery mechanism yang tepat** untuk kasus kita:
- TLS error = socket corrupt → harus dibersihkan
- Agent tetap hidup dengan konfigurasi → next request bikin koneksi baru
- Tidak perlu bikin agent baru (tidak contradict persistent connection)

---

## 7. Kesimpulan

1. **HuggingClaw vs Kita: masalah berbeda, solusi berbeda.** HuggingClaw solve "outbound diblokir" dengan proxy. Kita solve "callback diblokir" dengan persistent connection + heartbeat.

2. **`delete newOptions.agent` HuggingClaw** bukan "hapus connection pool", tapi safety measure saat rewrite hostname. Ini tidak bisa langsung diadopsi ke arsitektur kita.

3. **`workerAgent.destroy()` kita** tidak bertentangan dengan persistent connection. Cuma bersihin socket corrupt, agent tetap hidup.

4. **Pola `apiRoot` HuggingClaw** (override endpoint Telegram) menarik, tapi tidak solve masalah utama kita (Spaces→Worker callback terblokir).

5. **Heartbeat 5s** adalah solusi paling tepat untuk maintain NAT mapping. Alternatif (long-polling seperti HuggingClaw) tidak relevan karena kita pakai webhook Telegram, bukan polling dari Spaces.
