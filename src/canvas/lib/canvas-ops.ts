// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/lib/canvas/canvas-agent-ops.ts + web/src/constant/canvas.ts（NODE_SPECS）
// 改造点：
// - nanoid → node:crypto randomUUID
// - 选区（selectedNodeIds）是纯 UI 态，服务端 select_nodes 为 no-op
// - run_generation 不在这里执行，收集为 GenerationRequest 由 CanvasOpsService 分发
// - i18n 文案 → 中文硬编码

import { randomUUID } from 'node:crypto';
import {
  CanvasDocument,
  CanvasGenerationMode,
  CanvasNodeData,
  CanvasNodeMetadata,
  CanvasNodeType,
  CanvasNodeTypeId,
  ViewportTransform,
} from '../canvas.types';

export type CanvasAgentOp =
  | {
      type: 'add_node';
      id?: string;
      nodeType?: CanvasNodeTypeId;
      title?: string;
      position?: { x: number; y: number };
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      metadata?: CanvasNodeMetadata;
    }
  | {
      type: 'update_node';
      id: string;
      patch?: Partial<CanvasNodeData>;
      metadata?: CanvasNodeMetadata;
    }
  | { type: 'delete_node'; id?: string; ids?: string[]; nodeType?: CanvasNodeTypeId }
  | { type: 'delete_connections'; id?: string; ids?: string[]; all?: boolean }
  | { type: 'connect_nodes'; id?: string; fromNodeId: string; toNodeId: string }
  | { type: 'set_viewport'; viewport: ViewportTransform }
  | { type: 'select_nodes'; ids: string[] }
  | { type: 'run_generation'; nodeId: string; mode?: CanvasGenerationMode; prompt?: string };

/** run_generation op 的执行请求（由生成系统消费） */
export interface GenerationRequest {
  nodeId: string;
  mode?: CanvasGenerationMode;
  prompt?: string;
}

interface NodeSpec {
  title: string;
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
}

/** Ported from constant/canvas.ts NODE_SPECS */
const NODE_SPECS: Record<string, NodeSpec> = {
  [CanvasNodeType.Image]: { title: '图片', width: 340, height: 240 },
  [CanvasNodeType.Text]: { title: '文本', width: 340, height: 240 },
  [CanvasNodeType.Config]: { title: '生成配置', width: 340, height: 240 },
  [CanvasNodeType.Video]: { title: '视频', width: 420, height: 236 },
  [CanvasNodeType.Audio]: { title: '音频', width: 340, height: 120 },
  [CanvasNodeType.Group]: { title: '分组', width: 760, height: 480 },
};

const DEFAULT_SPEC: NodeSpec = NODE_SPECS[CanvasNodeType.Text];

function getNodeSpec(nodeType: CanvasNodeTypeId): NodeSpec {
  return NODE_SPECS[nodeType] ?? DEFAULT_SPEC;
}

function isBuiltinNodeType(nodeType: string): boolean {
  return Object.values<string>(CanvasNodeType).includes(nodeType);
}

export interface ApplyOpsResult {
  document: CanvasDocument;
  /** 本批 ops 中收集到的生成请求（按出现顺序） */
  generationRequests: GenerationRequest[];
  /** 本批 ops 新建/更新涉及的节点 ID（便于调用方返回变更摘要） */
  touchedNodeIds: string[];
}

/**
 * 把一批 ops 应用到文档上（纯函数，不改动入参）。
 * ops 按顺序原子应用：任一 op 结构非法直接抛错（zod 层已校验形状）。
 */
export function applyCanvasOps(document: CanvasDocument, ops: CanvasAgentOp[]): ApplyOpsResult {
  let nodes = document.nodes ?? [];
  let connections = document.connections ?? [];
  let viewport = document.viewport;
  const generationRequests: GenerationRequest[] = [];
  const touched = new Set<string>();

  (Array.isArray(ops) ? ops : []).forEach((op, index) => {
    if (!op?.type) return;
    if (op.type === 'add_node') {
      const nodeType =
        op.nodeType && isBuiltinNodeType(op.nodeType) ? op.nodeType : CanvasNodeType.Text;
      const spec = getNodeSpec(nodeType);
      // op.id 若与现有节点（含本批已建）重复，回退为随机 id，保证文档内 id 唯一且不覆盖他人节点
      const nodeId = op.id && !nodes.some((node) => node.id === op.id) ? op.id : randomUUID();
      const node: CanvasNodeData = {
        id: nodeId,
        type: nodeType,
        title: op.title || spec.title,
        position: op.position || { x: op.x ?? index * 36, y: op.y ?? index * 36 },
        width: op.width || spec.width,
        height: op.height || spec.height,
        metadata: { ...spec.metadata, ...op.metadata },
      };
      nodes = [...nodes, node];
      touched.add(node.id);
    }
    if (op.type === 'update_node') {
      if (!op.id) return;
      if (!nodes.some((node) => node.id === op.id)) {
        throw new Error(`节点 #${op.id} 不存在`);
      }
      // 防御：patch 即使绕过白名单也绝不能覆写 id/type（double-check）
      const { id: _patchId, type: _patchType, ...safePatch } = op.patch ?? {};
      void _patchId;
      void _patchType;
      nodes = nodes.map((node) =>
        node.id === op.id
          ? {
              ...node,
              ...safePatch,
              metadata: { ...node.metadata, ...op.patch?.metadata, ...op.metadata },
            }
          : node,
      );
      touched.add(op.id);
    }
    if (op.type === 'delete_node') {
      const ids = new Set(
        op.ids ||
          (op.id
            ? [op.id]
            : op.nodeType
              ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id)
              : []),
      );
      nodes = nodes.filter((node) => !ids.has(node.id));
      connections = connections.filter(
        (conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId),
      );
    }
    if (op.type === 'delete_connections') {
      const ids = new Set(op.ids || (op.id ? [op.id] : []));
      connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
    }
    if (op.type === 'connect_nodes') {
      if (!op.fromNodeId || !op.toNodeId) return;
      if (op.fromNodeId === op.toNodeId) return;
      const exists = connections.some(
        (conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId,
      );
      const hasNodes =
        nodes.some((node) => node.id === op.fromNodeId) &&
        nodes.some((node) => node.id === op.toNodeId);
      if (!exists && hasNodes) {
        connections = [
          ...connections,
          { id: op.id || randomUUID(), fromNodeId: op.fromNodeId, toNodeId: op.toNodeId },
        ];
      }
    }
    if (op.type === 'set_viewport' && op.viewport) viewport = op.viewport;
    // select_nodes：选区是纯 UI 态，服务端忽略
    if (op.type === 'run_generation') {
      generationRequests.push({ nodeId: op.nodeId, mode: op.mode, prompt: op.prompt });
    }
  });

  return {
    document: { ...document, nodes, connections, ...(viewport ? { viewport } : {}) },
    generationRequests,
    touchedNodeIds: [...touched],
  };
}

const OP_LABELS: Record<string, string> = {
  add_node: '新建节点',
  update_node: '更新节点',
  delete_node: '删除节点',
  delete_connections: '删除连线',
  connect_nodes: '连接节点',
  set_viewport: '调整视口',
  select_nodes: '选择节点',
  run_generation: '触发生成',
};

/** 生成 ops 的中文摘要，如「新建节点 2，连接节点 1」（工具结果展示用） */
export function summarizeCanvasOps(ops?: CanvasAgentOp[]): string {
  const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
    if (!op?.type) return acc;
    acc[op.type] = (acc[op.type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `${OP_LABELS[type] ?? type} ${count}`)
    .join('，');
}
