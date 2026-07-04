const SEARXNG_DEFAULT = "https://searx.be";
const SEARXNG_FALLBACKS = [
  "https://searx.namejeff.xyz",
  "https://sx.andrewyu.org",
  "https://search.us.projectsegfau.lt",
];

export async function webSearch(query, env) {
  const customInstance = env?.SEARXNG_INSTANCE || (typeof process !== 'undefined' && process.env?.SEARXNG_INSTANCE);
  const instances = [
    ...(customInstance ? [customInstance] : []),
    SEARXNG_DEFAULT,
    ...SEARXNG_FALLBACKS,
  ];

  let lastErr = null;
  for (const instance of instances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=id&categories=general`;
      const res = await fetch(url, {
        headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 429) continue;

      if (!res.ok) {
        lastErr = new Error(`Search API returned HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const results = (data.results || []).slice(0, 8);

      if (results.length === 0) {
        return "Tidak ada hasil penelusuran untuk query tersebut.";
      }

      return JSON.stringify(
        results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: (r.content || "").slice(0, 400),
        })),
      );
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) console.warn("SearXNG all failed, trying Bing fallback:", lastErr.message);

  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query + " 2026")}&hl=en`;
    const res = await fetch(bingUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      const results = [];
      const blockRegex = /<li class="b_algo">([\s\S]*?)<\/li>/g;
      let match;
      while ((match = blockRegex.exec(html)) !== null && results.length < 8) {
        const block = match[1];
        const titleMatch = block.match(/<h2>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
        const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        if (titleMatch) {
          results.push({
            title: titleMatch[2].replace(/<[^>]+>/g, '').trim().slice(0, 80),
            url: titleMatch[1],
            snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 400) : '',
          });
        }
      }
      if (results.length > 0) {
        return JSON.stringify(results);
      }
    }
  } catch (e) {
    console.warn("Bing fallback also failed:", e.message);
  }

  throw lastErr || new Error("Semua search instance gagal.");
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
