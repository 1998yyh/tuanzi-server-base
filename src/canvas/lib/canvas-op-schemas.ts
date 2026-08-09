// Ported from infinite-canvas (https://github.com/basketikun/infinite-canvas), AGPL-3.0. See NOTICE.
// 源文件：canvas-agent/src/canvas/schemas.ts 的 canvasOpSchema（zod v3 → zod v4 适配：
// .passthrough() → z.looseObject，z.record(z.unknown()) → z.record(z.string(), z.unknown())）

import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });
const nodeTypeSchema = z.enum(['image', 'text', 'config', 'video', 'audio', 'group']);
const generationModeSchema = z.enum(['text', 'image', 'video', 'audio']);

export const canvasOpSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('add_node'),
    nodeType: nodeTypeSchema.optional(),
    id: z.string().optional(),
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
    patch: recordSchema.optional(),
    metadata: recordSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('delete_node'),
    id: z.string().optional(),
    ids: z.array(z.string()).optional(),
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

export const canvasOpsArraySchema = z.array(canvasOpSchema).min(1);
