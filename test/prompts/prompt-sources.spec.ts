import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PromptsService } from 'src/prompts/prompts.service';
import { PromptItem } from 'src/prompts/prompt-item.entity';
import { PromptSource } from 'src/prompts/prompt-source.entity';

const user = { id: 'user-1', role: 'admin' } as never;

function builtinSource(overrides: Partial<PromptSource> = {}): PromptSource {
  return {
    id: 'src-builtin',
    userId: null,
    name: 'Builtin',
    url: 'https://cdn.example.com/sources/builtin.json',
    homepage: 'https://example.com',
    isBuiltin: true,
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PromptSource;
}

describe('PromptsService', () => {
  let service: PromptsService;
  let sourceRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    count: jest.Mock;
  };

  beforeEach(async () => {
    sourceRepo = {
      find: jest.fn(async () => [builtinSource()]),
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      remove: jest.fn(async () => undefined),
      count: jest.fn(async () => 0),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptsService,
        { provide: getRepositoryToken(PromptSource), useValue: sourceRepo },
        { provide: getRepositoryToken(PromptItem), useValue: {} },
      ],
    }).compile();
    service = module.get(PromptsService);
  });

  describe('onApplicationBootstrap（内置源种子）', () => {
    it('已有内置源时只插缺失的（按 url 去重）', async () => {
      sourceRepo.find.mockResolvedValue([
        builtinSource({
          url: 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/awesome-gpt-image.json',
        }),
      ]);
      await service.onApplicationBootstrap();
      const inserted = sourceRepo.save.mock.calls[0][0] as { url: string }[];
      expect(inserted).toHaveLength(5);
      expect(inserted.every((s) => s.url !== builtinSource().url)).toBe(true);
    });

    it('全部存在时不插入', async () => {
      // 模拟 6 个内置源全部已存在
      const { DEFAULT_PROMPT_SOURCES } = await import('src/prompts/lib/prompt-presets');
      sourceRepo.find.mockResolvedValue(
        DEFAULT_PROMPT_SOURCES.map((s) => builtinSource({ url: s.url })),
      );
      await service.onApplicationBootstrap();
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('源管理权限', () => {
    it('内置源不能改名/改地址，只能切换启用', async () => {
      sourceRepo.findOne.mockResolvedValue(builtinSource());
      await expect(service.updateSource(user, 'src-builtin', { name: '新名字' })).rejects.toThrow(
        BadRequestException,
      );
      const updated = await service.updateSource(user, 'src-builtin', { isActive: false });
      expect(updated.isActive).toBe(false);
    });

    it('内置源不能改排序（sortOrder 拒绝）', async () => {
      sourceRepo.findOne.mockResolvedValue(builtinSource());
      await expect(service.updateSource(user, 'src-builtin', { sortOrder: 5 })).rejects.toThrow(
        BadRequestException,
      );
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });

    it('内置源不能删除', async () => {
      sourceRepo.findOne.mockResolvedValue(builtinSource());
      await expect(service.removeSource(user, 'src-builtin')).rejects.toThrow(BadRequestException);
    });

    it('他人自建源不可见', async () => {
      sourceRepo.findOne.mockResolvedValue(builtinSource({ userId: 'user-2', isBuiltin: false }));
      await expect(service.updateSource(user, 'src-builtin', { name: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('源不存在时报 404', async () => {
      sourceRepo.findOne.mockResolvedValue(null);
      await expect(service.removeSource(user, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createSource 数量上限', () => {
    it('自建源达到 50 个上限时报错且不落库', async () => {
      sourceRepo.count.mockResolvedValue(50);
      await expect(
        service.createSource(user, { name: 'x', url: 'https://example.com/a.json' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(sourceRepo.save).not.toHaveBeenCalled();
    });

    it('未达上限时可正常创建', async () => {
      sourceRepo.count.mockResolvedValue(49);
      const created = await service.createSource(user, {
        name: 'x',
        url: 'https://example.com/a.json',
      } as never);
      expect(created.name).toBe('x');
      expect(sourceRepo.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    });
  });
});
