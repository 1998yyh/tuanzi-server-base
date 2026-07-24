import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/users.entity';
import { AgentConfig } from './entities/agent-config.entity';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { AgentResponseDto } from './dto/agent-response.dto';
import { AGENT_ENCRYPTION_KEY } from './utils/encryption-key.provider';
import { decrypt, encrypt, maskApiKey } from './utils/crypto.util';

type CurrentUser = Omit<User, 'password'>;

/**
 * Agent 配置业务逻辑：CRUD + API Key 加解密 + 多用户隔离。
 *
 * 安全约定：
 * - 所有查询按 userId 过滤，查不到统一抛 404（不区分「不存在」与「别人的」）
 * - API Key 写入前 AES-256-GCM 加密，响应只返回脱敏后 4 位
 * - stdio 类型 MCP Server 会在服务端执行子进程，仅管理员可配置
 */
@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    @Inject(AGENT_ENCRYPTION_KEY)
    private readonly encryptionKey: string,
  ) {}

  async create(user: CurrentUser, dto: CreateAgentDto): Promise<AgentResponseDto> {
    this.assertStdioPermission(user, dto.mcpServers);

    const { apiKey, ...rest } = dto;
    const agent = await this.agentRepo.save(
      this.agentRepo.create({
        ...rest,
        userId: user.id,
        apiKeyEncrypted: encrypt(apiKey, this.encryptionKey),
        enabledTools: dto.enabledTools ?? [],
        mcpServers: dto.mcpServers ?? [],
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
      items: items.map((a) => this.toResponse(a)),
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
    this.assertStdioPermission(user, dto.mcpServers);

    const { apiKey, ...rest } = dto;
    Object.assign(agent, rest);
    if (apiKey) {
      agent.apiKeyEncrypted = encrypt(apiKey, this.encryptionKey);
    }
    const saved = await this.agentRepo.save(agent);
    return this.toResponse(saved);
  }

  /** 软删除：is_active = false；重新激活通过 update 传 isActive=true */
  async remove(userId: string, id: string): Promise<void> {
    const agent = await this.findOwnedOrFail(userId, id);
    agent.isActive = false;
    await this.agentRepo.save(agent);
  }

  private async findOwnedOrFail(userId: string, id: string): Promise<AgentConfig> {
    const agent = await this.agentRepo.findOne({ where: { id, userId } });
    if (!agent) {
      throw new NotFoundException(`Agent #${id} 不存在`);
    }
    return agent;
  }

  /** stdio 模式会在服务端执行子进程（相当于 shell 权限），仅管理员可配置 */
  private assertStdioPermission(user: CurrentUser, mcpServers?: { transport: string }[]): void {
    if (mcpServers?.some((s) => s.transport === 'stdio') && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('仅管理员可配置 stdio 类型的 MCP Server');
    }
  }

  /** 响应脱敏：显式挑选字段，密文与 userId 不出现在响应中 */
  private toResponse(agent: AgentConfig): AgentResponseDto {
    const plaintext = decrypt(agent.apiKeyEncrypted, this.encryptionKey);
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
      model: agent.model,
      apiKeyMasked: maskApiKey(plaintext),
      systemPrompt: agent.systemPrompt,
      maxTokens: agent.maxTokens,
      maxIterations: agent.maxIterations,
      enabledTools: agent.enabledTools ?? [],
      mcpServers: agent.mcpServers ?? [],
      isActive: agent.isActive,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }
}
