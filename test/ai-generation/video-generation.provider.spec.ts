import {
  createVideoTask,
  downloadVideoContent,
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

/** 带可流式读取 body 的二进制响应（downloadVideoContent 走流式读取） */
function binaryResponse(bytes: Uint8Array, mimeType = 'video/mp4'): Response {
  return {
    ok: true,
    status: 200,
    type: 'basic',
    headers: new Headers({ 'content-type': mimeType, 'content-length': String(bytes.length) }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
}

/** 公网字面 IP 渠道地址：assertPublicUrl 直接放行，不触发 DNS */
const ipConfig: ResolvedChannelConfig = { ...openaiConfig, baseUrl: 'https://8.8.8.8' };

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

  describe('createVideoTask 参考素材上限（超限显式校验，不再静默裁剪）', () => {
    const imageRefs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        dataUrl: 'data:image/png;base64,AAAA',
        mimeType: 'image/png',
        fileName: `a${i}.png`,
      }));

    it('openai 参考图片超过 7 张报错', async () => {
      await expect(
        createVideoTask(openaiConfig, { prompt: 'x', imageReferences: imageRefs(8) }),
      ).rejects.toThrow('参考图片最多 7 张');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('seedance 参考图片超过 9 张报错', async () => {
      await expect(
        createVideoTask(arkConfig, { prompt: 'x', imageReferences: imageRefs(10) }),
      ).rejects.toThrow('参考图片最多 9 张');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('seedance 参考视频超过 3 个报错', async () => {
      const videoReferenceUrls = Array.from({ length: 4 }, () => 'https://pub.com/v.mp4');
      await expect(createVideoTask(arkConfig, { prompt: 'x', videoReferenceUrls })).rejects.toThrow(
        '参考视频最多 3 个',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('seedance 参考音频超过 3 个报错', async () => {
      const audioReferenceUrls = Array.from({ length: 4 }, () => 'https://pub.com/a.mp3');
      await expect(createVideoTask(arkConfig, { prompt: 'x', audioReferenceUrls })).rejects.toThrow(
        '参考音频最多 3 个',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('恰好 7 张参考图（openai）正常提交', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'queued' }));
      const ref = await createVideoTask(openaiConfig, {
        prompt: 'x',
        imageReferences: imageRefs(7),
      });
      expect(ref.remoteTaskId).toBe('video-123');
    });
  });

  describe('pollVideoTask 终态识别（放宽）', () => {
    const openaiRef: VideoTaskRef = { provider: 'openai', remoteTaskId: 'video-123' };

    it('状态 succeeded 且有直链：视为成功终态', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 'video-123', status: 'succeeded', url: 'https://cdn.com/v.mp4' }),
      );
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'succeeded',
        url: 'https://cdn.com/v.mp4',
      });
    });

    it('状态 done 且有直链：视为成功终态', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 'video-123', status: 'done', video_url: 'https://cdn.com/done.mp4' }),
      );
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'succeeded',
        url: 'https://cdn.com/done.mp4',
      });
    });

    it('状态 success 且有直链：视为成功终态', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 'video-123', status: 'success', result_url: 'https://cdn.com/s.mp4' }),
      );
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'succeeded',
        url: 'https://cdn.com/s.mp4',
      });
    });

    it('状态 succeeded 但无直链：视为失败（对齐 Seedance 分支）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'succeeded' }));
      await expect(pollVideoTask(openaiConfig, openaiRef)).resolves.toEqual({
        status: 'failed',
        error: '任务完成但未返回视频地址',
      });
    });

    it('状态 done 但无直链：视为失败', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'video-123', status: 'done' }));
      const state = await pollVideoTask(openaiConfig, openaiRef);
      expect(state.status).toBe('failed');
    });
  });

  describe('downloadVideoContent（SSRF + 流式大小上限）', () => {
    const ref: VideoTaskRef = { provider: 'openai', remoteTaskId: 'video-1' };

    it('正常流式下载返回 buffer 与 mimeType', async () => {
      const bytes = new TextEncoder().encode('fake-video-bytes');
      mockFetch.mockResolvedValue(binaryResponse(bytes));
      const { buffer, mimeType } = await downloadVideoContent(ipConfig, ref);
      expect(buffer.toString()).toBe('fake-video-bytes');
      expect(mimeType).toBe('video/mp4');
      // 下载 URL 落在渠道 baseUrl 下（自动补 /v1 + /content）
      expect(String(mockFetch.mock.calls[0][0])).toBe('https://8.8.8.8/v1/videos/video-1/content');
    });

    it('私网渠道地址被 SSRF 拦截（不发起请求）', async () => {
      await expect(
        downloadVideoContent({ ...openaiConfig, baseUrl: 'http://127.0.0.1:8080' }, ref),
      ).rejects.toThrow('禁止访问内网或保留地址');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('重定向响应拒绝', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
      } as unknown as Response);
      await expect(downloadVideoContent(ipConfig, ref)).rejects.toThrow('响应重定向');
    });

    it('响应超过 200MB 上限报错', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let pushed = 0;
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        type: 'basic',
        headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '1' }),
        body: new ReadableStream({
          pull(controller) {
            if (pushed >= 201) {
              controller.close();
              return;
            }
            pushed += 1;
            controller.enqueue(chunk);
          },
        }),
      } as unknown as Response);
      await expect(downloadVideoContent(ipConfig, ref)).rejects.toThrow('超过大小限制（200MB）');
    });
  });
});
