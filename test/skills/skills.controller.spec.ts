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
