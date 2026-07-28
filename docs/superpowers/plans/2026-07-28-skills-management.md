# Skills 全局管理 Implementation Plan（第二期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use tuanzii:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立全局 Skills 库（`skills` 表 + CRUD API + Agent/Skill 关联表），每个 Skill 是带 systemPrompt + 工具集的子 Agent 工具单元，主 Agent 可像普通工具一样调用。

**Architecture:** 新增 `src/skills/` 模块；`SkillToolFactory` 把 Skill 转为 `DynamicStructuredTool` 注入主 Agent 工具列表；`func` 借用主 Agent 的 provider/model/apiKey 调 `AgentExecutorService.runBatch`（无 checkpoint、覆盖 systemPrompt/工具集、`isSkillExecution=true` 防递归）；模块依赖方向为 `AgentsModule → SkillsModule → McpServersModule`，无循环（子工具构建与 runBatch 均以回调形式由 executor 传入工厂）。

**Tech Stack:** NestJS 11 + TypeORM 0.3 + @langchain/core（DynamicStructuredTool）+ zod 4。

**前置依赖：** 第一期计划已完成（`McpServersService` 提供 `validateForAssociation` / `toRuntimeConfig` / `findByAgentConfig`，`AgentExecutorService.getAllTools` 已存在）。

**源设计文档:** `docs/plans/2026-07-28-skills-management-design.md`

## Global Constraints

- 错误消息与 API 文案一律中文。
- 实体：`snake_case` 表名/列名，uuid 主键，必填 `createdAt/updatedAt`；枚举定义在实体文件里 export。
- DTO：每个字段带 `@ApiProperty`（中文描述）+ class-validator；Controller：`@ApiOperation`/`@ApiResponse`、`ParseUUIDPipe`、删除返回 204、`@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`。
- Service：找不到抛 `NotFoundException`；冲突抛 `ConflictException`；权限不足抛 `ForbiddenException`；参数非法抛 `BadRequestException`。
- 测试：放 `test/` 镜像 `src/` 结构，`src/` 别名导入，mock 全部外部依赖，测试描述用中文。
- 提交：conventional commits。
- 开发环境 `synchronize` 自动建表，不写 migration。
- 每个任务完成后跑 `pnpm typecheck` 与 `pnpm lint`。

## 文件清单

**新建：**
- `src/agents/tools/tool-names.ts` — 内置工具名常量（打破 SkillsService → ToolRegistryService 的依赖）
- `src/skills/skill.entity.ts` — Skill 实体 + `SkillView` 类型
- `src/skills/dto/create-skill.dto.ts` / `update-skill.dto.ts`
- `src/skills/skills.service.ts` / `src/skills/skills.controller.ts` / `src/skills/skills.module.ts`
- `src/skills/skill-input-schema.util.ts` — JSON Schema → zod 迷你转换器
- `src/skills/skill-tool.factory.ts` — Skill → DynamicStructuredTool
- `src/agents/dto/update-agent-skills.dto.ts`
- `test/skills/skills.service.spec.ts` / `skills.controller.spec.ts` / `skill-input-schema.util.spec.ts` / `skill-tool.factory.spec.ts`

**修改：**
- `src/app.module.ts` — imports 加 `SkillsModule`
- `src/agents/entities/agent-config.entity.ts` — 新增 `@ManyToMany` 关联 Skill
- `src/agents/agent-executor.service.ts` — `buildGraph` 支持无 checkpointer；新增 `runBatch`；`getAllTools` 加 Skill 注入与 `isSkillExecution` 防递归
- `src/agents/agents.module.ts` — imports 加 `SkillsModule`
- `src/agents/agents.service.ts` — 新增 `getSkills` / `updateSkills`
- `src/agents/agents.controller.ts` — 新增 `GET/PUT /api/agents/:id/skills`
- `test/agents/agent-executor.service.spec.ts` — 加 SkillToolFactory mock + runBatch 用例
- `test/agents/agents.service.spec.ts` — 加 skills 端点用例

## 依赖方向（重要，禁止反向）

```
AppModule → AgentsModule → SkillsModule → McpServersModule
```

- `SkillsModule` **禁止** import `AgentsModule`（否则循环依赖）。SkillsService 校验 `enabledTools` 用 `tool-names.ts` 的静态常量，不注入 ToolRegistryService。
- `SkillToolFactory` 不注入 `AgentExecutorService` / `ToolRegistryService`；执行回调由 executor 以参数传入（见 Task 4 Interfaces）。

---

### Task 1: tool-names 常量 + Skill 实体 + SkillsService + 模块注册

**Files:**
- Create: `src/agents/tools/tool-names.ts`
- Create: `src/skills/skill.entity.ts`
- Create: `src/skills/skills.service.ts`
- Create: `src/skills/skills.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/skills/skills.service.spec.ts`

**Interfaces:**
- Consumes: `McpServersService.validateForAssociation(ids: string[], user: CurrentUser): Promise<McpServer[]>`（第一期 Task 4，复用其「存在 + 启用 + stdio 仅 admin」校验——Skill 关联 stdio MCP 同样等于获得服务端子进程权限）。
- Produces:
  - `tool-names.ts`：`BUILTIN_TOOL_NAMES = ['web_search', 'calculator']`、`AGENT_SCOPED_TOOL_NAMES: readonly string[] = []`（第三期填充）、`ALL_BUILTIN_TOOL_NAMES`（前两者拼接）。
  - `Skill` 实体（表 `skills`，关联表 `skill_mcp_servers`）。
  - `type SkillView = Omit<Skill, 'creator' | 'mcpServers'> & { mcpServerIds: string[] }`
  - `SkillsService` 方法：
    - `create(user: CurrentUser, dto: CreateSkillDto): Promise<SkillView>`
    - `findAllActive(): Promise<{ items: SkillView[]; total: number }>`
    - `update(user: CurrentUser, id: string, dto: UpdateSkillDto): Promise<SkillView>`
    - `remove(user: CurrentUser, id: string): Promise<void>`
    - `findByAgentConfig(agentConfigId: string): Promise<Skill[]>` — 仅启用中，`relations: ['mcpServers']`（Task 4 工厂用）
    - `validateForAssociation(ids: string[]): Promise<Skill[]>` — 存在且启用（Task 4 AgentsService 用）
    - `toView(skill: Skill): SkillView`
  - `type CurrentUser = Omit<User, 'password'>`（模块内私有类型）

