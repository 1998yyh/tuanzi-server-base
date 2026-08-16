import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanvasDocumentService } from 'src/canvas/canvas-document.service';
import { CanvasProject } from 'src/canvas/canvas-project.entity';
import { CanvasDocument } from 'src/canvas/canvas.types';

const baseDocument: CanvasDocument = {
  nodes: [
    { id: 'n1', type: 'text', title: '文本', position: { x: 0, y: 0 }, width: 340, height: 240 },
  ],
  connections: [],
};

describe('CanvasDocumentService', () => {
  let service: CanvasDocumentService;
  let repo: jest.Mocked<Repository<CanvasProject>>;

  const project = {
    id: 'proj-1',
    userId: 'user-1',
    document: baseDocument,
    version: 3,
  } as CanvasProject;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanvasDocumentService,
        {
          provide: getRepositoryToken(CanvasProject),
          useValue: {
            findOne: jest.fn(),
            update: jest.fn(async () => ({ affected: 1, raw: {}, generatedMaps: [] })),
          },
        },
      ],
    }).compile();

    service = module.get(CanvasDocumentService);
    repo = module.get(getRepositoryToken(CanvasProject));
    jest.clearAllMocks();
  });

  it('mutator 无变更时跳过 UPDATE，version 与 document 均不变', async () => {
    repo.findOne.mockResolvedValue(project);
    const result = await service.applyMutation('proj-1', null, (doc) => ({
      document: { ...doc },
      result: 'ok',
    }));
    expect(repo.update).not.toHaveBeenCalled();
    expect(result.version).toBe(3);
    expect(result.document).toBe(project.document);
    expect(result.result).toBe('ok');
  });

  it('有变更时执行 UPDATE 并 version +1', async () => {
    repo.findOne.mockResolvedValue(project);
    const result = await service.applyMutation('proj-1', null, (doc) => ({
      document: { ...doc, viewport: { x: 0, y: 0, k: 1 } },
      result: undefined,
    }));
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'proj-1', version: 3 },
      { document: expect.objectContaining({ viewport: { x: 0, y: 0, k: 1 } }), version: 4 },
    );
    expect(result.version).toBe(4);
  });
});
