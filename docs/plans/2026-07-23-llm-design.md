# LLM 模块设计文档

**日期**: 2026-07-23
**模块**: `src/llm/`
**分支**: `feat/llm`
**状态**: 草稿

---

## 1. 背景与目标

团子后台后续需要接入 LLM 能力（股票数据分析、agent、workflow 等），本次只做**基础 LLM 模块**——提供稳固、可扩展的服务层，不暴露 HTTP 接口，不实现具体业务逻辑。

**本次范围**

- 同步单轮对话 `chat()`
- 流式返回 `chatStream()`
- tool use 参数透传（不执行 tool loop）
- 抽象 provider 接口，以 Anthropic Claude 为首个实现

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
  llm.module.ts                    # 模块定义，动态注册 provider
  llm.service.ts                   # 对外服务，其他模块注入使用
  providers/
    llm-provider.interface.ts      # ILlmProvider 接口 + 所有公共类型
    anthropic.provider.ts          # Anthropic Claude 实现（首个落地 provider）
  dto/
    llm-chat.dto.ts                # 内部 DTO（非 HTTP，无 @ApiProperty）
```

无 Controller，`LlmModule` 只 `exports: [LlmService]`。

---

## 3. 核心类型与接口

### 3.1 公共类型（`llm-provider.interface.ts`）

```typescript
export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** tool use 透传，结构对齐 Anthropic SDK，其他 provider 自行适配 */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // 原始 JSON Schema，不做约束
}

export interface LlmChatOptions {
  model?: string;     // 不传则使用 LLM_DEFAULT_MODEL
  maxTokens?: number; // 不传则使用 LLM_MAX_TOKENS
  tools?: LlmTool[];  // 透传给底层 SDK，本模块不执行 tool loop
}

export interface LlmResponse {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

### 3.2 ILlmProvider 接口

```typescript
export interface ILlmProvider {
  /**
   * 同步单轮对话，等待完整响应后返回
   */
  chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse>;

  /**
   * 流式返回，每个 yield 为文本增量（delta）
   * 调用方负责消费：SSE / WebSocket / 直接拼接
   */
  chatStream(
    messages: LlmMessage[],
    options?: LlmChatOptions,
  ): AsyncGenerator<string>;
}

export const LLM_PROVIDER_TOKEN = 'LLM_PROVIDER';
```

---

## 4. Provider 实现：AnthropicProvider

### 4.1 新增依赖

```bash
pnpm add @anthropic-ai/sdk
```

### 4.2 实现要点

- 使用 `@anthropic-ai/sdk` 官方 SDK，不走原始 HTTP
- `chat()`：调用 `client.messages.create()`，等待完整响应
- `chatStream()`：调用 `client.messages.stream()`，逐 chunk yield `text_delta`
- `tools` 参数直接映射到 SDK 的 `tools` 字段（`input_schema` 用 snake_case）
- `ANTHROPIC_API_KEY` 缺失时构造函数抛错（fail-fast，同 `JWT_SECRET` 风格）
- 默认模型 `claude-opus-4-8`，由 `LLM_DEFAULT_MODEL` 覆盖

### 4.3 tools 参数映射

`LlmTool.inputSchema`（camelCase）在 `AnthropicProvider` 内部转成 SDK 要求的 `input_schema`（snake_case），对调用方透明。

---

## 5. LlmModule 注册

工厂 provider 动态实例化，`LLM_PROVIDER` 不在支持列表直接抛错，不给未知 provider 静默运行的机会。

```typescript
@Module({
  providers: [
    {
      provide: LLM_PROVIDER_TOKEN,
      useFactory: (config: ConfigService): ILlmProvider => {
        const name = config.get<string>('LLM_PROVIDER', 'anthropic');
        switch (name) {
          case 'anthropic':
            return new AnthropicProvider(config);
          // case 'openai':
          //   return new OpenAIProvider(config);
          default:
            throw new Error(
              `不支持的 LLM provider: "${name}"，请检查 LLM_PROVIDER 环境变量`,
            );
        }
      },
      inject: [ConfigService],
    },
    LlmService,
  ],
  exports: [LlmService],
})
export class LlmModule {}
```

在 `app.module.ts` 的 `imports` 数组末尾添加 `LlmModule`（同步更新 CLAUDE.md 注册清单）。

---

## 6. LlmService

薄包装层，只负责将 `ILlmProvider` 暴露给其他 NestJS 模块，不含业务逻辑。

```typescript
@Injectable()
export class LlmService {
  constructor(
    @Inject(LLM_PROVIDER_TOKEN) private readonly provider: ILlmProvider,
  ) {}

  chat(messages: LlmMessage[], options?: LlmChatOptions): Promise<LlmResponse> {
    return this.provider.chat(messages, options);
  }

  chatStream(
    messages: LlmMessage[],
    options?: LlmChatOptions,
  ): AsyncGenerator<string> {
    return this.provider.chatStream(messages, options);
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
| `LLM_PROVIDER` | 否 | `anthropic` | 不在支持列表时启动报错 |
| `ANTHROPIC_API_KEY` | 是（Anthropic） | — | 缺失时 `AnthropicProvider` 构造报错 |
| `LLM_DEFAULT_MODEL` | 否 | `claude-opus-4-8` | 调用时未传 `model` 的兜底 |
| `LLM_MAX_TOKENS` | 否 | `4096` | 调用时未传 `maxTokens` 的兜底 |

---

## 8. 错误处理

- **启动阶段**：`ANTHROPIC_API_KEY` 缺失 → `AnthropicProvider` 构造抛 `Error`（应用无法启动，暴露问题最早）
- **运行阶段**：SDK 的网络/鉴权/限速错误**不在本模块捕获**，直接向上抛给调用方 Service 处理
- **流式场景**：`chatStream` 返回 `AsyncGenerator`，异常在 `for await` 时抛出，调用方 try/catch

---

## 9. 测试策略

- 测试文件：`src/llm/llm.service.spec.ts`
- Mock `LLM_PROVIDER_TOKEN`（`useValue` mock），不发真实 HTTP 请求
- 覆盖场景：
  1. `chat()` 正常返回完整响应
  2. `chatStream()` 多 chunk yield
  3. `LLM_PROVIDER` 未知值 → 模块加载时抛错

---

## 10. 后续扩展路径

| 场景 | 扩展方式 |
|------|---------|
| 接入 OpenAI | 新增 `openai.provider.ts`，`switch` 加 `case 'openai'` |
| 接入 DeepSeek / 通义 | 同上 |
| Agent tool execution | 独立 `AgentService` 注入 `LlmService`，不改本模块接口 |
| 多轮会话 | 调用方自行维护 `LlmMessage[]` 历史，`chat()` 接受完整 messages 数组 |
| 限速 / 重试 | 在 `LlmService` 层包 retry wrapper，不改 provider 接口 |

---

*文档版本 v1.0 | 维护者：团子项目组 | 最后更新：2026-07-23*

