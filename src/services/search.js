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

  if (lastErr) console.warn("SearXNG all failed, trying DuckDuckGo fallback:", lastErr.message);

  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const res = await fetch(ddgUrl, {
      headers: { "User-Agent": "CocoaBot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const results = [];
      if (data.AbstractText) {
        results.push({ title: data.Headline || "Ringkasan", url: data.AbstractURL || "", snippet: data.AbstractText.slice(0, 400) });
      }
      for (const topic of (data.RelatedTopics || [])) {
        if (topic.Text && topic.FirstURL && results.length < 8) {
          results.push({ title: topic.Text.split(" - ")[0]?.slice(0, 80) || topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text.slice(0, 400) });
        }
      }
      if (results.length > 0) {
        return JSON.stringify(results);
      }
    }
  } catch (e) {
    console.warn("DuckDuckGo fallback also failed:", e.message);
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
