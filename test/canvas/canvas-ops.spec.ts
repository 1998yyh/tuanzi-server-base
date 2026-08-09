import { applyCanvasOps, summarizeCanvasOps, CanvasAgentOp } from 'src/canvas/lib/canvas-ops';
import { CanvasDocument, CanvasNodeType } from 'src/canvas/canvas.types';

const doc = (partial?: Partial<CanvasDocument>): CanvasDocument => ({
  nodes: [],
  connections: [],
  ...partial,
});

const textNode = (id: string) => ({
  id,
  type: CanvasNodeType.Text,
  title: '文本',
  position: { x: 0, y: 0 },
  width: 340,
  height: 240,
});

describe('applyCanvasOps', () => {
  it('add_node：未给 id 自动生成 uuid，未知类型回退为 text', () => {
    const result = applyCanvasOps(doc(), [
      { type: 'add_node', nodeType: 'image', title: '我的图', x: 10, y: 20 },
      { type: 'add_node', nodeType: 'unknown-plugin:foo' as never },
    ]);
    expect(result.document.nodes).toHaveLength(2);
    expect(result.document.nodes[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.document.nodes[0].type).toBe('image');
    expect(result.document.nodes[0].position).toEqual({ x: 10, y: 20 });
    expect(result.document.nodes[0].width).toBe(340);
    expect(result.document.nodes[1].type).toBe(CanvasNodeType.Text);
    expect(result.touchedNodeIds).toHaveLength(2);
  });

  it('update_node：合并 patch 与 metadata；节点不存在时报中文错误', () => {
    const base = doc({ nodes: [{ ...textNode('n1'), metadata: { prompt: '旧' } }] });
    const result = applyCanvasOps(base, [
      { type: 'update_node', id: 'n1', patch: { title: '新标题' }, metadata: { prompt: '新' } },
    ]);
    expect(result.document.nodes[0].title).toBe('新标题');
    expect(result.document.nodes[0].metadata?.prompt).toBe('新');

    expect(() => applyCanvasOps(base, [{ type: 'update_node', id: 'ghost' }])).toThrow(
      '节点 #ghost 不存在',
    );
  });

  it('delete_node：级联删除相关连线', () => {
    const base = doc({
      nodes: [textNode('n1'), textNode('n2'), textNode('n3')],
      connections: [
        { id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' },
        { id: 'c2', fromNodeId: 'n2', toNodeId: 'n3' },
      ],
    });
    const result = applyCanvasOps(base, [{ type: 'delete_node', ids: ['n2'] }]);
    expect(result.document.nodes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(result.document.connections).toEqual([]);
  });

  it('connect_nodes：去重、防自连、节点不存在时不建', () => {
    const base = doc({ nodes: [textNode('n1'), textNode('n2')] });
    const result = applyCanvasOps(base, [
      { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'n2' },
      { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'n2' }, // 重复
      { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'n1' }, // 自连
      { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'ghost' }, // 不存在
    ]);
    expect(result.document.connections).toHaveLength(1);
    expect(result.document.connections[0]).toMatchObject({ fromNodeId: 'n1', toNodeId: 'n2' });
  });

  it('delete_connections：支持 all 与按 id', () => {
    const base = doc({
      nodes: [textNode('n1'), textNode('n2')],
      connections: [
        { id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' },
        { id: 'c2', fromNodeId: 'n2', toNodeId: 'n1' },
      ],
    });
    expect(
      applyCanvasOps(base, [{ type: 'delete_connections', id: 'c1' }]).document.connections,
    ).toHaveLength(1);
    expect(
      applyCanvasOps(base, [{ type: 'delete_connections', all: true }]).document.connections,
    ).toHaveLength(0);
  });

  it('run_generation：只收集请求不执行，select_nodes 忽略', () => {
    const result = applyCanvasOps(doc({ nodes: [textNode('n1')] }), [
      { type: 'run_generation', nodeId: 'n1', mode: 'image', prompt: '一只猫' },
      { type: 'select_nodes', ids: ['n1'] },
    ]);
    expect(result.generationRequests).toEqual([{ nodeId: 'n1', mode: 'image', prompt: '一只猫' }]);
    expect(result.document.nodes).toHaveLength(1);
  });

  it('set_viewport 更新视口', () => {
    const result = applyCanvasOps(doc(), [
      { type: 'set_viewport', viewport: { x: 100, y: 50, k: 2 } },
    ]);
    expect(result.document.viewport).toEqual({ x: 100, y: 50, k: 2 });
  });
});

describe('summarizeCanvasOps', () => {
  it('生成中文摘要', () => {
    const summary = summarizeCanvasOps([
      { type: 'add_node' },
      { type: 'add_node' },
      { type: 'connect_nodes', fromNodeId: 'a', toNodeId: 'b' },
    ] as CanvasAgentOp[]);
    expect(summary).toBe('新建节点 2，连接节点 1');
  });
});
