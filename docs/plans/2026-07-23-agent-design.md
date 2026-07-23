# Agent 模块设计文档

**日期**: 2026-07-23
**模块**: `src/agents/`
**分支**: `feat/agent`
**状态**: 设计阶段

---

## 1. 背景与目标

团子后台已有基础 `LlmService`（单轮对话 + 流式），本次在其之上构建完整的 **Agent 平台**：

- 用户可通过前端页面创建/管理多个 Agent 配置（模型、API Key、系统提示词、挂载工具）
- Agent 支持多轮有状态会话（后端持久化历史）
- Agent 可执行 tool loop——内置函数工具（skills）+ 外部 MCP Server 工具
- 提供同步和 SSE 流式两种聊天接口

**技术选型**：LangGraph（`@langchain/langgraph`）+ 官方 MCP SDK（`@modelcontextprotocol/sdk`）。

LangGraph 的理由：已有 `@langchain/anthropic` 底座，LangGraph 的 Checkpointer 抽象优雅处理会话状态持久化，状态图天然支持 tool loop、并行工具调用和后续多 Agent 编排扩展。

**新增依赖**：
```bash
pnpm add @langchain/langgraph @modelcontextprotocol/sdk
```

---

## 2. 模块结构

```
src/agents/
  agents.module.ts              # 模块定义，注册所有 Providers
  agents.controller.ts          # Agent 配置 CRUD
  agents.service.ts             # Agent 配置业务逻辑（CRUD + 加解密）
  conversations.controller.ts   # 会话管理 + 聊天接口
  conversations.service.ts      # 会话创建、消息持久化、Agent 执行入口
  agent-executor.service.ts     # 核心：LangGraph 状态图构建 + 执行
  tools/
    tool-registry.service.ts    # 工具注册表：内置工具 + MCP 客户端管理
    base.tool.ts                # 内置工具抽象基类
    builtin/                    # 内置工具实现（web_search.tool.ts 等）
  entities/
    agent-config.entity.ts
    conversation.entity.ts
    message.entity.ts
    agent-checkpoint.entity.ts
  dto/
    create-agent.dto.ts
    update-agent.dto.ts
    query-agents.dto.ts
    create-conversation.dto.ts
    send-message.dto.ts
  checkpointers/
    typeorm.checkpointer.ts     # LangGraph Checkpointer 的 TypeORM 适配器
```

`AgentsModule` 注册到 `app.module.ts` 的 `imports` 数组末尾，同步更新 CLAUDE.md 注册清单。

---

## 3. 数据库设计

新增 4 张表。关系：`AgentConfig ──< Conversation ──< Message`，`AgentCheckpoint` 独立存 LangGraph 快照（thread_id = conversationId）。

### 3.1 AgentConfig

```typescript
@Entity('agent_configs')
export class AgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column()
  provider: string; // 'anthropic' | 'openai' | 'deepseek'

  @Column()
  model: string;

  @Column({ name: 'api_key_encrypted' })
  apiKeyEncrypted: string; // AES-256-GCM 加密，绝不明文存储

  @Column({ name: 'system_prompt', type: 'text', nullable: true })
  systemPrompt: string;

  @Column({ name: 'max_tokens', default: 4096 })
  maxTokens: number;

  @Column({ name: 'max_iterations', default: 10 })
  maxIterations: number; // tool loop 最大轮次，防止无限循环

  @Column({ name: 'mcp_servers', type: 'json', default: [] })
  mcpServers: McpServerConfig[];

  @Column({ name: 'enabled_tools', type: 'json', default: [] })
  enabledTools: string[]; // 启用的内置工具名列表

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @OneToMany(() => Conversation, (c) => c.agentConfig)
  conversations: Conversation[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string; // stdio 模式：如 "npx @modelcontextprotocol/server-filesystem /tmp"
  url?: string;     // sse 模式：服务端 URL
}
```

### 3.2 Conversation

