# MCP Server 全局管理 Implementation Plan（第一期）

> **For agentic workers:** REQUIRED SUB-SKILL: Use tuanzii:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立全局 MCP Server 工具库（`mcp_servers` 表 + CRUD API + Agent 关联表），替代 `AgentConfig.mcpServers` JSON 字段。

**Architecture:** 新增 `src/mcp-servers/` 模块（实体/服务/控制器/DTO），`AgentConfig` 通过 `agent_config_mcp_servers` 关联表 ManyToMany 关联；`AgentExecutorService` 执行时经 `McpServersService.findByAgentConfig` 加载解密后的运行时配置，交给改造后的 `ToolRegistryService` 建连；旧 JSON 列保留但不再读写。

**Tech Stack:** NestJS 11 + TypeORM 0.3 + @modelcontextprotocol/sdk（stdio/sse/streamable-http 三种 transport）+ AES-256-GCM（复用 `src/agents/utils/crypto.util.ts`）。

**源设计文档:** `docs/plans/2026-07-28-mcp-server-management-design.md`

## Global Constraints

- 错误消息与 API 文案一律中文。
- 实体：`snake_case` 表名/列名，`@PrimaryGeneratedColumn('uuid')` 主键，必填 `createdAt/updatedAt`；枚举定义在实体文件里 export。
- DTO：每个字段同时带 `@ApiProperty({ example, description })`（中文描述）+ class-validator 装饰器；全局 `ValidationPipe` 开了 `forbidNonWhitelisted`。
- Controller：每个路由带 `@ApiOperation`/`@ApiResponse`；受保护路由 `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`；ID 参数用 `ParseUUIDPipe`；删除返回 204。
- Service：找不到抛 `NotFoundException`（中文）；业务冲突抛 `ConflictException`；权限不足抛 `ForbiddenException`。
- 测试：放 `test/` 镜像 `src/` 结构，用 `src/` 别名导入（jest moduleNameMapper 已配），`Test.createTestingModule` + `useValue` mock 全部外部依赖，不连真实数据库，测试描述用中文。
- 提交：conventional commits（husky + commitlint 拦截不规范信息），风格参照 `feat(agents): xxx`。
- 加密：env/headers 复用 `encrypt`/`decrypt`（`src/agents/utils/crypto.util.ts`），密钥经 `encryptionKeyProvider`（`src/agents/utils/encryption-key.provider.ts`）注入，token 为 `AGENT_ENCRYPTION_KEY`。
- 密文（`envEncrypted`/`headersEncrypted`）绝不出现在任何 API 响应中。
- 开发环境 `synchronize` 自动建表，不写 migration。
- 每个任务完成后跑 `pnpm typecheck` 与 `pnpm lint`。

## 文件清单

**新建：**
- `src/mcp-servers/mcp-server.entity.ts` — McpServer 实体 + `McpServerType` 枚举 + `McpServerView`/`McpServerRuntimeConfig` 类型
- `src/mcp-servers/dto/create-mcp-server.dto.ts` / `update-mcp-server.dto.ts` / `query-mcp-server.dto.ts`
- `src/mcp-servers/mcp-servers.service.ts` — CRUD + 权限 + 加解密 + 关联校验
- `src/mcp-servers/mcp-servers.controller.ts` — REST API（`/api/mcp-servers`）
- `src/mcp-servers/mcp-servers.module.ts`
- `src/agents/dto/update-agent-mcp-servers.dto.ts` — Agent 关联请求体
- `test/mcp-servers/mcp-servers.service.spec.ts`
- `test/mcp-servers/mcp-servers.controller.spec.ts`

**修改：**
- `src/app.module.ts` — imports 加 `McpServersModule`
- `src/agents/entities/agent-config.entity.ts` — `mcpServers` JSON 字段改名 `legacyMcpServers`（列名不变，废弃），新增 `@ManyToMany` 关联 `McpServer`
- `src/agents/tools/tool-registry.service.ts` — MCP 加载改为接收 `McpServerRuntimeConfig[]`，支持三种 transport + args/env/headers
- `src/agents/agent-executor.service.ts` — 注入 `McpServersService`，工具加载走 `findByAgentConfig`
- `src/agents/agents.module.ts` — imports 加 `McpServersModule`
- `src/agents/agents.service.ts` — 删除旧 mcpServers 读写，新增 `getMcpServers`/`updateMcpServers`
- `src/agents/agents.controller.ts` — 新增 `GET/PUT /api/agents/:id/mcp-servers`
- `src/agents/dto/create-agent.dto.ts` — 删除 `McpServerDto` 与 `mcpServers` 字段
- `src/agents/dto/agent-response.dto.ts` — 删除 `mcpServers` 字段
- `test/agents/tools/tool-registry.service.spec.ts` — 按新签名重写
- `test/agents/agent-executor.service.spec.ts` — 加 `McpServersService` mock
- `test/agents/agents.service.spec.ts` — 删除旧 stdio 权限用例，新增关联接口用例

---

### Task 1: McpServer 实体 + McpServersService CRUD + 模块注册

**Files:**
- Create: `src/mcp-servers/mcp-server.entity.ts`
- Create: `src/mcp-servers/dto/create-mcp-server.dto.ts`
- Create: `src/mcp-servers/dto/update-mcp-server.dto.ts`
- Create: `src/mcp-servers/dto/query-mcp-server.dto.ts`
- Create: `src/mcp-servers/mcp-servers.service.ts`
- Create: `src/mcp-servers/mcp-servers.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/mcp-servers/mcp-servers.service.spec.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt`（`src/agents/utils/crypto.util.ts`）、`AGENT_ENCRYPTION_KEY`/`encryptionKeyProvider`（`src/agents/utils/encryption-key.provider.ts`）、`User`/`UserRole`（`src/users/users.entity.ts`）。
- Produces:
  - `McpServerType` 枚举：`STDIO='stdio'`、`SSE='sse'`、`STREAMABLE_HTTP='streamable-http'`
  - `McpServer` 实体（表 `mcp_servers`），密文字段为 `envEncrypted`（列名 `env`）、`headersEncrypted`（列名 `headers`）
  - `type McpServerView = Omit<McpServer, 'envEncrypted' | 'headersEncrypted' | 'creator'>`
  - `interface McpServerRuntimeConfig { name: string; type: McpServerType; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; }`
  - `McpServersService` 方法（后续任务依赖以下精确签名）：
    - `create(user: CurrentUser, dto: CreateMcpServerDto): Promise<McpServerView>`
    - `findAllActive(query: QueryMcpServerDto): Promise<{ items: McpServerView[]; total: number }>`
    - `update(user: CurrentUser, id: string, dto: UpdateMcpServerDto): Promise<McpServerView>`
    - `remove(user: CurrentUser, id: string): Promise<void>`
    - `toView(server: McpServer): McpServerView`
    - `toRuntimeConfig(server: McpServer): McpServerRuntimeConfig`
  - 其中 `type CurrentUser = Omit<User, 'password'>`（模块内私有类型）