- [ ] **Step 1: 写失败测试**

创建 `test/skills/skills.service.spec.ts`：

```typescript
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

      expect(qb.innerJoin).toHaveBeenCalledWith(
        'agent_config_skills',
        'j',
        'j.skill_id = s.id',
      );
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- skills.service`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

**3a. 创建 `src/agents/tools/tool-names.ts`：**

```typescript
/**
 * 内置工具名注册表（静态常量）。
 *
 * 存在意义：SkillsService 需要校验 Skill.enabledTools 是否合法，
 * 若注入 ToolRegistryService 会形成 AgentsModule ↔ SkillsModule 循环依赖，
 * 故工具名在此静态维护，ToolRegistryService 实例化时以此为唯一来源。
 */

/** 无状态内置工具（ToolRegistryService.onModuleInit 实例化） */
export const BUILTIN_TOOL_NAMES = ['web_search', 'calculator'] as const;

/** Agent 作用域内置工具（按 agentConfigId 动态创建；第三期定时任务工具在此注册） */
export const AGENT_SCOPED_TOOL_NAMES: readonly string[] = [];

/** 全部可启用的内置工具名（Skill.enabledTools 等校验用） */
export const ALL_BUILTIN_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_TOOL_NAMES,
  ...AGENT_SCOPED_TOOL_NAMES,
];
```

**3b. 创建 `src/skills/skill.entity.ts`：**

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  Index,
} from 'typeorm';
import { User } from '../users/users.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';

/**
 * Skill：配置级工具单元。底层是带 systemPrompt + 工具集的临时子 Agent，
 * 主 Agent 调用时借用其 provider/model/apiKey 执行（见 SkillToolFactory）。
 */
@Entity('skills')
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 工具名（LLM 调用时的 tool name，snake_case），全局唯一 */
  @Index({ unique: true })
  @Column({ length: 100 })
  name: string;

  /** 工具描述：LLM 依此决定何时调用，直接影响调用质量 */
  @Column({ type: 'varchar', length: 500 })
  description: string;

  /** 子 Agent 的执行指令（system prompt） */
  @Column({ name: 'system_prompt', type: 'text' })
  systemPrompt: string;

  /** 入参 JSON Schema；为空时工具只接收单个 input 字符串 */
  @Column({ name: 'input_schema', type: 'json', nullable: true })
  inputSchema: Record<string, unknown> | null;

  /** 子 Agent 可用的内置工具名列表 */
  @Column({ name: 'enabled_tools', type: 'json', nullable: true })
  enabledTools: string[] | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** 子 Agent 可用的 MCP Server（skill_mcp_servers 关联表） */
  @ManyToMany(() => McpServer)
  @JoinTable({
    name: 'skill_mcp_servers',
    joinColumn: { name: 'skill_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mcp_server_id', referencedColumnName: 'id' },
  })
  mcpServers: McpServer[];

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator: User;

  @Column({ name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：mcpServers 关系展开为 id 列表 */
export type SkillView = Omit<Skill, 'creator' | 'mcpServers'> & { mcpServerIds: string[] };
```

**3c. 创建 `src/skills/skills.service.ts`：**

```typescript
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole } from '../users/users.entity';
import { Skill, SkillView } from './skill.entity';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { ALL_BUILTIN_TOOL_NAMES } from '../agents/tools/tool-names';

type CurrentUser = Omit<User, 'password'>;

/**
 * 全局 Skills 库管理：CRUD + 权限（修改/删除限创建者或 admin）。
 * Skill 库全局可见，任何登录用户可把启用中的 Skill 关联到自己的 Agent。
 */
@Injectable()
export class SkillsService {
  constructor(
    @InjectRepository(Skill)
    private readonly skillRepo: Repository<Skill>,
    private readonly mcpServersService: McpServersService,
  ) {}

  async create(user: CurrentUser, dto: CreateSkillDto): Promise<SkillView> {
    await this.assertNameAvailable(dto.name);
    this.assertBuiltinTools(dto.enabledTools);
    const mcpServers = dto.mcpServerIds?.length
      ? await this.mcpServersService.validateForAssociation(dto.mcpServerIds, user)
      : [];

    const saved = await this.skillRepo.save(
      this.skillRepo.create({
        name: dto.name,
        description: dto.description,
        systemPrompt: dto.systemPrompt,
        inputSchema: dto.inputSchema ?? null,
        enabledTools: dto.enabledTools ?? [],
        isActive: true,
        createdBy: user.id,
        mcpServers,
      }),
    );
    return this.toView(await this.reloadWithRelations(saved.id));
  }

  async findAllActive(): Promise<{ items: SkillView[]; total: number }> {
    const [items, total] = await this.skillRepo.findAndCount({
      where: { isActive: true },
      relations: ['mcpServers'],
      order: { createdAt: 'DESC' },
    });
    return { items: items.map((s) => this.toView(s)), total };
  }

  async update(user: CurrentUser, id: string, dto: UpdateSkillDto): Promise<SkillView> {
    const skill = await this.findOrFail(id);
    this.assertOwnerOrAdmin(user, skill);

    if (dto.name && dto.name !== skill.name) {
      await this.assertNameAvailable(dto.name);
    }
    if (dto.enabledTools !== undefined) {
      this.assertBuiltinTools(dto.enabledTools);
    }

    if (dto.name !== undefined) skill.name = dto.name;
    if (dto.description !== undefined) skill.description = dto.description;
    if (dto.systemPrompt !== undefined) skill.systemPrompt = dto.systemPrompt;
    if (dto.inputSchema !== undefined) skill.inputSchema = dto.inputSchema ?? null;
    if (dto.enabledTools !== undefined) skill.enabledTools = dto.enabledTools;
    if (dto.isActive !== undefined) skill.isActive = dto.isActive;
    if (dto.mcpServerIds !== undefined) {
      skill.mcpServers = dto.mcpServerIds.length
        ? await this.mcpServersService.validateForAssociation(dto.mcpServerIds, user)
        : [];
    }

    await this.skillRepo.save(skill);
    return this.toView(await this.reloadWithRelations(id));
  }

  /** 硬删除；agent_config_skills / skill_mcp_servers 关联由外键 CASCADE 清理 */
  async remove(user: CurrentUser, id: string): Promise<void> {
    const skill = await this.findOrFail(id);
    this.assertOwnerOrAdmin(user, skill);
    await this.skillRepo.remove(skill);
  }

  /** 执行用：Agent 关联的启用中 Skill（含 mcpServers 关系，SkillToolFactory 构建子工具用） */
  findByAgentConfig(agentConfigId: string): Promise<Skill[]> {
    return this.skillRepo
      .createQueryBuilder('s')
      .innerJoin('agent_config_skills', 'j', 'j.skill_id = s.id')
      .leftJoinAndSelect('s.mcpServers', 'm')
      .where('j.agent_config_id = :agentConfigId', { agentConfigId })
      .andWhere('s.isActive = true')
      .getMany();
  }

  /** Agent 关联前校验：全部存在且启用中；返回实体列表供写关联 */
  async validateForAssociation(ids: string[]): Promise<Skill[]> {
    if (!ids.length) return [];
    const skills = await this.skillRepo.find({ where: { id: In(ids) } });
    const foundIds = new Set(skills.map((s) => s.id));
    const missing = ids.find((id) => !foundIds.has(id));
    if (missing) {
      throw new NotFoundException(`Skill #${missing} 不存在`);
    }
    const inactive = skills.find((s) => !s.isActive);
    if (inactive) {
      throw new BadRequestException(`Skill "${inactive.name}" 已停用，无法关联`);
    }
    return skills;
  }

  toView(skill: Skill): SkillView {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      systemPrompt: skill.systemPrompt,
      inputSchema: skill.inputSchema,
      enabledTools: skill.enabledTools ?? [],
      isActive: skill.isActive,
      createdBy: skill.createdBy,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
      mcpServerIds: (skill.mcpServers ?? []).map((s) => s.id),
    };
  }

  private async reloadWithRelations(id: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({ where: { id }, relations: ['mcpServers'] });
    if (!skill) {
      throw new NotFoundException(`Skill #${id} 不存在`);
    }
    return skill;
  }

  private async findOrFail(id: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({ where: { id }, relations: ['mcpServers'] });
    if (!skill) {
      throw new NotFoundException(`Skill #${id} 不存在`);
    }
    return skill;
  }

  private async assertNameAvailable(name: string): Promise<void> {
    const existing = await this.skillRepo.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException(`Skill 名称 "${name}" 已存在`);
    }
  }

  private assertBuiltinTools(enabledTools?: string[]): void {
    const invalid = (enabledTools ?? []).filter((t) => !ALL_BUILTIN_TOOL_NAMES.includes(t));
    if (invalid.length) {
      throw new BadRequestException(`未注册的内置工具: ${invalid.join(', ')}`);
    }
  }

  private assertOwnerOrAdmin(user: CurrentUser, skill: Skill): void {
    if (skill.createdBy !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('只有创建者或管理员可以操作该 Skill');
    }
  }
}
```

**3d. 创建 `src/skills/skills.module.ts`**（controller 在 Task 2 加入）：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from './skill.entity';
import { SkillsService } from './skills.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

@Module({
  imports: [TypeOrmModule.forFeature([Skill]), McpServersModule],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
```

