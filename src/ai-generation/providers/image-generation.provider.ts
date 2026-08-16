// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/image.ts（942 行）。改造点：
// - axios → 全局 fetch（Node 24），AbortSignal.timeout 替代调用方 signal
// - i18n.t(...) → 中文错误消息硬编码
// - 配置来源 useConfigStore → 调用方注入 ResolvedChannelConfig
// - 响应 dataUrl → 标准化的 GeneratedImageOutput（b64 / url 二选一），由调用方落盘
// - 自定义调用脚本（model-plugin）与文本问答（requestImageQuestion）不在 v1 范围

import { ApiFormat } from '../entities/ai-channel.entity';
import {
  closestGeminiAspectRatio,
  normalizeBackground,
  normalizeQuality,
  parseImageDimensions,
  resolveGeminiImageSize,
  resolveRequestSize,
  supportsGeminiImageSize,
} from './image-size.util';

/** 已解析的渠道配置（apiKey 已解密，只活在调用栈帧） */
export interface ResolvedChannelConfig {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  model: string;
}

export interface ReferenceImageInput {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface GenerateImageRequest {
  prompt: string;
  count: number;
  quality?: string;
  size?: string;
  background?: string;
  references?: ReferenceImageInput[];
}

/** 生成结果：b64_json 或远程 URL，由 GenerationService 统一下载/解码落盘 */
export type GeneratedImageOutput = { kind: 'b64'; data: string } | { kind: 'url'; url: string };

const IMAGE_OUTPUT_FORMAT = 'png';
const REQUEST_TIMEOUT_MS = 120_000;

type ImageApiResponse = {
  data?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  error?: { message?: string };
  code?: number;
  msg?: string;
};

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
};
type GeminiPayload = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
};

// ---------------------------------------------------------------------------
// URL / Header 构造
// ---------------------------------------------------------------------------

/** Ported from use-config-store.ts buildApiUrl：自动补 /v1，兼容 ark 的 /api/v3 与 /api/plan/v3 */
export function buildApiUrl(baseUrl: string, path: string): string {
  let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
  const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
  const apiBaseUrl =
    lowerBaseUrl.endsWith('/v1') ||
    lowerBaseUrl.endsWith('/api/v3') ||
    lowerBaseUrl.endsWith('/api/plan/v3')
      ? normalizedBaseUrl
      : `${normalizedBaseUrl}/v1`;
  return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const lowerPath = path.toLowerCase();
    const arkPlanIndex = lowerPath.indexOf('/api/plan/v3');
    if (arkPlanIndex < 0) return baseUrl;
    const end = arkPlanIndex + '/api/plan/v3'.length;
    if (lowerPath.length !== end && lowerPath[end] !== '/') return baseUrl;
    url.pathname = path.slice(0, end);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return baseUrl;
  }
}

