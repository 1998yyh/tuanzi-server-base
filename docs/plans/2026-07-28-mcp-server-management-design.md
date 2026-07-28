# MCP Server 全局管理设计文档

**日期**: 2026-07-28  
**版本**: v1.0  
**状态**: 设计阶段  
**优先级**: 第一期（定时任务的前置依赖）

## 一、概述

### 背景

现有 `AgentConfig.mcpServers` 是一个 JSON 字段，每个 Agent 各自配置自己的 MCP server，存在以下问题：

1. 重复配置：同一个 MCP server 需要在每个 Agent 里分别配一遍
2. 无集中管理：无法统一查看、审计、启用/禁用 MCP servers
3. 权限粗糙：JSON 字段无法区分 stdio 和 HTTP 类型的权限控制
4. 扩展性差：后续「定时任务搜索工具」等功能无法依赖一个稳定的工具库

### 目标

建立**全局 MCP Server 工具库**，Admin 集中配置，普通用户可从中选配给自己的 Agent 使用。

### 设计原则

- **最小破坏**：废弃 `AgentConfig.mcpServers` JSON 字段，改用关联表；Agent 执行逻辑只改加载方式，tool loop 不动
- **权限分级**：stdio 类型仅 admin 可创建，HTTP/SSE 类型登录用户均可创建
- **复用加密工具**：`env` 和 `headers` 敏感字段复用现有 AES-256-GCM 加密（`crypto.util.ts`）

---

## 二、数据模型

### 新增实体：`McpServer`（表 `mcp_servers`）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | uuid | PK | 主键 |
| `name` | varchar(100) | NOT NULL, UNIQUE | 全局唯一名称 |
| `type` | enum('stdio','sse','streamable-http') | NOT NULL | MCP 连接类型 |
| `command` | varchar(500) | NULL | stdio 专用：可执行命令 |
| `args` | JSON | NULL | stdio 专用：命令参数数组 |
| `env` | text | NULL | stdio 专用：环境变量 JSON，AES-256-GCM 加密存储 |
| `url` | varchar(500) | NULL | sse/streamable-http 专用：连接地址 |
| `headers` | text | NULL | sse/streamable-http 专用：请求头 JSON，加密存储 |
| `description` | varchar(255) | NULL | 描述，展示在 Agent 配置界面 |
| `isActive` | boolean | NOT NULL, default true | 是否可被 Agent 选配 |
| `createdBy` | uuid | FK → users.id, NOT NULL | 创建者 |
| `createdAt` | datetime | NOT NULL | 创建时间 |
| `updatedAt` | datetime | NOT NULL | 更新时间 |

**索引**:
- `UQ_mcp_servers_name`: `name` 唯一索引
- `idx_mcp_servers_type_active`: `(type, isActive)` 复合索引

**字段约束**:
- `type=stdio` 时，`command` 必填，`url` 为空
- `type=sse` 或 `type=streamable-http` 时，`url` 必填，`command`/`args`/`env` 为空
- 约束在 Service 层代码校验，非数据库层

---

### 新增关联表：`agent_config_mcp_servers`

| 字段 | 类型 | 说明 |
|---|---|---|
| `agentConfigId` | uuid | FK → agent_configs.id，ON DELETE CASCADE |
| `mcpServerId` | uuid | FK → mcp_servers.id，ON DELETE CASCADE |
| 复合主键 | (agentConfigId, mcpServerId) | 防止重复关联 |

---

### 现有实体变更：`AgentConfig`

| 变更 | 说明 |
|---|---|
| 废弃 `mcpServers` JSON 字段 | 保留列但标记 `@Column({ nullable: true })`，不再读写；数据迁移完成后可彻底删除 |
| 新增 `@ManyToMany` 关系 | 关联 `McpServer`，通过 `agent_config_mcp_servers` 关联表 |

---

## 三、API 设计

### MCP Server CRUD（新增 `McpServersController`，前缀 `/api/mcp-servers`）

#### `GET /api/mcp-servers`

- **权限**: 登录用户
- **说明**: 列出所有 `isActive=true` 的 MCP servers，用于 Agent 配置界面选配
- **响应**: `{ items: McpServer[], total: number }`
- **注意**: 响应中 `env` / `headers` 字段不返回（脱敏）

---

#### `POST /api/mcp-servers`

- **权限**: 登录用户；`type=stdio` 时额外要求 `role=admin`
- **请求体**:

```typescript
{
  name: string;            // 必填，全局唯一
  type: 'stdio' | 'sse' | 'streamable-http';
  command?: string;        // stdio 必填
  args?: string[];         // stdio 可选
  env?: Record<string, string>;   // stdio 可选，存储前加密
  url?: string;            // sse/http 必填
  headers?: Record<string, string>; // sse/http 可选，存储前加密
  description?: string;
}
```

- **响应**: 创建的 `McpServer` 对象（脱敏 env/headers）

---

#### `PATCH /api/mcp-servers/:id`

- **权限**: 创建者或 admin
- **请求体**: 同 `POST`，所有字段可选（Partial）
- **响应**: 更新后的 `McpServer` 对象

