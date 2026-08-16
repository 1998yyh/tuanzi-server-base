import {
  closestGeminiAspectRatio,
  normalizeBackground,
  normalizeQuality,
  parseImageDimensions,
  resolveRequestSize,
  resolveSize,
  validateImageSize,
} from 'src/ai-generation/providers/image-size.util';

describe('image-size.util', () => {
  describe('normalizeQuality', () => {
    it('支持别名 1k/2k/4k', () => {
      expect(normalizeQuality('1k')).toBe('low');
      expect(normalizeQuality('2k')).toBe('medium');
      expect(normalizeQuality('4k')).toBe('high');
    });

    it('未知档位返回 undefined，空值返回 undefined', () => {
      expect(normalizeQuality('ultra')).toBeUndefined();
      expect(normalizeQuality(undefined)).toBeUndefined();
      expect(normalizeQuality('')).toBeUndefined();
    });
  });

  describe('normalizeBackground', () => {
    it('仅 transparent 透传', () => {
      expect(normalizeBackground('transparent')).toBe('transparent');
      expect(normalizeBackground(' Transparent ')).toBe('transparent');
      expect(normalizeBackground('white')).toBeUndefined();
      expect(normalizeBackground(undefined)).toBeUndefined();
    });
  });

  describe('resolveSize', () => {
    it('medium 16:9 推导为 2048 量级横版尺寸且 16 对齐', () => {
      const size = resolveSize('medium', '16:9');
      const { width, height } = parseImageDimensions(size)!;
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(width).toBeGreaterThan(height);
      expect(width * height).toBeGreaterThanOrEqual(655360);
      expect(width * height).toBeLessThanOrEqual(8294400);
    });

    it('竖版比例交换宽高', () => {
      const landscape = parseImageDimensions(resolveSize('low', '16:9'))!;
      const portrait = parseImageDimensions(resolveSize('low', '9:16'))!;
      expect(portrait.height).toBe(landscape.width);
      expect(portrait.width).toBe(landscape.height);
    });

    it('宽高比超限报错', () => {
      expect(() => resolveSize('low', '4:1')).toThrow('宽高比');
    });
  });

  describe('resolveRequestSize', () => {
    it('auto / 空返回 undefined', () => {
      expect(resolveRequestSize('medium', 'auto')).toBeUndefined();
      expect(resolveRequestSize('medium', '')).toBeUndefined();
      expect(resolveRequestSize('medium', undefined)).toBeUndefined();
    });

    it('显式像素尺寸校验后原样返回', () => {
      expect(resolveRequestSize('medium', '2048x1152')).toBe('2048x1152');
    });

    it('非 16 倍数的像素尺寸报错', () => {
      expect(() => resolveRequestSize('medium', '1000x1000')).toThrow('16 的倍数');
    });

    it('比例形式按 quality 推导', () => {
      expect(resolveRequestSize('high', '1:1')).toBe('2880x2880');
    });

    it('非法格式报错', () => {
      expect(() => resolveRequestSize('medium', 'big')).toThrow('尺寸格式不正确');
    });
  });

  describe('validateImageSize', () => {
    it('边界：最长边 3840 通过，3856 拒绝', () => {
      expect(() => validateImageSize(3840, 1280)).not.toThrow();
      expect(() => validateImageSize(3856, 1280)).toThrow('最长边');
    });
  });

  describe('closestGeminiAspectRatio', () => {
    it('就近吸附到受支持比例', () => {
      expect(closestGeminiAspectRatio('1:1')).toBe('1:1');
      expect(closestGeminiAspectRatio('1920:1080')).toBe('16:9');
    });
  });
});
