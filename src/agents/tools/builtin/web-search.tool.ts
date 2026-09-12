import { z } from 'zod';
import { BaseBuiltinTool } from '../base.tool';

/**
 * 供应商内置搜索的标记工具。保留 Agent / Skill 的 web_search 配置与工具目录，
 * 执行器在绑定模型时将此实例替换成供应商声明，不在本地执行搜索。
 */
export class WebSearchTool extends BaseBuiltinTool {
  constructor() {
    super({
      name: 'web_search',
      description:
        '在互联网上搜索实时信息。当用户询问最新资讯、股价、新闻等超出模型知识截止日期的内容时使用。',
      schema: z.object({
        query: z.string().describe('搜索关键词'),
      }),
      func: async () => {
        throw new Error('内置联网搜索必须由模型供应商执行');
      },
    });
  }
}
