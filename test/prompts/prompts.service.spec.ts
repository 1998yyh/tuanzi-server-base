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

// runPromptSource 现在先过 assertPublicUrl（会做 DNS 解析），mock 掉避免真实网络
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

// runPromptSource 走流式读取（不再 response.json），mock 响应需带可迭代 body
function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(bytes.length),
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    json: async () => body,
    text: async () => text,
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
    count: jest.Mock;
  };

  beforeEach(async () => {
    mockFetch.mockReset();
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

  describe('失败退避', () => {
    it('抓取失败后进入退避期：再次请求不触发重新抓取（连续失败不再每请求一抓）', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 500));
      const first = await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      expect(first.total).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // 失败刚发生（5 分钟退避期内）：第二次请求命中失败缓存，不再抓
      const second = await service.fetchPrompts(user, { page: 1, pageSize: 20 } as never);
      expect(second.total).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
