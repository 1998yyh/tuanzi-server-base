// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/services/api/image.ts 中的尺寸推导逻辑（i18n 文案已替换为中文硬编码）

export const QUALITY_BASE: Record<string, number> = {
  low: 1024,
  medium: 2048,
  high: 2880,
  standard: 1024,
  hd: 2048,
};
export const QUALITY_ALIASES: Record<string, string> = {
  '1k': 'low',
  '2k': 'medium',
  '4k': 'high',
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export const GEMINI_SUPPORTED_RATIOS = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
];
export const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = {
  low: '1K',
  medium: '2K',
  high: '4K',
  standard: '1K',
  hd: '2K',
};

export function normalizeQuality(quality: string | undefined): string | undefined {
  if (!quality) return undefined;
  const value = quality.trim().toLowerCase();
  const normalized = QUALITY_ALIASES[value] || value;
  return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** 仅 "transparent" 会被转发；其他值（含空）均表示保持默认不透明背景 */
export function normalizeBackground(background: string | undefined): string | undefined {
  return background?.trim().toLowerCase() === 'transparent' ? 'transparent' : undefined;
}

/** 把 "quality + 比例" 映射为显式像素尺寸，如 "3840x2160" */
export function resolveSize(quality: string | undefined, ratio: string): string {
  const parsedRatio = parseImageRatio(ratio);
  const basePixels = quality ? QUALITY_BASE[quality] : undefined;
  const isLandscape = parsedRatio.width >= parsedRatio.height;
  const longRatio = isLandscape
    ? parsedRatio.width / parsedRatio.height
    : parsedRatio.height / parsedRatio.width;
  let longSide: number;
  let shortSide: number;

  if (basePixels) {
    const targetPixels = basePixels * basePixels;
    const longSideRaw = Math.sqrt(targetPixels * longRatio);
    longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
  } else {
    shortSide = DEFAULT_IMAGE_SHORT_SIDE;
    longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
  }

  const width = isLandscape ? longSide : shortSide;
  const height = isLandscape ? shortSide : longSide;
  validateImageSize(width, height);
  return `${width}x${height}`;
}

export function parseRatioValue(value: string): { width: number; height: number } {
  const parts = value.split(':');
  if (parts.length !== 2) throw new Error('尺寸格式不正确，应为 "宽:高" 或 "宽x高"');
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('尺寸比例必须为正数');
  }
  return { width: w, height: h };
}

export function parseImageRatio(value: string): { width: number; height: number } {
  const ratio = parseRatioValue(value);
  if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) {
    throw new Error(`图片宽高比不能超过 ${IMAGE_MAX_RATIO}:1`);
  }
  return ratio;
}

export function parseImageDimensions(value: string): { width: number; height: number } | null {
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function validateImageSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸必须为正整数');
  }
  if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) {
    throw new Error(`图片宽高必须是 ${IMAGE_SIZE_STEP} 的倍数`);
  }
  if (Math.max(width, height) > IMAGE_MAX_EDGE) {
    throw new Error(`图片最长边不能超过 ${IMAGE_MAX_EDGE}px`);
  }
  if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) {
    throw new Error(`图片宽高比不能超过 ${IMAGE_MAX_RATIO}:1`);
  }
  const pixels = width * height;
  if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) {
    throw new Error(`图片像素数需在 ${IMAGE_MIN_PIXELS} ~ ${IMAGE_MAX_PIXELS} 之间`);
  }
}

/** 解析请求尺寸："auto"/空 → undefined；"WxH" → 校验后原样返回；"W:H" → 按 quality 推导像素尺寸 */
export function resolveRequestSize(
  quality: string | undefined,
  size: string | undefined,
): string | undefined {
  const value = (size ?? '').trim();
  if (!value || value.toLowerCase() === 'auto') return undefined;
  const dimensions = parseImageDimensions(value);
  if (dimensions) {
    validateImageSize(dimensions.width, dimensions.height);
    return `${dimensions.width}x${dimensions.height}`;
  }
  if (value.includes(':')) return resolveSize(quality, value);
  throw new Error('尺寸格式不正确，应为 "宽:高" 或 "宽x高"');
}

export function closestGeminiAspectRatio(value: string): string {
  const ratio = parseImageRatio(value);
  const target = ratio.width / ratio.height;
  return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
    const current = parseRatioValue(item);
    const bestRatio = parseRatioValue(best);
    return Math.abs(current.width / current.height - target) <
      Math.abs(bestRatio.width / bestRatio.height - target)
      ? item
      : best;
  });
}

export function resolveGeminiImageSize(
  quality: string | undefined,
  dimensions: { width: number; height: number } | null,
): string | undefined {
  const normalizedQuality = normalizeQuality(quality);
  if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
  if (!dimensions) return undefined;
  const edge = Math.max(dimensions.width, dimensions.height);
  if (edge <= 768) return '512';
  if (edge <= 1536) return '1K';
  if (edge <= 3072) return '2K';
  return '4K';
}

export function supportsGeminiImageSize(model: string): boolean {
  const value = model.toLowerCase();
  return value.includes('gemini-3') || value.includes('3.1') || value.includes('3-pro');
}
