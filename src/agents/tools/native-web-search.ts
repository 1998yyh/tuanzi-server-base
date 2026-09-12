import { BadRequestException } from '@nestjs/common';
import { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { ApiFormat } from '../../ai-generation/entities/ai-channel.entity';
import type { ResolvedChatModel } from '../../ai-generation/ai-channels.service';
import { WebSearchTool } from './builtin/web-search.tool';

interface NativeSearchBinding {
  kind: 'none' | 'anthropic' | 'openai' | 'kimi';
  modelTools: (StructuredToolInterface | Record<string, unknown>)[];
  executionTools: StructuredToolInterface[];
}

/** 按实际工具集绑定，Skill overrideTools 不继承父 Agent 的搜索开关。 */
export function prepareNativeWebSearch(
  channel: Pick<ResolvedChatModel, 'apiFormat' | 'baseUrl' | 'model'>,
  tools: StructuredToolInterface[],
): NativeSearchBinding {
  if (!tools.some((tool) => tool instanceof WebSearchTool)) {
    return { kind: 'none', modelTools: tools, executionTools: tools };
  }
  const localTools = tools.filter((tool) => !(tool instanceof WebSearchTool));
  const hostname = new URL(channel.baseUrl).hostname;
  const isHost = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
  // DeepSeek 的当前兼容性表明确标注忽略内置搜索，不能把普通回答当作搜索成功。
  if (isHost('deepseek.com') || /(^|[/:])deepseek(?:-|$)/i.test(channel.model)) {
    throw new BadRequestException(
      '当前 DeepSeek API 不支持此内置联网搜索，请关闭 web_search 或选择支持内置搜索的渠道',
    );
  }
  if (channel.apiFormat === ApiFormat.ANTHROPIC) {
    return {
      kind: 'anthropic',
      executionTools: localTools,
      modelTools: [...localTools, { type: 'web_search_20250305', name: 'web_search' }],
    };
  }
  if (channel.apiFormat === ApiFormat.OPENAI) {
    if (
      isHost('moonshot.cn') ||
      isHost('moonshot.ai') ||
      isHost('kimi.com') ||
      /(^|[/:])(?:kimi(?:-|$)|moonshot-)/i.test(channel.model)
    ) {
      const search = new DynamicStructuredTool({
        name: '$web_search',
        description: '回传 Kimi 内置搜索上下文',
        schema: z.record(z.string(), z.unknown()),
        func: async (args) => JSON.stringify(args),
      });
      return { kind: 'kimi', modelTools: localTools, executionTools: [...localTools, search] };
    }
    return {
      kind: 'openai',
      executionTools: localTools,
      modelTools: [...localTools, { type: 'web_search' }],
    };
  }
  throw new BadRequestException(`渠道格式 "${channel.apiFormat}" 不支持内置联网搜索`);
}

/**
 * 当前 LangChain 把 builtin_function 当作 OpenAI Responses 工具，且序列化时
 * 丢弃 tool 消息的 name。仅在 Kimi Chat Completions 的 HTTP 边界补齐其协议；
 * 搜索参数照原样回传，不调用任何额外搜索服务。
 */
export const kimiWebSearchFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/chat/completions')) {
    return fetch(request);
  }
  const body = (await request.json()) as {
    tools?: Record<string, unknown>[];
    messages?: {
      role: string;
      name?: string;
      tool_call_id?: string;
      content?: unknown;
      tool_calls?: { id: string; function: { name: string } }[];
    }[];
  };
  body.tools = [
    ...(body.tools ?? []),
    { type: 'builtin_function', function: { name: '$web_search' } },
  ];
  const searchIds = new Set(
    (body.messages ?? []).flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => call.function.name === '$web_search')
        .map((call) => call.id),
    ),
  );
  for (const message of body.messages ?? []) {
    if (message.role === 'tool' && message.tool_call_id && searchIds.has(message.tool_call_id)) {
      message.name = '$web_search';
      if (Array.isArray(message.content)) {
        message.content = (message.content as { type: string; text?: string }[])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
      }
    }
  }
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return fetch(new Request(request, { headers, body: JSON.stringify(body) }));
};
