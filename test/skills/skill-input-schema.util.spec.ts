import { buildSkillInputSchema } from 'src/skills/skill-input-schema.util';

describe('buildSkillInputSchema', () => {
  it('inputSchema 为空时应该回退为单个 input 字符串', () => {
    const schema = buildSkillInputSchema(null);

    expect(schema.safeParse({ input: '你好' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('非 object 类型 schema 应该回退为单个 input 字符串', () => {
    const schema = buildSkillInputSchema({ type: 'string' });

    expect(schema.safeParse({ input: '你好' }).success).toBe(true);
  });

  it('扁平 object schema 应该按 properties/required 生成字段', () => {
    const schema = buildSkillInputSchema({
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题' },
        count: { type: 'integer' },
        verbose: { type: 'boolean' },
      },
      required: ['topic'],
    });

    expect(schema.safeParse({ topic: 'AI' }).success).toBe(true);
    expect(schema.safeParse({ topic: 'AI', count: 3, verbose: true }).success).toBe(true);
    expect(schema.safeParse({ count: 3 }).success).toBe(false); // 缺 required 字段
    expect(schema.safeParse({ topic: 'AI', count: '三' }).success).toBe(false); // 类型不符
  });
});
