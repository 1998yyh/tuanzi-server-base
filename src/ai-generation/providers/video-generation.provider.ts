// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/video.ts + web/src/lib/seedance-video.ts。改造点：
// - axios → 全局 fetch；i18n → 中文错误硬编码；配置注入 ResolvedChannelConfig
// - 浏览器轮询循环拆为 create/poll 两步（服务端 generation-poller 定时驱动）
// - 参考素材由调用方预组装：图片给 dataUrl，音视频给可公网访问的绝对 URL
// - 自定义调用脚本（plugin provider）不在 v1 范围
import { ApiFormat } from '../entities/ai-channel.entity';
import { ResolvedChannelConfig } from './image-generation.provider';
import {
  boolConfig,
  buildSeedancePromptText,
  normalizeResolutionToken,
  normalizeSeedanceDuration,
  normalizeSeedanceRatio,
  normalizeSeedanceResolution,
  SEEDANCE_REFERENCE_LIMITS,
} from './seedance-video.util';

const CREATE_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export type VideoProviderKind = 'openai' | 'seedance';

export interface VideoTaskRef {
  provider: VideoProviderKind;
  remoteTaskId: string;
}

export interface VideoImageReference {
  dataUrl: string;
  mimeType: string;
  fileName: string;
}

export interface GenerateVideoRequest {
  prompt: string;
  seconds?: string;
  size?: string;
  vquality?: string;
  generateAudio?: string;
  watermark?: string;
  imageReferences?: VideoImageReference[];
  videoReferenceUrls?: string[];
  audioReferenceUrls?: string[];
}

export type VideoPollState =
  | { status: 'pending' }
  /** url 为 null 表示结果需经 /videos/:id/content 端点（带鉴权）下载 */
  | { status: 'succeeded'; url: string | null }
  | { status: 'failed'; error: string };

type VideoResponse = {
  id?: string;
  status?: string;
  error?: { message?: string };
  url?: string;
  result_url?: string;
  video_url?: string;
  content?: { video_url?: string; url?: string } | null;
};
type ApiVideoResponse =
  | VideoResponse
  | {
      code?: number | string;
      data?: VideoResponse | null;
      msg?: string;
      message?: string;
      error?: { message?: string };
    };
type SeedanceTask = {
  id?: string;
  status?: 'queued' | 'running' | 'succeeded' | 'completed' | 'failed' | 'cancelled' | 'expired';
  error?: { code?: string; message?: string } | null;
  content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
  url?: string;
  result_url?: string;
  video_url?: string;
};
type ApiEnvelope<T> =
  | T
  | {
      code?: number | string;
      data?: T | null;
      msg?: string;
      message?: string;
      error?: { message?: string };
    };

/** ark 渠道走 Seedance 任务接口，其余走 OpenAI 兼容 /videos */
export function resolveVideoProvider(
  config: Pick<ResolvedChannelConfig, 'apiFormat'>,
): VideoProviderKind {
  if (config.apiFormat === ApiFormat.GEMINI) {
    throw new Error('Gemini 渠道暂不支持视频生成');
  }
  return config.apiFormat === ApiFormat.ARK ? 'seedance' : 'openai';
}

export async function createVideoTask(
  config: ResolvedChannelConfig,
  req: GenerateVideoRequest,
): Promise<VideoTaskRef> {
  if (!config.model.trim()) throw new Error('请选择视频模型');
  if (!config.baseUrl.trim()) throw new Error('请配置渠道 Base URL');
  if (!config.apiKey.trim()) throw new Error('请配置渠道 API Key');
  const provider = resolveVideoProvider(config);
  if (provider === 'seedance') return createSeedanceTask(config, req);
  if (req.videoReferenceUrls?.length || req.audioReferenceUrls?.length) {
    throw new Error('当前渠道仅支持图片参考素材');
  }
  return createOpenAiVideoTask(config, req);
}

export async function pollVideoTask(
  config: ResolvedChannelConfig,
  ref: VideoTaskRef,
): Promise<VideoPollState> {
  return ref.provider === 'seedance'
    ? pollSeedanceTask(config, ref)
    : pollOpenAiVideoTask(config, ref);
}

