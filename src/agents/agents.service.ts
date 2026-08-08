import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/users.entity';
import { AgentConfig } from './entities/agent-config.entity';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpServerView } from '../mcp-servers/mcp-server.entity';
import { SkillsService } from '../skills/skills.service';
import { SkillView } from '../skills/skill.entity';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AiChannelsService } from '../ai-generation/ai-channels.service';

type CurrentUser = Omit<User, 'password'>;

/**
 * Agent 配置业务逻辑：CRUD + 渠道校验 + 多用户隔离。
 *
 * 安全约定：
 * - 所有查询按 userId 过滤，查不到统一抛 404（不区分「不存在」与「别人的」）
 * - 对话模型配置收敛到 AI 渠道（channelId + modelName），创建/更新前经
 *   AiChannelsService.resolveChatModel 校验渠道归属/启用/「对话」用途；
 *   API Key 密文只存在于渠道侧，本服务不碰加解密
 */
@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    private readonly mcpServersService: McpServersService,
    private readonly skillsService: SkillsService,
    private readonly aiChannelsService: AiChannelsService,
  ) {}

  async create(user: CurrentUser, dto: CreateAgentDto): Promise<AgentResponseDto> {
    // 渠道归属/启用/「对话」用途校验（失败抛 400/403，由全局过滤器转响应）
    await this.aiChannelsService.resolveChatModel(user.id, dto.channelId, dto.modelName);
    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        userId: user.id,
        name: dto.name,
        description: dto.description ?? null,
        channelId: dto.channelId,
        modelName: dto.modelName,
        systemPrompt: dto.systemPrompt ?? null,
        maxTokens: dto.maxTokens ?? 4096,
        maxIterations: dto.maxIterations ?? 10,
        enabledTools: dto.enabledTools ?? [],
      }),
    );
    return this.toResponse(agent);
  }

  async findAll(userId: string, query: QueryAgentsDto) {
    const { page = 1, limit = 10 } = query;
    const [items, total] = await this.agentRepo.findAndCount({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items: await Promise.all(items.map((a) => this.toResponse(a))),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(userId: string, id: string): Promise<AgentResponseDto> {
    const agent = await this.findOwnedOrFail(userId, id);
    return this.toResponse(agent);
  }

  async update(user: CurrentUser, id: string, dto: UpdateAgentDto): Promise<AgentResponseDto> {
    const agent = await this.findOwnedOrFail(user.id, id);

    // channelId/modelName 传其一时，按「合并后」的组合校验
    if (dto.channelId !== undefined || dto.modelName !== undefined) {
      await this.aiChannelsService.resolveChatModel(
        user.id,
        dto.channelId ?? agent.channelId,
        dto.modelName ?? agent.modelName,
      );
    }

    // 显式逐字段赋值，不用 Object.assign：class-transformer 实例化会带上
    // maxTokens/maxIterations 默认值与 undefined 自有属性，直接 assign 会把
    // 未传字段静默重置/丢键
    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.description !== undefined) agent.description = dto.description;
    if (dto.channelId !== undefined) agent.channelId = dto.channelId;
    if (dto.modelName !== undefined) agent.modelName = dto.modelName;
    if (dto.systemPrompt !== undefined) agent.systemPrompt = dto.systemPrompt;
    if (dto.maxTokens !== undefined) agent.maxTokens = dto.maxTokens;
    if (dto.maxIterations !== undefined) agent.maxIterations = dto.maxIterations;
    if (dto.enabledTools !== undefined) agent.enabledTools = dto.enabledTools;

    const saved = await this.agentRepo.save(agent);
    return this.toResponse(saved);
  }

  /** 软删除：is_active = false；重新激活通过 update 传 isActive=true */
  async remove(userId: string, id: string): Promise<void> {
    const agent = await this.findOwnedOrFail(userId, id);
    agent.isActive = false;
    await this.agentRepo.save(agent);
  }

  /** Agent 已关联的 MCP Server 列表（脱敏视图） */
  async getMcpServers(userId: string, agentId: string): Promise<McpServerView[]> {
    await this.findOwnedOrFail(userId, agentId);
    return this.mcpServersService.findViewsByAgentConfig(agentId);
  }

  /** 整体替换 Agent 的 MCP Server 关联（stdio 类型仅 admin，由 validateForAssociation 校验） */
  async updateMcpServers(
    user: CurrentUser,
    agentId: string,
    mcpServerIds: string[],
  ): Promise<McpServerView[]> {
    const agent = await this.findOwnedOrFail(user.id, agentId);
    const servers = await this.mcpServersService.validateForAssociation(mcpServerIds, user);
    agent.mcpServers = servers;
    await this.agentRepo.save(agent);
    return servers.map((s) => this.mcpServersService.toView(s));
  }

  /** Agent 已关联的 Skill 列表 */
  async getSkills(userId: string, agentId: string): Promise<SkillView[]> {
    await this.findOwnedOrFail(userId, agentId);
    return this.skillsService.findViewsByAgentConfig(agentId);
  }

  /** 整体替换 Agent 的 Skill 关联 */
  async updateSkills(user: CurrentUser, agentId: string, skillIds: string[]): Promise<SkillView[]> {
    const agent = await this.findOwnedOrFail(user.id, agentId);
    const skills = await this.skillsService.validateForAssociation(skillIds);
    agent.skills = skills;
    await this.agentRepo.save(agent);
    return skills.map((s) => this.skillsService.toView(s));
  }

  private async findOwnedOrFail(userId: string, id: string): Promise<AgentConfig> {
    const agent = await this.agentRepo.findOne({ where: { id, userId } });
    if (!agent) {
      throw new NotFoundException(`Agent #${id} 不存在`);
    }
    return agent;
  }

  /** 响应拼装：channelName/apiFormat 来自渠道轻量查询（不解密），密文绝不出现 */
  private async toResponse(agent: AgentConfig): Promise<AgentResponseDto> {
    const channel = await this.aiChannelsService.getById(agent.channelId);
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      channelId: agent.channelId,
      channelName: channel?.name ?? null,
      apiFormat: channel?.apiFormat ?? null,
      modelName: agent.modelName,
      systemPrompt: agent.systemPrompt,
      maxTokens: agent.maxTokens,
      maxIterations: agent.maxIterations,
      enabledTools: agent.enabledTools ?? [],
      isActive: agent.isActive,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }
}
