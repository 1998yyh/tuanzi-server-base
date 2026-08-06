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
