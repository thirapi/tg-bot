# HuggingClaw Keepalive Strategy — Analisis Lengkap

> **Repo:** https://github.com/somratpro/HuggingClaw  
> **Tujuan:** Menjaga koneksi HF Spaces tetap hidup (tidak di-suspend oleh NAT/firewall HF)  
> **Mekanisme Inti:** Cloudflare Worker cron → ping `/health` endpoint + Natural traffic dari OpenClaw agent loop

---

## 1. Ringkasan

HuggingClaw menggunakan **dua lapis strategi** untuk mengatasi HF Spaces NAT blocking dan suspend:

| Lapis | Mekanisme | Sumber Traffic | Frekuensi |
|-------|-----------|----------------|-----------|
| **External Keepalive** | Cloudflare Worker cron job ping `/health` | Cloudflare infrastructure (bukan dari dalam container) | Default tiap 10 menit (`*/10 * * * *`) |
| **Natural Traffic** | OpenClaw agent loop polling Telegram (via `apiRoot` yang指向 proxy) | Dari dalam container ke Cloudflare Worker → Telegram API | Kontinu (setiap ada pesan/user action) |

Kunci utamanya: **Tidak ada internal heartbeat/ping dari dalam Spaces ke luar.** Semua keepalive berasal dari **luar** (Cloudflare cron). Di dalam container, yang ada hanyalah natural traffic dari agent loop.

---

## 2. Proxy Mechanism (`cloudflare-proxy.js`)

### 2.1. Cara Kerja

Cloudflare Proxy di HuggingClaw adalah **transparent runtime patch** — bukan proxy server, melainkan monkey-patch terhadap modul HTTP Node.js.

File ini di-load secara otomatis ke **setiap proses Node.js** via `NODE_OPTIONS`:

```dockerfile
ENV NODE_OPTIONS="--require /opt/cloudflare-proxy.js"
```

(Dockerfile:122)

### 2.2. Apa yang Dipatch

Tiga layer HTTP di-patch:

1. **`https.request` / `http.request`** — fungsi `patch()` di line 90-156
2. **`globalThis.fetch`** — fungsi `patchedFetch` di line 162-273
3. **`undici` dispatch** — `patchDispatch()` di line 280-330 + hook `Module.prototype.require` di line 373-382

### 2.3. Mekanisme `delete newOptions.agent`

Ini adalah **kunci utama** mengapa proxy ini bisa membuat koneksi baru (tidak reuse connection pool yang sudah ada):

```javascript
const newOptions = { ...options };
newOptions._proxied = true;
newOptions.protocol = "https:";
newOptions.hostname = proxy.hostname;
newOptions.port = proxy.port || 443;
newOptions.servername = proxy.hostname;
delete newOptions.host;
delete newOptions.agent;        // <── INI KRUSIAL
```

**Penjelasan:**

- `options.agent` adalah HTTP Agent Node.js yang mengelola connection pooling (keepalive, reuse socket)
- Jika agent dipertahankan, Node.js akan **mereuse koneksi yang sudah ada ke target asli** (misalnya `api.telegram.org`)
- Karena target asli diblokir HF NAT, koneksi lama sudah mati/stale — mereuse-nya akan gagal
- Dengan `delete newOptions.agent`, **setiap request dipaksa membuat koneksi baru** ke proxy hostname (Cloudflare Worker)
- Karena proxy hostname tidak diblokir, koneksi baru selalu berhasil

Pada patched fetch, prinsip yang sama diterapkan dengan **tidak menyebarkan `init`** secara langsung:

```javascript
// Do NOT spread `init` because it may carry a `dispatcher`/`client`
// pinned to the original target's connection pool
const newInit = {
  method: init?.method || "GET",
  headers: mergedHeaders,
};
```

(Line 239-261)

### 2.4. Header Forwarding

Setiap request yang diproxy mendapatkan header tambahan:

- `x-target-host: api.telegram.org` — memberitahu Worker target asli
- `x-proxy-key: <shared_secret>` — autentikasi (optional)
- `host: <proxy_host>` — host header diubah ke proxy

### 2.5. Domain Filtering

Proxy hanya aktif untuk domain tertentu (DEFAULT_PROXY_DOMAINS line 27-45):
`api.telegram.org`, `discord.com`, `web.whatsapp.com`, `googleapis.com`, dll.

