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
    it('重命名并返回视图', async () => {
      repo.findOne.mockResolvedValue({ ...project });
      const result = await service.rename(user as never, 'proj-1', '改名了');
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ name: '改名了' }));
      expect(result.name).toBe('改名了');
    });
  });
});
