export function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function splitIntoChunks(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      if (para.length > maxLength) {
        const lines = para.split("\n");
        let lineBuf = "";
        for (const line of lines) {
          const lineCand = lineBuf ? lineBuf + "\n" + line : line;
          if (lineCand.length <= maxLength) {
            lineBuf = lineCand;
          } else {
            if (lineBuf) chunks.push(lineBuf.trim());
            lineBuf = line.slice(0, maxLength);
          }
        }
        if (lineBuf) current = lineBuf;
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function markdownToRichHtml(text) {
  if (!text) return "";
  const cleanedText = text.replace(/\\([_*\\\[\]()~`>#+\-=\|{}.!])/g, "$1");
  const lines = cleanedText.split("\n");
  const output = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      output.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
      i++;
      continue;
    }
    const h3 = line.match(/^###\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { output.push(`<b>${inlineFormat(h1[1])}</b>`); i++; continue; }
    if (h2) { output.push(`<b>${inlineFormat(h2[1])}</b>`); i++; continue; }
    if (h3) { output.push(`<b>${inlineFormat(h3[1])}</b>`); i++; continue; }
    if (line.startsWith("> ")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(inlineFormat(lines[i].slice(2)));
        i++;
      }
      output.push(`<blockquote>${quoteLines.join("\n")}</blockquote>`);
      continue;
    }
    if (/^[\-\*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\-\*]\s+/.test(lines[i])) {
        items.push(`• ${inlineFormat(lines[i].replace(/^[\-\*]\s+/, ""))}`);
        i++;
      }
      output.push(items.join("\n"));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`${inlineFormat(lines[i])}`);
        i++;
      }
      output.push(items.join("\n"));
      continue;
    }
    if (/^[-*_]{3,}$/.test(line.trim())) {
      output.push("────────────────");
      i++;
      continue;
    }
    if (line.trim() === "") {
      output.push("");
      i++;
      continue;
    }
    output.push(inlineFormat(line));
    i++;
  }
  return output.join("\n");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineFormat(str) {
  let s = escapeHtml(str);
  s = s.replace(/\*\*([\s\S]*?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([\s\S]*?)__/g, "<u>$1</u>");
  s = s.replace(/(?<!\*)\*(?!\*)([\s\S]*?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  s = s.replace(/(?<!_)_(?!_)([\s\S]*?)(?<!_)_(?!_)/g, "<i>$1</i>");
  s = s.replace(/~~([\s\S]*?)~~/g, "<s>$1</s>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
