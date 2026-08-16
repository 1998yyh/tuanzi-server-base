// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/prompt-source-runtime.ts。改造点：i18n → 中文错误硬编码；
// 2026-08-15 代码审查：SSRF 防护（assertPublicUrl）+ redirect manual + 流式 10MB 上限 + 错误脱敏
import { BadRequestException } from '@nestjs/common';
import { assertPublicUrl } from '../../common/utils/ssrf.util';

/** 单个提示词源抓取大小上限（10MB） */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

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
    // SSRF 防护：协议/私网/回环/云元数据等地址在此被拦截（抛 BadRequestException，直接透出）
    const url = await assertPublicUrl(source.url);
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      signal: options?.signal,
    });
    // redirect: manual 下重定向不会自动跟随，一律拒绝（防跳转到内网）
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new Error('提示词源返回重定向响应，已拒绝');
    }
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
    // Content-Length 超限直接拒绝（头可伪造，实际大小仍以流式累计为准）
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_SOURCE_BYTES) throw new Error('提示词源超过大小限制（10MB）');
    const buffer = await readSourceBody(response);
    data = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // SSRF / URL 校验失败属于可对用户展示的校验消息，直接透出
    if (error instanceof BadRequestException) throw error;
    // 抓取/解析失败：对外只暴露脱敏后的通用中文，原始细节挂到 cause 由服务层记日志
    const sanitized = new Error(`提示词源「${source.name}」抓取失败，请稍后重试`);
    (sanitized as Error & { cause?: unknown }).cause =
      error instanceof Error ? error.message : String(error);
    throw sanitized;
  }

  if (!Array.isArray(data)) throw new Error(`提示词源「${source.name}」格式错误：根节点必须是数组`);
  const items = normalizeItems(data, source.id, source.url);
  if (source.isBuiltin && !items.length)
    throw new Error(`提示词源「${source.name}」没有可用提示词`);
  return items;
}

/** 流式读取响应体，累计超过 MAX_SOURCE_BYTES 立即中止（不无上限 arrayBuffer/json） */
async function readSourceBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('提示词源响应无内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) throw new Error('提示词源超过大小限制（10MB）');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
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
