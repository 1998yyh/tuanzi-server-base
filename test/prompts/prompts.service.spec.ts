import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PromptsService } from 'src/prompts/prompts.service';
import { PromptSource } from 'src/prompts/prompt-source.entity';

const user = { id: 'user-1' } as never;

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

const RAW_ITEMS = [
  {
    id: 'p1',
    title: '猫咪肖像',
    prompt: '一只猫的肖像，柔光',
    coverUrl: 'covers/cat.png',
    tags: ['动物', '肖像'],
  },
  {
    id: 'p1', // 重复 id 应被去重
    title: '重复项',
    prompt: 'dup',
  },
  {
    title: '无 id 项',
    prompt: '自动生成 id',
    referenceImageUrls: ['refs/a.png'],
  },
];

const mockFetch = jest.fn();
global.fetch = mockFetch as never;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('PromptsService', () => {
  let service: PromptsService;
  let sourceRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    mockFetch.mockReset();
    sourceRepo = {
      find: jest.fn(async () => [builtinSource()]),
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      remove: jest.fn(async () => undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptsService,
        { provide: getRepositoryToken(PromptSource), useValue: sourceRepo },
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

  describe('fetchPrompts（缓存 + 归一化 + 过滤分页）', () => {
    it('抓取源并归一化：去重、相对 URL 转绝对、自动编号 id', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RAW_ITEMS));
      const result = await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      expect(result.total).toBe(2);
      const [first, second] = result.items;
      expect(first.id).toBe('p1');
      expect(first.coverUrl).toBe('https://cdn.example.com/sources/covers/cat.png');
      expect(first.category).toBe('Builtin');
      expect(second.id).toBe('src-builtin-0003');
      expect(second.referenceImageUrls[0]).toBe('https://cdn.example.com/sources/refs/a.png');
      // coverUrl 缺省时回退到第一张参考图
      expect(second.coverUrl).toBe('https://cdn.example.com/sources/refs/a.png');
      expect(result.tags).toEqual(['动物', '肖像']);
      expect(result.categories).toEqual(['Builtin']);
    });

    it('1h 内命中缓存不重复抓取', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RAW_ITEMS));
      await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('关键词过滤标题/内容/标签', async () => {
      mockFetch.mockResolvedValue(jsonResponse(RAW_ITEMS));
      const hit = await service.fetchPrompts(user, {
        keyword: '肖像',
        page: 1,
        pageSize: 20,
      } as never);
      expect(hit.total).toBe(1);
      expect(hit.items[0].id).toBe('p1');
      const miss = await service.fetchPrompts(user, {
        keyword: '不存在',
        page: 1,
        pageSize: 20,
      } as never);
      expect(miss.total).toBe(0);
    });

    it('源抓取失败且无缓存时返回空列表（不抛错）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 500));
      const result = await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      expect(result.total).toBe(0);
      const statuses = await service.fetchSourceStatuses(user);
      expect(statuses['src-builtin'].lastError).toContain('Builtin');
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
});
