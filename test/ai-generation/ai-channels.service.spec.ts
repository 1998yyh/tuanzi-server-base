import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';
import {
  AiChannel,
  ApiFormat,
  ModelCapability,
} from 'src/ai-generation/entities/ai-channel.entity';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { decrypt, encrypt } from 'src/common/utils/crypto.util';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('AiChannelsService', () => {
  let service: AiChannelsService;
  let repo: jest.Mocked<Repository<AiChannel>>;

  const user = { id: 'user-1' };

  const channel: AiChannel = {
    id: 'ch-1',
    user: user as never,
    userId: 'user-1',
    name: 'OpenAI 官方',
    apiFormat: ApiFormat.OPENAI,
    baseUrl: 'https://api.openai.com',
    apiKeyEncrypted: '',
    models: [{ name: 'gpt-image-2', capability: ModelCapability.IMAGE }],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiChannelsService,
        {
          provide: getRepositoryToken(AiChannel),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
            find: jest.fn(),
            findOne: jest.fn(),
            remove: jest.fn(async (v) => v),
          },
        },
        { provide: AGENT_ENCRYPTION_KEY, useValue: TEST_KEY },
      ],
    }).compile();

    service = module.get(AiChannelsService);
    repo = module.get(getRepositoryToken(AiChannel));
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('apiKey 应加密存储，响应只回脱敏值', async () => {
      const result = await service.create(user as never, {
        name: 'OpenAI 官方',
        apiFormat: ApiFormat.OPENAI,
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-secret-1234',
        models: [{ name: 'gpt-image-2', capability: ModelCapability.IMAGE }],
      });

      const saved = repo.save.mock.calls[0][0] as AiChannel;
      expect(saved.apiKeyEncrypted).toBeTruthy();
      expect(saved.apiKeyEncrypted).not.toContain('sk-secret-1234');
      expect(decrypt(saved.apiKeyEncrypted, TEST_KEY)).toBe('sk-secret-1234');

      expect(result).not.toHaveProperty('apiKeyEncrypted');
      expect(result.apiKeyMasked).toBe('****1234');
    });
  });

  describe('update', () => {
    it('不传 apiKey 时保持原密文', async () => {
      const existing = { ...channel, apiKeyEncrypted: encrypt('sk-old-key', TEST_KEY) };
      repo.findOne.mockResolvedValue(existing as AiChannel);

      await service.update(user as never, 'ch-1', { name: '新名字' });

      const saved = repo.save.mock.calls[0][0] as AiChannel;
      expect(saved.name).toBe('新名字');
      expect(decrypt(saved.apiKeyEncrypted, TEST_KEY)).toBe('sk-old-key');
    });

    it('他人渠道拒绝修改', async () => {
      repo.findOne.mockResolvedValue({ ...channel, userId: 'user-2' } as AiChannel);
      await expect(service.update(user as never, 'ch-1', { name: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('渠道不存在抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.update(user as never, 'ch-x', { name: 'x' })).rejects.toThrow(
        'AI 渠道 #ch-x 不存在',
      );
    });
  });

  describe('remove', () => {
    it('本人可删除', async () => {
      repo.findOne.mockResolvedValue(channel);
      await service.remove(user as never, 'ch-1');
      expect(repo.remove).toHaveBeenCalledWith(channel);
    });

    it('他人渠道拒绝删除', async () => {
      repo.findOne.mockResolvedValue({ ...channel, userId: 'user-2' } as AiChannel);
      await expect(service.remove(user as never, 'ch-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findWithKey', () => {
    it('返回解密后的 apiKey', async () => {
      const encrypted = await service.create(user as never, {
        name: 'x',
        apiFormat: ApiFormat.OPENAI,
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-plain-9999',
        models: [{ name: 'm', capability: ModelCapability.IMAGE }],
      });
      void encrypted;
      const saved = repo.save.mock.calls[0][0] as AiChannel;
      repo.findOne.mockResolvedValue({ ...saved, id: 'ch-9' });

      const result = await service.findWithKey('ch-9');
      expect(result.apiKey).toBe('sk-plain-9999');
    });

    it('不存在抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findWithKey('ch-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('chat 能力格式校验', () => {
    const chatChannelDto = {
      name: 'OpenAI 官方',
      apiFormat: ApiFormat.OPENAI,
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-test-key',
      models: [{ name: 'gpt-5', capability: ModelCapability.CHAT }],
    };

    it('openai 格式渠道允许 chat 模型', async () => {
      await expect(service.create(user as never, chatChannelDto)).resolves.toBeDefined();
    });

    it('anthropic 格式渠道允许 chat 模型', async () => {
      await expect(
        service.create(user as never, {
          ...chatChannelDto,
          apiFormat: ApiFormat.ANTHROPIC,
          baseUrl: 'https://api.anthropic.com',
          models: [{ name: 'claude-opus-4-8', capability: ModelCapability.CHAT }],
        }),
      ).resolves.toBeDefined();
    });

    it('gemini 格式渠道拒绝 chat 模型', async () => {
      await expect(
        service.create(user as never, { ...chatChannelDto, apiFormat: ApiFormat.GEMINI }),
      ).rejects.toThrow('不支持「对话」用途');
    });

    it('ark 格式渠道拒绝 chat 模型', async () => {
      await expect(
        service.create(user as never, { ...chatChannelDto, apiFormat: ApiFormat.ARK }),
      ).rejects.toThrow('不支持「对话」用途');
    });

    it('update 把 models 改成含 chat 时按合并后的 apiFormat 校验', async () => {
      // channel fixture 是 openai 格式；update 同时把 apiFormat 改成 gemini + models 含 chat → 拒绝
      repo.findOne.mockResolvedValue(channel);
      await expect(
        service.update(user as never, 'ch-1', {
          apiFormat: ApiFormat.GEMINI,
          models: [{ name: 'gemini-2.5-pro', capability: ModelCapability.CHAT }],
        }),
      ).rejects.toThrow('不支持「对话」用途');
    });
  });
});
