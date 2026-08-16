import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserRole } from '../users/users.entity';
import {
  McpServer,
  McpServerRuntimeConfig,
  McpServerType,
  McpServerView,
} from './mcp-server.entity';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { QueryMcpServerDto } from './dto/query-mcp-server.dto';
import { AGENT_ENCRYPTION_KEY } from '../agents/utils/encryption-key.provider';
import { decrypt, encrypt } from '../common/utils/crypto.util';
import { assertPublicUrl } from '../common/utils/ssrf.util';

type CurrentUser = Omit<User, 'password'>;

/**
 * 全局 MCP Server 管理：CRUD + 权限控制 + env/headers 加解密。
 *
 * 权限矩阵：
 * - 创建 stdio 类型 / 把类型改为 stdio：仅 admin（stdio 会在服务端执行子进程）
 * - 修改/删除：创建者或 admin
 * - 列表：所有登录用户可见（仅 isActive=true）
 */
@Injectable()
export class McpServersService {
  constructor(
    @InjectRepository(McpServer)
    private readonly mcpServerRepo: Repository<McpServer>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(AGENT_ENCRYPTION_KEY)
    private readonly encryptionKey: string,
  ) {}

  async create(user: CurrentUser, dto: CreateMcpServerDto): Promise<McpServerView> {
    this.assertStdioPermission(user, dto.type);
    await this.assertNameAvailable(dto.name);

    // SSRF：sse / streamable-http 的 url 是服务端出站建连地址，落库前必须校验（stdio 无 url，跳过）
    if (dto.type !== McpServerType.STDIO) {
      await assertPublicUrl(dto.url!);
    }

    let server: McpServer;
    try {
      server = await this.mcpServerRepo.save(
        this.mcpServerRepo.create({
          name: dto.name,
          type: dto.type,
          description: dto.description ?? null,
          createdBy: user.id,
          isActive: true,
          ...(dto.type === McpServerType.STDIO
            ? {
                command: dto.command!,
                args: dto.args ?? null,
                envEncrypted: dto.env ? this.encryptJson(dto.env) : null,
                url: null,
                headersEncrypted: null,
              }
            : {
                command: null,
                args: null,
                envEncrypted: null,
                url: dto.url!,
                headersEncrypted: dto.headers ? this.encryptJson(dto.headers) : null,
              }),
        }),
      );
    } catch (e) {
      // 先查重只是友好快速失败；并发下唯一索引才是最终防线（TOCTOU）
      if (this.isDuplicateNameError(e)) {
        throw new ConflictException(`MCP Server 名称 "${dto.name}" 已存在`);
      }
      throw e;
    }
    return this.toView(server);
  }

  async findAllActive(
    query: QueryMcpServerDto,
  ): Promise<{ items: McpServerView[]; total: number }> {
    const [items, total] = await this.mcpServerRepo.findAndCount({
      where: query.type ? { isActive: true, type: query.type } : { isActive: true },
      order: { createdAt: 'DESC' },
    });
    return { items: items.map((s) => this.toView(s)), total };
  }

