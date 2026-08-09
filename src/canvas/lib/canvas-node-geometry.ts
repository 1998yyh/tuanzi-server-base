// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：web/src/lib/canvas/canvas-node-geometry.ts（nodeBounds / 连线方向规则）
// 分组吸附（findGroupDropTarget/snapNodesIntoGroup）是前端拖拽交互逻辑，后端不移植。

import { CanvasNodeData, CanvasNodeType } from '../canvas.types';

export function nodeBounds(nodes: CanvasNodeData[]) {
  return nodes.reduce(
    (acc, node) => ({
      left: Math.min(acc.left, node.position.x),
      top: Math.min(acc.top, node.position.y),
      right: Math.max(acc.right, node.position.x + node.width),
      bottom: Math.max(acc.bottom, node.position.y + node.height),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/**
 * 连线方向归一化：
 * - 不允许自连、分组节点连线、config 与 config 互连
 * - config 节点只能作为「配置输入」侧（toNodeId），其余按拖拽方向
 */
export function normalizeConnection(
  firstNodeId: string,
  secondNodeId: string,
  nodes: CanvasNodeData[],
  firstHandleType: 'source' | 'target',
): { fromNodeId: string; toNodeId: string } | null {
  const first = nodes.find((node) => node.id === firstNodeId);
  const second = nodes.find((node) => node.id === secondNodeId);
  if (!first || !second || first.id === second.id) return null;
  if (first.type === CanvasNodeType.Group || second.type === CanvasNodeType.Group) return null;
  if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
  if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
  if (first.type === CanvasNodeType.Config && firstHandleType === 'target') {
    return { fromNodeId: second.id, toNodeId: first.id };
  }
  return { fromNodeId: first.id, toNodeId: second.id };
}
