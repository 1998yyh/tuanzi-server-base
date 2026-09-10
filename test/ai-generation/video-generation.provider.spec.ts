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
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
}));

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
    it('配置模板的渠道地址不允许指向内网', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'unsafe' }));
      await expect(
        createVideoTask(
          {
            ...openaiConfig,
            baseUrl: 'http://127.0.0.1:3000',
            videoConfig: { template: 'text', requestFormat: 'json' },
          } as any,
          { prompt: '测试' },
        ),
      ).rejects.toThrow('内网');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('配置模板不跟随创建任务响应的重定向', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 307));
      await expect(
        createVideoTask(
          { ...openaiConfig, videoConfig: { template: 'text', requestFormat: 'json' } } as any,
          { prompt: '测试' },
        ),
      ).rejects.toThrow('重定向');
      expect(mockFetch.mock.calls[0][1].redirect).toBe('manual');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    it('自定义渠道模型按配置映射 JSON 字段，不依赖域名或模型名', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'custom-video' }));
      const config = {
        ...openaiConfig,
        model: 'custom-first-last',
        videoConfig: {
          template: 'first_last' as const,
          requestFormat: 'json' as const,
          fields: {
            firstFrame: 'start_image',
            lastFrame: 'end_image',
            seconds: 'duration',
            resolution: 'quality',
            aspectRatio: 'ratio',
          },
          maxSeconds: 8,
          resolutions: ['480p', '720p'],
        },
      };
      await createVideoTask(config, {
        prompt: '转场',
        seconds: '8',
        size: '9:16',
        vquality: '480p',
        imageReferences: refs(2),
      });
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        model: 'custom-first-last',
        prompt: '转场',
        duration: 8,
        quality: '480p',
        ratio: '9:16',
        start_image: 'https://8.8.8.8/0.png',
        end_image: 'https://8.8.8.8/1.png',
      });
    });

    it('自定义 multipart 模板按指定字段上传图片文件', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'custom-video' }));
      const config = {
        ...openaiConfig,
        videoConfig: {
          template: 'image' as const,
          requestFormat: 'multipart' as const,
          fields: { images: 'reference' },
          minImages: 1,
          maxImages: 1,
        },
      };
      await createVideoTask(config, { prompt: '动起来', imageReferences: refs(1) });
      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('reference')).toBeInstanceOf(Blob);
      expect(body.get('prompt')).toBe('动起来');
      expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
    });

    it('显式模板覆盖同名内置预设', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'custom-video' }));
      await createVideoTask(
        {
          ...h3Config,
          videoConfig: { template: 'text', requestFormat: 'json', maxSeconds: 4, resolutions: [] },
        } as any,
        { prompt: '无图视频', seconds: '4' },
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        model: h3Config.model,
        prompt: '无图视频',
        seconds: 4,
      });
    });

    it('自定义清晰度名称原样映射，固定时长无需填写最大时长', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'custom-video' }));
      await createVideoTask(
        {
          ...openaiConfig,
          videoConfig: {
            template: 'text',
            requestFormat: 'json',
            fixedSeconds: 30,
            resolutions: ['standard', 'high'],
          },
        } as any,
        { prompt: '测试', vquality: 'high' },
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
        seconds: 30,
        resolution: 'high',
      });
    });

    const h3Config = {
      ...openaiConfig,
      baseUrl: 'https://ai.939593.xyz/v1',
      model: 'minimax_h3_first_last',
    };
    const refs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        dataUrl: 'data:image/png;base64,AAAA',
        url: `https://8.8.8.8/${i}.png`,
        mimeType: 'image/png',
        fileName: `${i}.png`,
      }));

    it('按渠道文档直接用 JSON 传首尾帧、数字秒数和清晰度', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'h3-video' }));
      await createVideoTask(h3Config, {
        prompt: '过渡',
        seconds: '5',
        size: '1280x720',
        vquality: '480p',
        imageReferences: refs(2),
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0][1];
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({
        model: h3Config.model,
        prompt: '过渡',
        seconds: 5,
        resolution: '480P',
        aspect_ratio: '16:9',
        first_frame: 'https://8.8.8.8/0.png',
        last_frame: 'https://8.8.8.8/1.png',
      });
    });

    it.each([0, 1, 3])('首尾帧模型传 %i 张图在提交前报中文错误', async (count) => {
      await expect(
        createVideoTask(h3Config, { prompt: '过渡', imageReferences: refs(count) }),
      ).rejects.toThrow('首帧和尾帧');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('H3 图生视频支持 9 张图，auto 不传比例', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'h3-video' }));
      await createVideoTask(
        { ...h3Config, model: 'minimax_h3_i2v' },
        { prompt: '动起来', seconds: '12', size: 'auto', imageReferences: refs(9) },
      );
      const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(payload.input_reference).toHaveLength(9);
      expect(payload.seconds).toBe(12);
      expect(payload).not.toHaveProperty('aspect_ratio');
      expect(payload).not.toHaveProperty('size');
    });

    it('H3 图生视频超出 12 秒时拒绝，不能静默裁剪', async () => {
      await expect(
        createVideoTask(
          { ...h3Config, model: 'minimax_h3_i2v' },
          { prompt: '动起来', seconds: '15', imageReferences: refs(1) },
        ),
      ).rejects.toThrow('12');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('H3 不支持的清晰度在提交前拒绝', async () => {
      await expect(
        createVideoTask(h3Config, { prompt: '过渡', vquality: '1080p', imageReferences: refs(2) }),
      ).rejects.toThrow('480P');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('H3 对口型把一段音频映射为 audio', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'h3-video' }));
      await createVideoTask(
        { ...h3Config, model: 'minimax_h3_lipsync' },
        { prompt: '说话', imageReferences: refs(1), audioReferenceUrls: ['https://8.8.8.8/a.mp3'] },
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
        audio: 'https://8.8.8.8/a.mp3',
        input_reference: ['https://8.8.8.8/0.png'],
      });
    });

    it('Vela 直接传 images，使用预设的固定时长和清晰度', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'vela-video' }));
      await createVideoTask(
        { ...h3Config, model: 'vela-2.5' },
        {
          prompt: '动起来',
          seconds: '5',
          size: '1:1',
          vquality: '480p',
          imageReferences: refs(10),
        },
      );
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        model: 'vela-2.5',
        prompt: '动起来',
        aspect_ratio: '1:1',
        seconds: 30,
        resolution: '720P',
        images: refs(10).map((r) => r.url),
      });
    });

    it('其他渠道相同模型名保留原有协议', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'other-video' }));
      await createVideoTask(
        { ...h3Config, baseUrl: 'https://other.example.com' },
        { prompt: '过渡', imageReferences: refs(2) },
      );
      expect(mockFetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
    });

    it('备用域名的文生视频同样直接提交 JSON', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'text-video' }));
      await createVideoTask(
        { ...h3Config, baseUrl: 'https://cdn-ai.939593.xyz', model: 'minimax_h3_t2v' },
        { prompt: '翠鸟捕鱼', seconds: '15', size: 'auto', vquality: '720p' },
      );
      expect(mockFetch.mock.calls[0][0]).toBe('https://cdn-ai.939593.xyz/v1/videos');
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        model: 'minimax_h3_t2v',
        prompt: '翠鸟捕鱼',
        seconds: 15,
        resolution: '720P',
      });
    });

    it.each([
      ['minimax_h3_i2v', { imageReferences: refs(10) }, '最多 9'],
      ['minimax_h3_i2v', {}, '需要参考图片'],
      ['minimax_h3_t2v', { imageReferences: refs(1) }, '不支持参考图片'],
      ['minimax_h3_lipsync', { imageReferences: refs(1) }, '1 段参考音频'],
      [
        'minimax_h3_i2v',
        { imageReferences: refs(1), audioReferenceUrls: ['https://8.8.8.8/a.mp3'] },
        '不支持参考音频',
      ],
      [
        'minimax_h3_i2v',
        { imageReferences: refs(1), videoReferenceUrls: ['https://8.8.8.8/a.mp4'] },
        '不支持参考视频',
      ],
      ['minimax_h3_t2v', { seconds: '1.5' }, '整数'],
      ['minimax_h3_t2v', { seconds: '16' }, '15'],
      ['minimax_h3_t2v', { size: '4:3' }, '比例'],
      [
        'minimax_h3_i2v',
        { imageReferences: [{ ...refs(1)[0], url: 'http://127.0.0.1/a.png' }] },
        '公网',
      ],
    ])('文档渠道拒绝非法素材或参数：%s %j', async (model, request, message) => {
      await expect(
        createVideoTask({ ...h3Config, model }, { prompt: '测试', ...request }),
      ).rejects.toThrow(message);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('文档渠道提交失败不重复创建任务', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: { message: '服务繁忙' } }, 503));
      await expect(
        createVideoTask(h3Config, { prompt: '过渡', imageReferences: refs(2) }),
      ).rejects.toThrow('服务繁忙');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('上游明确要求 JSON 时使用公网参考图重试一次', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: { message: 'JSON body required (public image URLs only)' } }, 400),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'json-video' }));
      const image = {
        dataUrl: 'data:image/png;base64,AAAA',
        url: 'https://8.8.8.8/uploads/media/a.png',
        mimeType: 'image/png',
        fileName: 'a.png',
      };
      await expect(
        createVideoTask(openaiConfig, {
          prompt: '动起来',
          seconds: '8',
          size: '9:16',
          imageReferences: [image],
        }),
      ).resolves.toEqual({ provider: 'openai', remoteTaskId: 'json-video' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url, init] = mockFetch.mock.calls[1];
      expect(url).toBe('https://api.example.com/v1/videos');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toMatchObject({
        model: 'sora-2',
        prompt: '动起来',
        seconds: '8',
        size: '720x1280',
        input_reference: [image.url],
      });
      expect(init.body).not.toContain('base64');
    });

    it('纯文本请求也能在明确拒绝表单后改用 JSON', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: 'JSON body required (public image URLs only)' }, 400),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'text-video' }));
      await expect(createVideoTask(openaiConfig, { prompt: '猫', size: 'auto' })).resolves.toEqual({
        provider: 'openai',
        remoteTaskId: 'text-video',
      });
      const payload = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(payload).not.toHaveProperty('input_reference');
      expect(payload).not.toHaveProperty('size');
    });

    it.each([undefined, 'http://127.0.0.1/a.png', 'data:image/png;base64,AAAA'])(
      'JSON 重试拒绝缺失或非公网图片地址：%s',
      async (url) => {
        mockFetch.mockResolvedValue(
          jsonResponse({ message: 'JSON body required (public image URLs only)' }, 400),
        );
        await expect(
          createVideoTask(openaiConfig, {
            prompt: '猫',
            imageReferences: [
              {
                dataUrl: 'data:image/png;base64,AAAA',
                mimeType: 'image/png',
                fileName: 'a.png',
                url,
              },
            ] as any,
          }),
        ).rejects.toThrow('公网');
        expect(mockFetch).toHaveBeenCalledTimes(1);
      },
    );

    it('JSON 仍失败时不继续重试，透出第二次错误', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: 'JSON body required (public image URLs only)' }, 400),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: '模型不支持' }, 400));
      await expect(createVideoTask(openaiConfig, { prompt: '猫' })).rejects.toThrow('模型不支持');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('普通 400 不触发格式重试', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ message: '参数错误' }, 400));
      await expect(createVideoTask(openaiConfig, { prompt: '猫' })).rejects.toThrow('参数错误');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

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
