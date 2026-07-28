# Agent 定时任务与自动日报生成设计文档

**日期**: 2026-07-28  
**版本**: v1.0  
**状态**: 设计阶段（第二期，依赖 MCP Server 管理完成后实施）  
**前置依赖**: `docs/plans/2026-07-28-mcp-server-management-design.md`、`docs/plans/2026-07-28-skills-management-design.md`（`AgentExecutorService.runBatch` 在第二期实现，第三期复用）

## 一、概述

### 背景

当前系统具备完整的 Agent 对话能力（LangGraph tool loop + MCP 工具）和日报内容管理（`daily_reports` 表），但缺少自动化生成机制。前端 AI 日报页面已完整实现，数据层已就绪，需要后端补齐「自动化生成」环节。

### 目标

通过**对话式创建定时任务**，让 Agent 按 cron 表达式自动触发，搜索网络最新资讯，生成日报内容并写入数据库，前端页面无需改动即可展示。

### 设计原则

- **复用现有架构**：定时任务复用现有 LangGraph tool loop 执行路径，不重复实现对话逻辑
- **对话式管理**：通过内置工具创建/查询/删除任务，无需新增管理界面
- **数据隔离**：新增独立 `ScheduledTask` 实体，与 `AgentConfig` 解耦，一个 Agent 可有多个任务
- **防御性校验**：cron 表达式、枚举、日期格式严格校验，防止异常输入

---

## 二、核心需求

1. **对话创建任务**：用户通过对话告知 Agent 「每天早 8 点生成 AI 日报」，Agent 调用工具自动创建定时任务
2. **自动执行**：定时触发时，系统构造触发消息，走完整 tool loop（搜索 → 整理 → 写库）
3. **任务管理**：通过对话列出、删除任务，无需额外 REST 端点
4. **内容写入**：Agent 主动调用 `write_daily_report` 工具，写入 `daily_reports` 表
5. **应用重启恢复**：服务重启后自动加载所有活跃任务，重新注册 cron job

---

## 三、数据模型

### 新增实体：`ScheduledTask`

**表名**: `agent_scheduled_tasks`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | uuid | PK | 主键 |
| `agentConfigId` | uuid | FK, NOT NULL | 关联 `agent_configs.id` |
| `reportType` | enum('ai', 'stock') | NOT NULL | 日报类型，复用 `DailyReportType` |
| `cronExpression` | varchar(100) | NOT NULL | cron 表达式，如 `0 8 * * *` |
| `description` | varchar(255) | NOT NULL | 任务描述，用于 list 展示 |
| `isActive` | boolean | NOT NULL, default true | 是否启用 |
| `lastRunAt` | datetime | NULL | 上次执行时间 |
| `createdAt` | datetime | NOT NULL | 创建时间 |
| `updatedAt` | datetime | NOT NULL | 更新时间 |

**索引**:
- `idx_agent_config_active`: `(agentConfigId, isActive)` — 快速查询活跃任务
- `idx_report_type_active`: `(reportType, isActive)` — 按类型查询（可选）

**业务约束**: 同一个 `agentConfigId + reportType` 组合下，最多 1 个 `isActive=true` 的任务（代码层校验，非数据库唯一索引）。

### 现有实体零改动

- `AgentConfig`：不新增字段，通过关联查询获取任务列表
- `DailyReport`：不改结构，复用现有 `[type, date]` 唯一索引

---

## 四、工具设计

在 `tool-registry.service.ts` 注册 4 个新工具，用户通过对话调用。

### 1. `create_scheduled_task`

**功能**: 创建定时任务

**参数**:
```typescript
{
  cronExpression: string;    // cron 表达式
  reportType: 'ai' | 'stock'; // 日报类型
  description: string;        // 任务描述
}
```

**执行逻辑**:
1. 校验 cron 表达式格式（使用 `cron-parser` 库）
2. 检查是否存在相同 `agentConfigId + reportType` 的活跃任务，存在则拒绝
3. 写入 `agent_scheduled_tasks` 表
4. 调用 `SchedulerRegistry.addCronJob()` 动态注册 cron job
5. 返回任务 ID 和下次执行时间

**返回值**: `{ success: true, taskId: string, nextRunAt: string }`

---

### 2. `write_daily_report`

**功能**: 写入日报内容到数据库

**参数**:
```typescript
{
  type: 'ai' | 'stock';  // 日报类型
  title: string;         // 标题
  content: string;       // 正文（Markdown 格式）
  date?: string;         // YYYY-MM-DD，可选，默认今天
}
```

