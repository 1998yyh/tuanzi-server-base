import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentsService } from 'src/agents/agents.service';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { SkillsService } from 'src/skills/skills.service';
import { McpServer, McpServerType } from 'src/mcp-servers/mcp-server.entity';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';
import { ApiFormat } from 'src/ai-generation/entities/ai-channel.entity';
import { UserRole } from 'src/users/users.entity';

describe('AgentsService', () => {
  let service: AgentsService;
  let repo: jest.Mocked<Repository<AgentConfig>>;
  let mcpServersService: Record<string, jest.Mock>;
  let skillsService: Record<string, jest.Mock>;
  let aiChannelsService: jest.Mocked<AiChannelsService>;

  const normalUser = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseAgent: AgentConfig = {
    id: 'agent-1',
    userId: 'user-1',
    user: normalUser as never,
    name: '客服助手',
    description: null,
    channel: null as never,
    channelId: 'ch-1',
    modelName: 'claude-opus-4-8',
    systemPrompt: '你是客服',
    maxTokens: 4096,
    maxIterations: 10,
    enabledTools: ['web_search'],
    legacyMcpServers: null,
    mcpServers: [],
    skills: [],
    isActive: true,
    conversations: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createDto = {
    name: '客服助手',
    channelId: 'ch-1',
    modelName: 'claude-opus-4-8',
  };

  const sseServer: McpServer = {
    id: 'srv-1',
    name: 'web-search',
    type: McpServerType.SSE,
    command: null,
    args: null,
    envEncrypted: null,
    url: 'https://mcp.example.com/sse',
    headersEncrypted: null,
    description: null,
    isActive: true,
    creator: normalUser as never,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    skillsService = {
      findViewsByAgentConfig: jest.fn(),
      validateForAssociation: jest.fn(),
      toView: jest.fn((s: { id: string; name: string }) => ({ id: s.id, name: s.name })),
    };
    mcpServersService = {
      findViewsByAgentConfig: jest.fn(),
      validateForAssociation: jest.fn(),
      toView: jest.fn((s: McpServer) => ({ id: s.id, name: s.name })),
    };
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
        { provide: McpServersService, useValue: mcpServersService },
        { provide: SkillsService, useValue: skillsService },
        {
          provide: AiChannelsService,
          useValue: {
            resolveChatModel: jest.fn(async () => ({
              channelId: 'ch-1',
              apiFormat: ApiFormat.OPENAI,
              baseUrl: 'https://api.openai.com',
              apiKey: 'sk-x',
              model: 'claude-opus-4-8',
            })),
            getById: jest.fn(async () => ({
              id: 'ch-1',
              name: '公司网关',
              apiFormat: ApiFormat.OPENAI,
            })),
          },
        },
      ],
    }).compile();

    service = module.get(AgentsService);
    repo = module.get(getRepositoryToken(AgentConfig));
    aiChannelsService = module.get(AiChannelsService);
  });

  describe('create', () => {
    it('先校验渠道再落库，响应拼装渠道信息且无密文字段', async () => {
      const result = await service.create(normalUser, createDto);

      expect(aiChannelsService.resolveChatModel).toHaveBeenCalledWith(
        'user-1',
        'ch-1',
        'claude-opus-4-8',
      );
      expect(result.channelName).toBe('公司网关');
      expect(result.apiFormat).toBe(ApiFormat.OPENAI);
      expect(result.modelName).toBe('claude-opus-4-8');
      expect(result).not.toHaveProperty('apiKeyMasked');
      expect(result).not.toHaveProperty('apiKeyEncrypted');
      expect(result).not.toHaveProperty('userId');
    });

    it('渠道校验失败（如模型用途不是「对话」）时创建抛错', async () => {
      aiChannelsService.resolveChatModel.mockRejectedValueOnce(
        new BadRequestException('模型 "gpt-image-2" 的用途不是「对话」'),
      );
      await expect(
        service.create(normalUser, { name: 'x', channelId: 'ch-1', modelName: 'gpt-image-2' }),
      ).rejects.toThrow('的用途不是「对话」');
    });

    it('未传 enabledTools 时应该默认空数组', async () => {
      await service.create(normalUser, createDto);
      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.enabledTools).toEqual([]);
    });

    it('响应不应再包含 mcpServers 字段（已迁移到关联端点）', async () => {
      const result = await service.create(normalUser, createDto);
      expect(result).not.toHaveProperty('mcpServers');
    });
  });

  describe('findAll', () => {
    it('应该只查当前用户的启用中 Agent，并返回分页结构', async () => {
      repo.findAndCount.mockResolvedValue([[baseAgent], 1]);

      const result = await service.findAll('user-1', { page: 1, limit: 10 });

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', isActive: true } }),
      );
      expect(result).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
      expect(result.items[0].channelName).toBe('公司网关');
    });
  });

  describe('findOne', () => {
    it('查不到（含他人的 Agent）应该抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('other-user', 'agent-1')).rejects.toThrow(NotFoundException);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1', userId: 'other-user' },
      });
    });
  });

  describe('update', () => {
    it('只在传了 channelId 或 modelName 时才重新校验渠道', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });

      await service.update(normalUser, 'agent-1', { name: '改名' });
      expect(aiChannelsService.resolveChatModel).not.toHaveBeenCalled();

      await service.update(normalUser, 'agent-1', { modelName: 'gpt-5' });
      // 合并校验：channelId 用现值
      expect(aiChannelsService.resolveChatModel).toHaveBeenCalledWith('user-1', 'ch-1', 'gpt-5');
    });
  });

  describe('remove', () => {
    it('应该是软删除（isActive = false）', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });

      await service.remove('user-1', 'agent-1');

      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.isActive).toBe(false);
    });

    it('他人的 Agent 应该抛 404 且不写库', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.remove('other-user', 'agent-1')).rejects.toThrow(NotFoundException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('getMcpServers', () => {
    it('应该校验归属后返回关联的 MCP Server 视图', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });
      mcpServersService.findViewsByAgentConfig.mockResolvedValue([{ id: 'srv-1' }]);

      const result = await service.getMcpServers('user-1', 'agent-1');

      expect(mcpServersService.findViewsByAgentConfig).toHaveBeenCalledWith('agent-1');
      expect(result).toEqual([{ id: 'srv-1' }]);
    });

    it('他人的 Agent 应该抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getMcpServers('other-user', 'agent-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateMcpServers', () => {
    it('应该校验后整体替换关联并返回视图列表', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });
      mcpServersService.validateForAssociation.mockResolvedValue([sseServer]);

      const result = await service.updateMcpServers(normalUser, 'agent-1', ['srv-1']);

      expect(mcpServersService.validateForAssociation).toHaveBeenCalledWith(['srv-1'], normalUser);
      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.mcpServers).toEqual([sseServer]);
      expect(result).toEqual([{ id: 'srv-1', name: 'web-search' }]);
    });

    it('他人的 Agent 应该抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.updateMcpServers(normalUser, 'agent-1', [])).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateSkills', () => {
    it('应该校验后整体替换关联并返回视图列表', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });
      const skill = { id: 'skill-1', name: 'generate_ai_report' };
      skillsService.validateForAssociation.mockResolvedValue([skill]);

      const result = await service.updateSkills(normalUser, 'agent-1', ['skill-1']);

      expect(skillsService.validateForAssociation).toHaveBeenCalledWith(['skill-1']);
      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.skills).toEqual([skill]);
      expect(result).toEqual([{ id: 'skill-1', name: 'generate_ai_report' }]);
    });
  });

  describe('getSkills', () => {
    it('应该校验归属后返回关联的 Skill 视图', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });
      skillsService.findViewsByAgentConfig.mockResolvedValue([{ id: 'skill-1' }]);

      const result = await service.getSkills('user-1', 'agent-1');

      expect(skillsService.findViewsByAgentConfig).toHaveBeenCalledWith('agent-1');
      expect(result).toEqual([{ id: 'skill-1' }]);
    });
  });
});