```typescript
@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string; // 同时作为 LangGraph thread_id

  @ManyToOne(() => AgentConfig, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_config_id' })
  agentConfig: AgentConfig;

  @Column({ name: 'agent_config_id' })
  agentConfigId: string;

  @Column({ nullable: true })
  title: string; // 默认取首条用户消息前 30 字

  @Column({ type: 'enum', enum: ['active', 'archived'], default: 'active' })
  status: 'active' | 'archived';

  @OneToMany(() => Message, (m) => m.conversation)
  messages: Message[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

### 3.3 Message

```typescript
@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'conversation_id' })
  conversationId: string;

  @Column({ type: 'enum', enum: ['user', 'assistant', 'tool'] })
  role: 'user' | 'assistant' | 'tool';

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'tool_calls', type: 'json', nullable: true })
  toolCalls: ToolCallRecord[] | null;

  @Column({ name: 'tool_call_id', nullable: true })
  toolCallId: string | null; // tool 结果消息关联的 call id

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
```

Message 表是**前端读取的展示层**——`GET /api/conversations/:id/messages` 直接查此表，无需反序列化 LangGraph 状态。

### 3.4 AgentCheckpoint

```typescript
@Entity('agent_checkpoints')
export class AgentCheckpoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'thread_id' })
  threadId: string; // = conversationId

  @Column({ name: 'checkpoint_ns', default: '' })
  checkpointNs: string;

  @Column({ name: 'checkpoint_id' })
  checkpointId: string;

  @Column({ name: 'parent_checkpoint_id', nullable: true })
  parentCheckpointId: string | null;

  @Column({ type: 'text' })
  checkpoint: string; // 序列化的 LangGraph 图状态 JSON

  @Column({ name: 'checkpoint_metadata', type: 'text', nullable: true })
  checkpointMetadata: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
```

此表由 `TypeORMCheckpointer` 独占读写，业务代码不直接操作。

---

## 4. 核心执行层

### 4.1 LangGraph 状态定义

```typescript
interface AgentState {
  messages: BaseMessage[];  // 会话消息列表（LangChain 格式）
  iterations: number;       // 当前 tool loop 轮次
  maxIterations: number;    // 最大轮次，从 AgentConfig 读取
}
```

### 4.2 状态图结构（ReAct Loop）

```
START → agent_node → [有 tool_calls 且未超 maxIterations？]
                         ↓ 是            ↓ 否
                     tools_node          END
                         ↓
                     回到 agent_node
```

- **agent_node**：用 `state.messages` 调用 LLM（model 已 `.bindTools(tools)` 绑定），把响应追加到 messages，iterations+1
- **tools_node**：并行执行所有 tool calls，结果封装为 `ToolMessage` 追加到 messages
- **终止条件**：LLM 返回纯文本（无 tool_calls），或达到 maxIterations

### 4.3 AgentExecutorService

```typescript
@Injectable()
export class AgentExecutorService {
  constructor(
    private readonly toolRegistry: ToolRegistryService,
    @InjectRepository(AgentCheckpoint)
    private readonly checkpointRepo: Repository<AgentCheckpoint>,
  ) {}

  async run(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
  ): Promise<NewMessages> {
    const tools = await this.toolRegistry.getToolsForAgent(agentConfig);
    const graph = this.buildGraph(agentConfig, tools);

    const result = await graph.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { configurable: { thread_id: conversationId } },
    );

    return this.extractNewMessages(result.messages);
  }

  // 同上，返回 AsyncGenerator<SseEvent> 用于流式
  async *runStream(
    agentConfig: AgentConfig,
    conversationId: string,
    userMessage: string,
  ): AsyncGenerator<SseEvent> {
    const tools = await this.toolRegistry.getToolsForAgent(agentConfig);
    const graph = this.buildGraph(agentConfig, tools);

    const stream = graph.streamEvents(
      { messages: [new HumanMessage(userMessage)] },
      { configurable: { thread_id: conversationId }, version: 'v2' },
    );

    for await (const event of stream) {
      yield this.mapToSseEvent(event);
    }
  }

  private buildGraph(
    config: AgentConfig,
    tools: StructuredTool[],
  ): CompiledStateGraph<AgentState> {
    const graph = new StateGraph<AgentState>({ channels: agentStateChannels });

    graph.addNode('agent_node', async (state) => {
      const model = this.createModelFromConfig(config).bindTools(tools);
      const response = await model.invoke(state.messages);
      return { messages: [response], iterations: state.iterations + 1 };
    });

    graph.addNode('tools_node', async (state) => {
      const lastMsg = state.messages.at(-1) as AIMessage;
      const results = await Promise.all(
        lastMsg.tool_calls.map(async (call) => {
          const tool = tools.find((t) => t.name === call.name);
          const output = tool
            ? await tool.invoke(call.args).catch((e) => `工具调用失败: ${e.message}`)
            : `未找到工具: ${call.name}`;
          return new ToolMessage({ content: String(output), tool_call_id: call.id });
        }),
      );
      return { messages: results };
    });

    graph.addConditionalEdges('agent_node', (state) => {
      const last = state.messages.at(-1) as AIMessage;
      if (last.tool_calls?.length && state.iterations < state.maxIterations) {
        return 'tools_node';
      }
      return END;
    });

    graph.addEdge('tools_node', 'agent_node');
    graph.setEntryPoint('agent_node');

    return graph.compile({
      checkpointer: new TypeORMCheckpointer(this.checkpointRepo),
    });
  }

  private createModelFromConfig(config: AgentConfig): BaseChatModel {
    const apiKey = decrypt(config.apiKeyEncrypted);
    switch (config.provider) {
      case 'anthropic':
        return new ChatAnthropic({ apiKey, model: config.model, maxTokens: config.maxTokens });
      case 'openai':
        return new ChatOpenAI({ apiKey, model: config.model, maxTokens: config.maxTokens });
      default:
        throw new BadRequestException(`不支持的 provider: ${config.provider}`);
    }
  }
}
```

### 4.4 ToolRegistryService

```typescript
@Injectable()
export class ToolRegistryService implements OnModuleInit, OnModuleDestroy {
  private builtinTools = new Map<string, StructuredTool>();
  private mcpClients = new Map<string, Client>(); // MCP 连接池