**执行逻辑**:
1. 参数校验（见下方「校验规则」）
2. 调用 `DailyReportsService.upsert()`，复用现有服务层逻辑
3. 利用 `[type, date]` 唯一索引，同类型同日期内容会覆盖旧记录

**返回值**: `{ success: true, id: string }`

---

### 3. `list_scheduled_tasks`

**功能**: 列出当前 Agent 的所有定时任务

**参数**: 无

**执行逻辑**:
1. 查询 `agentConfigId` 下所有任务（包含 `isActive=false` 的历史任务）
2. 返回任务列表（id、description、cron、reportType、isActive、lastRunAt）

**返回值**: `{ tasks: ScheduledTask[] }`

---

### 4. `delete_scheduled_task`

**功能**: 删除指定定时任务

**参数**:
```typescript
{
  taskId: string;  // UUID
}
```

**执行逻辑**:
1. 校验 taskId 属于当前 agentConfigId（防止跨 Agent 删除）
2. 硬删除数据库记录
3. 调用 `SchedulerRegistry.deleteCronJob()` 取消注册

**返回值**: `{ success: true }`

---

## 五、执行流程

### 定时触发完整数据流

```
┌──────────────────────────────────────────────────┐
│ 1. NestJS cron job 到时触发                      │
│    SchedulerRegistry 调用回调函数                │
└──────────────┬───────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│ 2. ScheduledTasksService.runTask(task)          │
│    - 创建新 Conversation                         │
│      title: "[Auto] AI日报 2026-07-28"          │
│      status: active                              │
│    - 插入触发消息（role: user）                  │
│      content: "今天是 2026-07-28，请搜索最新     │
│                AI 资讯，整理成日报，调用         │
│                write_daily_report 工具保存。"    │
└──────────────┬───────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│ 3. AgentExecutorService.runBatch(conversationId) │
│    （新增方法：不走 SSE，await 完整结果）        │
│    - 加载 Agent 配置（provider/model/apiKey）    │
│    - 初始化 LangGraph StateGraph                 │
│    - 执行 tool loop                              │
└──────────────┬───────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│ 4. LangGraph Tool Loop 自动执行                  │
│    ① LLM 决策调用搜索工具（如 MCP web_search）  │
│    ② 工具返回最新 AI 资讯                        │
│    ③ LLM 整理成日报格式                          │
│    ④ 调用 write_daily_report 工具写入数据库     │
│    ⑤ 返回 "日报已保存" 消息                      │
└──────────────┬───────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────┐
│ 5. 执行完成后收尾                                │
│    - Conversation status → archived              │
│    - 更新 task.lastRunAt = now()                 │
│    - 记录执行日志（可选）                        │
└──────────────────────────────────────────────────┘
```

### 关键设计点

- **触发消息内容由 `description` 字段拼接**：创建任务时用户自然语言描述会转为触发 prompt
- **复用现有执行路径**：`AgentExecutorService` 核心逻辑完全不动，只新增 `runBatch` 方法（去掉 SSE，改为 Promise resolve）
- **会话归档**：定时任务产生的会话自动归档，不干扰用户主动创建的会话列表

---

## 六、应用启动恢复

### 问题

NestJS 重启后，内存中的 `SchedulerRegistry` 清空，所有 cron job 丢失。

### 解决方案

在 `ScheduledTasksService` 实现 `OnApplicationBootstrap` 生命周期钩子：

```typescript
async onApplicationBootstrap() {
  const activeTasks = await this.scheduledTaskRepository.find({
    where: { isActive: true },
  });

  for (const task of activeTasks) {
    this.registerCronJob(task); // 重新注册到 SchedulerRegistry
  }

  this.logger.log(`已恢复 ${activeTasks.length} 个定时任务`);
}
```

### 注意事项

- 启动时不立即执行任务，严格按 cron 表达式调度
- 若任务在停机期间本该触发但错过了，**不补跑**（避免启动时雪崩）

---

## 七、参数校验规则

### `create_scheduled_task` 校验