**3e. 修改 `src/app.module.ts`：** imports 数组末尾加 `SkillsModule` 及对应 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- skills.service`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/skills src/agents/tools/tool-names.ts src/app.module.ts test/skills
git commit -m "feat(skills): 新增 Skill 实体与 CRUD 服务"
```

---

### Task 2: SkillsController + DTO

**Files:**
- Create: `src/skills/dto/create-skill.dto.ts`
- Create: `src/skills/dto/update-skill.dto.ts`
- Create: `src/skills/skills.controller.ts`
- Modify: `src/skills/skills.module.ts`
- Test: `test/skills/skills.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `SkillsService` CRUD 方法。
- Produces: 路由 `GET/POST /api/skills`、`PATCH/DELETE /api/skills/:id`。

- [ ] **Step 1: 写失败测试**

创建 `test/skills/skills.controller.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { SkillsController } from 'src/skills/skills.controller';
import { SkillsService } from 'src/skills/skills.service';
import { UserRole } from 'src/users/users.entity';

describe('SkillsController', () => {
  let controller: SkillsController;
  let service: Record<string, jest.Mock>;

  const user = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findAllActive: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkillsController],
      providers: [{ provide: SkillsService, useValue: service }],
    }).compile();

    controller = module.get(SkillsController);
  });

  it('GET / 应调用 findAllActive', async () => {
    service.findAllActive.mockResolvedValue({ items: [], total: 0 });

    const result = await controller.findAll();

    expect(service.findAllActive).toHaveBeenCalled();
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('POST / 应把当前用户与 DTO 传给 service.create', async () => {
    const dto = { name: 'generate_ai_report', description: '生成日报', systemPrompt: '你是助手' };
    service.create.mockResolvedValue({ id: 'skill-1' });

    await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith(user, dto);
  });

  it('PATCH /:id 应把当前用户、id、DTO 传给 service.update', async () => {
    service.update.mockResolvedValue({ id: 'skill-1' });

    await controller.update(user, 'skill-1', { description: '新描述' });

    expect(service.update).toHaveBeenCalledWith(user, 'skill-1', { description: '新描述' });
  });

  it('DELETE /:id 应调用 service.remove', async () => {
    await controller.remove(user, 'skill-1');

    expect(service.remove).toHaveBeenCalledWith(user, 'skill-1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- skills.controller`
Expected: FAIL（controller 不存在）

- [ ] **Step 3: 实现**

**3a. 创建 `src/skills/dto/create-skill.dto.ts`：**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';

export class CreateSkillDto {
  @ApiProperty({
    example: 'generate_ai_report',
    description: '工具名（LLM 调用时的 tool name，小写字母/数字/下划线）',
  })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'name 只能包含小写字母、数字、下划线，且必须以字母开头',
  })
  name: string;

  @ApiProperty({
    example: '搜索最新 AI 资讯并整理为结构化日报，适合每日资讯汇总场景',
    description: '工具描述：LLM 依此决定何时调用，需写清能做什么、何时适合用',
  })
  @IsString()
  @Length(1, 500)
  description: string;

  @ApiProperty({ example: '你是一个 AI 日报撰写助手...', description: '子 Agent 的执行指令' })
  @IsString()
  @IsNotEmpty()
  systemPrompt: string;

  @ApiProperty({
    required: false,
    example: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    description: '入参 JSON Schema（仅支持扁平 object）；缺省时工具只接收单个 input 字符串',
  })
  @IsObject()
  @IsOptional()
  inputSchema?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['web_search'],
    description: '子 Agent 可用的内置工具名列表',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  enabledTools?: string[];

  @ApiProperty({
    required: false,
    type: [String],
    description: '子 Agent 可用的 MCP Server ID 列表（stdio 类型仅管理员可关联）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  mcpServerIds?: string[];
}
```

**3b. 创建 `src/skills/dto/update-skill.dto.ts`：**

```typescript
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateSkillDto } from './create-skill.dto';

export class UpdateSkillDto extends PartialType(CreateSkillDto) {
  @ApiProperty({ required: false, example: false, description: '停用后不可被 Agent 关联/调用' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
```

**3c. 创建 `src/skills/skills.controller.ts`：**

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SkillsService } from './skills.service';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';

@ApiTags('Skill')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @ApiOperation({ summary: '全局 Skill 列表', description: '只返回启用中的 Skill，用于 Agent 配置界面选配' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll() {
    return this.skillsService.findAllActive();
  }

  @Post()
  @ApiOperation({ summary: '创建 Skill', description: 'name 全局唯一，snake_case' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '参数非法（含未注册的内置工具名）' })
  @ApiResponse({ status: 409, description: '名称已存在' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateSkillDto) {
    return this.skillsService.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 Skill', description: '仅创建者或管理员' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '非创建者且非管理员' })
  @ApiResponse({ status: 404, description: 'Skill 不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkillDto,
  ) {
    return this.skillsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除 Skill', description: '仅创建者或管理员；关联关系自动级联清理' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: 'Skill 不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.skillsService.remove(user, id);
  }
}
```

**3d. 修改 `src/skills/skills.module.ts`：** 加 `controllers: [SkillsController]` 及 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- skills.controller`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/skills test/skills
git commit -m "feat(skills): 新增 Skill REST API"
```

---

### Task 3: AgentExecutor.runBatch（批量执行 + 可选 checkpointer）

**Files:**
- Modify: `src/agents/agent-executor.service.ts`
- Test: `test/agents/agent-executor.service.spec.ts`

**Interfaces:**
- Consumes: 现有 `buildGraph` / `getAllTools`。
- Produces:
  - `interface BatchRunOptions { threadId?: string; overrideSystemPrompt?: string | null; overrideTools?: StructuredToolInterface[]; isSkillExecution?: boolean; }`（从 `agent-executor.service.ts` export，Task 4 与第三期复用）
  - `AgentExecutorService.runBatch(agentConfig: AgentConfig, userMessage: string, options?: BatchRunOptions): Promise<NewMessageData[]>`：
    - 带 `threadId` 且无覆盖项 → 等价 `run`（走 checkpoint）
    - 否则一次性执行（无 checkpoint，无历史），返回切片掉 userMessage 后的新消息
  - `buildGraph(config, tools, useCheckpointer: boolean)` 第三参控制是否挂 checkpointer。
  - `getAllTools(config, isSkillExecution?: boolean)` 加第二参（本任务只加参数透传，Skill 注入在 Task 4 接入）。

- [ ] **Step 1: 写失败测试**

在 `test/agents/agent-executor.service.spec.ts` 追加 describe（文件顶部无需新 import，复用现有）：

```typescript
  describe('runBatch（批量执行）', () => {
    it('带 threadId 且无覆盖项时应该走 checkpoint（等价 run）', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '批量回答' }));

      const result = await service.runBatch(buildAgent(), '生成日报', { threadId: 'conv-9' });

      expect(toolRegistry.getToolsForAgent).toHaveBeenCalled();
      expect(result).toEqual([
        { role: MessageRole.ASSISTANT, content: '批量回答', toolCalls: null, totalTokens: null },
      ]);
    });

    it('无 threadId 时应该一次性执行，不写 checkpoint 且只返回本轮消息', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: '子 Agent 输出' }));

      const result = await service.runBatch(buildAgent(), '执行任务');

      expect(result).toEqual([
        { role: MessageRole.ASSISTANT, content: '子 Agent 输出', toolCalls: null, totalTokens: null },
      ]);
    });

    it('overrideSystemPrompt 应该替代 Agent 自身的 systemPrompt', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent({ systemPrompt: '原始提示词' }), '执行任务', {
        overrideSystemPrompt: 'Skill 的执行指令',
      });

      const inputMessages = mockInvoke.mock.calls[0][0] as { _getType(): string; content: unknown }[];
      expect(inputMessages[0]._getType()).toBe('system');
      expect(inputMessages[0].content).toBe('Skill 的执行指令');
    });

    it('overrideTools 时不应该再加载 Agent 工具', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent(), '执行任务', { overrideTools: [calculatorTool] });

      expect(toolRegistry.getToolsForAgent).not.toHaveBeenCalled();
      expect(mockBindTools).toHaveBeenCalledWith([calculatorTool]);
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- agent-executor.service`
Expected: FAIL（`runBatch` 不存在）

- [ ] **Step 3: 实现**

修改 `src/agents/agent-executor.service.ts`：

**3a.** 在 `AGENT_NODE`/`TOOLS_NODE` 常量后追加导出接口：

```typescript
/** runBatch 批量执行选项 */
export interface BatchRunOptions {
  /** 提供则走 checkpointer 持久化（thread_id = 该值）；缺省为一次性无历史执行 */
  threadId?: string;
  /** Skill 子 Agent 的执行指令（替代 agentConfig.systemPrompt） */
  overrideSystemPrompt?: string | null;
  /** Skill 子 Agent 的工具集（替代正常工具加载） */
  overrideTools?: StructuredToolInterface[];
  /** 防递归：为 true 时不注入 Skill 工具（Task 4 生效） */
  isSkillExecution?: boolean;
}
```

**3b.** `buildGraph` 签名改为三参并条件挂载 checkpointer：

```typescript
  private buildGraph(config: AgentConfig, tools: StructuredToolInterface[], useCheckpointer = true) {
```

末尾 `return graph.compile({ checkpointer: this.checkpointer });` 改为：

```typescript
    return graph.compile(useCheckpointer ? { checkpointer: this.checkpointer } : {});
```

**3c.** `run`/`runStream` 内对 `buildGraph` 的现有调用（两参）不必改——第三参默认 `true`。`getAllTools` 本任务保持不变（防递归参数在 Task 4 接入）。

**3d.** 在 `runStream` 方法后追加 `runBatch`：

```typescript
  /**
   * 批量执行：不走 SSE，await 完整结果后返回本轮新增消息。
   *
   * 两种形态：
   * - 带 threadId 且无覆盖项：等价 run（走 checkpoint，第三期定时任务用）
   * - 其余：一次性无历史执行（Skill 子 Agent 用），不产生 checkpoint 数据
   */
  async runBatch(
    agentConfig: AgentConfig,
    userMessage: string,
    options: BatchRunOptions = {},
  ): Promise<NewMessageData[]> {
    const hasOverrides =
      options.overrideTools !== undefined ||
      options.overrideSystemPrompt !== undefined ||
      options.isSkillExecution === true;
    if (options.threadId && !hasOverrides) {
      return this.run(agentConfig, options.threadId, userMessage);
    }

    const tools = options.overrideTools ?? (await this.getAllTools(agentConfig));
    const graph = this.buildGraph(
      { ...agentConfig, systemPrompt: options.overrideSystemPrompt ?? agentConfig.systemPrompt },
      tools,
      false,
    );
    const invokeConfig = options.threadId
      ? { configurable: { thread_id: options.threadId } }
      : {};

    const result = await graph.invoke(
      {
        messages: [new HumanMessage(userMessage)],
        maxIterations: agentConfig.maxIterations,
      },
      invokeConfig,
    );

    // 一次性执行无历史：跳过 userMessage 本身即全部新增消息
    const newMessages = (result.messages as BaseMessage[]).slice(1);
    let runningTotal = 0;
    return newMessages.map((m) => {
      const data = this.toMessageData(m);
      if (data.totalTokens != null) {
        runningTotal += data.totalTokens;
        data.totalTokens = runningTotal;
      }
      return data;
    });
  }
```

注意：`run`/`runStream` 内对 `buildGraph` 的现有调用（两参）不必改——第三参默认 `true`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- agent-executor.service`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/agents/agent-executor.service.ts test/agents/agent-executor.service.spec.ts
git commit -m "feat(agents): AgentExecutor 新增 runBatch 批量执行与可选 checkpointer"
```

---

### Task 4: skill-input-schema 转换器 + SkillToolFactory + 执行链路集成 + Agent 关联端点

**Files:**
- Create: `src/skills/skill-input-schema.util.ts`
- Create: `src/skills/skill-tool.factory.ts`
- Create: `src/agents/dto/update-agent-skills.dto.ts`
- Modify: `src/skills/skills.module.ts`（providers/exports 加 `SkillToolFactory`）
- Modify: `src/agents/entities/agent-config.entity.ts`（ManyToMany Skill）
- Modify: `src/agents/agent-executor.service.ts`（getAllTools 注入 Skill 工具）
- Modify: `src/agents/agents.module.ts`（imports 加 SkillsModule）
- Modify: `src/agents/agents.service.ts` / `src/agents/agents.controller.ts`
- Test: `test/skills/skill-input-schema.util.spec.ts`
- Test: `test/skills/skill-tool.factory.spec.ts`
- Test: `test/agents/agent-executor.service.spec.ts`（加 mock + 防递归用例）
- Test: `test/agents/agents.service.spec.ts`（加 skills 端点用例）

**Interfaces:**
- Consumes: Task 1 `SkillsService.findByAgentConfig` / `validateForAssociation` / `toView`；Task 3 `BatchRunOptions` / `runBatch`；第一期 `McpServersService.toRuntimeConfig`。
- Produces:
  - `buildSkillInputSchema(inputSchema: Record<string, unknown> | null): z.ZodTypeAny`（`skill-input-schema.util.ts`）
  - `interface SkillExecutionDeps { runBatch: (userMessage: string, options: BatchRunOptions) => Promise<NewMessageData[]>; buildSubTools: (skill: Skill) => Promise<StructuredToolInterface[]>; }`（`skill-tool.factory.ts` export）
  - `SkillToolFactory.createToolsForAgent(agentConfig: AgentConfig, deps: SkillExecutionDeps): Promise<DynamicStructuredTool[]>`
  - `AgentsService.getSkills(userId: string, agentId: string): Promise<SkillView[]>`
  - `AgentsService.updateSkills(user: CurrentUser, agentId: string, skillIds: string[]): Promise<SkillView[]>`
  - 路由 `GET /api/agents/:id/skills`、`PUT /api/agents/:id/skills`
  - `AgentConfig.skills: Skill[]`（关联表 `agent_config_skills`）

- [ ] **Step 1: 写失败测试**

**1a. 创建 `test/skills/skill-input-schema.util.spec.ts`：**

```typescript
import { buildSkillInputSchema } from 'src/skills/skill-input-schema.util';

describe('buildSkillInputSchema', () => {
  it('inputSchema 为空时应该回退为单个 input 字符串', () => {
    const schema = buildSkillInputSchema(null);

    expect(schema.safeParse({ input: '你好' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('非 object 类型 schema 应该回退为单个 input 字符串', () => {
    const schema = buildSkillInputSchema({ type: 'string' });

    expect(schema.safeParse({ input: '你好' }).success).toBe(true);
  });

  it('扁平 object schema 应该按 properties/required 生成字段', () => {
    const schema = buildSkillInputSchema({
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题' },
        count: { type: 'integer' },
        verbose: { type: 'boolean' },
      },
      required: ['topic'],
    });

    expect(schema.safeParse({ topic: 'AI' }).success).toBe(true);
    expect(schema.safeParse({ topic: 'AI', count: 3, verbose: true }).success).toBe(true);
    expect(schema.safeParse({ count: 3 }).success).toBe(false); // 缺 required 字段
    expect(schema.safeParse({ topic: 'AI', count: '三' }).success).toBe(false); // 类型不符
  });
});
```

**1b. 创建 `test/skills/skill-tool.factory.spec.ts`：**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { StructuredToolInterface } from '@langchain/core/tools';
import { SkillToolFactory, SkillExecutionDeps } from 'src/skills/skill-tool.factory';
import { SkillsService } from 'src/skills/skills.service';
import { Skill } from 'src/skills/skill.entity';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { MessageRole } from 'src/agents/entities/message.entity';

describe('SkillToolFactory', () => {
  let factory: SkillToolFactory;
  let skillsService: Record<string, jest.Mock>;
  let deps: SkillExecutionDeps & { runBatch: jest.Mock; buildSubTools: jest.Mock };

  const agentConfig = {
    id: 'agent-1',
    name: '主 Agent',
    provider: ProviderType.ANTHROPIC,
  } as AgentConfig;

  const buildSkill = (override: Partial<Skill> = {}): Skill =>
    ({
      id: 'skill-1',
      name: 'generate_ai_report',
      description: '生成 AI 日报',
      systemPrompt: '你是日报撰写助手',
      inputSchema: null,
      enabledTools: ['web_search'],
      isActive: true,
      mcpServers: [],
      ...override,
    }) as Skill;

  beforeEach(async () => {
    skillsService = { findByAgentConfig: jest.fn().mockResolvedValue([buildSkill()]) };
    deps = {
      runBatch: jest.fn(),
      buildSubTools: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [SkillToolFactory, { provide: SkillsService, useValue: skillsService }],
    }).compile();

    factory = module.get(SkillToolFactory);
  });

  it('应该为每个 Skill 生成同名 DynamicStructuredTool', async () => {
    const tools = await factory.createToolsForAgent(agentConfig, deps);

    expect(skillsService.findByAgentConfig).toHaveBeenCalledWith('agent-1');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('generate_ai_report');
    expect(tools[0].description).toBe('生成 AI 日报');
  });

  it('func 应该构建子工具并以覆盖配置调用 runBatch，返回最后的 assistant 输出', async () => {
    const subTool = { name: 'web_search' } as StructuredToolInterface;
    deps.buildSubTools.mockResolvedValue([subTool]);
    deps.runBatch.mockResolvedValue([
      { role: MessageRole.TOOL, content: '搜索结果' },
      { role: MessageRole.ASSISTANT, content: '日报已生成' },
    ]);

    const tools = await factory.createToolsForAgent(agentConfig, deps);
    const result = (await tools[0].invoke({ input: '生成本周 AI 日报' })) as string;

    expect(deps.buildSubTools).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill-1' }));
    expect(deps.runBatch).toHaveBeenCalledWith('生成本周 AI 日报', {
      overrideSystemPrompt: '你是日报撰写助手',
      overrideTools: [subTool],
      isSkillExecution: true,
    });
    expect(result).toBe('日报已生成');
  });

  it('func 执行异常应该返回错误文案而不是抛出', async () => {
    deps.runBatch.mockRejectedValue(new Error('模型超时'));

    const tools = await factory.createToolsForAgent(agentConfig, deps);
    const result = (await tools[0].invoke({ input: '执行' })) as string;

    expect(result).toContain('Skill 执行失败');
    expect(result).toContain('模型超时');
  });

  it('与内置工具同名的 Skill 应该跳过并告警', async () => {
    skillsService.findByAgentConfig.mockResolvedValue([buildSkill({ name: 'web_search' })]);

    const tools = await factory.createToolsForAgent(agentConfig, deps);

    expect(tools).toHaveLength(0);
  });
});
```

**1c. 修改 `test/agents/agent-executor.service.spec.ts`：** providers 中 `{ provide: McpServersService, useValue: mcpServersService },` 之后加：

```typescript
        { provide: SkillToolFactory, useValue: skillToolFactory },
```

describe 内 `mcpServersService` 声明后加：

```typescript
  let skillToolFactory: { createToolsForAgent: jest.Mock };
```

beforeEach 中 `mcpServersService = {...}` 后加：

```typescript
    skillToolFactory = { createToolsForAgent: jest.fn().mockResolvedValue([]) };
```

import 区加：

```typescript
import { SkillToolFactory } from 'src/skills/skill-tool.factory';
```

并在 `describe('run（同步执行）')` 内追加两个用例：

```typescript
    it('正常执行应该把 Skill 工具追加进工具列表', async () => {
      const skillTool = { name: 'generate_ai_report', invoke: jest.fn() };
      skillToolFactory.createToolsForAgent.mockResolvedValue([skillTool]);
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '你好');

      expect(skillToolFactory.createToolsForAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          runBatch: expect.any(Function),
          buildSubTools: expect.any(Function),
        }),
      );
      expect(mockBindTools).toHaveBeenCalledWith([skillTool]);
    });

    it('isSkillExecution=true 时不应该注入 Skill 工具（防递归）', async () => {
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.runBatch(buildAgent(), '执行任务', { isSkillExecution: true });

      expect(skillToolFactory.createToolsForAgent).not.toHaveBeenCalled();
    });
```

**1d. 修改 `test/agents/agents.service.spec.ts`：** providers 中 `{ provide: McpServersService, useValue: mcpServersService },` 后加 `{ provide: SkillsService, useValue: skillsService },`；`mcpServersService` 声明旁加：

```typescript
  let skillsService: Record<string, jest.Mock>;
```

beforeEach 顶部加：

```typescript
    skillsService = {
      findViewsByAgentConfig: jest.fn(),
      validateForAssociation: jest.fn(),
      toView: jest.fn((s: { id: string; name: string }) => ({ id: s.id, name: s.name })),
    };
```

import 区加 `import { SkillsService } from 'src/skills/skills.service';`，并追加 describe：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- skills agents.service agent-executor.service`
Expected: FAIL（`skill-input-schema.util` / `skill-tool.factory` 不存在；`findViewsByAgentConfig` 未实现；agents 测试缺 provider）

- [ ] **Step 3: 实现**

**3a. 创建 `src/skills/skill-input-schema.util.ts`：**

```typescript
import { z } from 'zod';

/**
 * Skill 入参 JSON Schema → zod 转换器（迷你版）。
 *
 * 只支持扁平 object（properties 值为 string/number/integer/boolean/array），
 * 足以覆盖绝大多数工具入参；不满足时回退为单个 input 字符串。
 * DynamicStructuredTool 只接受 zod schema，而 Skill 的 inputSchema 以 JSON Schema 落库，
 * 故需要这层转换（不引入 json-schema-to-zod 之类依赖——它靠 eval 生成代码）。
 */
export function buildSkillInputSchema(inputSchema: Record<string, unknown> | null): z.ZodTypeAny {
  const fallback = () => z.object({ input: z.string().describe('子任务的输入指令') });

  if (
    !inputSchema ||
    inputSchema.type !== 'object' ||
    typeof inputSchema.properties !== 'object' ||
    inputSchema.properties === null
  ) {
    return fallback();
  }

  const required = new Set(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(
    inputSchema.properties as Record<string, Record<string, unknown> | undefined>,
  )) {
    let field: z.ZodTypeAny;
    switch (prop?.type) {
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'string':
      default:
        field = z.string();
        break;
    }
    if (typeof prop?.description === 'string') {
      field = field.describe(prop.description);
    }
    shape[key] = required.has(key) ? field : field.optional();
  }

  return Object.keys(shape).length ? z.object(shape) : fallback();
}
```

**3b. 创建 `src/skills/skill-tool.factory.ts`：**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { AgentConfig } from '../agents/entities/agent-config.entity';
import { BatchRunOptions } from '../agents/agent-executor.service';
import { NewMessageData } from '../agents/agents.types';
import { MessageRole } from '../agents/entities/message.entity';
import { ALL_BUILTIN_TOOL_NAMES } from '../agents/tools/tool-names';
import { Skill } from './skill.entity';
import { SkillsService } from './skills.service';
import { buildSkillInputSchema } from './skill-input-schema.util';

/**
 * Skill 执行所需的回调，由 AgentExecutorService 传入（反向注入会破坏模块依赖方向）：
 * - runBatch：借用主 Agent 的 provider/model/apiKey 做一次性批量执行
 * - buildSubTools：按 Skill 的 enabledTools + mcpServers 构建子 Agent 工具集
 */
export interface SkillExecutionDeps {
  runBatch: (userMessage: string, options: BatchRunOptions) => Promise<NewMessageData[]>;
  buildSubTools: (skill: Skill) => Promise<StructuredToolInterface[]>;
}

/**
 * Skill → DynamicStructuredTool 转换工厂。
 *
 * 主 Agent 像调用普通工具一样调用 Skill；func 内部以 Skill 的 systemPrompt +
 * 工具集起一次性子 Agent（isSkillExecution=true，子 Agent 不再注入 Skill 工具，防递归），
 * 把子 Agent 最终输出作为工具结果返回给主 Agent。
 */
@Injectable()
export class SkillToolFactory {
  private readonly logger = new Logger(SkillToolFactory.name);

  constructor(private readonly skillsService: SkillsService) {}

  async createToolsForAgent(
    agentConfig: AgentConfig,
    deps: SkillExecutionDeps,
  ): Promise<DynamicStructuredTool[]> {
    const skills = await this.skillsService.findByAgentConfig(agentConfig.id);
    const tools: DynamicStructuredTool[] = [];

    for (const skill of skills) {
      // name 冲突检查：Skill 名进入主 Agent 工具列表，不能覆盖内置工具
      if (ALL_BUILTIN_TOOL_NAMES.includes(skill.name)) {
        this.logger.warn(`Skill "${skill.name}" 与内置工具同名，已跳过（请改名后重新关联）`);
        continue;
      }

      tools.push(
        new DynamicStructuredTool({
          name: skill.name,
          description: skill.description,
          schema: buildSkillInputSchema(skill.inputSchema),
          func: async (args) => {
            const input =
              typeof (args as { input?: unknown })?.input === 'string'
                ? ((args as { input: string }).input)
                : JSON.stringify(args ?? {});
            try {
              const subTools = await deps.buildSubTools(skill);
              const messages = await deps.runBatch(input, {
                overrideSystemPrompt: skill.systemPrompt,
                overrideTools: subTools,
                isSkillExecution: true,
              });
              const last = messages.findLast((m) => m.role === MessageRole.ASSISTANT);
              return last?.content || '（子 Agent 未产生输出）';
            } catch (e) {
              // 与内置工具一致：失败信息作为工具结果交给主 Agent 决策，不向外抛
              return `Skill 执行失败: ${(e as Error).message}`;
            }
          },
        }),
      );
    }

    return tools;
  }
}
```

**3c. 修改 `src/skills/skills.module.ts`：** providers 加 `SkillToolFactory`，exports 改为 `[SkillsService, SkillToolFactory]`，import 加 `import { SkillToolFactory } from './skill-tool.factory';`。

**3d. 修改 `src/skills/skills.service.ts`：** 在 `findByAgentConfig` 方法后追加：

```typescript
  /** 展示用：Agent 关联的 Skill 视图（含已停用的，便于管理界面展示） */
  async findViewsByAgentConfig(agentConfigId: string): Promise<SkillView[]> {
    const skills = await this.skillRepo
      .createQueryBuilder('s')
      .innerJoin('agent_config_skills', 'j', 'j.skill_id = s.id')
      .leftJoinAndSelect('s.mcpServers', 'm')
      .where('j.agent_config_id = :agentConfigId', { agentConfigId })
      .getMany();
    return skills.map((s) => this.toView(s));
  }
```

**3e. 修改 `src/agents/entities/agent-config.entity.ts`：** import 区加 `import { Skill } from '../../skills/skill.entity';`；`mcpServers` 关系后追加：

```typescript
  /** 关联的 Skill（agent_config_skills 关联表） */
  @ManyToMany(() => Skill)
  @JoinTable({
    name: 'agent_config_skills',
    joinColumn: { name: 'agent_config_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'skill_id', referencedColumnName: 'id' },
  })
  skills: Skill[];
```

**3f. 修改 `src/agents/agent-executor.service.ts`：**

- import 区加：
```typescript
import { SkillToolFactory } from '../skills/skill-tool.factory';
import { Skill } from '../skills/skill.entity';
```
- constructor 末尾追加参数：`private readonly skillToolFactory: SkillToolFactory,`
- `getAllTools` 全量替换为：

```typescript
  /**
   * 汇总三层工具：内置工具 + MCP 工具 + Skill 工具。
   * isSkillExecution=true 时为 Skill 子 Agent 执行，跳过 Skill 注入（防递归）。
   */
  private async getAllTools(
    config: AgentConfig,
    isSkillExecution = false,
  ): Promise<StructuredToolInterface[]> {
    const mcpServers = await this.mcpServersService.findByAgentConfig(config.id);
    const tools = await this.toolRegistry.getToolsForAgent(config, mcpServers);
    if (isSkillExecution) {
      return tools;
    }
    const skillTools = await this.skillToolFactory.createToolsForAgent(config, {
      runBatch: (userMessage, options) => this.runBatch(config, userMessage, options),
      buildSubTools: (skill) => this.buildSkillSubTools(config, skill),
    });
    return [...tools, ...skillTools];
  }

  /** Skill 子 Agent 的工具集：Skill.enabledTools（内置）+ Skill.mcpServers（MCP，过滤停用并解密） */
  private async buildSkillSubTools(
    config: AgentConfig,
    skill: Skill,
  ): Promise<StructuredToolInterface[]> {
    const mcpRuntime = (skill.mcpServers ?? [])
      .filter((s) => s.isActive)
      .map((s) => this.mcpServersService.toRuntimeConfig(s));
    return this.toolRegistry.getToolsForAgent(
      { ...config, enabledTools: skill.enabledTools ?? [] },
      mcpRuntime,
    );
  }
```

- 同时把 `runBatch` 中 `const tools = options.overrideTools ?? (await this.getAllTools(agentConfig));` 改为：

```typescript
    const tools =
      options.overrideTools ??
      (await this.getAllTools(agentConfig, options.isSkillExecution ?? false));
```

**3g. 修改 `src/agents/agents.module.ts`：** imports 数组加 `SkillsModule`，import 加 `import { SkillsModule } from '../skills/skills.module';`。

**3h. 创建 `src/agents/dto/update-agent-skills.dto.ts`：**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class UpdateAgentSkillsDto {
  @ApiProperty({
    type: [String],
    example: ['b3b7c6e2-....'],
    description: '关联的 Skill ID 列表（整体替换，传空数组清空）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  skillIds: string[];
}
```

**3i. 修改 `src/agents/agents.service.ts`：**

- import 区加：
```typescript
import { SkillsService } from '../skills/skills.service';
import { SkillView } from '../skills/skill.entity';
```
- constructor 末尾追加参数：`private readonly skillsService: SkillsService,`
- `updateMcpServers` 方法后追加：

```typescript
  /** Agent 已关联的 Skill 列表 */
  async getSkills(userId: string, agentId: string): Promise<SkillView[]> {
    await this.findOwnedOrFail(userId, agentId);
    return this.skillsService.findViewsByAgentConfig(agentId);
  }

  /** 整体替换 Agent 的 Skill 关联 */
  async updateSkills(
    user: CurrentUser,
    agentId: string,
    skillIds: string[],
  ): Promise<SkillView[]> {
    const agent = await this.findOwnedOrFail(user.id, agentId);
    const skills = await this.skillsService.validateForAssociation(skillIds);
    agent.skills = skills;
    await this.agentRepo.save(agent);
    return skills.map((s) => this.skillsService.toView(s));
  }
```

**3j. 修改 `src/agents/agents.controller.ts`：** import 区加 `import { UpdateAgentSkillsDto } from './dto/update-agent-skills.dto';`，类末尾追加：

```typescript
  @Get(':id/skills')
  @ApiOperation({ summary: 'Agent 已关联的 Skill 列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async getSkills(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.agentsService.getSkills(user.id, id);
  }

  @Put(':id/skills')
  @ApiOperation({ summary: '整体替换 Agent 关联的 Skill', description: '传空数组清空关联' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 404, description: 'Agent 或 Skill 不存在' })
  async updateSkills(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentSkillsDto,
  ) {
    return this.agentsService.updateSkills(user, id, dto.skillIds);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: PASS（全量）

- [ ] **Step 5: typecheck + lint + 全量回归 + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/skills src/agents test/skills test/agents
git commit -m "feat(skills): Skill 工具工厂与执行链路集成，新增 Agent 关联 Skill 端点"
```

- [ ] **Step 6: 重启 dev server 验证表结构**

```bash
pnpm start:dev
```

用 Adminer（http://localhost:8080）确认：`skills`、`skill_mcp_servers`、`agent_config_skills` 三张表已建（复合主键 + 外键 CASCADE）。确认后停掉 dev server。

---

## 自审记录

- **Spec coverage**：实体/关联表（Task 1）、CRUD API（Task 1、2）、SkillToolFactory + 子 Agent 调用（Task 4）、防递归（Task 3 `isSkillExecution` + Task 4 接入）、name 冲突告警（Task 4 工厂）、Agent 选配端点（Task 4）、runBatch（Task 3）。
- **已知偏差（有意）**：
  1. 设计文档说「`tool-registry.service.ts` 支持 isSkillExecution 跳过 Skill 注入」——实际 Skill 注入点在 executor 而非 registry，故标志放在 `AgentExecutorService.getAllTools`，效果一致。
  2. `enabledTools` 校验用 `tool-names.ts` 静态常量而非注入 ToolRegistryService——避免 AgentsModule ↔ SkillsModule 循环依赖。
  3. Skill 关联 stdio 类型 MCP Server 复用「仅 admin」校验（设计未明确，但 stdio = 服务端子进程权限，与第一期权限矩阵同理）。
