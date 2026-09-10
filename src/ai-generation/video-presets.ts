import { BadRequestException } from '@nestjs/common';
import { ApiFormat, ChannelModel, ModelCapability } from './entities/ai-channel.entity';

export interface VideoModelConfig {
  template: 'text' | 'image' | 'first_last' | 'lipsync';
  requestFormat: 'json' | 'multipart';
  fields?: {
    images?: string;
    firstFrame?: string;
    lastFrame?: string;
    audio?: string;
    seconds?: string;
    resolution?: string;
    aspectRatio?: string;
  };
  minImages?: number;
  maxImages?: number;
  maxSeconds?: number;
  resolutions?: string[];
  fixedSeconds?: number;
  fixedResolution?: string;
}

export const VIDEO_FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const RESERVED_VIDEO_FIELDS = ['prototype', 'constructor', '__proto__', 'model', 'prompt'];
export const DEFAULT_VIDEO_FIELDS = {
  images: 'input_reference',
  firstFrame: 'first_frame',
  lastFrame: 'last_frame',
  audio: 'audio',
  seconds: 'seconds',
  resolution: 'resolution',
  aspectRatio: 'aspect_ratio',
};

const templates: {
  id: VideoModelConfig['template'];
  name: string;
  description: string;
  config: VideoModelConfig;
}[] = [
  {
    id: 'text',
    name: '文生视频',
    description: '仅使用提示词，无参考素材',
    config: { template: 'text', requestFormat: 'json', minImages: 0, maxImages: 0 },
  },
  {
    id: 'image',
    name: '图生视频',
    description: '使用一张或多张参考图',
    config: { template: 'image', requestFormat: 'json', minImages: 1, maxImages: 9 },
  },
  {
    id: 'first_last',
    name: '首尾帧视频',
    description: '依次上传首帧和尾帧两张图片',
    config: { template: 'first_last', requestFormat: 'json', minImages: 2, maxImages: 2 },
  },
  {
    id: 'lipsync',
    name: '图片＋音频',
    description: '参考图片与一段音频，生成对口型视频',
    config: { template: 'lipsync', requestFormat: 'json', minImages: 1, maxImages: 9 },
  },
];

function builtInModel(
  name: string,
  template: VideoModelConfig['template'],
  extra: Partial<VideoModelConfig> = {},
): ChannelModel {
  const base = templates.find((item) => item.id === template)!.config;
  return {
    name,
    capability: ModelCapability.VIDEO,
    videoConfig: {
      ...base,
      fields: { ...DEFAULT_VIDEO_FIELDS },
      maxSeconds: 15,
      resolutions: ['720P', '480P'],
      ...extra,
    },
  };
}

const preset = {
  id: '939593-video',
  name: '视频生成（推荐）',
  apiFormat: ApiFormat.OPENAI,
  baseUrl: 'https://ai.939593.xyz',
  models: [
    builtInModel('minimax_h3_t2v', 'text'),
    builtInModel('minimax_h3_i2v', 'image', { maxSeconds: 12, resolutions: [] }),
    builtInModel('minimax_h3_15s', 'image', { resolutions: [] }),
    builtInModel('minimax_h3_first_last', 'first_last'),
    builtInModel('minimax_h3_lipsync', 'lipsync'),
    builtInModel('minimax_h3_lipsync_v2', 'lipsync'),
    builtInModel('minimax_h3_lipsync_15s', 'lipsync'),
    builtInModel('vela-2.5', 'image', {
      minImages: 0,
      maxImages: 10,
      maxSeconds: 30,
      fixedSeconds: 30,
      fixedResolution: '720P',
      resolutions: ['720P'],
      fields: { ...DEFAULT_VIDEO_FIELDS, images: 'images' },
    }),
  ],
};

export function getVideoPresets() {
  return structuredClone({
    presets: [preset],
    templates: templates.map((item) => ({
      ...item,
      config: { ...item.config, fields: { ...DEFAULT_VIDEO_FIELDS } },
    })),
  });
}

export function resolveVideoModelConfig(
  baseUrl: string,
  model: string,
  explicit?: VideoModelConfig,
): VideoModelConfig | undefined {
  if (explicit) return structuredClone(explicit);
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (!['ai.939593.xyz', 'cdn-ai.939593.xyz'].includes(hostname)) return undefined;
  const config = preset.models.find((item) => item.name === model)?.videoConfig;
  return config ? structuredClone(config) : undefined;
}

/** 配置只声明字段映射，不执行脚本或表达式。 */
export function validateVideoModelConfig(config: VideoModelConfig): void {
  const fail = (message: string): never => {
    throw new BadRequestException(`视频模型配置无效：${message}`);
  };
  const base = templates.find((item) => item.id === config.template)?.config;
  if (!base || !['json', 'multipart'].includes(config.requestFormat))
    fail('请选择支持的素材模板和请求格式');
  const min = config.minImages ?? base!.minImages!;
  const max = config.maxImages ?? base!.maxImages!;
  if (![min, max].every((n) => Number.isInteger(n) && n >= 0 && n <= 20) || min > max)
    fail('图片数量范围不合法（0～20）');
  if (config.template === 'text' && (min !== 0 || max !== 0)) fail('文生视频不能配置参考图');
  if (config.template === 'first_last' && (min !== 2 || max !== 2))
    fail('首尾帧模板必须恰好两张图');
  if (config.template === 'lipsync' && min < 1) fail('图片＋音频模板至少需要一张图');
  if (config.template === 'image' && max < 1) fail('图生视频至少允许一张图');
  for (const value of [config.maxSeconds, config.fixedSeconds]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 600))
      fail('时长必须为 1～600 的整数');
  }
  if (
    config.fixedSeconds !== undefined &&
    config.maxSeconds !== undefined &&
    config.fixedSeconds > config.maxSeconds
  )
    fail('固定时长不能超过最大时长');
  if (
    config.resolutions &&
    (new Set(config.resolutions).size !== config.resolutions.length ||
      config.resolutions.some((v) => typeof v !== 'string' || !v.trim() || v.length > 32))
  )
    fail('清晰度选项不合法');
  if (
    config.fixedResolution !== undefined &&
    (!config.fixedResolution.trim() || config.fixedResolution.length > 32)
  )
    fail('固定清晰度不合法');
  if (
    config.fixedResolution &&
    config.resolutions?.length &&
    !config.resolutions.includes(config.fixedResolution)
  )
    fail('固定清晰度必须在选项内');
  const fields = { ...DEFAULT_VIDEO_FIELDS, ...config.fields };
  const names = Object.values(fields);
  if (
    names.some(
      (v) =>
        typeof v !== 'string' || !VIDEO_FIELD_PATTERN.test(v) || RESERVED_VIDEO_FIELDS.includes(v),
    )
  )
    fail('字段名必须是安全的扁平标识符，且不能覆盖模型或提示词');
  if (new Set(names).size !== names.length) fail('字段映射不能重名');
}
