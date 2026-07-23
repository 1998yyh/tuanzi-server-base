# LLM 模块设计文档

**日期**: 2026-07-23
**模块**: `src/llm/`
**分支**: `feat/llm`
**状态**: 已实现

---

## 1. 背景与目标

团子后台后续需要接入 LLM 能力（股票数据分析、agent、workflow 等），本次只做**基础 LLM 模块**——以 LangChain 为基础，提供稳固、可扩展的服务层，不暴露 HTTP 接口，不实现具体业务逻辑。

使用 LangChain 的理由：provider 切换（Anthropic / OpenAI / DeepSeek）只改配置，结构化输出解析内置，`system` 消息跨 provider 差异由框架处理，后续接入 LangSmith 可观测性无缝集成。

**本次范围**

- 同步单轮对话 `chat()`
- 流式返回 `chatStream()`
- tool use 参数透传（不执行 tool loop）
- 首个实现：Anthropic Claude（`@langchain/anthropic`）

**不在本次范围**

- HTTP 接口（无 Controller）
- Tool execution loop（agent 功能）
- 多轮会话状态管理
- Prompt 模板管理
- 重试 / 限速 / 缓存策略

---

## 2. 文件结构

```
src/llm/
  llm.module.ts     # 模块定义，注册 LlmService
  llm.service.ts    # 包装 LangChain ChatModel，对外暴露 chat/chatStream
  llm.types.ts      # 业务类型：LlmMessage / LlmResponse / LlmChatOptions
```

无 Controller，`LlmModule` 只 `exports: [LlmService]`。`providers/` 目录不存在——provider 抽象由 LangChain 的 `BaseChatModel` 承担，无需自行实现。

---

## 3. 核心业务类型（`llm.types.ts`）

对外暴露自有类型，调用方不直接依赖 LangChain 类型，便于后续切换底层实现。

