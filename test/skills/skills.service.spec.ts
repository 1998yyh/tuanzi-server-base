import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SkillsService } from 'src/skills/skills.service';
import { Skill } from 'src/skills/skill.entity';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { UserRole } from 'src/users/users.entity';

describe('SkillsService', () => {
  let service: SkillsService;
  let repo: jest.Mocked<Repository<Skill>>;
  let mcpServersService: Record<string, jest.Mock>;

  const normalUser = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adminUser = { ...normalUser, id: 'admin-1', role: UserRole.ADMIN };

  const baseSkill: Skill = {
    id: 'skill-1',
    name: 'generate_ai_report',
    description: '生成 AI 日报',
    systemPrompt: '你是日报撰写助手',
    inputSchema: null,
    enabledTools: ['web_search'],
    isActive: true,
    mcpServers: [],
    creator: normalUser as never,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createDto = {
    name: 'generate_ai_report',
    description: '生成 AI 日报',
    systemPrompt: '你是日报撰写助手',
    enabledTools: ['web_search'],
  };

  beforeEach(async () => {
    mcpServersService = { validateForAssociation: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillsService,
        {
          provide: getRepositoryToken(Skill),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => ({ id: 'skill-1', ...v })),
            findOne: jest.fn(),
            find: jest.fn(),
            findAndCount: jest.fn(),
            remove: jest.fn(async (v) => v),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: McpServersService, useValue: mcpServersService },
      ],
    }).compile();

    service = module.get(SkillsService);
    repo = module.get(getRepositoryToken(Skill));
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('应该保存 Skill 并返回含 mcpServerIds 的视图', async () => {
      repo.findOne
        .mockResolvedValueOnce(null) // 名称查重
        .mockResolvedValueOnce({ ...baseSkill }); // 保存后回读

      const result = await service.create(normalUser, createDto);

      const saved = repo.save.mock.calls[0][0] as Skill;
      expect(saved.createdBy).toBe('user-1');
      expect(result.mcpServerIds).toEqual([]);
      expect(result).not.toHaveProperty('mcpServers');
    });

    it('名称重复应抛 409', async () => {
      repo.findOne.mockResolvedValue({ ...baseSkill });

      await expect(service.create(normalUser, createDto)).rejects.toThrow(ConflictException);
    });

    it('enabledTools 含未注册工具名应抛 400', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.create(normalUser, { ...createDto, enabledTools: ['not_a_tool'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('传 mcpServerIds 时应走 McpServersService 校验并写关联', async () => {
      const mcpServer = { id: 'srv-1' };
      mcpServersService.validateForAssociation.mockResolvedValue([mcpServer]);
      repo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...baseSkill, mcpServers: [mcpServer] as never });

      const result = await service.create(normalUser, { ...createDto, mcpServerIds: ['srv-1'] });

      expect(mcpServersService.validateForAssociation).toHaveBeenCalledWith(['srv-1'], normalUser);
      expect(result.mcpServerIds).toEqual(['srv-1']);
    });
  });

  describe('findAllActive', () => {
    it('应只查启用中的 Skill 并返回视图', async () => {
      repo.findAndCount.mockResolvedValue([[{ ...baseSkill }], 1]);

      const result = await service.findAllActive();

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
      expect(result.total).toBe(1);
      expect(result.items[0].name).toBe('generate_ai_report');
    });
  });

  describe('update', () => {
    it('非创建者且非管理员应抛 403', async () => {
      repo.findOne.mockResolvedValue({ ...baseSkill });

      await expect(
        service.update({ ...normalUser, id: 'other' }, 'skill-1', { description: 'x' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('改名撞上已有名称应抛 409', async () => {
      repo.findOne
        .mockResolvedValueOnce({ ...baseSkill })
        .mockResolvedValueOnce({ ...baseSkill, id: 'skill-2' });

      await expect(service.update(normalUser, 'skill-1', { name: 'taken' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('传 mcpServerIds 时应整体替换关联', async () => {
      repo.findOne
        .mockResolvedValueOnce({ ...baseSkill })
        .mockResolvedValueOnce({ ...baseSkill, mcpServers: [{ id: 'srv-9' }] as never });
      mcpServersService.validateForAssociation.mockResolvedValue([{ id: 'srv-9' }]);

      const result = await service.update(normalUser, 'skill-1', { mcpServerIds: ['srv-9'] });

      expect(mcpServersService.validateForAssociation).toHaveBeenCalledWith(['srv-9'], normalUser);
      expect(result.mcpServerIds).toEqual(['srv-9']);
    });
  });

  describe('remove', () => {
    it('不存在应抛 404；创建者可删除', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove(normalUser, 'nope')).rejects.toThrow(NotFoundException);

      repo.findOne.mockResolvedValue({ ...baseSkill });
      await service.remove(adminUser, 'skill-1');
      expect(repo.remove).toHaveBeenCalled();
    });
  });

  describe('findByAgentConfig', () => {
    it('应通过关联表查询启用中的 Skill 并带 mcpServers 关系', async () => {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([baseSkill]),
      };
      (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findByAgentConfig('agent-1');

      expect(qb.innerJoin).toHaveBeenCalledWith('agent_config_skills', 'j', 'j.skill_id = s.id');
      expect(qb.where).toHaveBeenCalledWith('j.agent_config_id = :agentConfigId', {
        agentConfigId: 'agent-1',
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('validateForAssociation', () => {
    it('任一 id 不存在应抛 404，含停用应抛 400，空数组不查库', async () => {
      repo.find.mockResolvedValue([{ ...baseSkill }]);
      await expect(service.validateForAssociation(['skill-1', 'skill-x'])).rejects.toThrow(
        NotFoundException,
      );

      repo.find.mockResolvedValue([{ ...baseSkill, isActive: false }]);
      await expect(service.validateForAssociation(['skill-1'])).rejects.toThrow(
        BadRequestException,
      );

      await expect(service.validateForAssociation([])).resolves.toEqual([]);
    });
  });
});
