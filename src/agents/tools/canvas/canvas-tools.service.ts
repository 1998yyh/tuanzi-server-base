// Adapted from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：canvas-agent/src/canvas/tools.ts（工具注册）+ schemas.ts（toolInputSchemas/toolDescriptions）
// 改造点：浏览器 MCP 工具 → 后端 Agent 作用域工具（registerAgentScopedTool）：
// - 无「当前画布」概念，所有画布工具必传 projectId 并做归属校验
// - 高层工具经 canvas-operations 编译为 ops，统一走 CanvasOpsService 写路径（最新版本应用，不校验 version）
// - run_generation op 由本服务直接消费：调 GenerationService 生成并回填结果节点
// - 裁掉浏览器专属工具（site_navigate/selection/viewport/snapshot/attachment/workbench/*）
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { AgentConfig } from '../../entities/agent-config.entity';
import { ToolRegistryService } from '../tool-registry.service';
import { CanvasService } from '../../../canvas/canvas.service';
import { CanvasOpsService } from '../../../canvas/canvas-ops.service';
import { CanvasDocument, CanvasNodeData } from '../../../canvas/canvas.types';
import { CanvasAgentOp } from '../../../canvas/lib/canvas-ops';
import { GenerationService } from '../../../ai-generation/generation.service';
import { PromptsService } from '../../../prompts/prompts.service';
import { AssetsService } from '../../../assets/assets.service';
import { AssetKind } from '../../../assets/asset.entity';
import { ModelCapability } from '../../../ai-generation/entities/ai-channel.entity';
import { buildCanvasOps, CanvasToolName } from './canvas-operations';

const projectIdSchema = z.string().uuid().describe('目标画布 ID（从 canvas_list_projects 获取）');
const recordSchema = z.record(z.string(), z.unknown());
const generationModeSchema = z.enum(['image', 'video', 'audio']).describe('生成模式');

/** 各画布工具共用的生成参数 */
const generationOptionFields = {
  model: z
    .string()
    .optional()
    .describe('模型引用 "channelId::modelName"（从渠道配置获知；不填则生成时报错）'),
  size: z.string().optional().describe('尺寸/比例，如 1024x1024、16:9'),
  quality: z.string().optional().describe('图片质量：low/medium/high'),
  count: z.number().int().min(1).max(4).optional().describe('图片张数'),
  seconds: z.string().optional().describe('视频时长（秒）'),
  vquality: z.string().optional().describe('视频清晰度：480p/720p/1080p'),
  generateAudio: z.string().optional().describe('视频是否生成配音："true"/"false"'),
  watermark: z.string().optional().describe('视频是否加水印："true"/"false"'),
  audioVoice: z.string().optional().describe('音频音色'),
  audioFormat: z.string().optional().describe('音频格式：mp3/wav/opus/aac/flac/pcm'),
  audioSpeed: z.string().optional().describe('语速（0.25-4）'),
  audioInstructions: z.string().optional().describe('音频附加指令'),
};

/**
 * 画布 Agent 工具集：把 infinite-canvas 的画布操作词汇嫁接到后端。
 * 所有写操作经 ops 编译 → CanvasOpsService（乐观锁单一写路径）；
 * func 闭包捕获 agentConfigId，执行时解析出 userId 做归属校验。
 */
