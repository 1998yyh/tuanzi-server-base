import { z } from 'zod';
import { BaseBuiltinTool } from '../base.tool';

/**
 * 计算器工具：安全的四则运算求值。
 * 不依赖 eval——递归下降解析 + - * / % ** 与括号，拒绝任意代码执行。
 */
export class CalculatorTool extends BaseBuiltinTool {
  constructor() {
    super({
      name: 'calculator',
      description:
        '计算数学表达式的结果，支持 +、-、*、/、%、**（幂）和括号。输入必须是纯数学表达式。',
      schema: z.object({
        expression: z.string().describe('要计算的数学表达式，如 "(1 + 2) * 3"'),
      }),
      func: async ({ expression }) => {
        try {
          const result = evaluate(expression as string);
          return String(result);
        } catch (e) {
          return `表达式求值失败: ${(e as Error).message}`;
        }
      },
    });
  }
}

/** 递归下降解析器：只允许数字、运算符和括号 */
function evaluate(expr: string): number {
  let pos = 0;

  const skipWs = () => {
    while (pos < expr.length && expr[pos] === ' ') pos++;
  };
  const peek = () => {
    skipWs();
    return expr[pos];
  };

  const parsePrimary = (): number => {
    skipWs();
    if (peek() === '(') {
      pos++;
      const v = parseExpr();
      if (peek() !== ')') throw new Error('括号不匹配');
      pos++;
      return v;
    }
    if (peek() === '-') {
      pos++;
      return -parsePrimary();
    }
    if (peek() === '+') {
      pos++;
      return parsePrimary();
    }
    const match = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(expr.slice(pos));
    if (!match) throw new Error(`无法解析的位置: "${expr.slice(pos, pos + 10)}"`);
    pos += match[0].length;
    return Number(match[0]);
  };

  const parsePower = (): number => {
    const base = parsePrimary();
    skipWs();
    if (expr.startsWith('**', pos)) {
      pos += 2;
      return base ** parsePower(); // 右结合
    }
    return base;
  };

  const parseTerm = (): number => {
    let left = parsePower();
    for (;;) {
      const op = peek();
      if (op === '*' && !expr.startsWith('**', pos)) {
        pos++;
        left *= parsePower();
      } else if (op === '/') {
        pos++;
        left /= parsePower();
      } else if (op === '%') {
        pos++;
        left %= parsePower();
      } else {
        return left;
      }
    }
  };

  const parseExpr = (): number => {
    let left = parseTerm();
    for (;;) {
      const op = peek();
      if (op === '+') {
        pos++;
        left += parseTerm();
      } else if (op === '-') {
        pos++;
        left -= parseTerm();
      } else {
        return left;
      }
    }
  };

  const result = parseExpr();
  skipWs();
  if (pos < expr.length) throw new Error(`存在多余内容: "${expr.slice(pos)}"`);
  if (!Number.isFinite(result)) throw new Error('计算结果不是有限数');
  return result;
}
