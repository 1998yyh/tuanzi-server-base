// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：canvas-agent/src/canvas/operations.ts（buildCanvasToolRequest 编译器）
// 改造点：CanvasSnapshot → 服务端 CanvasDocument；nanoid → randomUUID；
// 裁掉浏览器专属工具（site_navigate/selection/viewport/snapshot/attachment/workbench）
import { randomUUID } from 'node:crypto';
import { CanvasDocument, CanvasGenerationMode } from '../../../canvas/canvas.types';
import { CanvasAgentOp } from '../../../canvas/lib/canvas-ops';

/** 高层画布工具名 → 编译为 ops 的工具子集 */
export type CanvasToolName =
  | 'canvas_apply_ops'
  | 'canvas_create_node'
  | 'canvas_create_text_node'
  | 'canvas_create_text_nodes'
  | 'canvas_create_config_node'
  | 'canvas_create_image_prompt_flow'
  | 'canvas_update_node'
  | 'canvas_update_node_text'
  | 'canvas_move_nodes'
  | 'canvas_resize_node'
  | 'canvas_delete_nodes'
  | 'canvas_connect_nodes'
  | 'canvas_run_generation';

/** 新节点默认 x：现有节点最大右缘右侧 40px（空画布为 0） */
export function nextCanvasX(document: CanvasDocument | null): number {
  const nodes = document?.nodes ?? [];
  if (!nodes.length) return 0;
  return Math.max(...nodes.map((node) => node.position.x + node.width)) + 40;
}