- [ ] **Step 1: 写失败测试**

创建 `test/mcp-servers/mcp-servers.service.spec.ts`：

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
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { McpServer, McpServerType } from 'src/mcp-servers/mcp-server.entity';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { decrypt } from 'src/agents/utils/crypto.util';
import { UserRole } from 'src/users/users.entity';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('McpServersService', () => {
  let service: McpServersService;
  let repo: jest.Mocked<Repository<McpServer>>;

  const normalUser = {
    id: 'user-1',
    email: 'u@test.com',
    username: 'user',
    role: UserRole.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const adminUser = { ...normalUser, id: 'admin-1', role: UserRole.ADMIN };

  const sseServer: McpServer = {
    id: 'srv-1',
    name: 'web-search',
    type: McpServerType.SSE,
    command: null,
    args: null,
    envEncrypted: null,
    url: 'https://mcp.example.com/sse',
    headersEncrypted: null,
    description: '联网搜索',
    isActive: true,
    creator: normalUser as never,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpServersService,
        {
          provide: getRepositoryToken(McpServer),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            remove: jest.fn(async (v) => v),
          },
        },
        { provide: AGENT_ENCRYPTION_KEY, useValue: TEST_KEY },
      ],
    }).compile();

    service = module.get(McpServersService);
    repo = module.get(getRepositoryToken(McpServer));
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('sse 类型：headers 应加密存储，响应脱敏', async () => {
      repo.findOne.mockResolvedValue(null); // 名称查重

      const result = await service.create(normalUser, {
        name: 'web-search',
        type: McpServerType.SSE,
        url: 'https://mcp.example.com/sse',
        headers: { Authorization: 'Bearer token-abc' },
      });

      const saved = repo.save.mock.calls[0][0] as McpServer;
      expect(saved.headersEncrypted).toBeTruthy();
      expect(saved.headersEncrypted).not.toContain('token-abc');
      expect(JSON.parse(decrypt(saved.headersEncrypted!, TEST_KEY))).toEqual({
        Authorization: 'Bearer token-abc',
      });
      expect(saved.command).toBeNull();
      expect(result).not.toHaveProperty('headersEncrypted');
      expect(result).not.toHaveProperty('envEncrypted');
      expect(result.url).toBe('https://mcp.example.com/sse');
    });

    it('stdio 类型：普通用户应抛 403', async () => {
      await expect(
        service.create(normalUser, {
          name: 'fs',
          type: McpServerType.STDIO,
          command: 'npx',
          args: ['-y', 'server-fs'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('stdio 类型：管理员可创建，env 加密存储且 url 置空', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.create(adminUser, {
        name: 'fs',
        type: McpServerType.STDIO,
        command: 'npx',
        args: ['-y', 'server-fs'],
        env: { ROOT: '/tmp' },
      });

      const saved = repo.save.mock.calls[0][0] as McpServer;
      expect(saved.url).toBeNull();
      expect(saved.headersEncrypted).toBeNull();
      expect(JSON.parse(decrypt(saved.envEncrypted!, TEST_KEY))).toEqual({ ROOT: '/tmp' });
      expect(result.command).toBe('npx');
    });

    it('名称重复应抛 409', async () => {
      repo.findOne.mockResolvedValue(sseServer);

      await expect(
        service.create(normalUser, { name: 'web-search', type: McpServerType.SSE, url: 'https://a.com/sse' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findAllActive', () => {
    it('应只查 isActive=true 并返回脱敏视图', async () => {
      repo.findAndCount.mockResolvedValue([[sseServer], 1]);

      const result = await service.findAllActive({});

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
      expect(result.total).toBe(1);
      expect(result.items[0]).not.toHaveProperty('headersEncrypted');
    });

    it('传 type 时应追加类型筛选', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      await service.findAllActive({ type: McpServerType.SSE });

      expect(repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true, type: McpServerType.SSE } }),
      );
    });
  });

  describe('update', () => {
    it('非创建者且非管理员应抛 403', async () => {
      repo.findOne.mockResolvedValue({ ...sseServer });

      await expect(
        service.update({ ...normalUser, id: 'other-user' }, 'srv-1', { description: 'x' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('创建者可更新；改名时若名称被占用应抛 409', async () => {
      repo.findOne
        .mockResolvedValueOnce({ ...sseServer }) // findOrFail
        .mockResolvedValueOnce({ ...sseServer, id: 'srv-2' }); // 名称查重

      await expect(service.update(normalUser, 'srv-1', { name: 'web-search-2' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('切换为 stdio 类型时普通用户（即便是创建者）应抛 403', async () => {
      repo.findOne.mockResolvedValue({ ...sseServer });

      await expect(
        service.update(normalUser, 'srv-1', { type: McpServerType.STDIO, command: 'npx' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('切换类型时应清空另一形态的字段；stdio 缺 command 应抛 400', async () => {
      repo.findOne.mockResolvedValue({ ...sseServer });

      await expect(service.update(adminUser, 'srv-1', { type: McpServerType.STDIO })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    it('不存在应抛 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.remove(normalUser, 'nope')).rejects.toThrow(NotFoundException);
    });

    it('非创建者且非管理员应抛 403，管理员可删除他人的', async () => {
      repo.findOne.mockResolvedValue({ ...sseServer });
      await expect(service.remove({ ...normalUser, id: 'other' }, 'srv-1')).rejects.toThrow(
        ForbiddenException,
      );

      repo.findOne.mockResolvedValue({ ...sseServer });
      await service.remove(adminUser, 'srv-1');
      expect(repo.remove).toHaveBeenCalled();
    });
  });

  describe('toRuntimeConfig', () => {
    it('stdio 类型应解密 env 为对象', () => {
      const server: McpServer = {
        ...sseServer,
        type: McpServerType.STDIO,
        command: 'npx',
        args: ['-y', 'server-fs'],
        envEncrypted: 'placeholder',
        url: null,
      };
      server.envEncrypted = (() => {
        // 用真实 encrypt 生成密文
        const { encrypt } = jest.requireActual('src/agents/utils/crypto.util') as typeof import('src/agents/utils/crypto.util');
        return encrypt(JSON.stringify({ ROOT: '/tmp' }), TEST_KEY);
      })();

      const runtime = service.toRuntimeConfig(server);

      expect(runtime).toEqual({
        name: 'web-search',
        type: McpServerType.STDIO,
        command: 'npx',
        args: ['-y', 'server-fs'],
        env: { ROOT: '/tmp' },
      });
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- mcp-servers.service`
Expected: FAIL（`Cannot find module 'src/mcp-servers/mcp-servers.service'`）

- [ ] **Step 3: 实现实体、DTO、Service、Module**

创建 `src/mcp-servers/mcp-server.entity.ts`：

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../users/users.entity';

/** MCP 连接类型。stdio 会在服务端执行子进程，仅管理员可创建/关联 */
export enum McpServerType {
  STDIO = 'stdio',
  SSE = 'sse',
  STREAMABLE_HTTP = 'streamable-http',
}

/**
 * 全局 MCP Server 工具库：Admin 集中配置，普通用户选配给自己的 Agent。
 * env/headers 为敏感配置，AES-256-GCM 加密存储（列名 env/headers，存密文），
 * 绝不明文落库、绝不出现在 API 响应。
 */
@Entity('mcp_servers')
@Index(['type', 'isActive'])
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 100 })
  name: string;

  @Column({ type: 'enum', enum: McpServerType })
  type: McpServerType;

  /** stdio 专用：可执行命令 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  command: string | null;

  /** stdio 专用：命令参数数组 */
  @Column({ type: 'json', nullable: true })
  args: string[] | null;

  /** stdio 专用：环境变量 JSON 的 AES-256-GCM 密文 */
  @Column({ name: 'env', type: 'text', nullable: true })
  envEncrypted: string | null;

  /** sse / streamable-http 专用：连接地址 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  url: string | null;

  /** sse / streamable-http 专用：请求头 JSON 的 AES-256-GCM 密文 */
  @Column({ name: 'headers', type: 'text', nullable: true })
  headersEncrypted: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

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

/** API 响应形状：密文字段与 creator 关系对象绝不出现在响应中 */
export type McpServerView = Omit<McpServer, 'envEncrypted' | 'headersEncrypted' | 'creator'>;

/** Agent 执行时使用的运行时配置：env/headers 已解密为对象 */
export interface McpServerRuntimeConfig {
  name: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
```

创建 `src/mcp-servers/dto/create-mcp-server.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateIf,
} from 'class-validator';
import { McpServerType } from '../mcp-server.entity';

export class CreateMcpServerDto {
  @ApiProperty({ example: 'web-search', description: '全局唯一名称' })
  @IsString()
  @Length(1, 100)
  name: string;

  @ApiProperty({
    enum: McpServerType,
    example: 'sse',
    description: '连接类型：stdio 在服务端执行子进程（仅管理员可创建）',
  })
  @IsEnum(McpServerType)
  type: McpServerType;

  @ApiProperty({ required: false, example: 'npx', description: 'stdio 类型必填：可执行命令' })
  @ValidateIf((o: CreateMcpServerDto) => o.type === McpServerType.STDIO)
  @IsString()
  @IsNotEmpty({ message: 'stdio 类型必须提供 command' })
  command?: string;

  @ApiProperty({
    required: false,
    example: ['-y', '@modelcontextprotocol/server-filesystem'],
    description: 'stdio 类型可选：命令参数数组',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  args?: string[];

  @ApiProperty({
    required: false,
    example: { API_KEY: 'xxx' },
    description: 'stdio 类型可选：环境变量（加密存储，响应中不回显）',
  })
  @IsObject()
  @IsOptional()
  env?: Record<string, string>;

  @ApiProperty({
    required: false,
    example: 'https://mcp.example.com/sse',
    description: 'sse / streamable-http 类型必填：连接地址',
  })
  @ValidateIf((o: CreateMcpServerDto) => o.type !== McpServerType.STDIO)
  @IsUrl({ require_tld: false }, { message: '必须提供合法的 url' })
  url?: string;

  @ApiProperty({
    required: false,
    example: { Authorization: 'Bearer xxx' },
    description: 'sse / streamable-http 类型可选：请求头（加密存储，响应中不回显）',
  })
  @IsObject()
  @IsOptional()
  headers?: Record<string, string>;

  @ApiProperty({ required: false, example: '联网搜索工具', description: '描述（展示在 Agent 配置界面）' })
  @IsString()
  @Length(0, 255)
  @IsOptional()
  description?: string;
}
```

创建 `src/mcp-servers/dto/update-mcp-server.dto.ts`：

```typescript
import { PartialType } from '@nestjs/swagger';
import { CreateMcpServerDto } from './create-mcp-server.dto';

/** 所有字段可选；env/headers 不传则保持原值，传 null 语义不支持（清空传 {}） */
export class UpdateMcpServerDto extends PartialType(CreateMcpServerDto) {}
```

创建 `src/mcp-servers/dto/query-mcp-server.dto.ts`：

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { McpServerType } from '../mcp-server.entity';

export class QueryMcpServerDto {
  @ApiProperty({ enum: McpServerType, required: false, description: '按连接类型筛选' })
  @IsEnum(McpServerType)
  @IsOptional()
  type?: McpServerType;
}
```

创建 `src/mcp-servers/mcp-servers.service.ts`：

```typescript
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

  async findAllActive(query: QueryMcpServerDto): Promise<{ items: McpServerView[]; total: number }> {
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
```

创建 `src/mcp-servers/mcp-servers.module.ts`（controller 在 Task 2 加入）：

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from './mcp-server.entity';
import { McpServersService } from './mcp-servers.service';
import { encryptionKeyProvider } from '../agents/utils/encryption-key.provider';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer])],
  providers: [McpServersService, encryptionKeyProvider],
  exports: [McpServersService],
})
export class McpServersModule {}
```

修改 `src/app.module.ts`：imports 数组末尾加 `McpServersModule`（并加 import 语句 `import { McpServersModule } from './mcp-servers/mcp-servers.module';`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- mcp-servers.service`
Expected: PASS（全部用例）

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/mcp-servers src/app.module.ts test/mcp-servers
git commit -m "feat(mcp-servers): 新增全局 MCP Server 实体与 CRUD 服务"
```

---

### Task 2: McpServersController（REST API）

**Files:**
- Create: `src/mcp-servers/mcp-servers.controller.ts`
- Modify: `src/mcp-servers/mcp-servers.module.ts`
- Test: `test/mcp-servers/mcp-servers.controller.spec.ts`

**Interfaces:**
- Consumes: `McpServersService`（Task 1 的 create/findAllActive/update/remove）、`JwtAuthGuard`（`src/common/guards/jwt-auth.guard.ts`）、`CurrentUser` 装饰器（`src/common/decorators/current-user.decorator.ts`）。
- Produces: 路由 `GET/POST /api/mcp-servers`、`PATCH/DELETE /api/mcp-servers/:id`。

- [ ] **Step 1: 写失败测试**

创建 `test/mcp-servers/mcp-servers.controller.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { McpServersController } from 'src/mcp-servers/mcp-servers.controller';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { McpServerType } from 'src/mcp-servers/mcp-server.entity';
import { UserRole } from 'src/users/users.entity';

describe('McpServersController', () => {
  let controller: McpServersController;
  let service: Record<string, jest.Mock>;

  const adminUser = {
    id: 'admin-1',
    email: 'a@test.com',
    username: 'admin',
    role: UserRole.ADMIN,
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
      controllers: [McpServersController],
      providers: [{ provide: McpServersService, useValue: service }],
    }).compile();

    controller = module.get(McpServersController);
  });

  it('GET / 应调用 findAllActive 并透传 query', async () => {
    service.findAllActive.mockResolvedValue({ items: [], total: 0 });

    const result = await controller.findAll({ type: McpServerType.SSE });

    expect(service.findAllActive).toHaveBeenCalledWith({ type: McpServerType.SSE });
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('POST / 应把当前用户与 DTO 传给 service.create', async () => {
    const dto = { name: 'web-search', type: McpServerType.SSE, url: 'https://a.com/sse' };
    service.create.mockResolvedValue({ id: 'srv-1' });

    await controller.create(adminUser, dto);

    expect(service.create).toHaveBeenCalledWith(adminUser, dto);
  });

  it('PATCH /:id 应把当前用户、id、DTO 传给 service.update', async () => {
    service.update.mockResolvedValue({ id: 'srv-1' });

    await controller.update(adminUser, 'srv-1', { description: '新描述' });

    expect(service.update).toHaveBeenCalledWith(adminUser, 'srv-1', { description: '新描述' });
  });

  it('DELETE /:id 应调用 service.remove', async () => {
    await controller.remove(adminUser, 'srv-1');

    expect(service.remove).toHaveBeenCalledWith(adminUser, 'srv-1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- mcp-servers.controller`
Expected: FAIL（`Cannot find module 'src/mcp-servers/mcp-servers.controller'`）

- [ ] **Step 3: 实现 Controller 并注册到模块**

创建 `src/mcp-servers/mcp-servers.controller.ts`：

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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '../users/users.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { McpServersService } from './mcp-servers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { QueryMcpServerDto } from './dto/query-mcp-server.dto';

@ApiTags('MCP Server')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('mcp-servers')
export class McpServersController {
  constructor(private readonly mcpServersService: McpServersService) {}

  @Get()
  @ApiOperation({ summary: '全局 MCP Server 列表', description: '只返回启用中的 server，env/headers 不回显' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async findAll(@Query() query: QueryMcpServerDto) {
    return this.mcpServersService.findAllActive(query);
  }

  @Post()
  @ApiOperation({ summary: '创建 MCP Server', description: 'stdio 类型仅管理员可创建' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 403, description: '非管理员创建 stdio 类型' })
  @ApiResponse({ status: 409, description: '名称已存在' })
  async create(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: CreateMcpServerDto) {
    return this.mcpServersService.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新 MCP Server', description: '仅创建者或管理员；env/headers 不传则保持原值' })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '非创建者且非管理员' })
  @ApiResponse({ status: 404, description: 'MCP Server 不存在' })
  async update(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    return this.mcpServersService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '删除 MCP Server', description: '仅创建者或管理员；关联关系自动级联清理' })
  @ApiResponse({ status: 204, description: '删除成功' })
  @ApiResponse({ status: 404, description: 'MCP Server 不存在' })
  async remove(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.mcpServersService.remove(user, id);
  }
}
```

修改 `src/mcp-servers/mcp-servers.module.ts`：`@Module` 中增加 `controllers: [McpServersController]`，并加 import：

```typescript
import { McpServersController } from './mcp-servers.controller';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- mcp-servers.controller`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/mcp-servers test/mcp-servers
git commit -m "feat(mcp-servers): 新增 MCP Server REST API"
```

---

### Task 3: ToolRegistryService 支持 McpServerRuntimeConfig（三种 transport）

**Files:**
- Modify: `src/agents/tools/tool-registry.service.ts`
- Test: `test/agents/tools/tool-registry.service.spec.ts`（按新签名重写）

**Interfaces:**
- Consumes: `McpServerRuntimeConfig`/`McpServerType`（`src/mcp-servers/mcp-server.entity.ts`，Task 1）。
- Produces:
  - `ToolRegistryService.getToolsForAgent(config: AgentConfig, mcpServers?: McpServerRuntimeConfig[]): Promise<StructuredToolInterface[]>` — 第二参为解密后的运行时配置（默认 `[]`），由 Task 4 的 executor 传入。
  - 连接缓存 key：stdio 为 `stdio:<command> <args 空格拼接>`；url 类为 `<type>:<url>`。

- [ ] **Step 1: 重写失败测试**

全量替换 `test/agents/tools/tool-registry.service.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import {
  McpServerRuntimeConfig,
  McpServerType,
} from 'src/mcp-servers/mcp-server.entity';

// 这些 mock 必须在 import 之前声明，jest.mock 会被提升到顶部。
// 注意：工厂函数在模块导入时执行（早于下方 const 初始化），
// 所以 mock 变量只能放在闭包里延迟引用，不能直接作为值导出（TDZ 报错）
const mockConnect = jest.fn();
const mockClose = jest.fn();
const mockLoadMcpTools = jest.fn();
const mockStdioTransport = jest.fn();
const mockSseTransport = jest.fn();
const mockHttpTransport = jest.fn();

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: (...args: unknown[]) => mockStdioTransport(...args),
  getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: (...args: unknown[]) => mockSseTransport(...args),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: (...args: unknown[]) => mockHttpTransport(...args),
}));
jest.mock('@langchain/mcp-adapters', () => ({
  loadMcpTools: (...args: unknown[]) => mockLoadMcpTools(...args),
}));

describe('ToolRegistryService', () => {
  let service: ToolRegistryService;

  const buildAgent = (override: Partial<AgentConfig> = {}): AgentConfig =>
    ({
      id: 'agent-1',
      name: '测试助手',
      provider: ProviderType.ANTHROPIC,
      enabledTools: [],
      ...override,
    }) as AgentConfig;

  const sseServer: McpServerRuntimeConfig = {
    name: '远程工具',
    type: McpServerType.SSE,
    url: 'https://mcp.example.com/sse',
  };

  const stdioServer: McpServerRuntimeConfig = {
    name: '文件系统',
    type: McpServerType.STDIO,
    command: 'npx',
    args: ['-y', 'server-fs'],
    env: { ROOT: '/tmp' },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockLoadMcpTools.mockResolvedValue([{ name: 'mcp_tool' }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolRegistryService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, def?: unknown) => def) },
        },
      ],
    }).compile();

    service = module.get(ToolRegistryService);
    service.onModuleInit();
  });

  describe('内置工具', () => {
    it('应该按 enabledTools 过滤内置工具', async () => {
      const tools = await service.getToolsForAgent(buildAgent({ enabledTools: ['calculator'] }));

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });

    it('listBuiltinToolNames 应该返回全部已注册工具名', () => {
      expect(service.listBuiltinToolNames()).toEqual(
        expect.arrayContaining(['web_search', 'calculator']),
      );
    });
  });

  describe('MCP 工具', () => {
    it('sse 类型应该用 SSEClientTransport 连接并加载工具', async () => {
      const tools = await service.getToolsForAgent(buildAgent(), [sseServer]);

      expect(mockSseTransport).toHaveBeenCalledTimes(1);
      expect(mockSseTransport.mock.calls[0][0]).toBeInstanceOf(URL);
      expect(String(mockSseTransport.mock.calls[0][0])).toBe('https://mcp.example.com/sse');
      expect(mockLoadMcpTools).toHaveBeenCalledWith('远程工具', expect.anything());
      expect(tools).toEqual([{ name: 'mcp_tool' }]);
    });

    it('带 headers 的 server 应该把 headers 放入 requestInit', async () => {
      const withHeaders: McpServerRuntimeConfig = {
        ...sseServer,
        headers: { Authorization: 'Bearer abc' },
      };

      await service.getToolsForAgent(buildAgent(), [withHeaders]);

      expect(mockSseTransport.mock.calls[0][1]).toEqual({
        requestInit: { headers: { Authorization: 'Bearer abc' } },
      });
    });

    it('streamable-http 类型应该用 StreamableHTTPClientTransport', async () => {
      const httpServer: McpServerRuntimeConfig = {
        name: 'http 工具',
        type: McpServerType.STREAMABLE_HTTP,
        url: 'https://mcp.example.com/mcp',
      };

      await service.getToolsForAgent(buildAgent(), [httpServer]);

      expect(mockHttpTransport).toHaveBeenCalledTimes(1);
      expect(String(mockHttpTransport.mock.calls[0][0])).toBe('https://mcp.example.com/mcp');
    });

    it('stdio 类型应该传 command/args，env 与默认环境合并', async () => {
      await service.getToolsForAgent(buildAgent(), [stdioServer]);

      expect(mockStdioTransport).toHaveBeenCalledWith({
        command: 'npx',
        args: ['-y', 'server-fs'],
        env: { PATH: '/usr/bin', ROOT: '/tmp' },
      });
    });

    it('相同 url 的 server（不同名字）应该复用连接', async () => {
      await service.getToolsForAgent(buildAgent(), [sseServer]);
      await service.getToolsForAgent(buildAgent(), [{ ...sseServer, name: '另一个名字' }]);

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('相同 command 不同 args 的 stdio server 不应该复用连接', async () => {
      await service.getToolsForAgent(buildAgent(), [stdioServer]);
      await service.getToolsForAgent(buildAgent(), [{ ...stdioServer, args: ['-y', 'other'] }]);

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('MCP 连接失败应该跳过该 Server 而不阻断整体', async () => {
      mockConnect.mockRejectedValue(new Error('connection refused'));

      const tools = await service.getToolsForAgent(buildAgent({ enabledTools: ['calculator'] }), [
        sseServer,
      ]);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('calculator');
    });

    it('onModuleDestroy 应该关闭全部 MCP 连接', async () => {
      await service.getToolsForAgent(buildAgent(), [sseServer]);

      await service.onModuleDestroy();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- tool-registry.service`
Expected: FAIL（新签名/新 transport 未实现）

- [ ] **Step 3: 改造 ToolRegistryService**

全量替换 `src/agents/tools/tool-registry.service.ts`：

```typescript
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { AgentConfig } from '../entities/agent-config.entity';
import { McpServerRuntimeConfig, McpServerType } from '../../mcp-servers/mcp-server.entity';
import { WebSearchTool } from './builtin/web-search.tool';
import { CalculatorTool } from './builtin/calculator.tool';

/**
 * 工具注册表：内置工具 + MCP 客户端连接池管理。
 *
 * - 内置工具按 name 注册，AgentConfig.enabledTools 按需取用
 * - MCP Server 由调用方（AgentExecutorService）从 mcp_servers 表加载解密后传入，
 *   Client 以 transport:endpoint 为 key 复用连接，模块销毁时统一关闭
 * - 单个 MCP Server 连接失败不阻断整体——跳过该 Server 并记录警告
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly builtinTools = new Map<string, StructuredToolInterface>();
  private readonly mcpClients = new Map<string, Client>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.builtinTools.set('web_search', new WebSearchTool(this.config));
    this.builtinTools.set('calculator', new CalculatorTool());
    // 后续新增内置工具在此注册
  }

  async onModuleDestroy() {
    for (const client of this.mcpClients.values()) {
      try {
        await client.close();
      } catch (e) {
        this.logger.warn(`关闭 MCP 连接失败: ${(e as Error).message}`);
      }
    }
    this.mcpClients.clear();
  }

  /** 返回全部内置工具名，供前端展示可选列表 */
  listBuiltinToolNames(): string[] {
    return [...this.builtinTools.keys()];
  }

  async getToolsForAgent(
    config: AgentConfig,
    mcpServers: McpServerRuntimeConfig[] = [],
  ): Promise<StructuredToolInterface[]> {
    const tools: StructuredToolInterface[] = [];

    for (const name of config.enabledTools ?? []) {
      const tool = this.builtinTools.get(name);
      if (tool) {
        tools.push(tool);
      } else {
        this.logger.warn(`Agent "${config.name}" 启用了不存在的内置工具: ${name}`);
      }
    }

    for (const server of mcpServers) {
      try {
        const mcpTools = await this.loadMcpTools(server);
        tools.push(...mcpTools);
      } catch (e) {
        // MCP 连接失败不阻断整体——跳过该 Server，日志记录警告
        this.logger.warn(`MCP Server "${server.name}" 连接失败，已跳过: ${(e as Error).message}`);
      }
    }

    return tools;
  }

  private async loadMcpTools(server: McpServerRuntimeConfig): Promise<StructuredToolInterface[]> {
    const client = await this.connectOrGet(server);
    // 必须用 @langchain/mcp-adapters 的 loadMcpTools 做 JSON Schema → Zod 转换：
    // MCP 返回的 inputSchema 是 JSON Schema 对象，直接强转 ZodSchema 会在运行时崩溃
    return loadMcpTools(server.name, client);
  }

  private async connectOrGet(server: McpServerRuntimeConfig): Promise<Client> {
    const cacheKey = this.buildCacheKey(server);
    const cached = this.mcpClients.get(cacheKey);
    if (cached) return cached;

    const client = new Client({ name: 'tuanzi-agent', version: '1.0.0' }, { capabilities: {} });

    let transport;
    if (server.type === McpServerType.STDIO) {
      transport = new StdioClientTransport({
        command: server.command!,
        args: server.args ?? [],
        // 用户 env 与 SDK 默认环境（PATH 等）合并，否则子进程可能找不到可执行文件
        env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
      });
    } else {
      const options = server.headers ? { requestInit: { headers: server.headers } } : undefined;
      transport =
        server.type === McpServerType.SSE
          ? new SSEClientTransport(new URL(server.url!), options)
          : new StreamableHTTPClientTransport(new URL(server.url!), options);
    }

    await client.connect(transport);
    this.mcpClients.set(cacheKey, client);
    return client;
  }

  /** 以 transport + endpoint 为 key，防止不同 URL/args 的配置复用错误连接 */
  private buildCacheKey(server: McpServerRuntimeConfig): string {
    return server.type === McpServerType.STDIO
      ? `stdio:${server.command} ${(server.args ?? []).join(' ')}`
      : `${server.type}:${server.url}`;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- tool-registry.service`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/agents/tools test/agents/tools
git commit -m "feat(agents): ToolRegistry 支持全局 MCP Server 运行时配置与三种 transport"
```

---

### Task 4: AgentConfig 关联改造 + AgentExecutor 加载改造

**Files:**
- Modify: `src/agents/entities/agent-config.entity.ts`
- Modify: `src/mcp-servers/mcp-servers.service.ts`（追加 `findByAgentConfig` / `findViewsByAgentConfig` / `validateForAssociation`）
- Modify: `src/agents/agent-executor.service.ts`
- Modify: `src/agents/agents.module.ts`
- Test: `test/mcp-servers/mcp-servers.service.spec.ts`（追加用例）
- Test: `test/agents/agent-executor.service.spec.ts`（加 mock）

**Interfaces:**
- Consumes: Task 1 的 `McpServersService` / `McpServerRuntimeConfig`；Task 3 的 `getToolsForAgent(config, mcpServers)`。
- Produces:
  - `McpServersService.findByAgentConfig(agentConfigId: string): Promise<McpServerRuntimeConfig[]>` — 仅 `isActive=true`，env/headers 已解密（执行用）。
  - `McpServersService.findViewsByAgentConfig(agentConfigId: string): Promise<McpServerView[]>` — 脱敏视图（展示用，Task 5 用）。
  - `McpServersService.validateForAssociation(ids: string[], user: CurrentUser): Promise<McpServer[]>` — 全部存在且启用，stdio 仅 admin；返回实体列表（Task 5 用）。
  - `AgentConfig.mcpServers: McpServer[]`（ManyToMany，关联表 `agent_config_mcp_servers`）；旧 JSON 字段改名 `legacyMcpServers`（列名 `mcp_servers` 不变）。

- [ ] **Step 1: 写失败测试（service 追加用例）**

在 `test/mcp-servers/mcp-servers.service.spec.ts` 的 `describe('McpServersService')` 内追加（repo mock 的 useValue 里需补 `createQueryBuilder: jest.fn()`）：

```typescript
  describe('findByAgentConfig', () => {
    it('应通过关联表查询，过滤停用 server，并解密 env', async () => {
      const { encrypt } = jest.requireActual('src/agents/utils/crypto.util') as typeof import('src/agents/utils/crypto.util');
      const activeStdio: McpServer = {
        ...sseServer,
        id: 'srv-stdio',
        type: McpServerType.STDIO,
        command: 'npx',
        args: null,
        url: null,
        envEncrypted: encrypt(JSON.stringify({ ROOT: '/tmp' }), TEST_KEY),
      };
      const inactive: McpServer = { ...sseServer, id: 'srv-off', isActive: false };
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([activeStdio, inactive]),
      };
      (repo.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.findByAgentConfig('agent-1');

      expect(qb.innerJoin).toHaveBeenCalledWith(
        'agent_config_mcp_servers',
        'j',
        'j.mcp_server_id = m.id',
      );
      expect(qb.where).toHaveBeenCalledWith('j.agent_config_id = :agentConfigId', {
        agentConfigId: 'agent-1',
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'web-search',
        type: McpServerType.STDIO,
        command: 'npx',
        env: { ROOT: '/tmp' },
      });
    });
  });

  describe('validateForAssociation', () => {
    it('任一 id 不存在应抛 404', async () => {
      repo.find.mockResolvedValue([{ ...sseServer }]);

      await expect(service.validateForAssociation(['srv-1', 'srv-x'], normalUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('包含已停用 server 应抛 400', async () => {
      repo.find.mockResolvedValue([{ ...sseServer, isActive: false }]);

      await expect(service.validateForAssociation(['srv-1'], normalUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('普通用户关联 stdio 类型应抛 403，管理员可以', async () => {
      const stdioServer: McpServer = { ...sseServer, type: McpServerType.STDIO, command: 'npx' };
      repo.find.mockResolvedValue([stdioServer]);

      await expect(service.validateForAssociation(['srv-1'], normalUser)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.validateForAssociation(['srv-1'], adminUser)).resolves.toHaveLength(1);
    });

    it('空数组直接返回空，不查库', async () => {
      await expect(service.validateForAssociation([], normalUser)).resolves.toEqual([]);
      expect(repo.find).not.toHaveBeenCalled();
    });
  });
```

同时在文件顶部 import 区把 `Repository` 的 import 保留，并给 `repo` 的 useValue mock 增加两个方法（在 beforeEach 的 useValue 对象里加）：

```typescript
            find: jest.fn(),
            createQueryBuilder: jest.fn(),
```

再在 `test/agents/agent-executor.service.spec.ts` 中追加一个用例（describe 'run（同步执行）' 内），并修改 beforeEach（见 Step 3 后说明）：

```typescript
    it('应该从 McpServersService 加载 MCP 工具并传给 ToolRegistry', async () => {
      const runtimeServer = { name: '远程工具', type: 'sse', url: 'https://mcp.example.com/sse' };
      mcpServersService.findByAgentConfig.mockResolvedValue([runtimeServer]);
      mockInvoke.mockResolvedValue(new AIMessage({ content: 'ok' }));

      await service.run(buildAgent(), 'conv-1', '你好');

      expect(mcpServersService.findByAgentConfig).toHaveBeenCalledWith('agent-1');
      expect(toolRegistry.getToolsForAgent).toHaveBeenCalledWith(expect.anything(), [
        runtimeServer,
      ]);
    });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- mcp-servers.service agent-executor.service`
Expected: FAIL（`findByAgentConfig`/`validateForAssociation` 不存在；executor 缺 `McpServersService` provider）

- [ ] **Step 3: 实现**

**3a. 修改 `src/agents/entities/agent-config.entity.ts`：**

- import 区加：
```typescript
import { ManyToMany, JoinTable } from 'typeorm';
import { McpServer } from '../../mcp-servers/mcp-server.entity';
```
（`ManyToMany`/`JoinTable` 并入已有的 `typeorm` import 列表。）
- `McpServerConfig` interface 加注释标记废弃（保留，供 `legacyMcpServers` 类型用）：
```typescript
/** @deprecated 旧 JSON 内联配置，已迁移到 mcp_servers 表；仅 legacyMcpServers 字段使用 */
export interface McpServerConfig {
```
- `mcpServers` 字段替换为：
```typescript
  /**
   * @deprecated 旧 JSON 内联 MCP 配置，已迁移到 mcp_servers + agent_config_mcp_servers。
   * 保留列待数据迁移完成后删除；代码不再读写。
   */
  @Column({ name: 'mcp_servers', type: 'json', nullable: true })
  legacyMcpServers: McpServerConfig[] | null;

  /** 关联的全局 MCP Server（agent_config_mcp_servers 关联表） */
  @ManyToMany(() => McpServer)
  @JoinTable({
    name: 'agent_config_mcp_servers',
    joinColumn: { name: 'agent_config_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mcp_server_id', referencedColumnName: 'id' },
  })
  mcpServers: McpServer[];
```

**3b. 修改 `src/mcp-servers/mcp-servers.service.ts`：** 在 `toRuntimeConfig` 方法后追加：

```typescript
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
   * Agent 关联前校验：全部存在且启用中；stdio 类型仅 admin 可关联。
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
    return servers;
  }

  private findEntitiesByAgentConfig(agentConfigId: string): Promise<McpServer[]> {
    return this.mcpServerRepo
      .createQueryBuilder('m')
      .innerJoin('agent_config_mcp_servers', 'j', 'j.mcp_server_id = m.id')
      .where('j.agent_config_id = :agentConfigId', { agentConfigId })
      .getMany();
  }
```

并把 `import { Repository } from 'typeorm';` 改为 `import { In, Repository } from 'typeorm';`。

**3c. 修改 `src/agents/agent-executor.service.ts`：**

- import 区加：
```typescript
import { McpServersService } from '../mcp-servers/mcp-servers.service';
```
- constructor 末尾追加参数：
```typescript
    private readonly mcpServersService: McpServersService,
```
- `run` 与 `runStream` 中 `const tools = await this.toolRegistry.getToolsForAgent(agentConfig);` 均替换为：
```typescript
    const tools = await this.getAllTools(agentConfig);
```
- 类中追加私有方法：
```typescript
  /** 汇总内置工具 + 全局 MCP Server 工具（从 mcp_servers 表加载并解密后建连） */
  private async getAllTools(config: AgentConfig): Promise<StructuredToolInterface[]> {
    const mcpServers = await this.mcpServersService.findByAgentConfig(config.id);
    return this.toolRegistry.getToolsForAgent(config, mcpServers);
  }
```

**3d. 修改 `src/agents/agents.module.ts`：** imports 数组加 `McpServersModule`，并加 import：

```typescript
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
```

**3e. 修改 `test/agents/agent-executor.service.spec.ts`：**

- import 区加：
```typescript
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
```
- describe 内 `toolRegistry` 声明后加：
```typescript
  let mcpServersService: { findByAgentConfig: jest.Mock };
```
- beforeEach 中 `toolRegistry = {...}` 后加：
```typescript
    mcpServersService = { findByAgentConfig: jest.fn().mockResolvedValue([]) };
```
- providers 数组中 `{ provide: ToolRegistryService, useValue: toolRegistry },` 后加：
```typescript
        { provide: McpServersService, useValue: mcpServersService },
```
- `buildAgent` 中删除 `mcpServers: [],` 一行（字段已改名 `legacyMcpServers`，mock 不需要）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test -- mcp-servers.service agent-executor.service`
Expected: PASS

- [ ] **Step 5: typecheck + lint + commit**

```bash
pnpm typecheck && pnpm lint
git add src/agents src/mcp-servers test/agents test/mcp-servers
git commit -m "feat(agents): AgentConfig 关联全局 MCP Server，执行时按关联加载工具"
```

---

### Task 5: Agent 关联端点 + DTO 清理

**Files:**
- Create: `src/agents/dto/update-agent-mcp-servers.dto.ts`
- Modify: `src/agents/agents.service.ts`
- Modify: `src/agents/agents.controller.ts`
- Modify: `src/agents/dto/create-agent.dto.ts`（删除 `McpServerDto` 与 `mcpServers` 字段）
- Modify: `src/agents/dto/agent-response.dto.ts`（删除 `mcpServers` 字段）
- Test: `test/agents/agents.service.spec.ts`

**Interfaces:**
- Consumes: Task 4 的 `findViewsByAgentConfig` / `validateForAssociation` / `toView`。
- Produces:
  - `AgentsService.getMcpServers(userId: string, agentId: string): Promise<McpServerView[]>`
  - `AgentsService.updateMcpServers(user: CurrentUser, agentId: string, mcpServerIds: string[]): Promise<McpServerView[]>`
  - 路由 `GET /api/agents/:id/mcp-servers`、`PUT /api/agents/:id/mcp-servers`。

- [ ] **Step 1: 改写失败测试**

全量替换 `test/agents/agents.service.spec.ts`：

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { AgentsService } from 'src/agents/agents.service';
import { AgentConfig, ProviderType } from 'src/agents/entities/agent-config.entity';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { McpServer, McpServerType } from 'src/mcp-servers/mcp-server.entity';
import { AGENT_ENCRYPTION_KEY } from 'src/agents/utils/encryption-key.provider';
import { decrypt, encrypt } from 'src/agents/utils/crypto.util';
import { UserRole } from 'src/users/users.entity';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const API_KEY = 'sk-ant-api03-abcdefg123456';

describe('AgentsService', () => {
  let service: AgentsService;
  let repo: jest.Mocked<Repository<AgentConfig>>;
  let mcpServersService: Record<string, jest.Mock>;

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
    provider: ProviderType.ANTHROPIC,
    model: 'claude-opus-4-8',
    apiKeyEncrypted: encrypt(API_KEY, TEST_KEY),
    systemPrompt: '你是客服',
    maxTokens: 4096,
    maxIterations: 10,
    enabledTools: ['web_search'],
    legacyMcpServers: null,
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
      expect(result.apiKeyMasked).toBe('****3456');
      expect(result).not.toHaveProperty('apiKeyEncrypted');
      expect(result).not.toHaveProperty('userId');
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

      expect(result).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
      expect(result.items[0].apiKeyMasked).toBe('****3456');
    });
  });

  describe('findOne', () => {
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
  });

  describe('remove', () => {
    it('应该是软删除（isActive = false）', async () => {
      repo.findOne.mockResolvedValue({ ...baseAgent });

      await service.remove('user-1', 'agent-1');

      const saved = repo.save.mock.calls[0][0] as AgentConfig;
      expect(saved.isActive).toBe(false);
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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test -- agents.service`
Expected: FAIL（`getMcpServers`/`updateMcpServers` 不存在，缺 `McpServersService` provider）

- [ ] **Step 3: 实现**

**3a. 创建 `src/agents/dto/update-agent-mcp-servers.dto.ts`：**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class UpdateAgentMcpServersDto {
  @ApiProperty({
    type: [String],
    example: ['b3b7c6e2-....'],
    description: '关联的 MCP Server ID 列表（整体替换，传空数组清空）',
  })
  @IsArray()
  @IsUUID('4', { each: true })
  mcpServerIds: string[];
}
```

**3b. 修改 `src/agents/agents.service.ts`：**

- import 区加：
```typescript
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpServerView } from '../mcp-servers/mcp-server.entity';
```
并删除 `User, UserRole` 中的 `UserRole`（不再用），保留 `User`。
- constructor 加参数（在 encryptionKey 之后）：
```typescript
    private readonly mcpServersService: McpServersService,
```
- `create` 方法：删除 `this.assertStdioPermission(user, dto.mcpServers);` 一行；`this.agentRepo.create({...})` 中删除 `mcpServers: dto.mcpServers ?? [],` 一行。
- `update` 方法：删除 `this.assertStdioPermission(user, dto.mcpServers);` 一行。
- 删除整个 `assertStdioPermission` 私有方法。
- `toResponse` 中删除 `mcpServers: agent.mcpServers ?? [],` 一行。
- 类中追加两个方法（放在 `remove` 之后）：

```typescript
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
```

**3c. 修改 `src/agents/agents.controller.ts`：**

- import 区 `Put` 加入 `@nestjs/common` import 列表；加：
```typescript
import { UpdateAgentMcpServersDto } from './dto/update-agent-mcp-servers.dto';
```
- 类末尾追加：

```typescript
  @Get(':id/mcp-servers')
  @ApiOperation({ summary: 'Agent 已关联的 MCP Server 列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  @ApiResponse({ status: 404, description: 'Agent 不存在' })
  async getMcpServers(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.agentsService.getMcpServers(user.id, id);
  }

  @Put(':id/mcp-servers')
  @ApiOperation({
    summary: '整体替换 Agent 关联的 MCP Server',
    description: 'stdio 类型仅管理员可关联；传空数组清空关联',
  })
  @ApiResponse({ status: 200, description: '更新成功' })
  @ApiResponse({ status: 403, description: '非管理员关联 stdio 类型' })
  @ApiResponse({ status: 404, description: 'Agent 或 MCP Server 不存在' })
  async updateMcpServers(
    @CurrentUser() user: Omit<User, 'password'>,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentMcpServersDto,
  ) {
    return this.agentsService.updateMcpServers(user, id, dto.mcpServerIds);
  }
```

- 同时把类上 `@ApiOperation` 里关于「stdio 类型的 MCP Server 仅管理员可配置」的描述从 `create`/`update` 路由的 `@ApiOperation`/`@ApiResponse({ status: 403 ... })` 中删除（那两个 403 response 声明一并删掉，create/update 不再涉及 MCP）。

**3d. 修改 `src/agents/dto/create-agent.dto.ts`：** 删除整个 `McpServerDto` 类、`CreateAgentDto.mcpServers` 字段，以及不再使用的 import（`IsUrl`、`ValidateIf`、`ValidateNested`；`Type` 仍被 maxTokens/maxIterations 使用，保留）。

**3e. 修改 `src/agents/dto/agent-response.dto.ts`：** 删除 `mcpServers` 字段及 `McpServerConfig` import（`ProviderType` 保留）。

- [ ] **Step 4: 跑全部测试**

Run: `pnpm test`
Expected: PASS（若有其它 spec 仍引用旧 `mcpServers` 字段——如 `conversations.service.spec.ts`——按编译/测试报错逐处删除该字段引用；mock 对象用 `as AgentConfig` 强转的不受影响）

- [ ] **Step 5: typecheck + lint + 全量回归 + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add src/agents test/agents
git commit -m "feat(agents): 新增 Agent 关联 MCP Server 端点，移除旧 JSON 内联配置"
```

- [ ] **Step 6: 重启 dev server 验证表结构**

```bash
pnpm start:dev
```

用 Adminer（http://localhost:8080）确认：`mcp_servers` 表已建（含 `env`/`headers` text 列、`created_by` 外键）、`agent_config_mcp_servers` 关联表已建（复合主键 + 双外键 CASCADE）。确认后停掉 dev server。

---

## 自审记录

- **Spec coverage**：实体/关联表（Task 1、4）、CRUD API（Task 1、2）、权限矩阵（Task 1 service 校验 + Task 5 关联校验）、执行加载变更（Task 3、4）、Agent 选配端点（Task 5）、字段废弃（Task 4、5）。设计中的「数据迁移」为上线前手工步骤，不属于代码任务，已在设计文档第八节描述，本计划不重复。
- **已知偏差（有意）**：`QueryMcpServerDto` 保留 `type` 筛选（设计列出了该文件但未定义字段，取最小有用实现）。