Bisa diubah via env `CLOUDFLARE_PROXY_DOMAINS` atau wildcard `*`.

### 2.6. Fresh Connection via `undici` Dispatch

Untuk library yang menggunakan `undici` (seperti OpenAI SDK versi baru, atau library yang meng-import `undici`), proxy juga mem-patch `dispatch()` method. Ini mengubah `options.origin` dari target asli ke proxy hostname, sehingga koneksi baru dibuat ke proxy.

---

## 3. Agent Loop & Natural Traffic Generation via `apiRoot`

### 3.1. Bagaimana `apiRoot` Dihubungkan ke Proxy

Di `start.sh` line 709-724:

```bash
resolve_telegram_api_root() {
  local candidate="$(trim_var "${CLOUDFLARE_PROXY_URL:-}")"
  if [ -n "$candidate" ]; then
    case "$candidate" in
      http://*|https://*)
        printf '%s' "$candidate"
        return 0
        ;;
    esac
  fi
  printf '%s' "https://api.telegram.org"
}
TELEGRAM_API_ROOT="$(resolve_telegram_api_root)"
```

Kemudian di line 739-744, `apiRoot` di-set di konfigurasi OpenClaw:

```javascript
.channels.telegram.apiRoot = $proxy_url
```

### 3.2. Alur Natural Traffic

1. **OpenClaw gateway** berjalan sebagai proses Node.js yang sudah di-patch oleh `cloudflare-proxy.js`
2. **OpenClaw Telegram plugin** melakukan polling ke `apiRoot` (yang merupakan Cloudflare Worker URL)
3. Karena `cloudflare-proxy.js` sudah mem-patch `https.request`, setiap request yang menuju domain dalam daftar (termasuk `api.telegram.org`) secara otomatis di-rewrite ke proxy URL
4. Tapi karena `apiRoot` SUDAH di-set ke proxy URL, request langsung menuju proxy — `shouldProxyHost()` akan return `false` (karena hostname === proxy hostname), jadi request **tidak dipatch lagi** — langsung ke Worker

Jadi alurnya: **OpenClaw → Cloudflare Worker (`apiRoot`) → Telegram API**

### 3.3. Dockerfile Entrypoint

```dockerfile
CMD ["/home/node/app/start.sh"]
```

(Dockerfile:132)

`start.sh` menjalankan:
1. `health-server.js` (background) — line 994
2. OpenClaw gateway dalam loop `while true` — line 1713-1815
3. `cloudflare-keepalive-setup.py` (sekali di awal) — line 1105

### 3.4. Natural Traffic = Keepalive

Karena agent loop OpenClaw **terus-menerus** berkomunikasi dengan Telegram API (polling/getUpdates, sendMessage, dll), ini menghasilkan traffic reguler dari container ke luar (via proxy). Traffic ini:

- Melewati Cloudflare Worker (yang tidak diblokir HF)
- Membuat koneksi keluar terus aktif
- Membantu mencegah NAT timeout (tapi tidak cukup sendiri — lihat section 4)

---

## 4. Internal Keepalive: Does It Exist?

### 4.1. Pencarian Menyeluruh

Telah dilakukan pencarian terhadap semua file di repo untuk pattern:
- `keepAlive`, `keep_alive`, `heartbeat`, `ping` (dalam konteks internal timer)
- `setInterval`, `cron`, `setTimeout` (dalam konteks keepalive)

**Hasil: Tidak ada internal keepalive/ping dari Spaces ke Worker.**

Yang DITEMUKAN:

| Pattern | File | Konteks |
|---------|------|---------|
| `setInterval(detectSpacePrivacy, ...)` | `health-server.js:194` | Re-check privacy status tiap 5 menit — **bukan** keepalive |
| `server.keepAliveTimeout = 65000` | `health-server.js:884` | TCP keepalive timeout untuk HTTP server — agar koneksi proxy tidak timeout |
| `keepalive` (sebagai status) | `health-server.js:225-231`, `start.sh:1103-1106` | Status dari file `/tmp/huggingclaw-cloudflare-keepalive-status.json` yang ditulis oleh `cloudflare-keepalive-setup.py` |

