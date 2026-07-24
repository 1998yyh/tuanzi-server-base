import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { BaseBuiltinTool } from '../base.tool';

/**
 * 联网搜索工具。
 *
 * 配置了 TAVILY_API_KEY 时走 Tavily API，否则返回明确的错误文案——按设计原则，
 * 工具失败信息作为工具结果返回给 LLM，由 LLM 决定换思路还是告知用户，而不是让 Agent 崩溃。
 */
export class WebSearchTool extends BaseBuiltinTool {
  constructor(config: ConfigService) {
    super({
      name: 'web_search',
      description:
        '在互联网上搜索实时信息。当用户询问最新资讯、股价、新闻等超出模型知识截止日期的内容时使用。',
      schema: z.object({
        query: z.string().describe('搜索关键词'),
      }),
      func: async ({ query }) => {
        const apiKey = config.get<string>('TAVILY_API_KEY');
        if (!apiKey) {
          return '搜索服务未配置（缺少 TAVILY_API_KEY），请基于已有知识回答，并告知用户当前无法联网检索。';
        }
        try {
          const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              query,
              max_results: 5,
            }),
          });
          if (!res.ok) {
            return `搜索请求失败（HTTP ${res.status}），请稍后重试或基于已有知识回答。`;
          }
          const data = (await res.json()) as {
            results?: { title: string; url: string; content: string }[];
          };
          const results = data.results ?? [];
          if (!results.length) return '未搜索到相关结果。';
          return results.map((r) => `【${r.title}】\n${r.content}\n来源: ${r.url}`).join('\n\n');
        } catch (e) {
          return `搜索调用异常: ${(e as Error).message}`;
        }
      },
    });
  }
}
