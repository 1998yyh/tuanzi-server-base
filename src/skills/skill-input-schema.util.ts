import { z } from 'zod';

/**
 * Skill 入参 JSON Schema → zod 转换器（迷你版）。
 *
 * 只支持扁平 object（properties 值为 string/number/integer/boolean/array），
 * 足以覆盖绝大多数工具入参；不满足时回退为单个 input 字符串。
 * DynamicStructuredTool 只接受 zod schema，而 Skill 的 inputSchema 以 JSON Schema 落库，
 * 故需要这层转换（不引入 json-schema-to-zod 之类依赖——它靠 eval 生成代码）。
 */
export function buildSkillInputSchema(inputSchema: Record<string, unknown> | null): z.ZodTypeAny {
  const fallback = () => z.object({ input: z.string().describe('子任务的输入指令') });

  if (
    !inputSchema ||
    inputSchema.type !== 'object' ||
    typeof inputSchema.properties !== 'object' ||
    inputSchema.properties === null
  ) {
    return fallback();
  }

  const required = new Set(
    Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(
    inputSchema.properties as Record<string, Record<string, unknown> | undefined>,
  )) {
    let field: z.ZodTypeAny;
    switch (prop?.type) {
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'string':
      default:
        field = z.string();
        break;
    }
    if (typeof prop?.description === 'string') {
      field = field.describe(prop.description);
    }
    shape[key] = required.has(key) ? field : field.optional();
  }

  return Object.keys(shape).length ? z.object(shape) : fallback();
}
