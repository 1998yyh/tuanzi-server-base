// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/audio.ts + web/src/lib/audio-generation.ts。改造点：
// - axios → 全局 fetch；i18n → 中文错误硬编码；配置注入 ResolvedChannelConfig
// - 返回二进制 buffer（调用方落盘），不再返回浏览器 Blob
// - 自定义调用脚本（plugin）不在 v1 范围
import { ApiFormat } from '../entities/ai-channel.entity';
import { ResolvedChannelConfig } from './image-generation.provider';

const REQUEST_TIMEOUT_MS = 120_000;

export const AUDIO_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

export const AUDIO_FORMATS = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'] as const;

export interface GenerateAudioRequest {
  prompt: string;
  voice?: string;
  format?: string;
  speed?: string;
  instructions?: string;
}

export function normalizeAudioVoice(value: string | undefined): string {
  return (AUDIO_VOICES as readonly string[]).includes(value || '') ? (value as string) : 'alloy';
}

export function normalizeAudioFormat(value: string | undefined): string {
  return (AUDIO_FORMATS as readonly string[]).includes(value || '') ? (value as string) : 'mp3';
}

export function normalizeAudioSpeed(value: string | undefined): string {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return '1';
  return String(Math.max(0.25, Math.min(4, Number(speed.toFixed(2)))));
}

export function audioMimeType(format: string): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'opus') return 'audio/opus';
  if (format === 'aac') return 'audio/aac';
  if (format === 'flac') return 'audio/flac';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/mpeg';
}

function buildAudioApiUrl(baseUrl: string, path: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');
  const lower = normalized.toLowerCase();
  if (!lower.endsWith('/v1') && !lower.endsWith('/api/v3') && !lower.endsWith('/api/plan/v3')) {
    normalized = `${normalized}/v1`;
  }
  return `${normalized}${path}`;
}

/** OpenAI 兼容 /audio/speech 语音合成（同步返回音频二进制） */
export async function generateAudio(
  config: ResolvedChannelConfig,
  req: GenerateAudioRequest,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!config.model.trim()) throw new Error('请选择音频模型');
  if (!config.baseUrl.trim()) throw new Error('请配置渠道 Base URL');
  if (!config.apiKey.trim()) throw new Error('请配置渠道 API Key');
  if (config.apiFormat === ApiFormat.GEMINI) throw new Error('Gemini 渠道暂不支持音频生成');

  const format = normalizeAudioFormat(req.format);
  const instructions = req.instructions?.trim();

  try {
    const response = await fetch(buildAudioApiUrl(config.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model.trim(),
        input: req.prompt,
        voice: normalizeAudioVoice(req.voice),
        response_format: format,
        speed: Number(normalizeAudioSpeed(req.speed)),
        ...(instructions ? { instructions } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await readFetchError(response, '音频生成失败'));
    const contentType = response.headers.get('content-type')?.split(';')[0] || '';
    if (contentType.includes('json')) {
      const payload = (await response.json()) as {
        code?: number;
        msg?: string;
        error?: { message?: string };
      };
      throw new Error(payload.error?.message || payload.msg || '音频生成失败');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      mimeType: contentType.startsWith('audio/') ? contentType : audioMimeType(format),
    };
  } catch (error) {
    throw toChineseError(error, '音频生成失败');
  }
}

function readApiErrorMessage(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return readApiErrorMessage(parsed) || value;
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
