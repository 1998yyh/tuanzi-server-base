import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PromptsService } from 'src/prompts/prompts.service';
import { UserRole } from 'src/users/users.entity';
import { runPromptSource } from 'src/prompts/lib/prompt-normalize';

jest.mock('src/prompts/lib/prompt-normalize', () => ({ runPromptSource: jest.fn() }));
const admin = { id: 'admin', role: UserRole.ADMIN } as never;
const user = { id: 'user', role: UserRole.USER } as never;
const source = {
  id: 'source',
  userId: null,
  name: '测试源',
  homepage: 'https://example.com',
  isBuiltin: true,
  isActive: true,
};
const raw = {
  id: 'upstream-1',
  title: '海报',
  prompt: '画一张海报',
  tags: ['海报'],
  description: '',
  coverUrl: '',
  referenceImageUrls: [],
  preview: '',
};

describe('内部提示词库', () => {
  let service: any;
  let rows: any[];
  let sourceRepo: any;
  let itemRepo: any;
  beforeEach(() => {
    rows = [];
    sourceRepo = {
      find: jest.fn(async () => [source]),
      findOne: jest.fn(async () => source),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
    };
    itemRepo = {
      create: jest.fn((v) => ({
        id: `local-${rows.length}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ...v,
      })),
      save: jest.fn(async (v) => {
        const i = rows.findIndex((r) => r.id === v.id);
        if (i < 0) rows.push({ ...v });
        else rows[i] = { ...v };
        return v;
      }),
      findOne: jest.fn(
        async ({ where, withDeleted }) =>
          rows.find(
            (r) =>
              Object.entries(where).every(([k, v]) => r[k] === v) && (withDeleted || !r.deletedAt),
          ) ?? null,
      ),
      update: jest.fn(async ({ id }, changes) => {
        const index = rows.findIndex((r) => r.id === id && !r.deletedAt);
        if (index < 0) return { affected: 0 };
        rows[index] = { ...rows[index], ...changes };
        return { affected: 1 };
      }),
      exists: jest.fn(async ({ where }) =>
        rows.some((r) => r.userId === null && r.maintainerId === where.maintainerId),
      ),
      count: jest.fn(async () => rows.filter((r) => !r.deletedAt).length),
      softDelete: jest.fn(async ({ id }) => {
        const r = rows.find((r) => r.id === id);
        if (r) r.deletedAt = new Date();
        return { affected: r ? 1 : 0 };
      }),
    };
    service = Reflect.construct(PromptsService, [sourceRepo, itemRepo]);
    jest
      .mocked(runPromptSource)
      .mockReset()
      .mockResolvedValue([raw] as never);
  });

  it('读取列表只查询数据库，不拉取远程源', async () => {
    const qb: any = {};
    for (const name of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
      'select',
      'distinct',
    ])
      qb[name] = jest.fn(() => qb);
    qb.clone = jest.fn(() => qb);
    qb.getManyAndCount = jest.fn(async () => [[], 0]);
    qb.getRawMany = jest.fn(async () => []);
    qb.getMany = jest.fn(async () => []);
    itemRepo.createQueryBuilder = jest.fn(() => qb);
    const result = await service.fetchPrompts(user, { page: 1, pageSize: 20 });
    expect(result.total).toBe(0);
    expect(itemRepo.createQueryBuilder).toHaveBeenCalled();
    expect(runPromptSource).not.toHaveBeenCalled();
  });

  it('导入后保存本地编号、分类与原始来源', async () => {
    await service.refreshSource(admin, source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '海报',
      category: '海报广告',
      sourceId: source.id,
      userId: null,
    });
    expect(rows[0].id).not.toBe(raw.id);
    expect(rows[0].importKey).toHaveLength(64);
  });

  it('重新导入不会覆盖编辑，也不会让已删除内容重新出现', async () => {
    await service.refreshSource(admin, source.id);
    await service.updatePrompt(admin, rows[0].id, { title: '我改的标题', category: '我的分类' });
    await service.refreshSource(admin, source.id);
    expect(rows[0].title).toBe('我改的标题');
    expect(rows[0].category).toBe('我的分类');
    await service.removePrompt(admin, rows[0].id);
    await service.refreshSource(admin, source.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });

  it('普通用户不能修改、删除或导入公共库', async () => {
    await service.refreshSource(admin, source.id);
    await expect(service.updatePrompt(user, rows[0].id, { title: '恶意修改' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.removePrompt(user, rows[0].id)).rejects.toThrow(ForbiddenException);
    await expect(service.refreshSource(user, source.id)).rejects.toThrow(ForbiddenException);
    await expect(service.createPrompt(user, { title: '新增', prompt: '正文' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(rows[0].title).toBe('海报');
  });

  it('自建源内容保持私有且仅本人可维护', async () => {
    sourceRepo.findOne.mockResolvedValue({ ...source, userId: 'user', isBuiltin: false });
    await service.refreshSource(user, source.id);
    expect(rows[0].userId).toBe('user');
    await service.updatePrompt(user, rows[0].id, { prompt: '新内容' });
    expect(rows[0].prompt).toBe('新内容');
    await expect(service.updatePrompt(admin, rows[0].id, { title: '越权' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('新增后可编辑保存，删除后无法再编辑', async () => {
    const created = await service.createPrompt(admin, {
      title: '自建标题',
      prompt: '自建正文',
      category: '自定义',
      tags: [' 标签 ', '标签'],
    });
    expect(created).toMatchObject({ title: '自建标题', category: '自定义', tags: ['标签'] });
    const saved = await service.updatePrompt(admin, created.id, { prompt: '更新正文', tags: [] });
    expect(saved).toMatchObject({ prompt: '更新正文', tags: [] });
    await service.removePrompt(admin, created.id);
    await expect(service.updatePrompt(admin, created.id, { prompt: '复活' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('源抓取失败如实返回失败且不会清空已导入内容', async () => {
    await service.refreshSource(admin, source.id);
    jest.mocked(runPromptSource).mockRejectedValue(new Error('抓取失败'));
    const result = await service.refreshAllSources(admin);
    expect(result.failureCount).toBe(1);
    expect(rows).toHaveLength(1);
  });
  it('编辑和删除并发时不恢复已删除记录', async () => {
    await service.refreshSource(admin, source.id);
    itemRepo.findOne.mockImplementationOnce(async () => {
      const loaded = { ...rows[0] };
      rows[0].deletedAt = new Date();
      return loaded;
    });
    await expect(service.updatePrompt(admin, rows[0].id, { title: '迟到的编辑' })).rejects.toThrow(
      NotFoundException,
    );
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });
  it('导入工具可指定现有普通账号维护公共库，不提升全站角色', async () => {
    await service.importBuiltinSnapshot(user, source.id, [raw]);
    expect(rows[0].maintainerId).toBe('user');
    expect(rows[0].userId).toBeNull();
    const edited = await service.updatePrompt(user, rows[0].id, { title: '维护者编辑' });
    expect(edited.canEdit).toBe(true);
  });
});
