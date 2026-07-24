import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentsService } from 'src/agents/agents.service';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { decrypt, encrypt } from 'src/agents/utils/crypto.util';
import { UserRole } from 'src/users/users.entity';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const API_KEY = 'sk-ant-api03-abcdefg123456';

describe('AgentsService', () => {
  let service: AgentsService;
  let repo: jest.Mocked<Repository<AgentConfig>>;

  const normalUser = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adminUser = { ...normalUser, id: 'admin-1', role: UserRole.ADMIN };

  const baseAgent: AgentConfig = {
    id: 'agent-1',
    userId: 'user-1',
    user: normalUser as never,
    name: '客服助手',
    description: null,
    provider: ProviderType.ANTHROPIC,
    model: 'claude-opus-4-8',
    apiKeyEncrypted: encrypt(API_KEY, TEST_KEY),
    systemPrompt: '你是客服',
    maxTokens: 4096,
    maxIterations: 10,
    enabledTools: ['web_search'],
    mcpServers: [],
    isActive: true,
    conversations: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createDto = {
    name: '客服助手',
    provider: ProviderType.ANTHROPIC,
    model: 'claude-opus-4-8',
    apiKey: API_KEY,
    systemPrompt: '你是客服',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        {
          provide: getRepositoryToken(AgentConfig),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
          },
        },
        { provide: AGENT_ENCRYPTION_KEY, useValue: TEST_KEY },
      ],
    }).compile();

    service = module.get(AgentsService);
    repo = module.get(getRepositoryToken(AgentConfig));
  });

  describe('create', () => {
    it('API Key 应该加密存储，响应只返回脱敏后 4 位', async () => {
      const result = await service.create(normalUser, createDto);

      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.apiKeyEncrypted).not.toContain(API_KEY);
      expect(decrypt(saved.apiKeyEncrypted, TEST_KEY)).toBe(API_KEY);
      expect(saved.userId).toBe(normalUser.id);
      expect(result.apiKeyMasked).toBe('****3456');
      expect(result).not.toHaveProperty('apiKeyEncrypted');
      expect(result).not.toHaveProperty('userId');
    });

    it('未传 enabledTools / mcpServers 时应该默认空数组', async () => {
      await service.create(normalUser, createDto);
      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.enabledTools).toEqual([]);
      expect(saved.mcpServers).toEqual([]);
    });

    it('普通用户配置 stdio MCP 应该抛 403', async () => {
      await expect(
        service.create(normalUser, {
          ...createDto,
          mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx fs' }],
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.create(normalUser, {
          ...createDto,
          mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx fs' }],
        }),
      ).rejects.toThrow('仅管理员可配置 stdio 类型的 MCP Server');
    });

    it('管理员配置 stdio MCP 应该成功', async () => {
      const result = await service.create(adminUser, {
        ...createDto,
        mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx fs' }],
      });
      expect(result.mcpServers).toHaveLength(1);
    });

    it('普通用户配置 sse MCP 应该成功', async () => {
      const result = await service.create(normalUser, {
        ...createDto,
        mcpServers: [{ name: 'remote', transport: 'sse', url: 'https://mcp.example.com/sse' }],
      });
      expect(result.mcpServers).toHaveLength(1);
    });
  });

  describe('findAll', () => {
    it('应该只查当前用户的启用中 Agent，并返回分页结构', async () => {
      repo.findAndCount.mockResolvedValue([[baseAgent], 1]);

      const result = await service.findAll('user-1', { page: 1, limit: 10 });

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', isActive: true },
        }),
      );
      expect(result).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
      expect(result.items[0].apiKeyMasked).toBe('****3456');
    });
  });

  describe('findOne', () => {
    it('应该按 userId 隔离查询', async () => {
      repo.findOne.mockResolvedValue(baseAgent);

      const result = await service.findOne('user-1', 'agent-1');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1', userId: 'user-1' },
      });
      expect(result.id).toBe('agent-1');
    });

    it('查不到（含他人的 Agent）应该抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('other-user', 'agent-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('传了 apiKey 才重新加密', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });

      await service.update(normalUser, 'agent-1', { name: '新名字' });
      let saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.apiKeyEncrypted).toBe(baseAgent.apiKeyEncrypted);

      await service.update(normalUser, 'agent-1', { apiKey: 'sk-new-key-9999' });
      saved = repo.save.mock.calls[1][0] as AgentConfig;
      expect(decrypt(saved.apiKeyEncrypted, TEST_KEY)).toBe('sk-new-key-9999');
    });

    it('更新 stdio MCP 时普通用户应该抛 403', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });
      await expect(
        service.update(normalUser, 'agent-1', {
          mcpServers: [{ name: 'fs', transport: 'stdio', command: 'npx fs' }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('应该是软删除（isActive = false）', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });

      await service.remove('user-1', 'agent-1');

      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.isActive).toBe(false);
    });

    it('他人的 Agent 删除时应该抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove('other-user', 'agent-1')).rejects.toThrow(NotFoundException);
    });
  });
});
