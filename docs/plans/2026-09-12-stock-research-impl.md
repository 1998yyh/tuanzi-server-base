# AI 复盘与观察池

复盘与聊天共用 `stock-research` 工作区，数据持久保存在 MySQL，复用现有 Agent、渠道、消息和 checkpoint。不包含成交记录或盈亏核算。

所有接口位于 `/api/stock-research`，使用现有 JWT。私有查询同时校验研究会话 userId 和所属 Agent 的 userId。服务端不接受客户端提供行情事实。

| 接口 | 用途 |
| --- | --- |
| `POST /conversations` | `{agentId,title?,context}` 创建会话与证据，事务落库 |
| `GET /conversations?page=1&limit=20` | 当前用户会话历史 |
| `GET /conversations/:id` | 上下文、冻结证据与标题 |
| `GET /conversations/:id/messages?page=1&limit=20` | 最新消息在前；客户端反转当前页呈现 |
| `POST /conversations/:id/messages` | `{content}`，始终 SSE |
| `DELETE /conversations/:id` | 同一事务清理 checkpoint、消息和研究上下文 |
| `GET /watchlist` | 当前用户观察池 |
| `POST /watchlist` | `{code,name,reason?}`；相同用户相同代码冲突返回 409 |
| `DELETE /watchlist/:id` | 移出观察，独立对话保留 |

上下文支持：

```json
{"kind":"general"}
{"kind":"market","date":"2026-09-11"}
{"kind":"stock","code":"600519","date":"2026-09-11"}
{"kind":"screen","screeningRunId":"任务UUID","codes":["600519"]}
```

`screen.codes` 可省略；传入时必须为该任务有效命中且无数据缺口的候选，最多 30 只、不重复。省略时按任务原顺序取前 30 只有效候选。证据明确记录总数、纳入数和未分析数，该顺序不代表 AI 推荐排序。只传入候选事实与策略定义，不把全市场目标名单塞进模型上下文。

大盘和个股复盘拒绝未来日期；取得未复权历史 K 线，先按日期裁剪，再计算指标，避免带入未来计算值。保存最多 60 根 K 线和 5 行带时间的指标、来源、抓取时间、实际末柱日期。历史数据是当前来源回看，不是当时保存的数据版本；财报、公告、市场宽度未接入时明确缺失。自由对话没有默认实时行情。指标预热不足使用 null。

每轮发送克隆 Agent 配置，附加冻结的研究证据，不改共享 Agent 的 systemPrompt，也不把上下文伪装成用户原话。复用现有 SSE 执行锁与失败 checkpoint 回滚。研究入口额外串行准备、发送、删除，避免本入口删除正在生成的会话。读取历史和删除不要求 Agent 仍启用；删除通过 checkpoint 的可选事务管理器与会话行同事务完成。创建前在事务外取得证据，事务内重新校验 Agent 后原子保存。底层既有通用会话接口仍保留其原有语义。

模型凭据始终通过现有 AiChannel 解析，APK 不保存模型密钥。用户在既有后台配置渠道和启用的 Agent 后，安卓选择该 Agent。模型调用由发送消息触发；本地集成脚本使用测试执行器，不产生模型费用，也不验证真实模型回答质量。

数据库变更见 `2026-09-12-stock-research.sql`，保持 `synchronize=false`。新增 DDL 已在专门测试数据库中执行，并运行真实 Nest HTTP/JWT/MySQL 贯通检查。测试脚本见 `scripts/guanlan-smoke.cjs`；它使用固定行情和模型替身，验证持久化、归属、SSE、续聊、删除及预警并发去重。