  async update(user: CurrentUser, id: string, dto: UpdateMcpServerDto): Promise<McpServerView> {
    const server = await this.findOrFail(id);
    this.assertOwnerOrAdmin(user, server);

    const nextType = dto.type ?? server.type;
    if (nextType === McpServerType.STDIO && server.type !== McpServerType.STDIO) {
      // 把已有 server 改成 stdio 等价于创建 stdio，需要 admin 权限
      this.assertStdioPermission(user, McpServerType.STDIO);
    }
    if (dto.name && dto.name !== server.name) {
      await this.assertNameAvailable(dto.name);
    }

    if (dto.name !== undefined) server.name = dto.name;
    if (dto.description !== undefined) server.description = dto.description ?? null;
    if (dto.isActive !== undefined) server.isActive = dto.isActive;
    server.type = nextType;

    // type 切换时重置另一形态的字段，避免出现 stdio+url 混合状态
    if (nextType === McpServerType.STDIO) {
      if (dto.command !== undefined) server.command = dto.command;
      if (dto.args !== undefined) server.args = dto.args ?? null;
      if (dto.env !== undefined) server.envEncrypted = dto.env ? this.encryptJson(dto.env) : null;
      server.url = null;
      server.headersEncrypted = null;
    } else {
      if (dto.url !== undefined) server.url = dto.url;
      if (dto.headers !== undefined) {
        server.headersEncrypted = dto.headers ? this.encryptJson(dto.headers) : null;
      }
      server.command = null;
      server.args = null;
      server.envEncrypted = null;
    }

    if (server.type === McpServerType.STDIO && !server.command) {
      throw new BadRequestException('stdio 类型必须提供 command');
    }
    if (server.type !== McpServerType.STDIO && !server.url) {
      throw new BadRequestException('sse / streamable-http 类型必须提供 url');
    }

    // SSRF：本次新传的 url（结果类型为非 stdio）保存前必须校验；
    // 未传 url 时沿用旧值（旧值在 create/update 落库前已校验过）
    if (nextType !== McpServerType.STDIO && dto.url !== undefined) {
      await assertPublicUrl(dto.url);
    }

    let saved: McpServer;
    try {
      saved = await this.mcpServerRepo.save(server);
    } catch (e) {
      // 改名并发撞唯一索引时转 409（先查重只是快速失败，DB 唯一索引是最终防线）
      if (this.isDuplicateNameError(e)) {
        throw new ConflictException(`MCP Server 名称 "${server.name}" 已存在`);
      }
      throw e;
    }
    return this.toView(saved);
  }

  /** 硬删除；关联表 agent_config_mcp_servers 由外键 CASCADE 自动清理 */
  async remove(user: CurrentUser, id: string): Promise<void> {
    const server = await this.findOrFail(id);
    this.assertOwnerOrAdmin(user, server);
    await this.mcpServerRepo.remove(server);
  }

  /** 响应脱敏：显式挑选字段，密文不出现在响应中 */
  toView(server: McpServer): McpServerView {
    return {
      id: server.id,
      name: server.name,
      type: server.type,
      command: server.command,
      args: server.args,
      url: server.url,
      description: server.description,
      isActive: server.isActive,
      createdBy: server.createdBy,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    };
  }

  /** 执行用运行时配置：env/headers 解密为对象，解密结果只活在调用方栈帧 */
  toRuntimeConfig(server: McpServer): McpServerRuntimeConfig {
    if (server.type === McpServerType.STDIO) {
      return {
        name: server.name,
        type: server.type,
        command: server.command ?? undefined,
        args: server.args ?? undefined,
        env: server.envEncrypted ? this.decryptJson(server.envEncrypted) : undefined,
      };
    }
    return {
      name: server.name,
      type: server.type,
      url: server.url ?? undefined,
      headers: server.headersEncrypted ? this.decryptJson(server.headersEncrypted) : undefined,
    };
  }

  /** 执行用：Agent 关联的启用中 MCP Server（env/headers 已解密） */
  async findByAgentConfig(agentConfigId: string): Promise<McpServerRuntimeConfig[]> {
    const servers = await this.findEntitiesByAgentConfig(agentConfigId);
    return servers.filter((s) => s.isActive).map((s) => this.toRuntimeConfig(s));
  }

  /** 展示用：Agent 关联的 MCP Server 脱敏视图 */
  async findViewsByAgentConfig(agentConfigId: string): Promise<McpServerView[]> {
    const servers = await this.findEntitiesByAgentConfig(agentConfigId);
    return servers.map((s) => this.toView(s));
  }

