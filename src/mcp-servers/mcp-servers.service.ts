import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import { decrypt, encrypt } from '../agents/utils/crypto.util';

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
    @Inject(AGENT_ENCRYPTION_KEY)
    private readonly encryptionKey: string,
  ) {}

  async create(user: CurrentUser, dto: CreateMcpServerDto): Promise<McpServerView> {
    this.assertStdioPermission(user, dto.type);
    await this.assertNameAvailable(dto.name);

    const server = await this.mcpServerRepo.save(
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

    const saved = await this.mcpServerRepo.save(server);
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

  private encryptJson(value: Record<string, string>): string {
    return encrypt(JSON.stringify(value), this.encryptionKey);
  }

  private decryptJson(stored: string): Record<string, string> {
    return JSON.parse(decrypt(stored, this.encryptionKey)) as Record<string, string>;
  }
}
