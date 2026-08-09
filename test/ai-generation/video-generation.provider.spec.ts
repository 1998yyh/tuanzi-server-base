import {
  createVideoTask,
  pollVideoTask,
  resolveVideoProvider,
  VideoTaskRef,
} from 'src/ai-generation/providers/video-generation.provider';
import { ApiFormat } from 'src/ai-generation/entities/ai-channel.entity';
import { ResolvedChannelConfig } from 'src/ai-generation/providers/image-generation.provider';

const openaiConfig: ResolvedChannelConfig = {
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  apiFormat: ApiFormat.OPENAI,
  model: 'sora-2',
};

const arkConfig: ResolvedChannelConfig = {
  ...openaiConfig,
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiFormat: ApiFormat.ARK,
  model: 'doubao-seedance-1-5-pro',
};

const mockFetch = jest.fn();
global.fetch = mockFetch as never;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('video-generation.provider', () => {
  beforeEach(() => mockFetch.mockReset());

  describe('resolveVideoProvider', () => {
    it('ark 渠道走 seedance，openai 渠道走 openai', () => {
      expect(resolveVideoProvider(openaiConfig)).toBe('openai');
      expect(resolveVideoProvider(arkConfig)).toBe('seedance');
    });

    it('gemini 渠道直接抛错', () => {
      expect(() => resolveVideoProvider({ ...openaiConfig, apiFormat: ApiFormat.GEMINI })).toThrow(
        'Gemini',
      );
    });
  });

  describe('createVideoTask（openai 兼容）', () => {
    it('multipart 提交并返回远端任务 ID，baseUrl 自动补 /v1', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'queued' }));
      const ref = await createVideoTask(openaiConfig, { prompt: '一只猫', seconds: '6' });
      expect(ref).toEqual({ provider: 'openai', remoteTaskId: 'video-123' });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.example.com/v1/videos');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).body).toBeInstanceOf(FormData);
    });

    it('音视频参考素材对 openai 渠道报错', async () => {
      await expect(
        createVideoTask(openaiConfig, { prompt: 'x', videoReferenceUrls: ['https://a.com/v.mp4'] }),
      ).rejects.toThrow('仅支持图片参考素材');
    });

    it('接口报错时优先提取接口返回的错误消息', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: { message: 'quota exceeded' } }, 429));
      await expect(createVideoTask(openaiConfig, { prompt: 'x' })).rejects.toThrow(
        'quota exceeded',
      );
    });
  });

  describe('createVideoTask（seedance）', () => {
    it('组装 content 数组（文本 + 参考图/视频/音频）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'sd-1' }));
      const ref = await createVideoTask(arkConfig, {
        prompt: '让画面动起来',
        imageReferences: [
          { dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', fileName: 'a.png' },
        ],
        videoReferenceUrls: ['https://pub.com/v.mp4'],
        audioReferenceUrls: ['https://pub.com/a.mp3'],
      });
      expect(ref).toEqual({ provider: 'seedance', remoteTaskId: 'sd-1' });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload.content[0]).toEqual({
        type: 'text',
        text: '参考图 1、参考视频 1、参考音频 1。让画面动起来',
      });
      expect(payload.content[1].role).toBe('reference_image');
      expect(payload.content[2].role).toBe('reference_video');
      expect(payload.content[3].role).toBe('reference_audio');
    });

    it('纯音频参考（无图无视频）报错', async () => {
      await expect(
        createVideoTask(arkConfig, { prompt: 'x', audioReferenceUrls: ['https://a.com/a.mp3'] }),
      ).rejects.toThrow('需要搭配');
    });
  });

  describe('pollVideoTask', () => {
    const openaiRef: VideoTaskRef = { provider: 'openai', remoteTaskId: 'video-123' };
    const seedanceRef: VideoTaskRef = { provider: 'seedance', remoteTaskId: 'sd-1' };

    it('进行中返回 pending', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'in_progress' }));
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({ status: 'pending' });
    });

    it('完成且有直链返回 succeeded+url', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 'video-123', status: 'completed', url: 'https://cdn.com/v.mp4' }),
      );
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'succeeded',
        url: 'https://cdn.com/v.mp4',
      });
    });

    it('完成但无直链返回 url:null（走 content 端点下载）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'completed' }));
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'succeeded',
        url: null,
      });
    });

    it('失败返回错误消息', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 'video-123', status: 'failed', error: { message: 'content policy' } }),
      );
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'failed',
        error: 'content policy',
      });
    });

    it('seedance 完成时从 content.video_url 提取地址', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          id: 'sd-1',
          status: 'succeeded',
          content: { video_url: 'https://cdn.com/sd.mp4' },
        }),
      );
      await expect(pollVideoTask(arkConfig, seedanceRef)).resolves.toEqual({
        status: 'succeeded',
        url: 'https://cdn.com/sd.mp4',
      });
    });

    it('seedance 完成但无地址视为失败', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'sd-1', status: 'succeeded' }));
      const state = await pollVideoTask(arkConfig, seedanceRef);
      expect(state.status).toBe('failed');
    });
  });
});