@Injectable()
export class CanvasToolsService implements OnModuleInit {
  private readonly logger = new Logger(CanvasToolsService.name);

  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentRepo: Repository<AgentConfig>,
    private readonly toolRegistry: ToolRegistryService,
    private readonly canvasService: CanvasService,
    private readonly canvasOpsService: CanvasOpsService,
    private readonly generationService: GenerationService,
    private readonly promptsService: PromptsService,
    private readonly assetsService: AssetsService,
  ) {}

  onModuleInit() {
    this.register(
      'canvas_list_projects',
      '列出用户全部画布（标题、节点数、连线数、更新时间），支持 keyword 搜索与分页。返回的 id 用于其他画布工具的 projectId。',
      z.object({
        keyword: z.string().optional().describe('按名称搜索'),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const result = await this.canvasService.findAll(
          { id: userId } as never,
          {
            keyword: args.keyword,
            page: args.page ?? 1,
            limit: args.pageSize ?? 20,
          } as never,
        );
        return JSON.stringify(result);
      },
    );

    this.register(
      'canvas_get_state',
      '读取指定画布的完整状态：节点（含 metadata）、连线、视口与版本号。修改画布前先调用本工具了解现状。',
      z.object({ projectId: projectIdSchema }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const project = await this.canvasService.findOwned(args.projectId, userId);
        return JSON.stringify({
          id: project.id,
          name: project.name,
          version: project.version,
          nodes: project.document.nodes ?? [],
          connections: project.document.connections ?? [],
          viewport: project.document.viewport ?? null,
        });
      },
    );

    this.register(
      'canvas_create_node',
      '创建任意类型节点：text、image、config、video、audio、group。适合创建占位或自定义 metadata 节点。',
      z.object({
        projectId: projectIdSchema,
        nodeType: z.enum(['image', 'text', 'config', 'video', 'audio', 'group']),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        metadata: recordSchema.optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_create_node', args),
    );

    this.register(
      'canvas_create_text_node',
      '在画布创建单个文本节点。',
      z.object({
        projectId: projectIdSchema,
        text: z.string().optional().describe('文本内容'),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_create_text_node', args),
    );

    this.register(
      'canvas_create_text_nodes',
      '批量创建文本节点，适合生成标题、段落、脚本、说明等内容块。',
      z.object({
        projectId: projectIdSchema,
        items: z
          .array(
            z.object({
              text: z.string(),
              title: z.string().optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
            }),
          )
          .min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        gap: z.number().optional(),
        direction: z.enum(['row', 'column']).optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_create_text_nodes', args),
    );

    this.register(
      'canvas_create_config_node',
      '创建生成配置节点，可指定 image/video/audio 模式和生成参数，autoRun=true 时立即触发生成。',
      z.object({
        projectId: projectIdSchema,
        prompt: z.string().optional(),
        mode: generationModeSchema.optional(),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        autoRun: z.boolean().optional().describe('创建后立即触发生成'),
        ...generationOptionFields,
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_create_config_node', args),
    );

    this.register(
      'canvas_create_image_prompt_flow',
      '创建提示词文本节点 + 图片生成配置节点并自动连线；autoRun=true 时立即触发生图。referenceNodeIds 可连入参考图节点。',
      z.object({
        projectId: projectIdSchema,
        prompt: z.string().describe('生成提示词'),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        referenceNodeIds: z.array(z.string()).optional().describe('参考图节点 ID 列表'),
        autoRun: z.boolean().optional(),
        ...generationOptionFields,
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_create_image_prompt_flow', args),
    );

    this.register(
      'canvas_update_node',
      '更新节点基础字段（title/position/width/height）或 metadata。',
      z.object({
        projectId: projectIdSchema,
        id: z.string().describe('节点 ID'),
        patch: recordSchema.optional(),
        metadata: recordSchema.optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_update_node', args),
    );

    this.register(
      'canvas_update_node_text',
      '更新文本节点内容和标题。',
      z.object({
        projectId: projectIdSchema,
        id: z.string().describe('文本节点 ID'),
        text: z.string(),
        title: z.string().optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_update_node_text', args),
    );

    this.register(
      'canvas_move_nodes',
      '移动一个或多个节点，支持绝对坐标（x/y）或偏移（dx/dy）。',
      z.object({
        projectId: projectIdSchema,
        items: z
          .array(
            z.object({
              id: z.string(),
              x: z.number().optional(),
              y: z.number().optional(),
              dx: z.number().optional(),
              dy: z.number().optional(),
            }),
          )
          .min(1),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_move_nodes', args),
    );

    this.register(
      'canvas_resize_node',
      '调整节点尺寸。',
      z.object({
        projectId: projectIdSchema,
        id: z.string(),
        width: z.number().min(40),
        height: z.number().min(40),
        freeResize: z.boolean().optional(),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_resize_node', args),
    );

    this.register(
      'canvas_delete_nodes',
      '删除指定节点及相关连线。',
      z.object({ projectId: projectIdSchema, ids: z.array(z.string()).min(1) }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_delete_nodes', args),
    );

    this.register(
      'canvas_connect_nodes',
      '批量连接节点（from → to）。文本/媒体节点连入 config 节点即作为提示词/参考素材。',
      z.object({
        projectId: projectIdSchema,
        connections: z.array(z.object({ fromNodeId: z.string(), toNodeId: z.string() })).min(1),
      }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_connect_nodes', args),
    );

    this.register(
      'canvas_apply_ops',
      '批量画布操作。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、run_generation。复杂批量改动用本工具一次提交。',
      z.object({ projectId: projectIdSchema, ops: z.array(recordSchema).min(1) }),
      (agentConfigId, args) =>
        this.runOpsTool(agentConfigId, args.projectId, 'canvas_apply_ops', args),
    );

    this.register(
      'canvas_run_generation',
      '触发指定配置节点生成（图片/视频/音频）。提示词取节点 prompt + 连入的文本节点内容；参考素材取连入的媒体节点。视频为异步任务，返回 taskId 后用 generation_get_status 查询。',
      z.object({
        projectId: projectIdSchema,
        nodeId: z.string().describe('配置节点 ID'),
        mode: generationModeSchema.optional(),
        prompt: z.string().optional().describe('覆盖提示词（不填用节点配置）'),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const project = await this.canvasService.findOwned(args.projectId, userId);
        const result = await this.executeGeneration(userId, args.projectId, project.document, {
          nodeId: args.nodeId,
          mode: args.mode,
          prompt: args.prompt,
        });
        return JSON.stringify(result);
      },
    );

    this.register(
      'generation_get_status',
      '查询生成任务状态。传 taskId 查单个任务；否则返回最近的任务列表（可按 capability 过滤）。',
      z.object({
        taskId: z.string().uuid().optional(),
        capability: z.enum(['image', 'video', 'audio']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const user = { id: userId } as never;
        if (args.taskId) {
          return JSON.stringify(await this.generationService.findTask(user, args.taskId));
        }
        const result = await this.generationService.findTasks(user, {
          page: 1,
          limit: args.limit ?? 10,
          capability: args.capability as ModelCapability | undefined,
        } as never);
        return JSON.stringify(result.items);
      },
    );

    this.register(
      'prompts_search',
      '搜索提示词库（开源图像提示词合集），支持 keyword、category、tags 过滤和分页，返回标题、提示词、分类、标签、封面等。',
      z.object({
        keyword: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const result = await this.promptsService.fetchPrompts(
          { id: userId } as never,
          {
            keyword: args.keyword,
            category: args.category,
            tag: args.tags?.join(','),
            page: args.page ?? 1,
            pageSize: args.pageSize ?? 20,
          } as never,
        );
        return JSON.stringify(result);
      },
    );

    this.register(
      'assets_list',
      '列出用户「我的素材」，支持 kind（text/image/video）过滤、keyword 搜索和分页。媒体素材只返回 URL 与元信息。',
      z.object({
        kind: z.enum(['text', 'image', 'video']).optional(),
        keyword: z.string().optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const result = await this.assetsService.findAll(
          { id: userId } as never,
          {
            kind: args.kind as AssetKind | undefined,
            keyword: args.keyword,
            page: args.page ?? 1,
            limit: args.pageSize ?? 20,
          } as never,
        );
        return JSON.stringify(result);
      },
    );

    this.register(
      'assets_add',
      '向「我的素材」新增素材。kind=text 时用 content 传文本内容；kind=image 时用 imageUrl 传图片地址或 dataURL。可附带 title、tags、source、note。',
      z.object({
        kind: z.enum(['text', 'image']),
        title: z.string(),
        content: z.string().optional().describe('文本内容（kind=text）'),
        imageUrl: z.string().optional().describe('图片地址或 dataURL（kind=image）'),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
        note: z.string().optional(),
      }),
      async (agentConfigId, args) => {
        const userId = await this.resolveUserId(agentConfigId);
        const user = { id: userId } as never;
        if (args.kind === 'text') {
          if (!args.content?.trim())
            return JSON.stringify({ success: false, error: '文本素材必须提供 content' });
          const asset = await this.assetsService.create(user, {
            kind: AssetKind.TEXT,
            title: args.title,
            textContent: args.content,
            tags: args.tags,
            source: args.source,
            note: args.note,
          });
          return JSON.stringify({ success: true, asset });
        }
        if (!args.imageUrl)
          return JSON.stringify({ success: false, error: '图片素材必须提供 imageUrl' });
        const asset = await this.assetsService.addImageFromUrl(user, {
          title: args.title,
          imageUrl: args.imageUrl,
          tags: args.tags,
          source: args.source,
          note: args.note,
        });
        return JSON.stringify({ success: true, asset });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private register(
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (agentConfigId: string, args: any) => Promise<string>,
  ) {
    this.toolRegistry.registerAgentScopedTool(
      name,
      (agentConfigId) =>
        new DynamicStructuredTool({
          name,
          description,
          schema,
          func: async (args) => {
            try {
              return await handler(agentConfigId, args);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logger.warn(`画布工具 ${name} 执行失败：${message}`);
              return JSON.stringify({ success: false, error: message });
            }
          },
        }),
    );
  }

  private async resolveUserId(agentConfigId: string): Promise<string> {
    const agent = await this.agentRepo.findOne({ where: { id: agentConfigId } });
    if (!agent) throw new Error('Agent 配置不存在');
    return agent.userId;
  }

  /** 高层工具统一入口：编译 ops → 校验 → 应用 → 执行其中的生成请求 */
  private async runOpsTool(
    agentConfigId: string,
    projectId: string,
    name: CanvasToolName,
    input: Record<string, unknown>,
  ): Promise<string> {
    const userId = await this.resolveUserId(agentConfigId);
    const project = await this.canvasService.findOwned(projectId, userId);
    const ops = buildCanvasOps(name, input, project.document);
    const validated = this.canvasOpsService.validateOps(ops);
    const result = await this.canvasOpsService.applyOps(projectId, validated);

    const generations: Record<string, unknown>[] = [];
    for (const request of result.generationRequests) {
      generations.push(await this.executeGeneration(userId, projectId, result.document, request));
    }

    return JSON.stringify({
      success: true,
      summary: result.summary,
      version: result.version,
      touchedNodeIds: result.touchedNodeIds,
      ...(generations.length ? { generations } : {}),
    });
  }

  /** 执行 run_generation：收集节点输入 → 调生成服务 → 结果节点回填 */
  private async executeGeneration(
    userId: string,
    projectId: string,
    document: CanvasDocument,
    request: { nodeId: string; mode?: string; prompt?: string },
  ): Promise<Record<string, unknown>> {
    const node = (document.nodes ?? []).find((n) => n.id === request.nodeId);
    if (!node)
      return { nodeId: request.nodeId, success: false, error: `节点 #${request.nodeId} 不存在` };
    const meta = node.metadata || {};
    const mode = request.mode || meta.generationMode || 'image';
    if (mode === 'text') {
      return {
        nodeId: node.id,
        success: false,
        error: '文本生成模式暂未接入（v1 支持图片/视频/音频）',
      };
    }
    if (!meta.model) {
      return {
        nodeId: node.id,
        success: false,
        error: '配置节点未选择模型，请先 canvas_update_node 设置 metadata.model',
      };
    }
    const prompt = request.prompt || this.collectPrompt(document, node);
    if (!prompt) return { nodeId: node.id, success: false, error: '缺少提示词' };
    const referenceMediaIds = this.collectReferenceMediaIds(document, node);
    const user = { id: userId } as never;

    try {
      if (mode === 'video') {
        const resultId = `video-${randomUUID()}`;
        await this.canvasOpsService.applyOps(projectId, [
          {
            type: 'add_node',
            id: resultId,
            nodeType: 'video',
            title: '视频生成中…',
            position: this.resultPosition(node, 0),
            metadata: { status: 'loading' },
          },
          { type: 'connect_nodes', fromNodeId: node.id, toNodeId: resultId },
        ]);
        const { task } = await this.generationService.generateVideo(user, {
          modelRef: meta.model,
          prompt,
          seconds: meta.seconds,
          size: meta.size,
          vquality: meta.vquality,
          generateAudio: meta.generateAudio,
          watermark: meta.watermark,
          referenceMediaIds: referenceMediaIds.length ? referenceMediaIds : undefined,
          nodeRef: { projectId, nodeId: resultId },
        } as never);
        await this.canvasOpsService.patchNodeMetadata(projectId, resultId, { taskId: task.id });
        return { success: true, mode, nodeId: resultId, taskId: task.id, status: 'processing' };
      }

      if (mode === 'audio') {
        const { media } = await this.generationService.generateAudio(user, {
          modelRef: meta.model,
          prompt,
          voice: meta.audioVoice,
          format: meta.audioFormat,
          speed: meta.audioSpeed,
          instructions: meta.audioInstructions,
        } as never);
        const resultId = `audio-${randomUUID()}`;
        await this.canvasOpsService.applyOps(projectId, [
          {
            type: 'add_node',
            id: resultId,
            nodeType: 'audio',
            title: node.title || '音频',
            position: this.resultPosition(node, 0),
            metadata: {
              content: media.url,
              storageKey: media.fileName,
              mediaId: media.id,
              status: 'success',
              mimeType: media.mimeType,
              bytes: media.bytes,
            },
          },
          { type: 'connect_nodes', fromNodeId: node.id, toNodeId: resultId },
        ]);
        return { success: true, mode, nodeId: resultId, mediaId: media.id };
      }

      const { media } = await this.generationService.generateImage(user, {
        modelRef: meta.model,
        prompt,
        count: meta.count,
        quality: meta.quality,
        size: meta.size,
        background: meta.background,
        referenceMediaIds: referenceMediaIds.length ? referenceMediaIds : undefined,
      } as never);
      const ops: CanvasAgentOp[] = media.flatMap((m, index) => {
        const resultId = `image-${randomUUID()}`;
        return [
          {
            type: 'add_node' as const,
            id: resultId,
            nodeType: 'image',
            title: node.title || '图片',
            position: this.resultPosition(node, index),
            metadata: {
              content: m.url,
              storageKey: m.fileName,
              mediaId: m.id,
              status: 'success' as const,
              naturalWidth: m.width || undefined,
              naturalHeight: m.height || undefined,
              bytes: m.bytes,
              mimeType: m.mimeType,
            },
          },
          { type: 'connect_nodes' as const, fromNodeId: node.id, toNodeId: resultId },
        ];
      });
      await this.canvasOpsService.applyOps(projectId, ops);
      return {
        success: true,
        mode: 'image',
        nodeIds: ops.filter((op) => op.type === 'add_node').map((op) => (op as { id: string }).id),
      };
    } catch (error) {
      return {
        nodeId: node.id,
        success: false,
        error: error instanceof Error ? error.message : '生成失败',
      };
    }
  }

  /** 提示词 = 节点自身 prompt + 连入文本节点内容（与前端 collectInputs 一致） */
  private collectPrompt(document: CanvasDocument, node: CanvasNodeData): string {
    const parts: string[] = [];
    const own = node.metadata?.prompt?.trim();
    if (own) parts.push(own);
    for (const conn of document.connections ?? []) {
      if (conn.toNodeId !== node.id) continue;
      const source = (document.nodes ?? []).find((n) => n.id === conn.fromNodeId);
      if (source?.type === 'text') {
        const text = source.metadata?.content?.trim();
        if (text) parts.push(text);
      }
    }
    return parts.join('\n');
  }

  /** 参考素材 = 连入的图片/视频/音频节点的 mediaId */
  private collectReferenceMediaIds(document: CanvasDocument, node: CanvasNodeData): string[] {
    const ids: string[] = [];
    for (const conn of document.connections ?? []) {
      if (conn.toNodeId !== node.id) continue;
      const source = (document.nodes ?? []).find((n) => n.id === conn.fromNodeId);
      const mediaId = source?.metadata?.mediaId;
      if (
        mediaId &&
        (source.type === 'image' || source.type === 'video' || source.type === 'audio')
      ) {
        ids.push(mediaId);
      }
    }
    return ids;
  }

  /** 结果节点落点：源节点右侧 80px，按索引垂直错位 */
  private resultPosition(node: CanvasNodeData, index: number): { x: number; y: number } {
    return {
      x: node.position.x + node.width + 80,
      y: node.position.y + index * 48,
    };
  }
}
