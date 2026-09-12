/** 把供应商的网页引用转为现有前端可显示、可持久化的 Markdown 来源链接。 */
export function extractAnswerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = content as {
    type?: string;
    text?: string;
    citations?: unknown[];
    annotations?: unknown[];
  }[];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const sources = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const entry of [...(block.citations ?? []), ...(block.annotations ?? [])]) {
      if (!entry || typeof entry !== 'object') continue;
      const citation = entry as { url?: unknown; title?: unknown };
      if (typeof citation.url !== 'string') continue;
      try {
        const url = new URL(citation.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        const href = url.href.replace(
          /[()]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        const title = (typeof citation.title === 'string' ? citation.title : url.hostname)
          .replace(/[\r\n]/g, ' ')
          .replace(/[\\[\]]/g, '\\$&');
        if (!text.includes(href)) sources.set(href, title);
      } catch {
        /* Ignore malformed citation URLs. */
      }
    }
  }
  if (!sources.size) return text;
  return `${text}\n\n来源：\n${[...sources].map(([url, title]) => `- [${title}](${url})`).join('\n')}`;
}
