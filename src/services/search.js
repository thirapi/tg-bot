const SEARXNG_INSTANCE = "https://searx.be";

export async function webSearch(query) {
  const url = `${SEARXNG_INSTANCE}/search?q=${encodeURIComponent(query)}&format=json&language=id&categories=general`;

  const res = await fetch(url, {
    headers: { "User-Agent": "TelegramBot/1.0 (Cocoa)" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Search API returned HTTP ${res.status}`);
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
