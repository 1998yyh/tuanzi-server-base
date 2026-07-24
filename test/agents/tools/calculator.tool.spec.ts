import { CalculatorTool } from 'src/agents/tools/builtin/calculator.tool';

describe('CalculatorTool', () => {
  let tool: CalculatorTool;

  beforeEach(() => {
    tool = new CalculatorTool();
  });

  it('应该正确计算四则运算与括号优先级', async () => {
    expect(await tool.invoke({ expression: '(1 + 2) * 3' })).toBe('9');
    expect(await tool.invoke({ expression: '10 / 4' })).toBe('2.5');
    expect(await tool.invoke({ expression: '2 ** 10' })).toBe('1024');
    expect(await tool.invoke({ expression: '-3 + 5' })).toBe('2');
  });

  it('非法表达式应该返回错误文案而不是抛异常（交给 LLM 决策）', async () => {
    expect(await tool.invoke({ expression: '1 +' })).toContain('表达式求值失败');
    expect(await tool.invoke({ expression: '(1 + 2' })).toContain('表达式求值失败');
    expect(await tool.invoke({ expression: 'abc' })).toContain('表达式求值失败');
  });

  it('不应该执行任意代码', async () => {
    expect(await tool.invoke({ expression: 'process.exit(1)' })).toContain('表达式求值失败');
    expect(await tool.invoke({ expression: '1; alert(1)' })).toContain('表达式求值失败');
  });
});
