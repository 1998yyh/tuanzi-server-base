import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole } from '../users/users.entity';
import { Skill, SkillView } from './skill.entity';
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { ALL_BUILTIN_TOOL_NAMES, CANVAS_TOOL_NAMES } from '../agents/tools/tool-names';

type CurrentUser = Omit<User, 'password'>;

/** 「画布助手」内置 Skill 名称（种子幂等键） */
export const CANVAS_ASSISTANT_SKILL_NAME = 'canvas_assistant';

// 指令改写自 infinite-canvas canvas-agent/agent-instructions.md
// （https://github.com/basketikun/infinite-canvas, AGPL-3.0）：浏览器 MCP 词汇 → 后端工具词汇
const CANVAS_ASSISTANT_SYSTEM_PROMPT = `# 画布助手

你正在帮助用户操作无限画布工作台：创建/编辑节点、连线、AI 生成图片/视频/音频、提示词与素材管理。

- 操作画布前先确认目标画布：用户没明说时用 canvas_list_projects 列出并选择；拿到 projectId 后用 canvas_get_state 读取现状再执行修改。
- 修改画布用对应的 canvas_* 工具；复杂批量改动用 canvas_apply_ops 一次提交。
- 用户要求生成图片/视频/音频时：用 canvas_create_image_prompt_flow 或 canvas_create_config_node（autoRun=true）创建流程并触发生成，或对已有配置节点用 canvas_run_generation。
- 配置节点需要 metadata.model（"channelId::modelName"）。用户没指定模型时，说明需要先配置模型，不要臆造 modelRef。
- 参考图：把图片节点用 canvas_connect_nodes 连到配置节点，即自动作为参考素材。
- 视频生成是异步任务：提交后返回 taskId，用 generation_get_status 查询进度；任务未完成时不要声称"已生成"。
- 找提示词灵感用 prompts_search；保存/查看素材用 assets_add / assets_list。
- 需要生成内容时直接调用对应工具，不要要求用户手动复制 JSON。`;

/**
 * 全局 Skills 库管理：CRUD + 权限（修改/删除限创建者或 admin）。
 * Skill 库全局可见，任何登录用户可把启用中的 Skill 关联到自己的 Agent。
 */
@Injectable()
export class SkillsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    @InjectRepository(Skill)
    private readonly skillRepo: Repository<Skill>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly mcpServersService: McpServersService,
  ) {}

  /** 「画布助手」内置 Skill 幂等种子：挂在首个 admin 名下（无用户时跳过，下次启动再试） */
  async onApplicationBootstrap(): Promise<void> {
    const existing = await this.skillRepo.findOne({ where: { name: CANVAS_ASSISTANT_SKILL_NAME } });
    if (existing) return;
    const admin = await this.userRepo.findOne({ where: { role: UserRole.ADMIN } });
    if (!admin) {
      this.logger.warn('暂无 admin 用户，画布助手 Skill 种子跳过（下次启动重试）');
      return;
    }
    await this.skillRepo.save(
      this.skillRepo.create({
        name: CANVAS_ASSISTANT_SKILL_NAME,
        description:
          '无限画布工作台助手：创建/编辑画布节点、连线，AI 生成图片/视频/音频，搜索提示词库，管理素材',
        systemPrompt: CANVAS_ASSISTANT_SYSTEM_PROMPT,
        inputSchema: null,
        enabledTools: [...CANVAS_TOOL_NAMES],
        isActive: true,
        mcpServers: [],
        createdBy: admin.id,
      }),
    );
    this.logger.log('已种子化内置 Skill「画布助手」');
  }

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