**Kesimpulan:** Tidak ada scheduler internal, tidak ada ping dari dalam Spaces ke Cloudflare Worker atau ke Telegram. Satu-satunya "keepalive" dari dalam adalah **natural traffic** yang dihasilkan oleh agent loop.

---

## 5. External Keepalive: Cloudflare Cron → Spaces

### 5.1. Cloudflare Keepalive Setup (`cloudflare-keepalive-setup.py`)

File ini dipanggil di `start.sh` line 1103-1106:

```bash
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
  echo "Setting up Cloudflare KeepAlive monitor..."
  python3 /home/node/app/cloudflare-keepalive-setup.py || true
fi
```

### 5.2. Worker yang Dibuat

Di `render_keepalive_worker()` (line 72-124), Python script meng-generate Cloudflare Worker dengan dua event listener:

```javascript
addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

addEventListener("scheduled", (event) => {
  event.waitUntil(ping("cron"));
});
```

### 5.3. Fungsi Ping

```javascript
async function ping(source) {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(TARGET_URL, {
      method: "GET",
      headers: {
        "user-agent": "HuggingClaw Cloudflare KeepAlive",
        "cache-control": "no-cache"
      },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    return { ok: response.ok, status: response.status, source, target: TARGET_URL, timestamp: startedAt };
  } catch (error) {
    return { ok: false, status: 0, source, target: TARGET_URL, timestamp: startedAt, error: error.message };
  }
}
```

### 5.4. Target URL

Default: `https://<SPACE_HOST>/health`

```
SPACE_HOST = "username-spacename.hf.space"
TARGET_URL = "https://username-spacename.hf.space/health"
```

Bisa di-override via `CLOUDFLARE_KEEPALIVE_URL`.

### 5.5. Cron Schedule

Default: `*/10 * * * *` (setiap 10 menit).  
Bisa di-override via `CLOUDFLARE_KEEPALIVE_CRON` env var.

### 5.6. Worker Deployment

Setup dilakukan via Cloudflare API:
1. PUT worker script ke `/accounts/{id}/workers/scripts/{worker_name}` (line 171-177)
2. Enable subdomain (line 178-183)
3. Set cron schedule via `/accounts/{id}/workers/scripts/{worker_name}/schedules` (line 184-189)

Worker name: `{space_host_slug}-keepalive` atau custom via `CLOUDFLARE_KEEPALIVE_WORKER_NAME`.

### 5.7. Manual Ping Endpoint

Worker juga memiliki HTTP endpoint untuk manual ping:
- `GET /` → ping
- `GET /health` → ping
- `GET /ping` → ping

Berguna untuk testing: `https://{worker_name}.{subdomain}.workers.dev/ping`

### 5.8. Status File

Hasil setup ditulis ke `/tmp/huggingclaw-cloudflare-keepalive-status.json` dan ditampilkan di dashboard health-server.

---

## 6. Health Server Role

### 6.1. Dua Fungsi Utama

`health-server.js` memiliki dua peran krusial:

1. **Reverse proxy** — meneruskan request dari port publik 7861 ke internal service
2. **Health endpoint** — menyediakan `/health` yang menjadi target Cloudflare keepalive ping

### 6.2. Endpoint /health

```javascript
if (pathname === "/health") {
  const gatewayReady = await probePort(GATEWAY_HOST, GATEWAY_PORT, "/health");
  res.writeHead(gatewayReady ? 200 : 503, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({
    status: gatewayReady ? "ok" : "degraded",
    gatewayReady,
    uptime: formatUptime(Date.now() - startTime),
    sync: getSyncStatus(),
    keepalive: getKeepaliveStatus()
  }));
}
```

Ini adalah endpoint yang dipanggil oleh Cloudflare Worker cron. Jika gateway hidup, return 200. Jika mati, return 503.

### 6.3. Endpoint /status

Mirip dengan `/health` tapi lebih detail — termasuk status WhatsApp, JupyterLab, dll.

### 6.4. TCP Keepalive

```javascript
server.timeout = 0;
server.keepAliveTimeout = 65000;
```

`server.keepAliveTimeout = 65000` menjaga koneksi TCP tetap hidup untuk reverse proxy, sehingga koneksi antara HF infrastructure dan container tidak diputus.

### 6.5. Route Map

