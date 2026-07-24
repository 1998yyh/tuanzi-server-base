# Agent 模块设计文档

**日期**: 2026-07-23
**模块**: `src/agents/`
**分支**: `feat/agent`
**状态**: ✅ 已实现（2026-07-24，含文末「实施修正记录」）

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
pnpm add @langchain/langgraph @modelcontextprotocol/sdk @langchain/mcp-adapters
```

`@langchain/mcp-adapters` 负责将 MCP 工具的 JSON Schema 正确转换为 LangChain 所需的 Zod Schema，不引入它直接 `as ZodSchema` 强转会在运行时崩溃。

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
// provider 枚举：扩展时在此添加，switch 分支同步更新
export enum ProviderType {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  DEEPSEEK = 'deepseek',
}

@Entity('agent_configs')
export class AgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ── 用户归属（多用户隔离核心字段）──────────────────────────
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: string;
  // ─────────────────────────────────────────────────────────

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'enum', enum: ProviderType })
  provider: ProviderType;

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
  // ⚠️ stdio 模式直接在服务端执行子进程，仅允许管理员角色配置
  // 普通用户只能使用 sse 模式连接已部署的 MCP Server
  command?: string; // stdio 模式：如 "npx @modelcontextprotocol/server-filesystem /tmp"
  url?: string;     // sse 模式：服务端 URL
}
```

### 3.2 Conversation

```typescript
export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

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

  @Column({ type: 'enum', enum: ConversationStatus, default: ConversationStatus.ACTIVE })
  status: ConversationStatus;

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
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ name: 'conversation_id' })
  conversationId: string;

  @Column({ type: 'enum', enum: MessageRole })
  role: MessageRole;

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

  // MEDIUMTEXT（16MB）：LangGraph 每步追加一行，多轮 tool loop 后状态 JSON 轻松超出 TEXT 的 65KB 上限
  @Column({ type: 'mediumtext' })
  checkpoint: string; // 序列化的 LangGraph 图状态 JSON

  @Column({ name: 'checkpoint_metadata', type: 'mediumtext', nullable: true })
  checkpointMetadata: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
```

此表由 `TypeORMCheckpointer` 独占读写，业务代码不直接操作。

**⚠️ 表膨胀说明**：LangGraph 采用追加写入模式，每个图节点执行完都会插入一条新记录（类似事件溯源），不会更新已有行。一次5轮 tool loop 的 Agent 执行会写入约6条记录。长期运行后此表是全库增长最快的表，必须有清理策略：

| 触发时机 | 清理范围 | 实现位置 |
|---------|---------|---------|
| 会话归档（`status → ARCHIVED`） | 删除该 `thread_id` 的全部 checkpoint 行 | `ConversationsService.archiveConversation()` |
| 会话删除 | 同上（`onDelete: 'CASCADE'` 无法覆盖，因为 AgentCheckpoint 不与 Conversation 建外键，需手动删） | `ConversationsService.remove()` |
| 定期维护任务（可选） | 每个 `thread_id` 只保留最新 N 条，清理超出部分 | 独立 cron job |