| 参数 | 校验规则 | 错误提示 |
|---|---|---|
| `cronExpression` | 用 `cron-parser` 解析，失败抛错；禁止间隔 < 1 小时的表达式 | "不合法的 cron 表达式" / "任务间隔不能少于 1 小时" |
| `reportType` | 严格枚举 `ai \| stock` | "日报类型必须是 ai 或 stock" |
| `description` | 非空，长度 ≤ 255 | "描述不能为空" / "描述最长 255 字符" |
| **业务唯一性** | 同 `agentConfigId + reportType` 下已有活跃任务 | "该 Agent 已有 AI 日报定时任务，请先删除旧任务" |

---

### `write_daily_report` 校验

| 参数 | 校验规则 | 错误提示 |
|---|---|---|
| `type` | 严格枚举 `ai \| stock` | "日报类型必须是 ai 或 stock" |
| `title` | 非空，长度 ≤ 255 | "标题不能为空" / "标题最长 255 字符" |
| `content` | 非空，长度 ≤ 64KB | "内容不能为空" / "内容过长（最大 64KB）" |
| `date` | 可选；提供时格式必须 `YYYY-MM-DD` 且是合法日期 | "日期格式错误，应为 YYYY-MM-DD" |

**默认行为**: `date` 未提供时，取服务器当前日期（`Asia/Shanghai` 时区）。

---

### `delete_scheduled_task` 校验

| 参数 | 校验规则 | 错误提示 |
|---|---|---|
| `taskId` | UUID 格式 + 必须属于当前 `agentConfigId` | "任务不存在或无权限删除" |

---

### 校验实现位置

在 `ScheduledTasksService` 方法入口手动校验，不走全局 `ValidationPipe`（工具调用参数不经过 HTTP 管道）。

校验失败抛出 `BadRequestException`（中文消息），工具层捕获后作为工具错误返回给 LLM，LLM 会把原因反馈给用户。

---

## 八、模块结构变更

### 新增文件

```
src/agents/
  scheduled-tasks/
    scheduled-task.entity.ts         ← ScheduledTask 实体
    scheduled-tasks.service.ts       ← 任务管理 + cron 调度逻辑
    scheduled-tasks.module.ts        ← 模块定义（可选，也可直接在 agents.module）
```

### 修改文件

```
src/agents/
  agent-executor.service.ts          ← 新增 runBatch 方法
  tools/tool-registry.service.ts     ← 注册 4 个新工具
  agents.module.ts                   ← imports 加 DailyReportsModule + ScheduleModule.forRoot()
```

### 不新增 HTTP Controller

任务完全通过对话管理，不暴露额外 REST 端点。若未来需要管理界面，可再加 `ScheduledTasksController`。

---

## 九、前端影响

**零改动**。前端页面已完整实现，数据接口已就绪，定时任务只负责写 `daily_reports` 表，前端自动读取展示。

---

## 十、技术依赖

### 新增依赖

| 包名 | 用途 | 安装命令 |
|---|---|---|
| `@nestjs/schedule` | 定时任务调度 | `pnpm add @nestjs/schedule` |
| `cron-parser` | cron 表达式解析与校验 | `pnpm add cron-parser` |
| `@types/cron-parser` | TS 类型定义 | `pnpm add -D @types/cron-parser` |

### 现有依赖复用

- `TypeORM`：实体、Repository
- `LangGraph`：tool loop 执行
- `DailyReportsService`：写入日报内容

---

## 十一、风险与限制

### 风险

1. **高频任务资源消耗**：若用户创建大量短间隔任务（如每分钟），LLM 调用成本激增
   - **缓解措施**：校验层禁止 < 1 小时间隔的 cron 表达式
2. **LLM 生成失败**：搜索无结果、API 超时、工具调用错误
   - **缓解措施**：错误捕获 + 会话归档 + 记录失败日志，下次调度正常继续
3. **时区问题**：cron 表达式按服务器时区执行
   - **缓解措施**：文档明确服务器时区（`Asia/Shanghai`），或未来加时区配置字段

### 限制

- **单机调度**：当前设计不支持分布式，多实例部署时任务会重复执行
  - **未来方案**：引入 Redis 分布式锁或改用 BullMQ 队列
- **无任务执行历史**：当前只记录 `lastRunAt`，不保存执行日志
  - **未来方案**：新增 `task_execution_logs` 表记录详细执行结果

---

## 十二、总结

本设计通过新增 `ScheduledTask` 实体和 4 个内置工具，实现对话式定时任务管理，复用现有 LangGraph tool loop 执行路径，前端零改动即可展示自动生成的日报内容。架构简洁，扩展性强，符合现有项目规范。

---

**设计文档完成，待实施计划跟进。**
