// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：canvas-agent/src/canvas/schemas.ts 的 canvasOpSchema（zod v3 → zod v4 适配：
// .passthrough() → z.looseObject，z.record(z.unknown()) → z.record(z.string(), z.unknown())）

import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });
const nodeTypeSchema = z.enum(['image', 'text', 'config', 'video', 'audio', 'group']);
const generationModeSchema = z.enum(['text', 'image', 'video', 'audio']);

/**
 * update_node.patch 白名单：只允许修改基础字段。
 * .strict() 拒绝 id/type 等未知键——节点身份与类型不可经 patch 改写
 * （applyCanvasOps 合并处还会 double-check 排除这两个键）。
 */
const nodePatchSchema = z
  .object({
    title: z.string().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    width: z.number().min(1).optional(),
    height: z.number().min(1).optional(),
    metadata: recordSchema.optional(),
  })
  .strict();

export const canvasOpSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('add_node'),
    nodeType: nodeTypeSchema.optional(),
    // id 可选：提供时必须是合法节点 id（字母/数字/-/_，1~64 位），省略则由服务端生成
    id: z
      .string()
      .regex(/^[0-9a-zA-Z_-]{1,64}$/)
      .optional(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    position: positionSchema.optional(),
    metadata: recordSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('update_node'),
    id: z.string(),
    patch: nodePatchSchema.optional(),
    metadata: recordSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('delete_node'),
    id: z.string().optional(),
    ids: z.array(z.string()).optional(),
    // 与 applyCanvasOps 实现一致：未给 id/ids 时按节点类型批量删除
    nodeType: nodeTypeSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('delete_connections'),
    id: z.string().optional(),
    ids: z.array(z.string()).optional(),
    all: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal('connect_nodes'),
    id: z.string().optional(),
    fromNodeId: z.string(),
    toNodeId: z.string(),
  }),
  z.looseObject({ type: z.literal('set_viewport'), viewport: viewportSchema }),
  z.looseObject({ type: z.literal('select_nodes'), ids: z.array(z.string()) }),
  z.looseObject({
    type: z.literal('run_generation'),
    nodeId: z.string(),
    mode: generationModeSchema.optional(),
    prompt: z.string().optional(),
  }),
]);

export const canvasOpsArraySchema = z.array(canvasOpSchema).min(1).max(500);
