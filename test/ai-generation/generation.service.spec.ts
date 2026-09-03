import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GenerationService } from 'src/ai-generation/generation.service';
import {
  GenerationTask,
  GenerationTaskStatus,
} from 'src/ai-generation/entities/generation-task.entity';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';
import { MediaService } from 'src/media/media.service';
import { CanvasOpsService } from 'src/canvas/canvas-ops.service';
import { ApiFormat, ModelCapability } from 'src/ai-generation/entities/ai-channel.entity';
import { MediaKind, MediaSource } from 'src/media/media-file.entity';
import { generateImages } from 'src/ai-generation/providers/image-generation.provider';

jest.mock('src/ai-generation/providers/image-generation.provider', () => ({
  generateImages: jest.fn(),
}));

// 参考图读取走 fs，测试中拦截避免真实磁盘访问
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(async () => Buffer.from('fake-image-bytes')),
}));

const mockedGenerateImages = jest.mocked(generateImages);

describe('GenerationService', () => {
  let service: GenerationService;
  let taskRepo: jest.Mocked<Repository<GenerationTask>>;
  let aiChannelsService: { findWithKey: jest.Mock };
  let mediaService: {
    findByIdsForUser: jest.Mock;
    saveBuffer: jest.Mock;
    toView: jest.Mock;
    diskPath: jest.Mock;
  };

  const user = { id: 'user-1' };
  const channel = {
    id: 'ch-1',
    userId: 'user-1',
    name: 'OpenAI 官方',
    isActive: true,
    apiFormat: ApiFormat.OPENAI,
    baseUrl: 'https://api.openai.com',
    models: [{ name: 'gpt-image-2', capability: ModelCapability.IMAGE }],
  };

  const task: GenerationTask = {
    id: 'task-1',
    user: user as never,
    userId: 'user-1',
    channel: channel as never,
    channelId: 'ch-1',
    model: 'gpt-image-2',
    capability: ModelCapability.IMAGE,
    status: GenerationTaskStatus.PROCESSING,
    prompt: '一只猫',
    params: null,
    remoteTaskId: null,
    resultMedia: null,
    resultMediaId: null,
    resultExtra: null,
    error: null,
    nodeRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    taskRepo = {
      create: jest.fn((v) => ({ ...v, id: 'task-1' })),
      save: jest.fn(async (v) => v),
      update: jest.fn(async () => ({})),
      findOne: jest.fn(),
      remove: jest.fn(async (v) => v),
      createQueryBuilder: jest.fn(),
    } as never;
    aiChannelsService = { findWithKey: jest.fn() };
    mediaService = {
      findByIdsForUser: jest.fn(async () => []),
      saveBuffer: jest.fn(async (_userId: string, _buf: Buffer, opts: unknown) => ({
        id: 'media-1',
        url: '/uploads/media/x.png',
        ...(opts as object),
      })),
      toView: jest.fn((m) => m),
      diskPath: jest.fn((m) => `/tmp/${(m as { fileName: string }).fileName}`),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenerationService,
        { provide: getRepositoryToken(GenerationTask), useValue: taskRepo },
        { provide: AiChannelsService, useValue: aiChannelsService },
        { provide: MediaService, useValue: mediaService },
        { provide: CanvasOpsService, useValue: { patchNodeMetadata: jest.fn() } },
      ],
    }).compile();

    service = module.get(GenerationService);
    jest.clearAllMocks();
  });

  describe('resolveChannelModel', () => {
    it('格式非法时报错', async () => {
      await expect(
        service.resolveChannelModel('user-1', 'bad-ref', ModelCapability.IMAGE),
      ).rejects.toThrow('channelId::modelName');
    });

    it('他人渠道拒绝', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({
        channel: { ...channel, userId: 'user-2' },
        apiKey: 'k',
      });
      await expect(
        service.resolveChannelModel('user-1', 'ch-1::gpt-image-2', ModelCapability.IMAGE),
      ).rejects.toThrow(ForbiddenException);
    });

    it('停用渠道拒绝', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({
        channel: { ...channel, isActive: false },
        apiKey: 'k',
      });
      await expect(
        service.resolveChannelModel('user-1', 'ch-1::gpt-image-2', ModelCapability.IMAGE),
      ).rejects.toThrow('已停用');
    });

    it('模型不存在或能力不匹配时报错', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({ channel, apiKey: 'k' });
      await expect(
        service.resolveChannelModel('user-1', 'ch-1::unknown', ModelCapability.IMAGE),
      ).rejects.toThrow('不存在模型');
      await expect(
        service.resolveChannelModel('user-1', 'ch-1::gpt-image-2', ModelCapability.VIDEO),
      ).rejects.toThrow('不是video能力模型');
    });

    it('成功返回解密后的渠道配置', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({ channel, apiKey: 'sk-plain' });
      const resolved = await service.resolveChannelModel(
        'user-1',
        'ch-1::gpt-image-2',
        ModelCapability.IMAGE,
      );
      expect(resolved).toEqual({
        channelId: 'ch-1',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-plain',
        apiFormat: ApiFormat.OPENAI,
        model: 'gpt-image-2',
      });
    });
  });

  describe('generateImage', () => {
    const dto = {
      modelRef: 'ch-1::gpt-image-2',
      prompt: '一只猫',
      count: 1,
    };

    it('成功：b64 输出落盘，任务置为 succeeded', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({ channel, apiKey: 'k' });
      mockedGenerateImages.mockResolvedValue([
        { kind: 'b64', data: Buffer.from('png-bytes').toString('base64') },
      ]);
      taskRepo.findOne.mockResolvedValue({ ...task, status: GenerationTaskStatus.SUCCEEDED });

      const result = await service.generateImage(user as never, dto as never);

      expect(mockedGenerateImages).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-image-2', apiKey: 'k' }),
        expect.objectContaining({ prompt: '一只猫', count: 1 }),
      );
      expect(mediaService.saveBuffer).toHaveBeenCalledWith(
        'user-1',
        expect.any(Buffer),
        expect.objectContaining({ kind: MediaKind.IMAGE, source: MediaSource.GENERATION }),
      );
      expect(taskRepo.update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: GenerationTaskStatus.SUCCEEDED,
          resultMediaId: 'media-1',
        }),
      );
      expect(result.media).toHaveLength(1);
    });

    it('有参考图时 prompt 自动加编号前缀', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({ channel, apiKey: 'k' });
      mediaService.findByIdsForUser.mockResolvedValue([
        {
          id: 'm1',
          userId: 'user-1',
          kind: MediaKind.IMAGE,
          mimeType: 'image/png',
          fileName: 'a.png',
        },
      ]);
      mockedGenerateImages.mockResolvedValue([{ kind: 'b64', data: 'eA==' }]);
      taskRepo.findOne.mockResolvedValue(task);

      await service.generateImage(user as never, { ...dto, referenceMediaIds: ['m1'] } as never);

      const req = mockedGenerateImages.mock.calls[0][1];
      expect(req.prompt).toBe('参考图 1。一只猫');
      expect(req.references).toHaveLength(1);
    });

    it('失败：任务置为 failed 并抛出中文错误', async () => {
      aiChannelsService.findWithKey.mockResolvedValue({ channel, apiKey: 'k' });
      mockedGenerateImages.mockRejectedValue(new Error('接口限流，请稍后重试'));

      await expect(service.generateImage(user as never, dto as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(taskRepo.update).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          status: GenerationTaskStatus.FAILED,
          error: '接口限流，请稍后重试',
        }),
      );
    });
  });

  describe('findTask', () => {
    it('他人任务拒绝查看', async () => {
      taskRepo.findOne.mockResolvedValue({ ...task, userId: 'user-2' });
      await expect(service.findTask(user as never, 'task-1')).rejects.toThrow(ForbiddenException);
    });

    it('不存在抛 NotFoundException', async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.findTask(user as never, 'task-x')).rejects.toThrow(
        '生成任务 #task-x 不存在',
      );
    });
  });

  describe('removeTask', () => {
    it('删除自己的任务', async () => {
      taskRepo.findOne.mockResolvedValue(task);
      await service.removeTask(user as never, 'task-1');
      expect(taskRepo.remove).toHaveBeenCalledWith(task);
    });

    it('他人任务拒绝删除', async () => {
      taskRepo.findOne.mockResolvedValue({ ...task, userId: 'user-2' });
      await expect(service.removeTask(user as never, 'task-1')).rejects.toThrow(ForbiddenException);
      expect(taskRepo.remove).not.toHaveBeenCalled();
    });

    it('不存在抛 NotFoundException', async () => {
      taskRepo.findOne.mockResolvedValue(null);
      await expect(service.removeTask(user as never, 'task-x')).rejects.toThrow(NotFoundException);
    });
  });
});