/** OpenAI 兼容：状态完成但没有直链时，经 /videos/:id/content 带鉴权下载 */
export async function downloadVideoContent(
  config: ResolvedChannelConfig,
  ref: VideoTaskRef,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const url = `${buildVideoApiUrl(config.baseUrl, `/videos/${encodeURIComponent(ref.remoteTaskId)}`)}/content`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await readFetchError(response, '视频结果下载失败'));
  const mimeType = response.headers.get('content-type')?.split(';')[0] || 'video/mp4';
  if (mimeType.includes('json')) {
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      error?: { message?: string };
    };
    throw new Error(payload.error?.message || payload.msg || '视频结果下载失败');
  }
  return { buffer: Buffer.from(await response.arrayBuffer()), mimeType };
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 /videos
// ---------------------------------------------------------------------------

function buildVideoApiUrl(baseUrl: string, path: string): string {
  // 与 image provider 的 buildApiUrl 一致：自动补 /v1，兼容 ark /api/v3
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  const lower = normalized.toLowerCase();
  if (!lower.endsWith('/v1') && !lower.endsWith('/api/v3') && !lower.endsWith('/api/plan/v3')) {
    normalized = `${normalized}/v1`;
  }
  return `${normalized}${path}`;
}

async function createOpenAiVideoTask(
  config: ResolvedChannelConfig,
  req: GenerateVideoRequest,
): Promise<VideoTaskRef> {
  const body = new FormData();
  body.append('model', config.model.trim());
  body.append('prompt', req.prompt);
  body.append('seconds', normalizeVideoSeconds(req.seconds));
  const size = normalizeVideoSize(req.size);
  if (size) body.append('size', size);
  body.append('resolution_name', normalizeResolutionToken(req.vquality || ''));
  body.append('preset', 'normal');
  (req.imageReferences || []).slice(0, 7).forEach((image) => {
    const buffer = Buffer.from(image.dataUrl.split(',')[1] || '', 'base64');
    body.append(
      'input_reference[]',
      new Blob([new Uint8Array(buffer)], { type: image.mimeType }),
      image.fileName,
    );
  });

  try {
    const response = await fetch(buildVideoApiUrl(config.baseUrl, '/videos'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body,
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readFetchError(response, '视频任务创建失败'));
    const created = unwrapEnvelope(
      (await response.json()) as ApiVideoResponse,
      '接口未返回视频任务',
    );
    if (!created.id) throw new Error('接口未返回视频任务 ID');
    return { provider: 'openai', remoteTaskId: created.id };
  } catch (error) {
    throw toChineseError(error, '视频任务创建失败');
  }
}

async function pollOpenAiVideoTask(
  config: ResolvedChannelConfig,
  ref: VideoTaskRef,
): Promise<VideoPollState> {
  try {
    const response = await fetch(
      buildVideoApiUrl(config.baseUrl, `/videos/${encodeURIComponent(ref.remoteTaskId)}`),
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(await readFetchError(response, '视频任务查询失败'));
    const video = unwrapEnvelope((await response.json()) as ApiVideoResponse, '接口未返回视频任务');
    const url = videoResultUrl(video);
    if (url) return { status: 'succeeded', url };
    if (video.status === 'completed') return { status: 'succeeded', url: null };
    if (video.status === 'failed' || video.status === 'cancelled') {
      return {
        status: 'failed',
        error: readApiErrorMessage(video.error?.message) || '视频生成失败',
      };
    }
    return { status: 'pending' };
  } catch (error) {
    throw toChineseError(error, '视频任务查询失败');
  }
}

function normalizeVideoSeconds(value: string | undefined): string {
  const seconds = Math.floor(Number(value) || 6);
  return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string | undefined): string | null {
  if (value === 'auto') return null;
  const size = value || '1280x720';
  if (/^\d+x\d+$/.test(size)) return size;
  return ['9:16', '2:3', '3:4'].includes(size) ? '720x1280' : '1280x720';
}

// ---------------------------------------------------------------------------
// Seedance（ark）/contents/generations/tasks
// ---------------------------------------------------------------------------

function seedanceApiUrl(config: ResolvedChannelConfig, taskId?: string): string {
  return buildVideoApiUrl(
    config.baseUrl,
    `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ''}`,
  );
}

async function createSeedanceTask(
  config: ResolvedChannelConfig,
  req: GenerateVideoRequest,
): Promise<VideoTaskRef> {
  const images = (req.imageReferences || []).slice(0, SEEDANCE_REFERENCE_LIMITS.images);
  const videos = (req.videoReferenceUrls || []).slice(0, SEEDANCE_REFERENCE_LIMITS.videos);
  const audios = (req.audioReferenceUrls || []).slice(0, SEEDANCE_REFERENCE_LIMITS.audios);
  if (audios.length && !images.length && !videos.length) {
    throw new Error('参考音频需要搭配至少一个图片或视频参考素材');
  }

  const content: Array<Record<string, unknown>> = [];
  const text = buildSeedancePromptText(req.prompt, images.length, videos.length, audios.length);
  if (text) content.push({ type: 'text', text });
  for (const image of images) {
    content.push({ type: 'image_url', image_url: { url: image.dataUrl }, role: 'reference_image' });
  }
  for (const url of videos) {
    content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
  }
  for (const url of audios) {
    content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  }
  if (!content.length) throw new Error('请输入视频提示词');

  const payload = {
    model: config.model.trim(),
    content,
    ratio: normalizeSeedanceRatio(req.size),
    resolution: normalizeSeedanceResolution(req.vquality),
    duration: normalizeSeedanceDuration(req.seconds),
    generate_audio: boolConfig(req.generateAudio, true),
    watermark: boolConfig(req.watermark, false),
  };

  try {
    const response = await fetch(seedanceApiUrl(config), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readFetchError(response, 'Seedance 任务创建失败'));
    const created = unwrapEnvelope(
      (await response.json()) as ApiEnvelope<SeedanceTask>,
      '接口未返回 Seedance 任务',
    );
    if (!created.id) throw new Error('接口未返回 Seedance 任务 ID');
    return { provider: 'seedance', remoteTaskId: created.id };
  } catch (error) {
    throw toChineseError(error, 'Seedance 任务创建失败');
  }
}

async function pollSeedanceTask(
  config: ResolvedChannelConfig,
  ref: VideoTaskRef,
): Promise<VideoPollState> {
  try {
    const response = await fetch(seedanceApiUrl(config, ref.remoteTaskId), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readFetchError(response, 'Seedance 任务查询失败'));
    const state = unwrapEnvelope(
      (await response.json()) as ApiEnvelope<SeedanceTask>,
      '接口未返回 Seedance 任务',
    );
    const url = videoResultUrl(state);
    if (url) return { status: 'succeeded', url };
    if (state.status === 'succeeded' || state.status === 'completed') {
      return { status: 'failed', error: '任务完成但未返回视频地址' };
    }
    if (state.status === 'failed' || state.status === 'cancelled' || state.status === 'expired') {
      const fallback = state.status === 'expired' ? '视频生成超时（任务已过期）' : '视频生成失败';
      return { status: 'failed', error: readApiErrorMessage(state.error?.message) || fallback };
    }
    return { status: 'pending' };
  } catch (error) {
    throw toChineseError(error, 'Seedance 任务查询失败');
  }
}

// ---------------------------------------------------------------------------
// 共享：响应解包 / URL 提取 / 错误
// ---------------------------------------------------------------------------

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
  if (!payload) throw new Error(emptyMessage);
  if (typeof payload === 'object' && 'code' in payload && payload.code !== undefined) {
    if (payload.code !== 0 && payload.code !== '0') {
      throw new Error(readApiErrorMessage(payload) || '请求失败');
    }
    if (!payload.data) throw new Error(emptyMessage);
    return payload.data;
  }
  return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask): string | null {
  const url = [
    payload.video_url,
    payload.result_url,
    payload.url,
    payload.content?.video_url,
    payload.content?.url,
  ].find(
    (value) =>
      typeof value === 'string' && (/^https?:\/\//i.test(value) || /\.mp4(\?|#|$)/i.test(value)),
  );
  return url || null;
}

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

function toChineseError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return new Error('请求超时，请稍后重试');
    const parsed = readApiErrorMessage(error.message);
    return new Error(parsed || error.message || fallback);
  }
  return new Error(fallback);
}