  async onModuleInit() {
    this.builtinTools.set('web_search', new WebSearchTool());
    this.builtinTools.set('calculator', new CalculatorTool());
    // 后续新增内置工具在此注册
  }

  async onModuleDestroy() {
    for (const client of this.mcpClients.values()) {
      await client.close();
    }
  }

  async getToolsForAgent(config: AgentConfig): Promise<StructuredTool[]> {
    const tools: StructuredTool[] = [];

    for (const name of config.enabledTools) {
      const tool = this.builtinTools.get(name);
      if (tool) tools.push(tool);
    }

    for (const mcpConfig of config.mcpServers) {
      try {
        const mcpTools = await this.loadMcpTools(mcpConfig);
        tools.push(...mcpTools);
      } catch (e) {
        // MCP 连接失败不阻断整体——跳过该 Server，日志记录警告
        console.warn(`MCP Server "${mcpConfig.name}" 连接失败，已跳过: ${e.message}`);
      }
    }

    return tools;
  }

  private async loadMcpTools(mcpConfig: McpServerConfig): Promise<StructuredTool[]> {
    const client = await this.connectOrGet(mcpConfig);
    const { tools } = await client.listTools();

    return tools.map(
      (t) =>
        new DynamicStructuredTool({
          name: t.name,
          description: t.description,
          schema: t.inputSchema as ZodSchema,
          func: async (input) => {
            const result = await client.callTool({ name: t.name, arguments: input });
            return JSON.stringify(result.content);
          },
        }),
    );
  }

