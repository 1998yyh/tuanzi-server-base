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
import { decrypt } from 'src/common/utils/crypto.util';
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
            find: jest.fn(),
            findAndCount: jest.fn(),
            remove: jest.fn(async (v) => v),
            createQueryBuilder: jest.fn(),
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
        service.create(normalUser, {
          name: 'web-search',
          type: McpServerType.SSE,
          url: 'https://a.com/sse',
        }),
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

      await expect(
        service.update(adminUser, 'srv-1', { type: McpServerType.STDIO }),
      ).rejects.toThrow(BadRequestException);
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
        const { encrypt } = jest.requireActual(
          'src/common/utils/crypto.util',
        ) as typeof import('src/common/utils/crypto.util');
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

  describe('findByAgentConfig', () => {
    it('应通过关联表查询，过滤停用 server，并解密 env', async () => {
      const { encrypt } = jest.requireActual(
        'src/common/utils/crypto.util',
      ) as typeof import('src/common/utils/crypto.util');
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
});
