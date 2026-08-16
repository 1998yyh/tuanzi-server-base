import { canvasOpSchema, canvasOpsArraySchema } from 'src/canvas/lib/canvas-op-schemas';

const parse = (op: unknown) => canvasOpSchema.safeParse(op);

describe('canvasOpSchema', () => {
  describe('update_node.patch 白名单', () => {
    it('接受合法的 title/width/height/position/metadata', () => {
      const result = parse({
        type: 'update_node',
        id: 'n1',
        patch: {
          title: '新标题',
          width: 400,
          height: 300,
          position: { x: 1.5, y: -2 },
          metadata: { status: 'success' },
        },
      });
      expect(result.success).toBe(true);
    });

    it('拒绝 patch 里的 id / type（节点身份与类型不可改）', () => {
      expect(parse({ type: 'update_node', id: 'n1', patch: { id: 'hacked' } }).success).toBe(false);
      expect(parse({ type: 'update_node', id: 'n1', patch: { type: 'video' } }).success).toBe(
        false,
      );
      expect(parse({ type: 'update_node', id: 'n1', patch: { unknownKey: 1 } }).success).toBe(
        false,
      );
    });

    it('拒绝非法值：position 传字符串、width 小于 1、title 非字符串', () => {
      expect(parse({ type: 'update_node', id: 'n1', patch: { position: 'abc' } }).success).toBe(
        false,
      );
      expect(parse({ type: 'update_node', id: 'n1', patch: { width: 0 } }).success).toBe(false);
      expect(parse({ type: 'update_node', id: 'n1', patch: { title: 123 } }).success).toBe(false);
    });

    it('patch 缺省（只改 metadata）仍合法', () => {
      expect(parse({ type: 'update_node', id: 'n1', metadata: { prompt: '新' } }).success).toBe(
        true,
      );
    });
  });

  describe('delete_node.nodeType', () => {
    it('带合法 nodeType 可校验通过', () => {
      expect(parse({ type: 'delete_node', nodeType: 'text' }).success).toBe(true);
    });

    it('非法 nodeType 被拒绝', () => {
      expect(parse({ type: 'delete_node', nodeType: 'hacker' }).success).toBe(false);
    });
  });

  describe('add_node.id 格式', () => {
    it('uuid / nanoid 风格 id 通过', () => {
      expect(
        parse({ type: 'add_node', id: 'text-550e8400-e29b-41d4-a716-446655440000' }).success,
      ).toBe(true);
      expect(parse({ type: 'add_node', id: 'node_1' }).success).toBe(true);
    });

    it('非法 id（含空格/含点/超长）被拒绝，省略 id 仍合法', () => {
      expect(parse({ type: 'add_node', id: 'a b' }).success).toBe(false);
      expect(parse({ type: 'add_node', id: 'a.b' }).success).toBe(false);
      expect(parse({ type: 'add_node', id: 'x'.repeat(65) }).success).toBe(false);
      expect(parse({ type: 'add_node' }).success).toBe(true);
    });
  });
});

describe('canvasOpsArraySchema', () => {
  it('ops 数组最多 500 条', () => {
    const ops = Array.from({ length: 500 }, () => ({ type: 'add_node' as const }));
    expect(canvasOpsArraySchema.safeParse(ops).success).toBe(true);
    const tooMany = Array.from({ length: 501 }, () => ({ type: 'add_node' as const }));
    expect(canvasOpsArraySchema.safeParse(tooMany).success).toBe(false);
  });

  it('空数组被拒绝（min(1)）', () => {
    expect(canvasOpsArraySchema.safeParse([]).success).toBe(false);
  });
});