```typescript
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** tool use 透传，inputSchema 为原始 JSON Schema */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmChatOptions {
  model?: string;     // 不传则使用 LLM_DEFAULT_MODEL
  maxTokens?: number; // 不传则使用 LLM_MAX_TOKENS
  tools?: LlmTool[];  // 透传给 LangChain bindTools，本模块不执行 tool loop
}

export interface LlmResponse {
  content: string;    // 仅含文本内容；tool_use block 静默丢弃（见第 5 节）
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

---

## 4. 新增依赖

```bash
pnpm add @langchain/core @langchain/anthropic
```

不安装 `langchain` 主包——chains / agents / document loaders 当前用不到，等需要再加（YAGNI）。

---

## 5. LlmService 实现

`LlmService` 是唯一对外接口，内部持有 `ChatAnthropic` 实例，负责：

- 消息类型转换（`LlmMessage` → LangChain `BaseMessage`）
- per-call 参数覆盖（model / maxTokens / tools）
- 响应结果映射回 `LlmResponse`

```typescript
@Injectable()
export class LlmService {
  private readonly defaultModel: ChatAnthropic;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY 未配置，LlmService 无法初始化');
    }
    this.defaultModel = new ChatAnthropic({
      apiKey,
      model: config.get<string>('LLM_DEFAULT_MODEL', 'claude-opus-4-8'),
      maxTokens: Number(config.get('LLM_MAX_TOKENS', '4096')),
    });
  }

  async chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse> {
    const model = this.resolveModel(options);
    const response = await model.invoke(this.toBaseMessages(messages));
    return {
      content: this.extractText(response.content),
      model: (response.response_metadata?.model as string) ?? options?.model ?? 'unknown',
      usage: response.usage_metadata
        ? {
            inputTokens: response.usage_metadata.input_tokens,
            outputTokens: response.usage_metadata.output_tokens,
          }
        : undefined,
    };
  }

  async *chatStream(
    messages: LlmMessage[],
    options?: LlmChatOptions,
  ): AsyncGenerator<string> {
    const model = this.resolveModel(options);
    const stream = await model.stream(this.toBaseMessages(messages));
    for await (const chunk of stream) {
      const text = this.extractText(chunk.content);
      if (text) yield text;
    }
  }

  /** 根据 per-call options 决定使用默认实例或创建覆盖实例 */
  private resolveModel(options?: LlmChatOptions): ChatAnthropic {
    if (!options?.model && !options?.maxTokens && !options?.tools?.length) {
      return this.defaultModel;
    }
    const overrideModel = new ChatAnthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY')!,
      model: options.model ?? this.config.get<string>('LLM_DEFAULT_MODEL', 'claude-opus-4-8'),
      maxTokens: Number(
        options.maxTokens ?? this.config.get('LLM_MAX_TOKENS', '4096'),
      ),
    });
    if (options.tools?.length) {
      return overrideModel.bindTools(
        options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema, // LangChain 内部转换为 Anthropic SDK snake_case 格式
        })),
      ) as unknown as ChatAnthropic;
    }
    return overrideModel;
  }

  /** LlmMessage[] → LangChain BaseMessage[]；system 消息由 LangChain 自动处理 */
  private toBaseMessages(messages: LlmMessage[]): BaseMessage[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case 'user':
          return new HumanMessage(msg.content);
        case 'assistant':
          return new AIMessage(msg.content);
        case 'system':
          return new SystemMessage(msg.content);
      }
    });
  }

  /**
   * 从 LangChain content 提取纯文本。
   * 当传入 tools 时 LLM 可能返回 ContentBlock[]，只取 type=text 的部分；
   * tool_use block 静默丢弃，本模块不执行 tool loop。
   */
  private extractText(content: string | unknown[]): string {
    if (typeof content === 'string') return content;
    return (content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}
```

**调用示例（未来 `StockAnalysisService`）**：

```typescript
constructor(private readonly llm: LlmService) {}

async analyze(prompt: string): Promise<string> {
  const res = await this.llm.chat([{ role: 'user', content: prompt }]);
  return res.content;
}
```

---

## 6. LlmModule 注册

```typescript
@Module({
  imports: [ConfigModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
```

在 `app.module.ts` 的 `imports` 数组末尾添加 `LlmModule`（同步更新 CLAUDE.md 注册清单）。

`ConfigModule` 在 `app.module.ts` 已配置 `isGlobal: true`，`LlmModule` 无需重复 import，但显式写出更清晰。

---

## 7. 环境变量

新增至 `.env.example`：

```bash
# LLM 配置
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key-here
LLM_DEFAULT_MODEL=claude-opus-4-8
LLM_MAX_TOKENS=4096
```

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `ANTHROPIC_API_KEY` | 是 | — | 缺失时 `LlmService` 构造报错（fail-fast） |
| `LLM_DEFAULT_MODEL` | 否 | `claude-opus-4-8` | 调用时未传 `model` 的兜底 |
| `LLM_MAX_TOKENS` | 否 | `4096` | 调用时未传 `maxTokens` 的兜底；从 env 读取后必须 `Number()` 转换 |

`LLM_PROVIDER` 字段保留在 `.env.example` 作为文档说明，当前代码中未使用（只有 Anthropic 实现）。切换 provider 时修改 `LlmService` 中的 `ChatAnthropic` 为对应 LangChain 模型类。

---

## 8. 错误处理

- **启动阶段**：`ANTHROPIC_API_KEY` 缺失 → `LlmService` 构造抛 `Error`（应用无法启动）
- **运行阶段**：LangChain / SDK 错误不在本模块捕获，原样向上抛给调用方 Service 处理
- **流式场景**：`chatStream` 返回 `AsyncGenerator`，异常在 `for await` 时抛出，调用方 try/catch

调用方可能收到的常见错误类型（LangChain 包装后仍透出 SDK 原始错误）：

| 错误类 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `Anthropic.AuthenticationError` | 401 | API Key 无效或已吊销 |
| `Anthropic.RateLimitError` | 429 | 触发限速，需退避重试 |
| `Anthropic.APIConnectionTimeoutError` | — | 请求超时 |
| `Anthropic.APIConnectionError` | — | 网络连接失败 |

> 后续如需统一重试/限速策略，在 `LlmService` 层包 retry wrapper，不改公共接口。

---

## 9. 测试策略

### `src/llm/llm.service.spec.ts`

Mock `@langchain/anthropic` 的 `ChatAnthropic`（`jest.mock('@langchain/anthropic')`），不发真实 HTTP 请求，覆盖场景：

1. `chat()` 正常返回，`LlmResponse` 字段映射正确（content / model / usage）
2. `chatStream()` 多 chunk yield，文本正确拼接
3. `system` 消息转换为 `SystemMessage`（验证 `toBaseMessages` 输出）
4. 传入 `tools` 时调用 `bindTools`，`inputSchema` 映射为 `input_schema`
5. 响应中 `tool_use` block 被丢弃，`content` 只含文本
6. `ANTHROPIC_API_KEY` 缺失时构造函数抛错
7. `options.model` / `options.maxTokens` 覆盖时创建新模型实例

---

## 10. 后续扩展路径

| 场景 | 扩展方式 |
|------|---------|
| 接入 OpenAI | `pnpm add @langchain/openai`，`LlmService` 中替换 `ChatAnthropic` 为 `ChatOpenAI` |
| 接入 DeepSeek / 通义 | 同上，使用对应 LangChain 包 |
| 多 provider 动态切换 | `LlmModule` 工厂函数按 `LLM_PROVIDER` env 实例化不同模型类，通过 DI token 注入 |
| Agent tool execution | 独立 `AgentService` 注入 `LlmService`，自行实现 tool loop，不改本模块接口 |
| 多轮会话 | 调用方自行维护 `LlmMessage[]` 历史，`chat()` 接受完整 messages 数组 |
| 限速 / 重试 | `LlmService` 层包 retry wrapper，或接入 LangChain 的 `RetryWithFallbacks` |
| 可观测性 | 接入 LangSmith：`pnpm add langsmith`，设置 `LANGCHAIN_API_KEY` 环境变量，零代码改动即可追踪每次调用 |

---

*文档版本 v2.0 | 维护者：团子项目组 | 最后更新：2026-07-23*
