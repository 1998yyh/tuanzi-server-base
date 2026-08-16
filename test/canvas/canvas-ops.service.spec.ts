import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CanvasOpsService } from 'src/canvas/canvas-ops.service';
import { CanvasDocumentService } from 'src/canvas/canvas-document.service';
import { CanvasDocument } from 'src/canvas/canvas.types';

describe('CanvasOpsService', () => {
  let service: CanvasOpsService;
  let documentService: { applyMutation: jest.Mock };

  const baseDocument: CanvasDocument = {
    nodes: [
      { id: 'n1', type: 'text', title: '文本', position: { x: 0, y: 0 }, width: 340, height: 240 },
    ],
    connections: [],
  };

  beforeEach(async () => {
    documentService = {
      applyMutation: jest.fn(
        async (_id: string, _version: number | null, mutator: (doc: CanvasDocument) => unknown) => {
          const { document, result } = mutator(baseDocument) as {
            document: CanvasDocument;
            result: unknown;
          };
          return { document, version: 2, result };
        },
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CanvasOpsService, { provide: CanvasDocumentService, useValue: documentService }],
    }).compile();
    service = module.get(CanvasOpsService);
    jest.clearAllMocks();
  });

  describe('validateOps', () => {
    it('合法 ops 通过', () => {
      const ops = service.validateOps([{ type: 'add_node', nodeType: 'text' }]);
      expect(ops).toHaveLength(1);
    });

    it('非法 ops 抛 BadRequestException（中文）', () => {
      expect(() => service.validateOps([{ type: 'hack_everything' }])).toThrow(BadRequestException);
      expect(() => service.validateOps([])).toThrow(BadRequestException);
      expect(() => service.validateOps('not-an-array')).toThrow(BadRequestException);
    });

    it('connect_nodes 缺少 fromNodeId 时报错', () => {
      expect(() => service.validateOps([{ type: 'connect_nodes', toNodeId: 'b' }])).toThrow(
        BadRequestException,
      );
    });
  });

  describe('applyOps', () => {
    it('应用 ops 并返回摘要与收集到的生成请求', async () => {
      const result = await service.applyOps('proj-1', [
        { type: 'add_node', nodeType: 'config', x: 10, y: 10 },
        { type: 'run_generation', nodeId: 'n1', mode: 'image' },
      ]);
      expect(result.version).toBe(2);
      expect(result.document.nodes).toHaveLength(2);
      expect(result.summary).toBe('新建节点 1，触发生成 1');
      expect(result.generationRequests).toEqual([
        { nodeId: 'n1', mode: 'image', prompt: undefined },
      ]);
      // 透传 baseVersion 给乐观锁
      expect(documentService.applyMutation).toHaveBeenCalledWith(
        'proj-1',
        null,
        expect.any(Function),
      );
    });

    it('baseVersion 透传', async () => {
      await service.applyOps('proj-1', [{ type: 'add_node' }], 5);
      expect(documentService.applyMutation).toHaveBeenCalledWith('proj-1', 5, expect.any(Function));
    });

    it('乐观锁冲突向上抛 409', async () => {
      documentService.applyMutation.mockRejectedValue(
        new ConflictException('画布已被其他操作修改，请刷新后重试'),
      );
      await expect(service.applyOps('proj-1', [{ type: 'add_node' }])).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('patchNodeMetadata', () => {
    it('基于最新版本 patch 单节点 metadata（不校验版本）', async () => {
      const result = await service.patchNodeMetadata('proj-1', 'n1', {
        status: 'success',
        taskId: 't1',
      });
      expect(result.version).toBe(2);
      expect(documentService.applyMutation).toHaveBeenCalledWith(
        'proj-1',
        null,
        expect.any(Function),
      );
      const mutator = documentService.applyMutation.mock.calls[0][2] as (doc: CanvasDocument) => {
        document: CanvasDocument;
      };
      const mutated = mutator(baseDocument);
      expect(mutated.document.nodes[0].metadata).toMatchObject({ status: 'success', taskId: 't1' });
    });
  });
});