> 当前版本实现最小集：会话删除时手动清理对应 checkpoint 行，暂不引入 cron job。

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
// 本次执行新增的消息数据，用于持久化到 Message 表
export interface NewMessageData {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRecord[] | null;
  toolCallId?: string | null;
}

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
  ): Promise<NewMessageData[]> {
    const tools = await this.toolRegistry.getToolsForAgent(agentConfig);
    const graph = this.buildGraph(agentConfig, tools);

    // 记录调用前的消息数，用于提取本轮新增消息
    // graph.invoke 返回的 messages 包含完整历史（Checkpointer 恢复的旧消息 + 本次新消息）
    // 直接取 result.messages 会把历史重复写进 Message 表
    const stateBefore = await graph.getState({ configurable: { thread_id: conversationId } });
    const previousCount = stateBefore?.values?.messages?.length ?? 0;

    const result = await graph.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { configurable: { thread_id: conversationId } },
    );

    // 只取本轮新增部分（跳过 userMessage 本身，它已由 ConversationsService 单独持久化）
    const newLangChainMessages = result.messages.slice(previousCount + 1);
    return newLangChainMessages.map((m) => this.toLangChainMessageData(m));
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
      const TOOL_TIMEOUT_MS = 30_000; // 单个工具最长执行时间，超时视为失败让 LLM 决策
      const results = await Promise.all(
        lastMsg.tool_calls.map(async (call) => {
          const tool = tools.find((t) => t.name === call.name);
          const output = tool
            ? await Promise.race([
                tool.invoke(call.args),
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error(`工具调用超时（${TOOL_TIMEOUT_MS / 1000}s）`)), TOOL_TIMEOUT_MS),
                ),
              ]).catch((e: Error) => `工具调用失败: ${e.message}`)
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
    // 必须用 @langchain/mcp-adapters 的 loadMcpTools 做 JSON Schema → Zod 转换
    // MCP 返回的 inputSchema 是 JSON Schema 对象，不是 Zod 实例
    // 直接 `as ZodSchema` 强转只骗过 TypeScript，运行时 LangChain 调用 .parse() 必然崩溃
    const { loadMcpTools } = await import('@langchain/mcp-adapters');
    return loadMcpTools(client);
  }

  private async connectOrGet(config: McpServerConfig): Promise<Client> {
    // 以 transport + endpoint 为 key，防止同名但不同 URL/command 的配置复用错误连接
    const cacheKey = `${config.transport}:${config.url ?? config.command}`;
    if (this.mcpClients.has(cacheKey)) return this.mcpClients.get(cacheKey)!;

    const client = new Client(
      { name: 'tuanzi-agent', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    const transport =
      config.transport === 'stdio'
        ? new StdioClientTransport({ command: config.command! })
        : new SSEClientTransport(new URL(config.url!));

    await client.connect(transport);
    this.mcpClients.set(cacheKey, client);
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

  // 流式版本：透传 SSE 事件同时收集 agent 消息，流结束后持久化到 Message 表
  async *sendMessageStream(
    conversationId: string,
    content: string,
  ): AsyncGenerator<SseEvent> {
    const conversation = await this.conversationRepo.findOneOrFail({
      where: { id: conversationId },
      relations: ['agentConfig'],
    });

    await this.messageRepo.save(
      this.messageRepo.create({ conversationId, role: MessageRole.USER, content }),
    );

    // 收集本轮 agent 产生的所有消息，用于流结束后持久化
    const pendingMessages: Partial<Message>[] = [];
    let currentContent = '';
    let currentToolCalls: ToolCallRecord[] = [];

    for await (const event of this.agentExecutor.runStream(
      conversation.agentConfig,
      conversationId,
      content,
    )) {
      yield event; // 先透传给 Controller，保证流不被阻塞

      // 同步追踪消息内容，供后续持久化
      switch (event.type) {
        case 'message_start':
          currentContent = '';
          currentToolCalls = [];
          break;
        case 'text_delta':
          currentContent += (event.data as { text: string }).text;
          break;
        case 'tool_use':
          currentToolCalls.push({
            id: (event.data as { id: string }).id,
            name: (event.data as { name: string }).name,
            args: (event.data as { args: Record<string, unknown> }).args,
          });
          break;
        case 'tool_result':
          pendingMessages.push({
            conversationId,
            role: MessageRole.TOOL,
            content: String((event.data as { content: unknown }).content),
            toolCallId: (event.data as { callId: string }).callId,
          });
          break;
        case 'message_end':
          if (currentContent || currentToolCalls.length) {
            pendingMessages.push({
              conversationId,
              role: MessageRole.ASSISTANT,
              content: currentContent,
              toolCalls: currentToolCalls.length ? currentToolCalls : null,
            });
          }
          break;
      }
    }

    // 流结束后统一持久化，保证消息历史完整
    if (pendingMessages.length) {
      await this.messageRepo.save(
        pendingMessages.map((m) => this.messageRepo.create(m)),
      );
    }
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

**软删除行为约定**：

- `GET /api/agents` 列表默认只返回 `is_active = true` 的记录，软删除的 Agent 不出现在列表中
- 软删除后，向该 Agent 下的 Conversation 发消息时，`ConversationsService.sendMessage()` 检查 `agentConfig.isActive`，为 `false` 时抛 `GoneException`（410），告知前端 Agent 已停用
- 当前版本不提供重新激活接口（YAGNI），需要时通过 `PATCH /api/agents/:id` 传 `{ "isActive": true }` 恢复

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
data: {"id":"call_xxx","name":"web_search","args":{"query":"AAPL stock price"}}

event: tool_result
data: {"callId":"call_xxx","name":"web_search","content":"{\"price\":198.5}"}

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

### 6.1 MCP stdio 权限隔离

`stdio` 类型的 MCP Server 会在后端直接执行子进程（`command` 字段中的任意 shell 命令）。若允许普通认证用户自由填写 `command`，等同于向其开放服务器 shell 权限。

**强制规则**：

- `transport: 'stdio'` 配置项**仅管理员角色可写**，`AgentsService.create/update` 在保存前必须校验当前用户角色，非管理员提交 stdio 类型直接 `403 Forbidden`。
- `transport: 'sse'` 普通用户可用，只允许连接已独立部署的 MCP Server，风险可控。
- 后续若需要对 stdio 开放，必须引入 command 白名单机制，禁止任意字符串传入。

### 6.2 API Key 加密

三道保护，缺一不可：

1. **写入加密**：`AgentsService.create()` 拿到明文 Key → AES-256-GCM 加密 → 只存密文
2. **返回脱敏**：所有 GET 响应只返回 `apiKeyMasked`（后4位），明文永不出现在 API 响应和日志
3. **使用解密**：仅 `AgentExecutorService.createModelFromConfig()` 内部解密，解密结果只活在函数栈帧

新增环境变量 `AGENT_ENCRYPTION_KEY`（32 字节随机字符串），缺失时 `AgentsService` 构造器 fail-fast 报错，应用拒绝启动。

加密工具函数放 `src/agents/utils/crypto.util.ts`，使用 Node.js 内置 `crypto` 模块（AES-256-GCM），不引入第三方加密库。

**`crypto.util.ts` 存储格式约定**（必须严格遵守，否则解密必然失败）：

- IV：12 字节（GCM 推荐长度），每次加密随机生成，**绝不复用**
- authTag：16 字节，由 GCM 模式自动生成
- 数据库存储格式：`hex(iv):hex(ciphertext + authTag)`，两段均为十六进制字符串，冒号分隔

```typescript
// crypto.util.ts 参考实现
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${Buffer.concat([encrypted, tag]).toString('hex')}`;
}

export function decrypt(stored: string, keyHex: string): string {
  const [ivHex, dataHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const tag = data.subarray(data.length - TAG_BYTES);
  const ciphertext = data.subarray(0, data.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
```

### 6.3 新增环境变量

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

**⚠️ 当前已知限制——并发请求**：

同一 `conversationId` 不支持并发请求。若两个请求同时进入，两个 LangGraph 执行都会读取同一 thread 的 Checkpoint，各自追加消息后写回，造成状态覆盖和消息乱序。

**当前版本要求**：前端必须保证同一会话串行发消息，在上一条消息的响应（同步 200 或 SSE `message_end`）返回前，禁止发出下一条。

后续如需支持并发，方案是在 `ConversationsService.sendMessage()` 入口处用数据库行锁保护：
```typescript
// 使用 SELECT ... FOR UPDATE 锁住会话行，确保同一 conversation 串行执行
await this.dataSource.transaction(async (em) => {
  await em.getRepository(Conversation).findOne({
    where: { id: conversationId },
    lock: { mode: 'pessimistic_write' },
  });
  // ... 后续 Agent 执行
});
```

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

---

## 10. 实施修正记录（2026-07-24）

实施时核实 `@langchain/langgraph@1.4.8` / `@langchain/mcp-adapters@1.1.3` / `@modelcontextprotocol/sdk@1.29.0` / `@langchain/openai@1.5.5`，本文档代码草案基于旧版 API，以下为实际落地的差异：

| # | 修正 | 说明 |
|---|------|------|
| 1 | LangGraph 1.x 状态定义 | `new StateGraph({ channels })` 是 0.x 旧写法，实际用 `Annotation.Root` + `messagesStateReducer`，入口边用 `addEdge(START, 'agent_node')` |
| 2 | Checkpointer 接口 | 1.x `BaseCheckpointSaver` 抽象方法为 `getTuple`/`list`(AsyncGenerator)/`put`(4 参含 newVersions)/`putWrites`/`deleteThread`，实现参照官方 MemorySaver；序列化产物为 `Uint8Array`，base64 后存 MEDIUMTEXT |
| 3 | AgentCheckpoint 主键 | 改自增 number（「取最新快照」按自增主键排序），thread/ns/id 三元组加唯一复合索引 |
| 4 | 新增第 5 张表 `agent_checkpoint_writes` | putWrites 被调用时对应 checkpoint 行可能尚未写入，独立 writes 表是官方各 saver 通用做法 |
| 5 | `loadMcpTools` 签名 | 实际为 `loadMcpTools(serverName, client, opts?)`，首参 serverName 必传 |
| 6 | MySQL JSON 列默认值 | `mcp_servers`/`enabled_tools` 改 `nullable: true`（MySQL JSON 列不支持字面 DEFAULT），读取处 `?? []` |
| 7 | 多用户隔离 | AgentConfig 已含 userId 字段；所有 Agent/会话接口按当前用户过滤，查不到统一 404（设计文档 API 章节未写，实现已补齐） |
| 8 | 响应脱敏 | 所有返回 AgentConfig 的接口走 `toResponse()` 显式挑字段，只返回 `apiKeyMasked`，密文与 userId 不外泄 |
| 9 | SSE 时序 | `ConversationsService` 拆 `prepareStream()`（同步校验 + 持久化用户消息）与 `streamMessages()`；Controller 先 await 校验再发响应头，流内异常发 `event: error` 后关闭 |
| 10 | 角色体系 | User 实体新增 `role` 列（`user`/`admin`，默认 `user`），stdio MCP 仅 admin 可配（403）；首个管理员手工 SQL 提权；注册逻辑无需改动 |
| 11 | 流式持久化 | assistant 消息以 `message_end` 事件携带的最终 AIMessage 内容为准（真实事件序中 tool_use 发生在 message_end 之后，逐事件拼接不可靠）；text_delta/tool_use 仅用于前端实时展示 |
| 12 | Provider 范围 | 本期实现 anthropic + openai（已装 `@langchain/openai`）；deepseek 枚举保留但 `createModelFromConfig` 抛「暂不支持」 |
| 13 | 归档接口 | 本期不实现，`ConversationStatus.ARCHIVED` 枚举预留；checkpoint 清理仅在 `DELETE /api/conversations/:id` 时执行（调 `checkpointer.deleteThread`） |
| 14 | 内置工具 | `web_search` 配置 `TAVILY_API_KEY` 走 Tavily，未配置时返回明确错误文案交 LLM 决策；`calculator` 为无 eval 的递归下降解析器 |
| 15 | 额外直接依赖 | `@langchain/langgraph-checkpoint`（pnpm 不提升传递依赖）与 `zod` 需显式安装 |

*文档版本 v1.1 | 维护者：团子项目组 | 最后更新：2026-07-24*