| Path | Service | Internal Port | Auth |
|------|---------|---------------|------|
| `/health`, `/status` | Health check | — | No |
| `/` | Dashboard | — | Optional (private space) |
| `/app/` → | OpenClaw Control UI | 7860 | Yes |
| `/terminal/` → | JupyterLab | 8888 | Yes |
| `/login`, `/logout` | Auth | — | — |

---

## 7. Full Traffic Flow Diagram

```
                        CLOUDFLARE INFRASTRUCTURE
   ┌─────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker (KeepAlive)                              │
   │  ┌──────────────────────┐  ┌──────────────────────────┐    │
   │  │ Cron: */10 * * * *  │  │ HTTP: /health, /ping     │    │
   │  │ ↓ ping(TARGET_URL)  │  │ (manual/from browser)     │    │
   │  └────────┬─────────────┘  └────────┬─────────────────┘    │
   │           │                         │                       │
   └───────────┼─────────────────────────┼───────────────────────┘
               │                         │
               │  HTTPS GET /health      │  HTTPS GET /ping
               ▼                         ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  HF SPACES (Docker Container)                               │
   │  ┌────────────────────────────────────────────────────┐    │
   │  │  health-server.js  (port 7861)                     │    │
   │  │  ├── /health  ───→ probe Gateway :7860 → 200/503   │    │
   │  │  ├── /app/*   ──→ proxy → localhost:7860           │    │
   │  │  └── /terminal/* ──→ proxy → localhost:8888        │    │
   │  └───────────────────────┬────────────────────────────┘    │
   │                          │                                  │
   │  ┌───────────────────────▼────────────────────────────┐    │
   │  │  OpenClaw Gateway (localhost:7860)                  │    │
   │  │  ┌─────────────────────────────────────────────┐   │    │
   │  │  │  Telegram Plugin (agent loop)               │   │    │
   │  │  │  apiRoot = CLOUDFLARE_PROXY_URL             │   │    │
   │  │  │  ↓                                           │   │    │
   │  │  │  Polling getUpdates, sendMessage, dll        │   │    │
   │  │  └──────────────────────┬──────────────────────┘   │    │
   │  └─────────────────────────┼──────────────────────────┘    │
   └────────────────────────────┼────────────────────────────────┘
                                │
                  HTTPS request │ (ke proxy URL)
                                ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Cloudflare Worker (Proxy)                                  │
   │  ┌────────────────────────────────────────────────────┐    │
   │  │ 1. Terima request dengan header x-target-host      │    │
   │  │ 2. Validasi secret (x-proxy-key)                   │    │
   │  │ 3. Forward ke target asli (api.telegram.org)      │    │
   │  │ 4. Return response ke container                    │    │
   │  └────────────────────────────────────────────────────┘    │
   └─────────────────────────────────────────────────────────────┘
                                │
                                ▼
                     ┌──────────────────┐
                     │  Telegram API    │
                     │  api.telegram.org│
                     └──────────────────┘
```

---

## 8. Kenapa Ini Works untuk HF NAT

### 8.1. Masalah HF NAT

HF Spaces menggunakan NAT untuk outbound traffic. NAT memiliki **connection timeout** — jika tidak ada traffic keluar dalam periode tertentu, NAT entry dihapus dan koneksi baru akan gagal (dialihkan ke node lain / kena reset).

HF juga melakukan **idle suspend** — Space akan dihentikan jika tidak ada traffic HTTP masuk selama periode tertentu (konon ~30 menit untuk free tier).

### 8.2. Solusi HuggingClaw

Dua masalah, dua solusi:

| Masalah | Solusi | Mekanisme |
|---------|--------|-----------|
| **Idle Suspend** (Space dimatikan) | External cron ping dari Cloudflare | Worker cron GET `/health` tiap 10 menit — membuat HF melihat traffic HTTP masuk → Space tetap hidup |
| **NAT Timeout** (koneksi keluar mati) | Natural traffic + fresh connection per request | Agent loop terus membuat koneksi via proxy. `delete agent` memaksa koneksi baru setiap request. Tidak ada stale connection pool |

### 8.3. Mengapa Cron Saja Tidak Cukup

Cron ping hanya membuat traffic masuk (dari Cloudflare ke Spaces). Tapi jika koneksi keluar (dari Spaces ke Telegram) timeout karena NAT, request ke Telegram akan gagal.

