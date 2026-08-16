import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CanvasService } from 'src/canvas/canvas.service';
import { CanvasProject } from 'src/canvas/canvas-project.entity';
import { EMPTY_CANVAS_DOCUMENT } from 'src/canvas/canvas.types';

describe('CanvasService', () => {
  let service: CanvasService;
  let repo: jest.Mocked<Repository<CanvasProject>>;

  const user = { id: 'user-1' };
  const project: CanvasProject = {
    id: 'proj-1',
    user: user as never,
    userId: 'user-1',
    name: '我的画布',
    document: EMPTY_CANVAS_DOCUMENT,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanvasService,
        {
          provide: getRepositoryToken(CanvasProject),
          useValue: {
            create: jest.fn((v) => v),
            save: jest.fn(async (v) => v),
            findOne: jest.fn(),
            update: jest.fn(async () => ({ affected: 1 })),
            remove: jest.fn(async (v) => v),
            createQueryBuilder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(CanvasService);
    repo = module.get(getRepositoryToken(CanvasProject));
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('创建空文档画布，version=1', async () => {
      const result = await service.create(user as never, { name: '新画布' });
      const saved = repo.save.mock.calls[0][0] as CanvasProject;
      expect(saved.document).toEqual({ nodes: [], connections: [] });
      expect(saved.version).toBe(1);
      expect(result).not.toHaveProperty('user');
    });
  });

  describe('findOwned', () => {
    it('不存在抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOwned('ghost', 'user-1')).rejects.toThrow('画布 #ghost 不存在');
    });

    it('他人画布同样按不存在处理（不泄露存在性）', async () => {
      repo.findOne.mockResolvedValue({ ...project, userId: 'user-2' });
      await expect(service.findOwned('proj-1', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateDocument', () => {
    const newDoc = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          title: '文本',
          position: { x: 0, y: 0 },
          width: 340,
          height: 240,
        },
      ],
      connections: [],
    };

    it('baseVersion 不一致抛 409', async () => {
      repo.findOne.mockResolvedValue(project);
      await expect(
        service.updateDocument(user as never, 'proj-1', {
          document: newDoc,
          baseVersion: 99,
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('并发写（update 影响 0 行）抛 409', async () => {
      repo.findOne.mockResolvedValue(project);
      repo.update.mockResolvedValue({ affected: 0, raw: {}, generatedMaps: [] });
      await expect(
        service.updateDocument(user as never, 'proj-1', {
          document: newDoc,
          baseVersion: 1,
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('正常保存 version +1', async () => {
      repo.findOne.mockResolvedValue(project);
      const result = await service.updateDocument(user as never, 'proj-1', {
        document: newDoc,
        baseVersion: 1,
      } as never);
      expect(result.version).toBe(2);
      expect(result.document.nodes).toHaveLength(1);
    });
  });

  describe('rename', () => {
    it('只调用 update（不调 save），只更新 name 列，返回改名后的视图', async () => {
      repo.findOne.mockResolvedValue({ ...project });
      const result = await service.rename(user as never, 'proj-1', '改名了');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'proj-1', userId: 'user-1' },
        { name: '改名了' },
      );
      expect(repo.save).not.toHaveBeenCalled();
      expect(result.name).toBe('改名了');
      expect(result.version).toBe(1);
      expect(result.document).toEqual(EMPTY_CANVAS_DOCUMENT);
    });

    it('update 影响 0 行（并发删除）抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue({ ...project });
      repo.update.mockResolvedValue({ affected: 0, raw: {}, generatedMaps: [] });
      await expect(service.rename(user as never, 'proj-1', '改名了')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findVersion', () => {
    it('只 select version 列，返回 { version }', async () => {
      repo.findOne.mockResolvedValue({ version: 3 } as CanvasProject);
      const result = await service.findVersion(user as never, 'proj-1');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'proj-1', userId: 'user-1' },
        select: ['version'],
      });
      expect(result).toEqual({ version: 3 });
    });

    it('不存在（含他人画布）抛 NotFoundException', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findVersion(user as never, 'proj-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('select 排除 document，摘要计数取 SQL 侧 JSON_LENGTH', async () => {
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({
          entities: [
            {
              id: 'proj-1',
              name: '我的画布',
              version: 3,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          raw: [{ nodeCount: 2, connectionCount: 1 }],
        }),
        getCount: jest.fn().mockResolvedValue(1),
      };
      repo.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.findAll(user as never, { page: 1, limit: 20 });

      expect(qb.select).toHaveBeenCalledWith([
        'p.id',
        'p.name',
        'p.version',
        'p.createdAt',
        'p.updatedAt',
      ]);
      expect(qb.addSelect).toHaveBeenCalledWith("JSON_LENGTH(p.document, '$.nodes')", 'nodeCount');
      expect(qb.addSelect).toHaveBeenCalledWith(
        "JSON_LENGTH(p.document, '$.connections')",
        'connectionCount',
      );
      expect(result.items[0]).toMatchObject({
        id: 'proj-1',
        name: '我的画布',
        nodeCount: 2,
        connectionCount: 1,
      });
      expect(result.items[0]).not.toHaveProperty('document');
      expect(result).toMatchObject({ total: 1, page: 1, limit: 20, totalPages: 1 });
    });
  });
});
