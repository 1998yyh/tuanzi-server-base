// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/lib/seedance-video.ts。改造点：i18n → 中文硬编码；裁掉 UI 选项常量与标签函数
export const SEEDANCE_REFERENCE_LIMITS = {
  images: 9,
  videos: 3,
  audios: 3,
  imageMaxBytes: 30 * 1024 * 1024,
  videoMaxBytes: 200 * 1024 * 1024,
  audioMaxBytes: 15 * 1024 * 1024,
};

export const SEEDANCE_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];

const SEEDANCE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] as const;
const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p'] as const;

export function normalizeSeedanceResolution(value: string | undefined): string {
  const normalized = normalizeResolutionToken(value || '');
  return (SEEDANCE_RESOLUTIONS as readonly string[]).includes(normalized) ? normalized : '720p';
}

export function normalizeResolutionToken(value: string): string {
  if (value === 'low') return '480p';
  if (value === 'auto' || value === 'high' || value === 'medium') return '720p';
  const resolution = String(value || '').replace(/p$/i, '') || '720';
  return `${resolution}p`;
}

export function normalizeSeedanceDuration(value: string | undefined): number {
  if (String(value ?? '').trim() === '-1') return -1;
  const seconds = Math.floor(Number(value) || 5);
  return Math.max(4, Math.min(15, seconds));
}

export function normalizeSeedanceRatio(value: string | undefined): string {
  if (!value || value === 'auto' || value === 'adaptive') return 'adaptive';
  if ((SEEDANCE_RATIOS as readonly string[]).includes(value)) return value;
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) return 'adaptive';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 'adaptive';
  const ratio = width / height;
  const options = [
    ['16:9', 16 / 9],
    ['4:3', 4 / 3],
    ['1:1', 1],
    ['3:4', 3 / 4],
    ['9:16', 9 / 16],
    ['21:9', 21 / 9],
  ] as const;
  return options.reduce(
    (best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best),
    options[0],
  )[0];
}

export function boolConfig(value: string | undefined, fallback: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** 参考素材编号前缀：「参考图 1、参考视频 1。{prompt}」 */
export function buildSeedancePromptText(
  prompt: string,
  imageCount: number,
  videoCount: number,
  audioCount: number,
): string {
  const labels = [
    ...Array.from({ length: imageCount }, (_, i) => `参考图 ${i + 1}`),
    ...Array.from({ length: videoCount }, (_, i) => `参考视频 ${i + 1}`),
    ...Array.from({ length: audioCount }, (_, i) => `参考音频 ${i + 1}`),
  ];
  const text = prompt.trim();
  if (!labels.length) return text;
  return `${labels.join('、')}。${text}`;
}

/** 参考视频格式/体积/时长/尺寸校验，返回中文错误（空串 = 通过） */
export function seedanceVideoReferenceError(
  videos: {
    mimeType: string;
    bytes: number;
    durationMs?: number | null;
    width?: number | null;
    height?: number | null;
  }[],
): string {
  let totalDurationMs = 0;
  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const label = `参考视频 ${index + 1}`;
    if (!SEEDANCE_VIDEO_MIME_TYPES.includes(video.mimeType))
      return `${label} 仅支持 mp4 / mov 格式`;
    if (video.bytes && video.bytes > SEEDANCE_REFERENCE_LIMITS.videoMaxBytes)
      return `${label} 超过 200MB 限制`;
    if (video.durationMs) {
      if (video.durationMs < 2000 || video.durationMs > 15000)
        return `${label} 时长需在 2~15 秒之间`;
      totalDurationMs += video.durationMs;
    }
    if (video.width && video.height) {
      if (video.width < 300 || video.width > 6000 || video.height < 300 || video.height > 6000)
        return `${label} 尺寸需在 300~6000 像素之间`;
      const ratio = video.width / video.height;
      if (ratio < 0.4 || ratio > 2.5) return `${label} 宽高比需在 0.4~2.5 之间`;
      const pixels = video.width * video.height;
      if (pixels < 640 * 640 || pixels > 3326 * 2494) return `${label} 总像素超出支持范围`;
    }
  }
  if (totalDurationMs > 15000) return '参考视频总时长不能超过 15 秒';
  return '';
}