function geminiBaseUrl(config: Pick<ResolvedChannelConfig, 'baseUrl'>): string {
  const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
  return lowerBaseUrl.endsWith('/v1') || lowerBaseUrl.endsWith('/v1beta')
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string): string {
  return model.trim().replace(/^models\//, '');
}

function geminiApiUrl(
  config: Pick<ResolvedChannelConfig, 'baseUrl' | 'model'>,
  action: 'generateContent',
): string {
  return `${geminiBaseUrl(config)}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

function readApiErrorMessage(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      const inner = readApiErrorMessage(parsed) || value;
      if (inner === value && typeof parsed === 'object' && Object.keys(parsed).length === 0)
        return '';
      return inner;
    } catch {
      if (/<[a-z][\s\S]*>/i.test(value)) return `接口返回了 HTML 错误页：${value.slice(0, 80)}...`;
      return value;
    }
  }
  if (typeof value !== 'object') return '';
  const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
  const errorMsg =
    typeof payload.error === 'string'
      ? payload.error
      : (payload.error as { message?: unknown })?.message;
  return (
    readApiErrorMessage(payload.msg) ||
    readApiErrorMessage(payload.message) ||
    readApiErrorMessage(errorMsg) ||
    readApiErrorMessage(payload.detail) ||
    ''
  );
}

function readStatusError(status: number | undefined, fallback: string): string {
  if (status === 401 || status === 403) return 'API Key 认证失败，请检查渠道配置';
  if (status === 429) return '接口限流，请稍后重试';
  if (status === 404) return '接口地址或模型不存在';
  if (status === 502) return '网关错误，请稍后重试';
  if (status === 503) return '服务繁忙，请稍后重试';
  return status ? `请求失败（HTTP ${status}）` : fallback;
}

async function readFetchError(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) return readStatusError(response.status, fallback);
  try {
    return readApiErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
  } catch {
    return (
      readApiErrorMessage(text) || text.slice(0, 300) || readStatusError(response.status, fallback)
    );
  }
}

/** 把任意异常收敛为中文错误消息 */
function toChineseError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return new Error('请求超时，请稍后重试');
    const parsed = readApiErrorMessage(error.message);
    return new Error(parsed || error.message || fallback);
  }
  return new Error(fallback);
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

function resolveImageOutput(item: Record<string, unknown>): GeneratedImageOutput | null {
  if (typeof item.b64_json === 'string' && item.b64_json)
    return { kind: 'b64', data: item.b64_json };
  if (typeof item.url === 'string' && item.url) return { kind: 'url', url: item.url };
  return null;
}

/** 兼容 data / images / results 三种响应字段（不同中转站习惯不同） */
function parseImagePayload(payload: ImageApiResponse): GeneratedImageOutput[] {
  if (typeof payload.code === 'number' && payload.code !== 0) {
    throw new Error(payload.msg || '生成请求失败');
  }
  const imageList = payload.data || payload.images || payload.results || [];
  const images = imageList
    .map(resolveImageOutput)
    .filter((v): v is GeneratedImageOutput => Boolean(v));
  if (images.length === 0) {
    const rawKeys = Object.keys(payload).filter((k) => !['code', 'msg', 'error'].includes(k));
    throw new Error(
      rawKeys.length > 0
        ? `无法识别的图片响应格式（字段：${rawKeys.join(', ')}）`
        : '接口未返回任何图片',
    );
  }
  return images;
}

function validateGeminiPayload(payload: GeminiPayload): void {
  if (payload.error?.message) throw new Error(payload.error.message);
  if (payload.promptFeedback?.blockReason) {
    throw new Error(`Gemini 拒绝了请求：${payload.promptFeedback.blockReason}`);
  }
}

function parseGeminiImagePayload(payload: GeminiPayload): GeneratedImageOutput[] {
  validateGeminiPayload(payload);
  const images = (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part): GeneratedImageOutput | null => {
      const inlineData =
        part.inlineData ||
        (part.inline_data
          ? {
              mimeType: part.inline_data.mimeType || part.inline_data.mime_type,
              data: part.inline_data.data,
            }
          : undefined);
      if (inlineData?.data) return { kind: 'b64', data: inlineData.data };
      if (part.fileData?.fileUri) return { kind: 'url', url: part.fileData.fileUri };
      return null;
    })
    .filter((v): v is GeneratedImageOutput => Boolean(v));
  if (!images.length) throw new Error('Gemini 未返回任何图片');
  return images;
}

// ---------------------------------------------------------------------------
// 请求实现
// ---------------------------------------------------------------------------

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await readFetchError(response, '生成请求失败'));
  return (await response.json()) as T;
}

/** OpenAI 兼容：文生图 /v1/images/generations */
async function requestOpenAiGeneration(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Promise<GeneratedImageOutput[]> {
  const quality = normalizeQuality(req.quality);
  const requestSize = resolveRequestSize(quality, req.size);
  const background = normalizeBackground(req.background);
  try {
    const payload = await postJson<ImageApiResponse>(
      buildApiUrl(config.baseUrl, '/images/generations'),
      { Authorization: `Bearer ${config.apiKey}` },
      {
        model: config.model,
        prompt: req.prompt,
        n: req.count,
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(background ? { background } : {}),
        response_format: 'b64_json',
        output_format: IMAGE_OUTPUT_FORMAT,
      },
    );
    return parseImagePayload(payload);
  } catch (error) {
    throw toChineseError(error, '生成请求失败');
  }
}

/** OpenAI 兼容：参考图编辑 multipart /v1/images/edits */
async function requestOpenAiEdit(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Promise<GeneratedImageOutput[]> {
  const quality = normalizeQuality(req.quality);
  const requestSize = resolveRequestSize(quality, req.size);
  const background = normalizeBackground(req.background);

  const formData = new FormData();
  formData.set('model', config.model);
  formData.set('prompt', req.prompt);
  formData.set('n', String(req.count));
  formData.set('response_format', 'b64_json');
  formData.set('output_format', IMAGE_OUTPUT_FORMAT);
  if (quality) formData.set('quality', quality);
  if (requestSize) formData.set('size', requestSize);
  if (background) formData.set('background', background);
  for (const ref of req.references || []) {
    formData.append(
      'image',
      new Blob([new Uint8Array(ref.buffer)], { type: ref.mimeType }),
      ref.fileName,
    );
  }

  try {
    const response = await fetch(buildApiUrl(config.baseUrl, '/images/edits'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readFetchError(response, '生成请求失败'));
    return parseImagePayload((await response.json()) as ImageApiResponse);
  } catch (error) {
    throw toChineseError(error, '生成请求失败');
  }
}

/** Ark（火山引擎）：参考图走 /images/generations 的 image 字段（data URL 数组） */
async function requestArkEdit(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Promise<GeneratedImageOutput[]> {
  const quality = normalizeQuality(req.quality);
  const requestSize = resolveRequestSize(quality, req.size);
  const background = normalizeBackground(req.background);
  const refs = (req.references || []).map(
    (ref) => `data:${ref.mimeType};base64,${ref.buffer.toString('base64')}`,
  );
  try {
    const payload = await postJson<ImageApiResponse>(
      buildApiUrl(config.baseUrl, '/images/generations'),
      { Authorization: `Bearer ${config.apiKey}` },
      {
        model: config.model,
        prompt: req.prompt,
        n: req.count,
        response_format: 'b64_json',
        output_format: IMAGE_OUTPUT_FORMAT,
        image: refs,
        ...(quality ? { quality } : {}),
        ...(requestSize ? { size: requestSize } : {}),
        ...(background ? { background } : {}),
      },
    );
    return parseImagePayload(payload);
  } catch (error) {
    throw toChineseError(error, '生成请求失败');
  }
}

function toGeminiImagePart(ref: ReferenceImageInput): GeminiPart {
  return { inlineData: { mimeType: ref.mimeType, data: ref.buffer.toString('base64') } };
}

function resolveGeminiImageConfig(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Record<string, unknown> {
  const value = (req.size ?? '').trim();
  const dimensions = parseImageDimensions(value);
  const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
  const aspectRatio =
    value && value.toLowerCase() !== 'auto' ? closestGeminiAspectRatio(ratio) : undefined;
  const imageSize = supportsGeminiImageSize(config.model)
    ? resolveGeminiImageSize(req.quality, dimensions)
    : undefined;
  const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
  return Object.keys(image).length ? { responseFormat: { image } } : {};
}

/** Gemini：generateContent（文生图与参考图编辑同路径，每次请求产 1 张，并行 count 次） */
async function requestGeminiImages(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Promise<GeneratedImageOutput[]> {
  const single = async (): Promise<GeneratedImageOutput[]> => {
    const parts: GeminiPart[] = [
      { text: req.prompt },
      ...(req.references || []).map(toGeminiImagePart),
    ];
    try {
      const payload = await postJson<GeminiPayload>(
        geminiApiUrl(config, 'generateContent'),
        { 'x-goog-api-key': config.apiKey },
        {
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...resolveGeminiImageConfig(config, req),
          },
        },
      );
      return parseGeminiImagePayload(payload);
    } catch (error) {
      throw toChineseError(error, '生成请求失败');
    }
  };
  const results = await Promise.all(Array.from({ length: req.count }, single));
  return results.flat();
}

/**
 * 图片生成统一入口：按 apiFormat + 是否有参考图分发。
 * 参考图编辑时由调用方（GenerationService）把参考图编号说明拼入 prompt。
 */
export async function generateImages(
  config: ResolvedChannelConfig,
  req: GenerateImageRequest,
): Promise<GeneratedImageOutput[]> {
  const hasReferences = Boolean(req.references?.length);
  if (config.apiFormat === ApiFormat.GEMINI) {
    return requestGeminiImages(config, req);
  }
  if (config.apiFormat === ApiFormat.ARK) {
    return hasReferences ? requestArkEdit(config, req) : requestOpenAiGeneration(config, req);
  }
  return hasReferences ? requestOpenAiEdit(config, req) : requestOpenAiGeneration(config, req);
}
