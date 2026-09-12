# Agent 使用供应商内置联网搜索

Agent 和 Skill 继续通过 `enabledTools: ["web_search"]` 开启联网搜索。搜索交给模型供应商执行，服务端不再请求 Tavily，不需要 `TAVILY_API_KEY` 或额外搜索服务凭据。已有配置无需迁移，关闭搜索时保留原有模型调用方式。

## 接口映射

| 渠道                         | 请求方式                     | 搜索声明                                                                |
| ---------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| Anthropic 格式               | Messages API                 | `{ "type": "web_search_20250305", "name": "web_search" }`               |
| OpenAI 格式                  | 启用搜索时使用 Responses API | `{ "type": "web_search" }`                                              |
| Kimi / Moonshot，OpenAI 格式 | Chat Completions             | `{ "type": "builtin_function", "function": { "name": "$web_search" } }` |
| DeepSeek                     | 开启内置搜索时返回明确错误   | 当前官方兼容性指南标注内置搜索会被忽略                                  |

Kimi 根据官方域名（moonshot.cn、moonshot.ai、kimi.com）或模型名称中的 kimi / moonshot 前缀识别，因此也能用于保留模型名称的代理网关。DeepSeek 同样根据官方域名或模型名前缀识别。其他 OpenAI 格式网关开启搜索时须支持 Responses API 和对应内置工具；接口拒绝时直接传播错误，不静默退回无搜索回答。

## 实现

- `WebSearchTool` 保留为工具目录中的标记实例，`prepareNativeWebSearch` 在绑定模型前替换为供应商声明。只有标记实例会被转换，第三方同名工具不会被误识别为内置搜索。
- 根据实际加载的工具集决定是否搜索，覆盖同步、SSE、定时/后台批量、Skill 和 delegate 子代理入口。Skill 的覆盖工具集不会继承父 Agent 的搜索开关。
- 服务端已执行的搜索不会进入本地工具循环。Kimi 则按官方协议把 `$web_search` 的完整参数序列化回传为同名 `tool` 消息。
- 当前 LangChain 对 `builtin_function` 的处理会选错 API，并且丢失 tool 消息的 name。因此 Kimi 使用 `ChatOpenAICompletions`，在该渠道专用的 fetch 适配器中补充声明及 name；仍只访问原模型渠道，不产生额外搜索 API 调用。请求的取消信号和其他工具声明保留。
- Anthropic 返回 `pause_turn` 时，携带原始内容块继续执行，受 Agent 的 `maxIterations` 限制。达到上限仍未完成时明确报错。
- 模型 checkpoint 保存原始搜索内容块，维持后续模型请求的上下文。对用户展示及数据库消息保存时，将网页引用转为回答末尾的 Markdown 来源链接，不修改数据库 Schema。流式文本增量保持原样，完整引用在 `message_end` 中返回。供应商内部搜索不会被伪装成本地 `tool_use` / `tool_result` 事件。

## 验证

`test/agents/native-web-search.spec.ts` 使用真实 LangChain 序列化、LangGraph 和 MemorySaver，仅 mock HTTP 边界。覆盖实际路径、请求声明、Kimi 参数回传和普通工具共存、Skill 搜索隔离、Claude pause/resume、流式引用、子代理及不支持的接口错误。测试不访问真实供应商，不验证某个账号/代理网关的搜索开通状态。

```sh
npm test -- --runInBand test/agents/native-web-search.spec.ts test/agents/agent-executor.service.spec.ts test/agents/tools/tool-registry.service.spec.ts
npm run typecheck
npm run build
```

## 官方依据

- [Anthropic Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Kimi 内置联网搜索](https://platform.kimi.com/docs/guide/use-web-search)
- [DeepSeek Responses API 兼容性](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)

本说明替代早期 Agent 设计中关于 Tavily 的实现描述。