Natural traffic dari agent loop memastikan koneksi keluar tetap segar. Ditambah `delete newOptions.agent`, setiap request adalah koneksi baru — jadi tidak peduli apakah koneksi sebelumnya sudah mati.

### 8.4. Peran `delete newOptions.agent` dalam NAT Bypass

Tanpa patch ini, Node.js akan membuat koneksi pertama ke `api.telegram.org` via proxy, dan menyimpan koneksi tersebut di connection pool (agent). Ketika NAT timeout (biasanya ~30-60 detik untuk koneksi idle di HF), koneksi ini mati. Request berikutnya mencoba mereuse koneksi mati → timeout/error.

Dengan `delete newOptions.agent`:
- Setiap request membuat **koneksi TCP baru** ke proxy hostname
- Proxy hostname (Cloudflare Worker) selalu bisa di-resolve dan reachable
- Worker kemudian membuat koneksi baru ke target asli
- Tidak ada dependency pada stale connection

---

## 9. Implikasi untuk Arsitektur Kita

### 9.1. Yang Bisa Kita Adopsi

1. **External cron keepalive** — menggunakan Cloudflare Worker atau UptimeRobot/cron-job.org untuk ping endpoint health secara teratur
2. **Transparent proxy patch** — jika kita perlu mem-bypass blokade HF NAT untuk service tertentu, kita bisa adopsi `cloudflare-proxy.js`
3. **`delete agent` pattern** — untuk services yang menggunakan connection pooling, pastikan untuk mem-bypass agent saat membuat koneksi via proxy
4. **Health endpoint** — provide endpoint `/health` yang dicek oleh external monitor

### 9.2. Yang Perlu Dimodifikasi

Jika kita tidak punya akses ke Cloudflare Workers API (CLOUDFLARE_WORKERS_TOKEN), kita bisa:
- **Manual cron-job.org** / **UptimeRobot** → ping `https://space-name.hf.space/health`
- Atau buat cron job dari VM/server lain

### 9.3. Perbedaan dengan Arsitektur Kita

HuggingClaw menggunakan **dual Worker pattern**:
1. **Proxy Worker** — untuk outbound traffic (Telegram API)
2. **Keepalive Worker** — untuk cron ping inbound

Kita mungkin bisa merge keduanya menjadi satu Worker, atau menggunakan external service untuk keepalive.

### 9.4. Natural Traffic vs. Artificial Ping

Natural traffic dari agent loop lebih reliable daripada artificial ping karena:
- Tidak perlu scheduler terpisah
- Traffic real lebih sulit dideteksi sebagai "abuse" oleh HF
- Membawa data berguna (bukan sekadar keepalive)

Tapi external ping tetap diperlukan untuk mencegah **idle suspend** (Space dimatikan karena tidak ada HTTP request masuk).

---

## 10. Kesimpulan

1. **Cloudflare Proxy** (`cloudflare-proxy.js`) adalah transparent runtime patch yang meng-intercept semua HTTP/HTTPS request dari Node.js dan mengarahkan traffic ke Cloudflare Worker jika domain termasuk dalam daftar blokir. **`delete newOptions.agent`** adalah kunci untuk memastikan setiap request membuat koneksi baru, menghindari stale connection pool yang mati karena NAT timeout.

2. **Tidak ada internal keepalive.** Tidak ada setInterval, setTimeout, cron, atau heartbeat scheduler di dalam container. Satu-satunya traffic dari dalam adalah **natural traffic** dari OpenClaw agent loop.

3. **External keepalive** disediakan oleh Cloudflare Worker cron yang di-deploy otomatis oleh `cloudflare-keepalive-setup.py`. Cron default `*/10 * * * *` memanggil `https://space.hf.space/health` setiap 10 menit.

4. **Health server** (`health-server.js`) menyediakan endpoint `/health` yang menjadi target cron ping. Juga berfungsi sebagai reverse proxy untuk dashboard, OpenClaw UI, dan JupyterLab.

5. **Dual strategy** bekerja bersama: (a) external cron mencegah idle suspend, (b) natural traffic + fresh connection per request mencegah NAT timeout pada koneksi keluar.

6. **Tanpa Cloudflare Workers API**, strategi tetap bisa dijalankan dengan menggunakan external cron service (cron-job.org, UptimeRobot, atau server sendiri) untuk ping `/health` secara periodik.