/** 将上层画布工具调用编译为批量 ops（纯函数，不触碰数据库） */
export function buildCanvasOps(
  name: CanvasToolName,
  input: Record<string, unknown>,
  document: CanvasDocument | null,
): CanvasAgentOp[] {
  if (name === 'canvas_apply_ops') return (input as { ops: CanvasAgentOp[] }).ops;
  if (name === 'canvas_create_node') {
    const data = input as {
      nodeType?: string;
      title?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      metadata?: Record<string, unknown>;
    };
    return [
      {
        type: 'add_node',
        nodeType: data.nodeType,
        title: data.title,
        position: { x: data.x ?? nextCanvasX(document), y: data.y ?? 0 },
        width: data.width,
        height: data.height,
        metadata: data.metadata,
      },
    ];
  }
  if (name === 'canvas_create_text_node') {
    const data = input as {
      text?: string;
      x?: number;
      y?: number;
      title?: string;
      width?: number;
      height?: number;
    };
    return [textNodeOp(data, data.x ?? nextCanvasX(document), data.y ?? 0)];
  }
  if (name === 'canvas_create_text_nodes') {
    const data = input as {
      items: Array<{
        text: string;
        title?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }>;
      x?: number;
      y?: number;
      gap?: number;
      direction?: 'row' | 'column';
    };
    const x = Number(data.x ?? nextCanvasX(document));
    const y = Number(data.y ?? 0);
    const gap = Number(data.gap ?? 40);
    return data.items.map((item, index) =>
      textNodeOp(
        item,
        item.x ?? (data.direction === 'row' ? x + index * (340 + gap) : x),
        item.y ?? (data.direction === 'row' ? y : y + index * (240 + gap)),
      ),
    );
  }
  if (name === 'canvas_create_image_prompt_flow') {
    return generationFlowOps({ ...input, mode: 'image' }, document);
  }
  if (name === 'canvas_create_config_node') {
    const x = Number(input.x ?? nextCanvasX(document));
    const y = Number(input.y ?? 0);
    const configId = `config-${randomUUID()}`;
    const mode = generationMode(input.mode);
    const prompt = String(input.prompt || '');
    return [
      configNodeOp(configId, input, x, y),
      ...(input.autoRun ? [runGenerationOp(configId, mode, prompt)] : []),
    ];
  }
  if (name === 'canvas_update_node') {
    const data = input as {
      id: string;
      patch?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    return [{ type: 'update_node', id: data.id, patch: data.patch, metadata: data.metadata }];
  }
  if (name === 'canvas_update_node_text') {
    const data = input as { id: string; text: string; title?: string };
    return [
      {
        type: 'update_node',
        id: data.id,
        patch: data.title ? { title: data.title } : undefined,
        metadata: { content: data.text, status: 'success' },
      },
    ];
  }
  if (name === 'canvas_move_nodes') {
    const data = input as {
      items: Array<{ id: string; x?: number; y?: number; dx?: number; dy?: number }>;
    };
    const nodes = document?.nodes ?? [];
    return data.items.map((item) => {
      const current = nodes.find((node) => node.id === item.id);
      return {
        type: 'update_node' as const,
        id: item.id,
        patch: {
          position: {
            x: item.x ?? (current?.position.x || 0) + (item.dx || 0),
            y: item.y ?? (current?.position.y || 0) + (item.dy || 0),
          },
        },
      };
    });
  }
  if (name === 'canvas_resize_node') {
    const data = input as { id: string; width: number; height: number; freeResize?: boolean };
    return [
      {
        type: 'update_node',
        id: data.id,
        patch: { width: data.width, height: data.height },
        metadata: data.freeResize === undefined ? undefined : { freeResize: data.freeResize },
      },
    ];
  }
  if (name === 'canvas_delete_nodes') {
    return [{ type: 'delete_node', ids: (input as { ids: string[] }).ids }];
  }
  if (name === 'canvas_connect_nodes') {
    const data = input as { connections: Array<{ fromNodeId: string; toNodeId: string }> };
    return data.connections.map((connection) => ({
      type: 'connect_nodes' as const,
      ...connection,
    }));
  }
  if (name === 'canvas_run_generation') {
    const data = input as { nodeId: string; mode?: string; prompt?: string };
    return [runGenerationOp(data.nodeId, generationMode(data.mode), data.prompt)];
  }
  throw new Error(`未知工具：${name}`);
}

/** 创建文本节点操作 */
function textNodeOp(
  input: { id?: string; text?: string; title?: string; width?: number; height?: number },
  x: number,
  y: number,
): CanvasAgentOp {
  return {
    type: 'add_node',
    id: input.id,
    nodeType: 'text',
    title: input.title,
    position: { x, y },
    width: input.width,
    height: input.height,
    metadata: { content: input.text || '', status: 'success', fontSize: 14 },
  };
}

/** 创建生成配置节点操作 */
function configNodeOp(
  id: string,
  input: Record<string, unknown>,
  x: number,
  y: number,
): CanvasAgentOp {
  const mode = generationMode(input.mode);
  const prompt = String(input.prompt || '');
  return {
    type: 'add_node',
    id,
    nodeType: 'config',
    title: String(input.title || generationTitle(mode)),
    position: { x, y },
    width: typeof input.width === 'number' ? input.width : undefined,
    height: typeof input.height === 'number' ? input.height : undefined,
    metadata: cleanRecord({
      generationMode: mode,
      composerContent: prompt,
      prompt,
      status: 'idle',
      model: input.model,
      size: input.size,
      quality: input.quality,
      count: input.count,
      seconds: input.seconds,
      vquality: input.vquality,
      generateAudio: input.generateAudio,
      watermark: input.watermark,
      audioVoice: input.audioVoice,
      audioFormat: input.audioFormat,
      audioSpeed: input.audioSpeed,
      audioInstructions: input.audioInstructions,
    }),
  };
}

/** 创建包含提示词、配置节点和引用连线的生成流程 */
function generationFlowOps(
  input: Record<string, unknown>,
  document: CanvasDocument | null,
): CanvasAgentOp[] {
  const mode = generationMode(input.mode);
  const prompt = String(input.prompt || '');
  const x = Number(input.x ?? nextCanvasX(document));
  const y = Number(input.y ?? 0);
  const textId = `text-${randomUUID()}`;
  const configId = `config-${randomUUID()}`;
  const referenceNodeIds = Array.isArray(input.referenceNodeIds)
    ? input.referenceNodeIds.filter((id): id is string => typeof id === 'string')
    : [];
  return [
    textNodeOp({ id: textId, text: prompt, title: String(input.title || '提示词') }, x, y),
    configNodeOp(configId, { ...input, prompt }, x + 420, y),
    { type: 'connect_nodes', fromNodeId: textId, toNodeId: configId },
    ...referenceNodeIds.map((fromNodeId) => ({
      type: 'connect_nodes' as const,
      fromNodeId,
      toNodeId: configId,
    })),
    ...(input.autoRun ? [runGenerationOp(configId, mode, prompt)] : []),
  ];
}

/** 创建触发节点生成的画布操作 */
function runGenerationOp(
  nodeId: string,
  mode: CanvasGenerationMode,
  prompt?: string,
): CanvasAgentOp {
  return { type: 'run_generation', nodeId, mode, prompt };
}

/** 将未知生成模式归一为画布支持的模式 */
function generationMode(value: unknown): CanvasGenerationMode {
  return value === 'text' || value === 'video' || value === 'audio' ? value : 'image';
}

/** 获取生成模式对应的默认节点标题 */
function generationTitle(mode: CanvasGenerationMode): string {
  if (mode === 'text') return '文本生成';
  if (mode === 'video') return '视频生成';
  if (mode === 'audio') return '音频生成';
  return '图片生成';
}

/** 移除对象中未设置的生成参数 */
function cleanRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ''),
  );
}
