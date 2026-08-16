import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CanvasToolsService } from 'src/agents/tools/canvas/canvas-tools.service';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { CanvasService } from 'src/canvas/canvas.service';
import { CanvasOpsService } from 'src/canvas/canvas-ops.service';
import { GenerationService } from 'src/ai-generation/generation.service';
import { PromptsService } from 'src/prompts/prompts.service';
import { AssetsService } from 'src/assets/assets.service';
import { CanvasDocument } from 'src/canvas/canvas.types';
import { CanvasAgentOp } from 'src/canvas/lib/canvas-ops';

const DOCUMENT: CanvasDocument = {
  nodes: [
    {
      id: 'text-1',
      type: 'text',
      title: '提示词',
      position: { x: 0, y: 0 },
      width: 340,
      height: 240,
      metadata: { content: '一只猫', status: 'success' },
    },
    {
      id: 'config-1',
      type: 'config',
      title: '图片生成',
      position: { x: 420, y: 0 },
      width: 340,
      height: 240,
      metadata: { generationMode: 'image', model: 'ch-1::gpt-image-2', status: 'idle' },
    },
  ],
  connections: [{ id: 'c-1', fromNodeId: 'text-1', toNodeId: 'config-1' }],
};

describe('CanvasToolsService', () => {
  let service: CanvasToolsService;
  let agentRepo: { findOne: jest.Mock };
  let toolRegistry: { registerAgentScopedTool: jest.Mock };
  let canvasService: { findAll: jest.Mock; findOwned: jest.Mock };
  let canvasOpsService: {
    validateOps: jest.Mock;
    applyOps: jest.Mock;
    patchNodeMetadata: jest.Mock;
  };
  let generationService: {
    generateImage: jest.Mock;
    generateVideo: jest.Mock;
    generateAudio: jest.Mock;
  };
  let registeredTools: Map<
    string,
    (agentConfigId: string) => { invoke: (args: unknown) => Promise<string> }
  >;

  const project = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    userId: 'user-1',
    name: '画布',
    version: 3,
    document: DOCUMENT,
  };

  beforeEach(async () => {
    registeredTools = new Map();
    agentRepo = { findOne: jest.fn(async () => ({ id: 'agent-1', userId: 'user-1' })) };
    toolRegistry = {
      registerAgentScopedTool: jest.fn((name, factory) => registeredTools.set(name, factory)),
    };
    canvasService = {
      findAll: jest.fn(async () => ({ items: [], total: 0 })),
      findOwned: jest.fn(async () => project),
    };
    canvasOpsService = {
      validateOps: jest.fn((ops) => ops),
      applyOps: jest.fn(async (_id: string, ops: CanvasAgentOp[]) => ({
        document: DOCUMENT,
        version: 4,
        summary: '新建节点 1',
        generationRequests: ops
          .filter((op) => op.type === 'run_generation')
          .map((op) => ({ nodeId: (op as { nodeId: string }).nodeId })),
        touchedNodeIds: [],
      })),
      patchNodeMetadata: jest.fn(async () => ({ version: 5 })),
    };
    generationService = {
      generateImage: jest.fn(async () => ({
        task: { id: 'task-1' },
        media: [
          {
            id: 'media-1',
            url: '/uploads/media/x.png',
            fileName: 'x.png',
            mimeType: 'image/png',
            bytes: 100,
            width: 1024,
            height: 1024,
          },
        ],
      })),
      generateVideo: jest.fn(async () => ({ task: { id: 'task-v1' } })),
      generateAudio: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanvasToolsService,
        { provide: getRepositoryToken(AgentConfig), useValue: agentRepo },
        { provide: ToolRegistryService, useValue: toolRegistry },
        { provide: CanvasService, useValue: canvasService },
        { provide: CanvasOpsService, useValue: canvasOpsService },
        { provide: GenerationService, useValue: generationService },
        { provide: PromptsService, useValue: {} },
        { provide: AssetsService, useValue: {} },
      ],
    }).compile();
    service = module.get(CanvasToolsService);
    service.onModuleInit();
  });

  async function invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const factory = registeredTools.get(name);
    expect(factory).toBeDefined();
    const tool = factory!('agent-1');
    return JSON.parse(await tool.invoke(args));
  }

  it('注册全部 19 个 Agent 作用域工具', () => {
    expect(registeredTools.size).toBe(19);
    expect(registeredTools.has('canvas_run_generation')).toBe(true);
    expect(registeredTools.has('assets_add')).toBe(true);
  });

  it('canvas_create_text_nodes：编译为批量 add_node 并应用', async () => {
    const result = await invoke('canvas_create_text_nodes', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      items: [{ text: '标题' }, { text: '正文' }],
    });
    expect(result.success).toBe(true);
    const ops = canvasOpsService.applyOps.mock.calls[0][1] as CanvasAgentOp[];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: 'add_node', nodeType: 'text' });
  });

  it('canvas_create_image_prompt_flow autoRun：流程 ops + run_generation 被消费', async () => {
    const result = await invoke('canvas_create_image_prompt_flow', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      prompt: '一只猫',
      autoRun: true,
    });
    expect(result.success).toBe(true);
    const ops = canvasOpsService.applyOps.mock.calls[0][1] as CanvasAgentOp[];
    // 文本节点 + 配置节点 + 连线 + run_generation
    expect(ops.map((op) => op.type)).toEqual([
      'add_node',
      'add_node',
      'connect_nodes',
      'run_generation',
    ]);
    // autoRun 的 run_generation 指向新建 config 节点；该节点无 model → 返回可重试错误而不是抛异常
    expect(result.generations).toHaveLength(1);
    expect((result.generations as Record<string, unknown>[])[0].success).toBe(false);
  });

  it('canvas_run_generation：收集连入文本节点提示词，生成图片并回填结果节点', async () => {
    const result = await invoke('canvas_run_generation', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      nodeId: 'config-1',
    });
    expect(result.success).toBe(true);
    // 提示词 = 连入文本节点内容「一只猫」
    expect(generationService.generateImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelRef: 'ch-1::gpt-image-2', prompt: '一只猫' }),
    );
    // 结果节点 ops：add_node + connect_nodes
    const resultOps = canvasOpsService.applyOps.mock.calls.at(-1)![1] as CanvasAgentOp[];
    expect(resultOps.map((op) => op.type)).toEqual(['add_node', 'connect_nodes']);
    expect(resultOps[0]).toMatchObject({
      type: 'add_node',
      nodeType: 'image',
      metadata: expect.objectContaining({ content: '/uploads/media/x.png', mediaId: 'media-1' }),
    });
  });

  it('canvas_run_generation 视频：先建 pending 节点 + nodeRef 创建任务 + 回填 taskId', async () => {
    canvasService.findOwned.mockResolvedValue({
      ...project,
      document: {
        ...DOCUMENT,
        nodes: DOCUMENT.nodes.map((n) =>
          n.id === 'config-1' ? { ...n, metadata: { ...n.metadata, generationMode: 'video' } } : n,
        ),
      },
    });
    const result = await invoke('canvas_run_generation', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      nodeId: 'config-1',
    });
    expect(result).toMatchObject({
      success: true,
      mode: 'video',
      taskId: 'task-v1',
      status: 'processing',
    });
    expect(generationService.generateVideo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nodeRef: {
          projectId: '123e4567-e89b-42d3-a456-426614174000',
          nodeId: expect.stringMatching(/^video-/),
        },
      }),
    );
    expect(canvasOpsService.patchNodeMetadata).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000',
      expect.stringMatching(/^video-/),
      { taskId: 'task-v1' },
    );
  });

  it('配置节点无 model：返回中文可重试错误', async () => {
    canvasService.findOwned.mockResolvedValue({
      ...project,
      document: {
        ...DOCUMENT,
        nodes: DOCUMENT.nodes.map((n) =>
          n.id === 'config-1' ? { ...n, metadata: { generationMode: 'image' } } : n,
        ),
      },
    });
    const result = await invoke('canvas_run_generation', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
      nodeId: 'config-1',
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('未选择模型');
    expect(generationService.generateImage).not.toHaveBeenCalled();
  });

  it('他人画布：归属校验拦截', async () => {
    canvasService.findOwned.mockRejectedValue(new Error('画布不存在或无权限'));
    const result = await invoke('canvas_get_state', {
      projectId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('无权限');
  });
});