  /**
   * Agent/Skill 关联前校验：全部存在且启用中；stdio 类型仅 admin 可关联；
   * 属主校验（跨用户凭据复用防护）：admin 可关联任意 server，普通用户只能关联
   * 「自己创建」或「管理员创建（公共工具库）」的 server——普通用户 A 的私有
   * server（env/headers 含其凭据）不允许被普通用户 B 关联复用。
   * 校验通过返回实体列表，供调用方直接写关联。
   */
  async validateForAssociation(ids: string[], user: CurrentUser): Promise<McpServer[]> {
    if (!ids.length) return [];
    const servers = await this.mcpServerRepo.find({ where: { id: In(ids) } });
    const foundIds = new Set(servers.map((s) => s.id));
    const missing = ids.find((id) => !foundIds.has(id));
    if (missing) {
      throw new NotFoundException(`MCP Server #${missing} 不存在`);
    }
    const inactive = servers.find((s) => !s.isActive);
    if (inactive) {
      throw new BadRequestException(`MCP Server "${inactive.name}" 已停用，无法关联`);
    }
    if (user.role !== UserRole.ADMIN && servers.some((s) => s.type === McpServerType.STDIO)) {
      throw new ForbiddenException('仅管理员可为 Agent 关联 stdio 类型的 MCP Server');
    }
    // 属主校验：admin 全放行；普通用户仅能关联自己的或管理员创建的 server
    if (user.role !== UserRole.ADMIN) {
      const foreignServers = servers.filter((s) => s.createdBy !== user.id);
      if (foreignServers.length) {
        const creatorIds = [...new Set(foreignServers.map((s) => s.createdBy))];
        const adminCreatorIds = new Set(
          (
            await this.userRepo.find({
              where: { id: In(creatorIds) },
              select: ['id', 'role'],
            })
          )
            .filter((u) => u.role === UserRole.ADMIN)
            .map((u) => u.id),
        );
        const unauthorized = foreignServers.find((s) => !adminCreatorIds.has(s.createdBy));
        if (unauthorized) {
          throw new ForbiddenException(`无权使用该 MCP Server "${unauthorized.name}"`);
        }
      }
    }
    return servers;
  }

  private findEntitiesByAgentConfig(agentConfigId: string): Promise<McpServer[]> {
    return this.mcpServerRepo
      .createQueryBuilder('m')
      .innerJoin('agent_config_mcp_servers', 'j', 'j.mcp_server_id = m.id')
      .where('j.agent_config_id = :agentConfigId', { agentConfigId })
      .getMany();
  }

  private async findOrFail(id: string): Promise<McpServer> {
    const server = await this.mcpServerRepo.findOne({ where: { id } });
    if (!server) {
      throw new NotFoundException(`MCP Server #${id} 不存在`);
    }
    return server;
  }

  private async assertNameAvailable(name: string): Promise<void> {
    const existing = await this.mcpServerRepo.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException(`MCP Server 名称 "${name}" 已存在`);
    }
  }

  private assertStdioPermission(user: CurrentUser, type: McpServerType): void {
    if (type === McpServerType.STDIO && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('仅管理员可创建 stdio 类型的 MCP Server');
    }
  }

  private assertOwnerOrAdmin(user: CurrentUser, server: McpServer): void {
    if (server.createdBy !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('只有创建者或管理员可以操作该 MCP Server');
    }
  }

  /** MySQL 唯一索引冲突（name 唯一）识别：兼容 driverError 与直接 errno 两种形状 */
  private isDuplicateNameError(e: unknown): boolean {
    const err = e as { driverError?: { errno?: number; code?: string }; errno?: number };
    return (
      err?.driverError?.errno === 1062 ||
      err?.driverError?.code === 'ER_DUP_ENTRY' ||
      err?.errno === 1062
    );
  }

  private encryptJson(value: Record<string, string>): string {
    return encrypt(JSON.stringify(value), this.encryptionKey);
  }

  private decryptJson(stored: string): Record<string, string> {
    return JSON.parse(decrypt(stored, this.encryptionKey)) as Record<string, string>;
  }
}
