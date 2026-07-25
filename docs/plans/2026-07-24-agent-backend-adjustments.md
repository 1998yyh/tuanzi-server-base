# 消息历史分页倒序 + 流式落库时机调整 变更提案

- **日期**: 2026-07-24
- **发起方**: 前端「Web Tools」Agent 聊天页开发（`personal-homepage` 仓库 `feat/agent-page` 分支）
- **状态**: 已实施（2026-07-25，单测 131 全绿；运行时联调待进行）
- **包含三项配套变更**：① 消息历史 DESC 分页；② SSE 模式下 user 消息落库时机后移；③ assistant 消息持久化 token 用量

---

# 变更 ①：消息历史分页改为倒序（DESC）

## 1. 背景

前端实现 Agent 聊天页时，消息历史采用聊天应用的标准交互：

- 打开会话 → 直接展示**最新**一屏消息，滚动位置落在底部
- 向上滚动 / 点击"加载更多" → 拉取**更早**的消息，prepend 到列表顶部

## 2. 现状与问题

`GET /api/conversations/:id/messages` 当前为 **ASC 正序分页**（`src/agents/conversations.service.ts:175`，`order: { createdAt: 'ASC' }`）：

- `page=1` 返回的是**最老**的消息，最新消息在 `page=totalPages`
- 前端要展示最新消息，必须先请求一次拿 `totalPages`，再请求最后一页——多一次串行往返
- 边缘情况多：空会话（totalPages=0）、limit 整除时最后一页为空、拉取期间新消息写入导致页码漂移
- "加载更早"需要前端反向维护页码（page-1、page-2…），逻辑绕且易错

聊天历史场景下，"最新一页"是 99% 的请求目标，ASC 分页属于接口设计不合理，不应由前端绕路弥补。

## 3. 变更内容（仅一处）

`src/agents/conversations.service.ts` 的 `listMessages` 方法：

```diff
  const [items, total] = await this.messageRepo.findAndCount({
    where: { conversationId },
-   order: { createdAt: 'ASC' },
+   order: { createdAt: 'DESC' },
    skip: (page - 1) * limit,
    take: limit,
  });
```

不新增 `order` 查询参数——聊天历史倒序是唯一正确使用方式，避免过度设计。

响应结构（`items/total/page/limit/totalPages`）**完全不变**，仅 `items` 排序方向变化：

- `page=1` → 最新 limit 条（DESC）
- `page < totalPages` → 还有更早消息，前端翻页 prepend
- 前端拿到每页后自行 `reverse()` 即可按时间正序渲染

## 4. 影响面评估

| 项 | 结论 |
|---|---|
| 调用方 | 仅前端「Web Tools」Agent 聊天页（尚未上线，无存量调用方） |
| 响应结构 | 不变，无契约破坏 |
| 前端 SSE 发送消息 | 无关联（消息落库逻辑不动） |
| 测试 | `test/agents/conversations.controller.spec.ts` 只 mock 了 `listMessages`，无排序断言，无需改动；建议补一条 service 层排序断言 |
| Swagger 文档 | 建议给 `listMessages` 的 `@ApiOperation` summary 补充"倒序分页（最新在前）"说明 |

## 5. 验收标准

1. `GET /api/conversations/:id/messages?page=1&limit=20` 返回最新 20 条，`items[0]` 为最新一条
2. 已有单测/集成测试全绿
3. 前端联调：打开会话直接展示最新消息，向上翻页可一直加载到第一条历史消息

---

# 变更 ②：SSE 模式下 user 消息落库时机后移

## 1. 背景与问题

`conversations.service.ts:113` 的 `prepareStream` 在**流开始之前**就把 user 消息落库。流中途异常（LLM 报错、网络断流）时，数据库里已存在这条 user 消息，但对应的 assistant 回复永远不会有——前端"重试"若重新调 `POST /messages`，展示层就会出现**两条重复的 user 消息**。

## 2. 关键事实（已核实）

- Agent 执行上下文走 **LangGraph checkpointer**（`agent-executor.service.ts` 的 `graph.getState`），**不读 `messages` 表**——该表是纯展示层（`message.entity.ts` 注释亦如此说明），挪动落库时机不影响执行。
- `streamMessages` 已有流结束后统一落库的机制（`pendingMessages`，`conversations.service.ts:165`），user 消息并入该批次即可。

## 3. 变更内容

- `prepareStream` 中移除 `persistUserMessage` 调用（只做归属校验与 Agent 启用校验）
- `streamMessages` 的 `pendingMessages` 批次开头加入 user 消息；流正常结束（含 `message_end`）后随 assistant 消息一并落库
- 流中途异常 → 展示层零残留，前端"重试"= 原样重发同一 content，不会产生重复消息
- **同步模式（非 stream）行为不变**：`sendMessage` 保持现有落库逻辑
- 会话标题兜底逻辑（首条消息前 30 字，`persistUserMessage` 内）随落库批次一并迁移，保证行为不变

## 4. 实施注意点（必须验证）

⚠️ **LangGraph checkpoint 残留**：流中途异常时，graph state 可能已写入 human message。重试重跑时 agent 上下文里可能出现重复的用户输入。实施后需手动验证：流中途故意制造异常 → 重发同一消息 → 观察 agent 行为是否异常（如重复引用上一轮输入）。如有问题，需在重跑前清理或修正 checkpoint 状态。

## 5. 影响面与验收

| 项 | 结论 |
|---|---|
| 契约 | 无变化（请求/响应结构不动） |
| 代价 | 进程崩溃会丢失进行中的消息（个人项目可接受） |
| 验收 | 流中途断开后重发，历史记录仅一条 user 消息；正常对话历史无回归 |

---

# 变更 ③：assistant 消息持久化 token 用量

## 1. 背景与问题

前端要在 assistant 气泡上展示 token 消耗（用户自己的 apiKey，token 即成本）。`totalTokens` 目前只存在于 SSE `message_end` 事件的实时数据里，`messages` 表**没有对应字段**——页面刷新后历史消息无法展示 token 数，UI 不一致。

## 2. 变更内容

1. `message.entity.ts` 新增字段：

   ```ts
   /** 本条 assistant 消息的累计 token 消耗（仅 assistant 有值） */
   @Column({ name: 'total_tokens', type: 'int', nullable: true })
   totalTokens: number | null;
   ```

2. 落库时写入：
   - **流式**：`streamMessages` 的 `message_end` 分支，`event.data` 已含 `totalTokens`（`agent-executor.service.ts:288`），直接随 assistant 消息落库
   - **同步模式**：`sendMessage` 落库 assistant 消息时同样写入
3. `GET /conversations/:id/messages` 响应自动带出该字段（TypeORM 实体直返，无需改 DTO）

## 3. 影响面与验收

| 项 | 结论 |
|---|---|
| 表结构 | 开发环境 `synchronize: true` 自动加列；**生产环境 `synchronize: false`（`app.module.ts:29`），需手动执行 `ALTER TABLE messages ADD COLUMN total_tokens INT NULL`** |
| 存量数据 | 历史消息该字段为 NULL，前端按"无 token 信息"处理（不展示该行即可） |
| 契约 | 响应新增可选字段，向后兼容 |
| 验收 | 新产生的 assistant 消息（流式+同步）均带 `totalTokens`；历史接口返回该字段 |