---

#### `DELETE /api/mcp-servers/:id`

- **权限**: 创建者或 admin
- **说明**: 硬删除；关联表 `ON DELETE CASCADE` 自动清理 Agent 关联
- **响应**: 204 No Content

---

### Agent 选配 MCP（扩展现有 `AgentsController`）

#### `GET /api/agents/:id/mcp-servers`

- **权限**: 登录用户（只能查自己的 Agent）
- **响应**: 当前 Agent 已关联的 MCP server 列表

---

#### `PUT /api/agents/:id/mcp-servers`

- **权限**: Agent 拥有者
- **说明**: 整体替换关联列表，传入选中的 mcpServerIds 数组
- **请求体**: `{ mcpServerIds: string[] }`
- **执行逻辑**:
  1. 校验所有 `mcpServerId` 存在且 `isActive=true`
  2. 校验 `stdio` 类型的 server 只有 admin 才能关联（非 admin 不能使用 stdio 工具）
  3. 删除旧关联，插入新关联
- **响应**: 更新后的关联列表

---

## 四、权限控制矩阵

| 操作 | 普通登录用户 | Admin |
|---|---|---|
| 查看全局 MCP server 列表 | ✅ | ✅ |
| 创建 sse/streamable-http 类型 | ✅ | ✅ |
| 创建 stdio 类型 | ❌ | ✅ |
| 修改/删除自己创建的 server | ✅ | ✅ |
| 修改/删除他人创建的 server | ❌ | ✅ |
| 给 Agent 关联非 stdio 类型 | ✅ | ✅ |
| 给 Agent 关联 stdio 类型 | ❌ | ✅ |

---

## 五、Agent 执行时加载变更

### 现有逻辑

```typescript
// agent-executor.service.ts（现有）
const mcpServers = agentConfig.mcpServers; // 直接读 JSON 字段
```

### 新逻辑

```typescript
// agent-executor.service.ts（修改后）
const mcpServers = await this.mcpServersService.findByAgentConfig(agentConfigId);
// 返回已解密 env/headers 的 McpServer 实体列表，后续连接逻辑不变
```

**改动范围**: 仅 `AgentExecutorService` 的加载入口，MCP 连接建立和工具调用逻辑完全不动。

---

## 六、模块结构

### 新增文件

```
src/
  mcp-servers/
    mcp-server.entity.ts           ← McpServer 实体
    mcp-servers.service.ts         ← CRUD + 权限校验 + 加解密
    mcp-servers.controller.ts      ← REST API
    dto/
      create-mcp-server.dto.ts
      update-mcp-server.dto.ts
      query-mcp-server.dto.ts
    mcp-servers.module.ts
```

### 修改文件

```
src/
  app.module.ts                    ← imports 加 McpServersModule
  agents/
    entities/agent-config.entity.ts  ← 废弃 mcpServers 字段 + 加 ManyToMany
    agents.module.ts                 ← imports 加 McpServersModule
    agent-executor.service.ts        ← 修改 MCP 加载逻辑
    agents.controller.ts             ← 新增两个 mcp-servers 子路由
    agents.service.ts                ← 新增 updateMcpServers 方法
```

---

## 七、参数校验规则

### `POST /api/mcp-servers` 校验

| 字段 | 校验规则 |
|---|---|
| `name` | 非空，长度 ≤ 100，全局唯一（查库） |
| `type` | 严格枚举 `stdio \| sse \| streamable-http` |
| `command` | type=stdio 时必填，非空 |
| `url` | type=sse/http 时必填，合法 URL 格式 |
| `env` | 提供时必须是合法的 key-value 对象 |
| `headers` | 提供时必须是合法的 key-value 对象 |
| `description` | 长度 ≤ 255 |

### `PUT /api/agents/:id/mcp-servers` 校验

| 校验项 | 规则 |
|---|---|
| `mcpServerIds` | 数组，每项为 UUID 格式 |
| 存在性校验 | 每个 ID 对应的 McpServer 存在且 `isActive=true` |
| 权限校验 | 非 admin 不能关联 stdio 类型的 server |

---

## 八、风险与注意事项

### 数据迁移

现有 `AgentConfig.mcpServers` JSON 字段里可能有数据（如已配置的 MCP server）。迁移步骤：

1. 上线前手动检查生产库，确认该字段是否有非空数据
2. 若有，逐条提取并创建对应 `McpServer` 记录，建立关联
3. 确认迁移完成后，再从代码里彻底移除旧字段

### 加密 Key 依赖

`env` 和 `headers` 加密依赖 `AGENT_ENCRYPTION_KEY` 环境变量（现有必填变量），无需新增配置。

---

## 九、关联设计

本设计完成后，将解锁「Agent 定时任务」子系统：

- Agent 可配置全局 MCP web_search server
- 定时任务触发时，Agent 通过已关联的搜索工具抓取最新资讯
- 详见：`docs/plans/2026-07-28-agents-scheduled-tasks-design.md`

---

**设计文档完成，待实施计划跟进。**
