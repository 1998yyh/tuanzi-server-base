// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/prompt-source-runtime.ts。改造点：i18n → 中文错误硬编码
export type RawPrompt = {
  id: string;
  title: string;
  prompt: string;
  description: string;
  coverUrl: string;
  referenceImageUrls: string[];
  tags: string[];
  preview: string;
  createdAt: string;
  updatedAt: string;
  author?: string;
  sourceUrl?: string;
  imageMode?: string;
  imageModel?: string;
  imageSize?: string;
  imageCount?: number;
};

/** 抓取并归一化一个提示词源（JSON 数组格式） */
export async function runPromptSource(
  source: { id: string; name: string; url: string; isBuiltin: boolean },
  options?: { signal?: AbortSignal },
): Promise<RawPrompt[]> {
  if (!source.url.trim()) throw new Error('提示词源地址不能为空');
  let data: unknown;
  try {
    const response = await fetch(source.url, { cache: 'no-store', signal: options?.signal });
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    data = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(
      `拉取提示词源「${source.name}」失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(data)) throw new Error(`提示词源「${source.name}」格式错误：根节点必须是数组`);
  const items = normalizeItems(data, source.id, source.url);
  if (source.isBuiltin && !items.length)
    throw new Error(`提示词源「${source.name}」没有可用提示词`);
  return items;
}

function normalizeItems(values: unknown[], sourceId: string, sourceUrl: string): RawPrompt[] {
  const seen = new Set<string>();
  const items: RawPrompt[] = [];
  values.forEach((value, index) => {
    const record = asRecord(value);
    const title = stringValue(record.title).trim();
    const prompt = stringValue(record.prompt).trim();
    if (!title || !prompt) return;
    const id = stringValue(record.id).trim() || `${sourceId}-${leftPad(index + 1)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const referenceImageUrls = stringArray(record.referenceImageUrls).map((url) =>
      absoluteUrl(sourceUrl, url),
    );
    const coverUrl =
      absoluteUrl(sourceUrl, stringValue(record.coverUrl)) || referenceImageUrls[0] || '';
    items.push({
      id,
      title,
      prompt,
      description: stringValue(record.description),
      coverUrl,
      referenceImageUrls,
      tags: stringArray(record.tags),
      preview: stringValue(record.preview),
      createdAt: stringValue(record.createdAt),
      updatedAt: stringValue(record.updatedAt),
      author: stringValue(record.author),
      sourceUrl: absoluteUrl(sourceUrl, stringValue(record.sourceUrl)),
      imageMode: optionalString(record.imageMode),
      imageModel: optionalString(record.imageModel),
      imageSize: optionalString(record.imageSize),
      imageCount: optionalNumber(record.imageCount),
    });
  });
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(stringValue)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function optionalString(value: unknown): string | undefined {
  const result = stringValue(value).trim();
  return result || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function absoluteUrl(baseUrl: string, path: string): string {
  if (!path) return '';
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

function leftPad(value: number): string {
  return String(value).padStart(4, '0');
}