  private async connectOrGet(config: McpServerConfig): Promise<Client> {
    if (this.mcpClients.has(config.name)) return this.mcpClients.get(config.name)!;

    const client = new Client(
      { name: 'tuanzi-agent', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({ command: config.command! })
        : new SSEClientTransport(new URL(config.url!));

    await client.connect(transport);
    this.mcpClients.set(config.name, client);
    return client;
  }
}
```

### 4.5 ConversationsService（执行入口）

```typescript
@Injectable()
export class ConversationsService {
  async sendMessage(
    conversationId: string,
    content: string,
  ): Promise<{ userMessage: Message; agentMessages: Message[] }> {
    const conversation = await this.conversationRepo.findOneOrFail({
      where: { id: conversationId },
      relations: ['agentConfig'],
    });

    // 1. 持久化用户消息
    const userMsg = await this.messageRepo.save(
      this.messageRepo.create({ conversationId, role: 'user', content }),
    );

    // 2. 自动生成会话标题（首条消息前 30 字）
    if (!conversation.title) {
      await this.conversationRepo.update(conversationId, {
        title: content.slice(0, 30),
      });
    }

    // 3. 调用 AgentExecutorService 执行 LangGraph
    const newMsgs = await this.agentExecutor.run(
      conversation.agentConfig,
      conversationId,
      content,
    );

    // 4. 持久化 agent 产生的消息（assistant + tool messages）
    const agentMessages = await this.messageRepo.save(
      newMsgs.map((m) => this.messageRepo.create({ conversationId, ...m })),
    );

    return { userMessage: userMsg, agentMessages };
  }

  // 流式版本：直接透传 AgentExecutorService.runStream() 的 AsyncGenerator
  async *sendMessageStream(
    conversationId: string,
    content: string,
  ): AsyncGenerator<SseEvent> {
    const conversation = await this.conversationRepo.findOneOrFail({
      where: { id: conversationId },
      relations: ['agentConfig'],
    });

    await this.messageRepo.save(
      this.messageRepo.create({ conversationId, role: 'user', content }),
    );

    yield* this.agentExecutor.runStream(
      conversation.agentConfig,
      conversationId,
      content,
    );
  }
}
```

### 4.6 TypeORMCheckpointer

实现 LangGraph 的 `BaseCheckpointSaver` 接口，三个核心方法：

- `get(config)`：按 `thread_id` + `checkpoint_ns` 查最新快照
- `put(config, checkpoint, metadata)`：序列化后写入 `agent_checkpoints`
- `list(config)`：列出某个 thread 的所有快照（用于状态回滚）

---

## 5. REST API 设计

所有接口均需 `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`。

### 5.1 Agent 配置 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents` | 创建 Agent |
| GET | `/api/agents` | 分页列表 |
| GET | `/api/agents/:id` | 详情（API Key 脱敏） |
| PATCH | `/api/agents/:id` | 更新配置 |
| DELETE | `/api/agents/:id` | 软删除（is_active = false） |

`POST /api/agents` 请求体：
```json
{
  "name": "客服助手",
  "provider": "anthropic",
  "model": "claude-opus-4-8",
  "apiKey": "sk-ant-xxxx",
  "systemPrompt": "你是一个专业客服...",
  "maxTokens": 4096,
  "maxIterations": 10,
  "enabledTools": ["web_search"],
  "mcpServers": [
    { "name": "文件系统", "transport": "stdio",
      "command": "npx @modelcontextprotocol/server-filesystem /tmp" }
  ]
}
```

`GET /api/agents/:id` 响应（API Key 永不明文返回）：
```json
{
  "id": "uuid",
  "name": "客服助手",
  "provider": "anthropic",
  "model": "claude-opus-4-8",
  "apiKeyMasked": "****3xYz",
  "systemPrompt": "...",
  "maxTokens": 4096,
  "maxIterations": 10,
  "enabledTools": ["web_search"],
  "mcpServers": [...],
  "isActive": true,
  "createdAt": "2026-07-23T08:00:00Z"
}
```

### 5.2 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agents/:agentId/conversations` | 创建新会话 |
| GET | `/api/agents/:agentId/conversations` | 分页列表 |
| DELETE | `/api/conversations/:id` | 删除（级联删消息 + 检查点） |
| GET | `/api/conversations/:id/messages` | 获取消息历史（分页） |

### 5.3 聊天接口

**同步模式**（等待 Agent 完整执行）：
```
POST /api/conversations/:id/messages
Body: { "content": "帮我分析苹果公司最新股价" }

Response 200:
{
  "userMessage": { "id": "...", "role": "user", "content": "..." },
  "agentMessages": [
    { "id": "...", "role": "assistant", "content": "我先查一下...",
      "toolCalls": [{ "id": "call_xxx", "name": "web_search",
                      "args": { "query": "AAPL stock price" } }] },
    { "id": "...", "role": "tool", "content": "{\"price\":198.5}",
      "toolCallId": "call_xxx" },
    { "id": "...", "role": "assistant", "content": "苹果公司最新股价 198.5 美元..." }
  ]
}
```

**流式模式**（SSE，`?stream=true`）：
```
POST /api/conversations/:id/messages?stream=true
→ Content-Type: text/event-stream

event: message_start
data: {"role":"assistant"}

event: text_delta
data: {"text":"我先查一下"}

event: tool_use
data: {"name":"web_search","args":{"query":"AAPL stock price"}}

event: tool_result
data: {"name":"web_search","content":"{\"price\":198.5}"}

event: text_delta
data: {"text":"苹果公司最新股价 198.5 美元..."}

event: message_end
data: {"conversationId":"...","totalTokens":512}
```

同一个 Controller 方法检测 `?stream=true` query 参数，决定走同步还是流式路径：

```typescript
@Post(':id/messages')
async sendMessage(
  @Param('id', ParseUUIDPipe) id: string,
  @Body() dto: SendMessageDto,
  @Query('stream') stream: string,
  @Res() res: Response,
) {
  if (stream === 'true') {
    // SSE 模式：NestJS @Sse() 仅支持 GET，POST 流式需手动设响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of this.conversationsService.sendMessageStream(id, dto.content)) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
    res.end();
  } else {
    // 同步模式
    const result = await this.conversationsService.sendMessage(id, dto.content);
    res.json(result);
  }
}
```

---

## 6. 安全机制

### 6.1 API Key 加密

三道保护，缺一不可：

1. **写入加密**：`AgentsService.create()` 拿到明文 Key → AES-256-GCM 加密 → 只存密文
2. **返回脱敏**：所有 GET 响应只返回 `apiKeyMasked`（后4位），明文永不出现在 API 响应和日志
3. **使用解密**：仅 `AgentExecutorService.createModelFromConfig()` 内部解密，解密结果只活在函数栈帧

新增环境变量 `AGENT_ENCRYPTION_KEY`（32 字节随机字符串），缺失时 `AgentsService` 构造器 fail-fast 报错，应用拒绝启动。

加密工具函数放 `src/agents/utils/crypto.util.ts`，使用 Node.js 内置 `crypto` 模块（AES-256-GCM），不引入第三方加密库。

### 6.2 新增环境变量

```bash
# Agent 模块配置
AGENT_ENCRYPTION_KEY=your-32-byte-random-key-here
```

同步添加到 `.env.example`。

---

## 7. 错误处理

| 错误发生层 | 错误类型 | 处理方式 |
|-----------|---------|---------|
| Agent 配置 | provider/model 不合法 | DTO 校验 400 |
| LLM 调用 | `AuthenticationError` | 向上抛，Controller 返回 502 |
| LLM 调用 | `RateLimitError` | 向上抛，Controller 返回 429 |
| MCP 连接 | Server 不可达 | `getToolsForAgent()` 捕获，跳过该 Server，log warn |
| Tool 执行 | 单个 tool 失败 | 错误信息封装为 `ToolMessage`，Agent 继续决策 |
| Graph 执行 | 达到 maxIterations | 强制终止，返回当前最后一条 assistant 消息 |
| SSE 流式 | 任意异常 | 发送 `event: error\ndata: {"message":"..."}` 后关闭流 |

**Tool 执行失败设计原则**：单个 tool 报错不终止整个 Agent，而是把错误信息作为 tool 结果返回给 LLM，让 LLM 自行决定是重试、换工具还是直接回复用户。

---

## 8. 测试策略

测试文件放 `test/agents/`，镜像 `src/agents/` 结构，延续项目现有 Jest 风格。

| 测试目标 | Mock 策略 | 覆盖场景 |
|---------|---------|---------|
| `AgentExecutorService` | Mock `ToolRegistryService` + Mock `ChatAnthropic` | tool loop 轮次、maxIterations 截断、无工具调用直接结束 |
| `ToolRegistryService` | Mock `@modelcontextprotocol/sdk` Client | MCP 工具发现/包装、连接失败降级、内置工具注册 |
| `AgentsService` | Mock Repository | 加解密 round-trip、API Key 脱敏返回 |
| `ConversationsService` | Mock `AgentExecutorService` + Mock Repository | 消息持久化、会话 title 自动截取 |
| `TypeORMCheckpointer` | Mock Repository | get/put/list 正确序列化/反序列化 |

---

## 9. 后续扩展路径

| 场景 | 扩展方式 |
|------|---------|
| 新增 provider（DeepSeek / 通义） | `AgentExecutorService.createModelFromConfig()` switch 分支新增，`pnpm add` 对应 LangChain 包 |
| 内置工具市场 | `tools/builtin/` 新增工具文件，`ToolRegistryService.onModuleInit()` 注册，前端展示可选列表 |
| 多 Agent 协作 | LangGraph 多节点图，`AgentExecutorService` 扩展为 supervisor 模式 |
| 人工审批节点 | LangGraph `interrupt()` + WebSocket 通知前端，前端确认后 `graph.continue()` 恢复 |
| Agent 模板 | `AgentConfig` 新增 `isTemplate` 字段，支持从模板克隆创建 |
| 可观测性 | 接入 LangSmith：设置 `LANGCHAIN_API_KEY` + `LANGCHAIN_TRACING_V2=true`，零代码改动自动追踪每次 Agent 执行 |

---

*文档版本 v1.0 | 维护者：团子项目组 | 最后更新：2026-07-23*
