async function searchBing(query) {
  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&hl=en`;
  const res = await fetch(bingUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
  let html = await res.text();
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const MAX = 6000;
  return html.slice(0, MAX) || "Tidak ada hasil.";
}

async function searchSearxng(query) {
  const customInstance = (typeof process !== 'undefined' && process.env?.SEARXNG_INSTANCE) ? process.env.SEARXNG_INSTANCE : null;
  const instances = [
    ...(customInstance ? [customInstance] : []),
    "https://searx.be",
    "https://searx.namejeff.xyz",
    "https://sx.andrewyu.org",
  ];
  for (const instance of instances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=id&categories=general`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 429) continue;
      if (!res.ok) continue;
      const data = await res.json();
      const results = (data.results || []).slice(0, 8);
      if (results.length === 0) continue;
      return JSON.stringify(results.map(r => ({ title: r.title, url: r.url, snippet: (r.content || "").slice(0, 400) })));
    } catch (_) {}
  }
  throw new Error("SearXNG all failed");
}

export async function webSearch(query, env) {
  const errors = [];
  for (const searchFn of [searchBing, searchSearxng]) {
    try {
      const result = await searchFn(query);
      if (result) return result;
    } catch (e) {
      errors.push(`${searchFn.name}: ${e.message}`);
    }
  }
  throw new Error("Semua search backend gagal: " + errors.join("; "));
}

export async function webFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} saat fetch ${url}`);
  }

  const html = await res.text();

  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const MAX_LENGTH = 8000;
  if (text.length > MAX_LENGTH) {
    text = text.slice(0, MAX_LENGTH) + "... [dipotong]";
  }

  return text || "Halaman web tidak mengandung teks yang bisa dibaca.";
}
