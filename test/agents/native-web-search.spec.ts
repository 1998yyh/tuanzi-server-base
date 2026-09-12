import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MemorySaver } from '@langchain/langgraph';
import { AgentExecutorService } from 'src/agents/agent-executor.service';
import { ToolRegistryService } from 'src/agents/tools/tool-registry.service';
import { TypeORMCheckpointer } from 'src/agents/checkpointers/typeorm.checkpointer';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { SkillToolFactory } from 'src/skills/skill-tool.factory';
import { AiChannelsService } from 'src/ai-generation/ai-channels.service';
import { ApiFormat } from 'src/ai-generation/entities/ai-channel.entity';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';
import { DelegateToolFactory } from 'src/agents/tools/delegate-tool.factory';

// Exercise the real LangChain serializers and graph; only the HTTP boundary is mocked.
describe('供应商内置联网搜索', () => {
  let service: AgentExecutorService;
  let registry: ToolRegistryService;
  let requests: { url: string; body: any }[];
  let replies: Response[];
  let fetchSpy: jest.SpyInstance;
  let resolved: {
    channelId: string;
    apiFormat: ApiFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  const agent = {
    id: 'agent-search',
    userId: 'user-1',
    channelId: 'channel-1',
    modelName: 'gpt-4.1',
    name: '搜索助手',
    maxTokens: 1024,
    maxIterations: 5,
    enabledTools: ['web_search'],
  } as AgentConfig;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  const completion = (message: object, finishReason = 'stop') =>
    json({
      id: `chatcmpl-search-${replies.length}`,
      object: 'chat.completion',
      created: 1,
      model: resolved.model,
      choices: [
        { index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  const response = (text = '查到了', annotations: object[] = []) =>
    json({
      id: 'resp-search',
      object: 'response',
      created_at: 1,
      model: 'gpt-4.1',
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          id: 'ws-1',
          status: 'completed',
          action: { type: 'search', query: '最新消息' },
        },
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

  beforeEach(async () => {
    requests = [];
    replies = [];
    resolved = {
      channelId: 'channel-1',
      apiFormat: ApiFormat.OPENAI,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4.1',
    };
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      requests.push({ url: req.url, body: await req.json() });
      if (!replies.length)
        return new Response(JSON.stringify({ error: { message: 'Unexpected model request' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      return replies.shift()!;
    });
    const module = await Test.createTestingModule({
      providers: [
        AgentExecutorService,
        ToolRegistryService,
        { provide: DelegateToolFactory, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TypeORMCheckpointer, useValue: new MemorySaver() },
        {
          provide: McpServersService,
          useValue: { findByAgentConfig: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: SkillToolFactory,
          useValue: { createToolsForAgent: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: AiChannelsService,
          useValue: { resolveChatModel: jest.fn(async () => resolved) },
        },
      ],
    }).compile();
    registry = module.get(ToolRegistryService);
    registry.onModuleInit();
    service = module.get(AgentExecutorService);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('OpenAI 发往 Responses，声明托管搜索并保留引用，不调用第三方搜索', async () => {
    replies.push(
      response('发布了新版。', [
        {
          type: 'url_citation',
          url: 'https://example.com/news',
          title: '发布公告',
          start_index: 0,
          end_index: 6,
        },
      ]),
    );
    const result = await service.run(agent, 'search-1', '搜一下最新消息');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0].body.tools).toEqual([{ type: 'web_search' }]);
    expect(result.at(-1)?.content).toContain('[发布公告](https://example.com/news)');
    expect(result.at(-1)?.toolCalls).toBeNull();
  });

  it('未开启搜索时保留原来的 Chat Completions 请求', async () => {
    replies.push(completion({ content: '你好' }));
    await service.run({ ...agent, enabledTools: [] }, 'off', '你好');
    expect(requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0].body.tools).toBeUndefined();
  });

  it('Claude 使用服务端搜索，搜索结果不会进入本地工具循环', async () => {
    resolved.apiFormat = ApiFormat.ANTHROPIC;
    resolved.baseUrl = 'https://api.anthropic.com';
    resolved.model = 'claude-sonnet-4-6';
    replies.push(
      json({
        id: 'msg-a',
        type: 'message',
        role: 'assistant',
        model: resolved.model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu-1',
            name: 'web_search',
            input: { query: '新闻' },
          },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu-1', content: [] },
          {
            type: 'text',
            text: '官方消息。',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://example.com/news',
                title: '官方公告',
                encrypted_index: 'opaque',
                cited_text: '消息',
              },
            ],
          },
        ],
      }),
    );
    const result = await service.run(agent, 'claude', '搜索');
    expect(requests).toHaveLength(1);
    expect(requests[0].body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(result.at(-1)?.content).toContain('[官方公告](https://example.com/news)');
    expect(result.at(-1)?.toolCalls).toBeNull();
  });

  it('Kimi 保持 Chat Completions，原样回传搜索参数并保留计算器', async () => {
    resolved.baseUrl = 'https://api.moonshot.cn/v1';
    resolved.model = 'kimi-k2.5';
    const args = { query: '新闻', opaque: { token: 'search-context', count: 2 } };
    replies.push(
      completion(
        {
          content: null,
          tool_calls: [
            {
              id: 'call-k',
              type: 'function',
              function: { name: '$web_search', arguments: JSON.stringify(args) },
            },
          ],
        },
        'tool_calls',
      ),
    );
    replies.push(completion({ content: '搜索完成' }));
    const result = await service.run(
      { ...agent, enabledTools: ['web_search', 'calculator'] },
      'kimi',
      '搜索',
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('https://api.moonshot.cn/v1/chat/completions');
      expect(request.body.tools).toContainEqual({
        type: 'builtin_function',
        function: { name: '$web_search' },
      });
      expect(request.body.tools).toContainEqual(
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({ name: 'calculator' }),
        }),
      );
      expect(request.body.tools).not.toContainEqual(
        expect.objectContaining({
          function: expect.objectContaining({ name: 'web_search' }),
        }),
      );
    }
    expect(requests[1].body.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'call-k',
      name: '$web_search',
      content: JSON.stringify(args),
    });
    expect(result.at(-1)?.content).toBe('搜索完成');
  });

  it('Skill 覆盖工具集时不继承父 Agent 的搜索开关', async () => {
    replies.push(completion({ content: '仅计算' }));
    await service.runBatch(agent, '计算', { overrideTools: [], isSkillExecution: true });
    expect(requests[0].body.tools).toBeUndefined();
  });

  it('Skill 自己启用搜索时，即使父 Agent 未启用也会声明内置工具', async () => {
    replies.push(response());
    const tools = await registry.getToolsForAgent(agent);
    await service.runBatch({ ...agent, enabledTools: [] }, '搜索', {
      overrideTools: tools,
      isSkillExecution: true,
    });
    expect(requests[0].body.tools).toEqual([{ type: 'web_search' }]);
  });

  it('DeepSeek 不静默忽略搜索开关，调用模型前明确报出不支持', async () => {
    resolved.baseUrl = 'https://api.deepseek.com';
    resolved.model = 'deepseek-chat';
    await expect(service.run(agent, 'deepseek', '搜索')).rejects.toThrow('不支持');
    expect(requests).toHaveLength(0);
  });

  it('Claude 的 pause_turn 会继续请求并携带原始搜索上下文', async () => {
    resolved.apiFormat = ApiFormat.ANTHROPIC;
    resolved.baseUrl = 'https://api.anthropic.com';
    resolved.model = 'claude-sonnet-4-6';
    const searchBlock = {
      type: 'server_tool_use',
      id: 'srvtoolu-pause',
      name: 'web_search',
      input: { query: '新闻' },
    };
    replies.push(
      json({
        id: 'msg-pause',
        type: 'message',
        role: 'assistant',
        model: resolved.model,
        stop_reason: 'pause_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [searchBlock],
      }),
    );
    replies.push(
      json({
        id: 'msg-done',
        type: 'message',
        role: 'assistant',
        model: resolved.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: '搜索完成' }],
      }),
    );
    const result = await service.run(agent, 'pause', '搜索');
    expect(requests).toHaveLength(2);
    expect(requests[1].body.messages).toContainEqual({ role: 'assistant', content: [searchBlock] });
    expect(result.at(-1)?.content).toBe('搜索完成');
  });

  it('pause_turn 达到迭代上限时明确报错，避免空回答被当成成功', async () => {
    resolved.apiFormat = ApiFormat.ANTHROPIC;
    resolved.baseUrl = 'https://api.anthropic.com';
    resolved.model = 'claude-sonnet-4-6';
    replies.push(
      json({
        id: 'msg-limit',
        type: 'message',
        role: 'assistant',
        model: resolved.model,
        stop_reason: 'pause_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu-limit',
            name: 'web_search',
            input: { query: '新闻' },
          },
        ],
      }),
    );
    await expect(service.run({ ...agent, maxIterations: 1 }, 'limit', '搜索')).rejects.toThrow(
      '迭代上限',
    );
    expect(requests).toHaveLength(1);
  });

  it('Claude 流式回答的引用会出现在 message_end，供应商上下文不会变成回答文字', async () => {
    resolved.apiFormat = ApiFormat.ANTHROPIC;
    resolved.baseUrl = 'https://api.anthropic.com';
    resolved.model = 'claude-sonnet-4-6';
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg-stream',
          type: 'message',
          role: 'assistant',
          content: [],
          model: resolved.model,
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu-stream',
          name: 'web_search',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"新闻"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu-stream',
          content: [],
        },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '找到公告。' } },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://example.com/news',
            title: '公告',
            encrypted_index: 'opaque',
            cited_text: '公告',
          },
        },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ];
    replies.push(
      new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'Content-Type': 'text/event-stream' },
        },
      ),
    );
    const output = [];
    for await (const event of service.runStream(agent, 'stream', '搜索')) output.push(event);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.stream).toBe(true);
    expect(output).toContainEqual({ type: 'text_delta', data: { text: '找到公告。' } });
    expect(output.find((event) => event.type === 'message_end')?.data).toMatchObject({
      content: '找到公告。\n\n来源：\n- [公告](https://example.com/news)',
      toolCalls: null,
    });
  });

  it('OpenAI 流式与子代理路径保留搜索引用', async () => {
    const annotation = {
      type: 'url_citation',
      url: 'https://example.com/news',
      title: '公告',
      start_index: 0,
      end_index: 5,
    };
    const final = await response('找到公告。', [annotation]).json();
    const events = [
      { type: 'response.created', response: { ...final, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...final.output[0], status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: 0, item: final.output[0] },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...final.output[1], content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        delta: '找到公告。',
      },
      {
        type: 'response.output_text.annotation.added',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        annotation_index: 0,
        annotation,
      },
      {
        type: 'response.output_text.done',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        text: '找到公告。',
      },
      {
        type: 'response.content_part.done',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        part: final.output[1].content[0],
      },
      { type: 'response.output_item.done', output_index: 1, item: final.output[1] },
      { type: 'response.completed', response: final },
    ];
    const streamReply = () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    replies.push(streamReply());
    const output = [];
    for await (const event of service.runStream(agent, 'openai-stream', '搜索')) output.push(event);
    expect(output.find((event) => event.type === 'message_end')?.data.content).toContain(
      '[公告](https://example.com/news)',
    );
    expect(requests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(requests[0].body.tools).toEqual([{ type: 'web_search' }]);

    replies.push(streamReply());
    const onEvent = jest.fn();
    const subAnswer = await service.runSubAgent(agent, '搜索', { onEvent });
    expect(subAnswer).toContain('[公告](https://example.com/news)');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'message_end' }));
  });

  it('模型网关拒绝托管搜索时传播错误，不回退到第三方或无搜索回答', async () => {
    replies.push(
      new Response(
        JSON.stringify({
          error: { message: 'web_search is not supported', type: 'invalid_request_error' },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    await expect(service.run(agent, 'unsupported-gateway', '搜索')).rejects.toThrow('web_search');
    expect(requests).toHaveLength(1);
  });

  it('Kimi 仅启用搜索时，流式工具回传和最终回答仍正常工作', async () => {
    resolved.baseUrl = 'https://api.moonshot.cn/v1';
    resolved.model = 'kimi-k2.5';
    const args = { query: '新闻', context: 'opaque-context' };
    const streamReply = (id: string, delta: object, finishReason: string) => {
      const chunk = (value: object, stop: string | null) => ({
        id,
        object: 'chat.completion.chunk',
        created: 1,
        model: resolved.model,
        choices: [{ index: 0, delta: value, finish_reason: stop }],
      });
      const events = [
        chunk(delta, null),
        {
          ...chunk({}, finishReason),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        {
          headers: { 'Content-Type': 'text/event-stream' },
        },
      );
    };
    replies.push(
      streamReply(
        'kimi-stream-1',
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-stream-kimi',
              type: 'function',
              function: { name: '$web_search', arguments: JSON.stringify(args) },
            },
          ],
        },
        'tool_calls',
      ),
    );
    replies.push(streamReply('kimi-stream-2', { role: 'assistant', content: '搜索完成' }, 'stop'));
    const output = [];
    for await (const event of service.runStream(agent, 'kimi-stream', '搜索')) output.push(event);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.tools).toEqual([
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]);
    expect(requests[1].body.messages).toContainEqual({
      role: 'tool',
      name: '$web_search',
      tool_call_id: 'call-stream-kimi',
      content: JSON.stringify(args),
    });
    expect(output.filter((event) => event.type === 'message_end').at(-1)?.data.content).toBe(
      '搜索完成',
    );
  });
});
