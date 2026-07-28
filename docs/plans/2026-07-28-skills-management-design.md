# Skills 全局管理设计文档

**日期**: 2026-07-28  
**版本**: v1.0  
**状态**: 设计阶段（第二期，可与 MCP Server 管理并行开发）  
**前置依赖**: `docs/plans/2026-07-28-mcp-server-management-design.md`（Skills 可关联 MCP 工具）

## 一、概述

### 背景

现有工具体系分两层：
- **内置工具**（代码级）：`web_search`、`calculator`，逻辑硬编码，不可动态扩展
- **MCP 工具**（服务级）：通过外部 MCP server 动态发现，需 admin 维护 server

两层之间缺少一个**配置级**的工具抽象：用自然语言指令定义可复用的能力单元，不需要改代码，主 Agent 可以像调用普通工具一样调用它。

### 目标

建立全局 Skills 库，支持在数据库里定义「技能单元」——每个 Skill 底层是一个带有 systemPrompt + 工具集的临时子 Agent，主 Agent 调用时借用其模型执行，返回结果后继续推理。

### 设计原则

- **轻量复用**：Skill 不绑定模型配置，执行时借用调用方 Agent 的 provider/model/apiKey
- **防递归**：Skill 执行的子 Agent 不注入 Skill 工具，禁止嵌套调用
- **全局共享**：Skill 库全局可见，Agent 按需选配

---

## 二、工具体系全貌

```
内置工具（代码级）   →  web_search、calculator、write_daily_report 等
                          ↕ enabledTools JSON 数组控制
MCP 工具（服务级）   →  全局 mcp_servers 表，Agent 通过关联表选配
                          ↕ agent_config_mcp_servers 关联表
Skills（配置级）     →  全局 skills 表，子 Agent 工具单元，Agent 通过关联表选配
                          ↕ agent_config_skills 关联表
                                    ↓
                            AgentConfig 汇总三层工具
                                    ↓
                          AgentExecutorService 组装执行
```

---

## 三、数据模型

### 新增实体：`Skill`（表 `skills`）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | uuid | PK | 主键 |
| `name` | varchar(100) | NOT NULL, UNIQUE | 工具名，LLM 调用时的 tool name（英文，snake_case） |
| `description` | varchar(500) | NOT NULL | 工具描述，LLM 依此决定何时调用（**直接影响调用质量**，需写清楚能做什么、何时适合用） |
| `systemPrompt` | text | NOT NULL | 子 Agent 的执行指令 |
| `inputSchema` | JSON | NULL | 入参结构（JSON Schema），为空时默认接收单个 `input: string` |
| `enabledTools` | JSON | NOT NULL, default '[]' | 子 Agent 可用的内置工具名列表 |
| `isActive` | boolean | NOT NULL, default true | 是否可被 Agent 选配 |
| `createdBy` | uuid | FK → users.id, NOT NULL | 创建者 |
| `createdAt` | datetime | NOT NULL | 创建时间 |
| `updatedAt` | datetime | NOT NULL | 更新时间 |

**索引**:
- `UQ_skills_name`: `name` 唯一索引
- `idx_skills_active`: `isActive`

---

### 新增关联表：`skill_mcp_servers`（Skill 可使用哪些 MCP 工具）

| 字段 | 类型 | 说明 |
|---|---|---|
| `skillId` | uuid | FK → skills.id，ON DELETE CASCADE |
| `mcpServerId` | uuid | FK → mcp_servers.id，ON DELETE CASCADE |
| 复合主键 | (skillId, mcpServerId) | 防重复 |

---

### 新增关联表：`agent_config_skills`（Agent 启用哪些 Skills）

| 字段 | 类型 | 说明 |
|---|---|---|
| `agentConfigId` | uuid | FK → agent_configs.id，ON DELETE CASCADE |
| `skillId` | uuid | FK → skills.id，ON DELETE CASCADE |
| 复合主键 | (agentConfigId, skillId) | 防重复 |

---

### 现有实体变更：`AgentConfig`

新增 `@ManyToMany` 关系指向 `Skill`，通过 `agent_config_skills` 关联表查询。其余字段不变。

---

## 四、执行机制

### Skill 作为工具的调用流程

```
主 Agent tool loop
    ↓
主 Agent 决定调用某个 Skill（如 generate_ai_report）
    ↓
SkillToolFactory 为该 Skill 生成的 DynamicStructuredTool.func 被触发
    ↓
1. 从调用方 AgentConfig 借用 provider / model / apiKey
2. 构建临时执行配置：
   - systemPrompt = Skill.systemPrompt
   - tools = Skill.enabledTools（内置工具）+ Skill.mcpServers（MCP 工具）
   - ⚠️ 不注入 Skill 工具（防递归）
3. 调用 AgentExecutorService.runBatch（无历史，一次性执行）
    ↓
子 Agent 执行 tool loop，完成任务
    ↓
返回子 Agent 最终输出字符串给主 Agent
主 Agent 继续推理
```

### SkillToolFactory 职责

位于 `src/skills/skill-tool.factory.ts`，核心方法：

```typescript
createToolsForAgent(
  skills: Skill[],                  // Agent 已关联的 Skills
  agentConfig: AgentConfig,         // 借用模型配置
): DynamicStructuredTool[]
```

- 为每个 Skill 创建一个 `DynamicStructuredTool`，name/description/schema 来自 Skill 实体
- `func` 内部调用 `AgentExecutorService.runBatch`，注入 Skill 配置

### 防递归机制

`runBatch` 接收一个 `isSkillExecution: boolean` 标志。为 `true` 时，`ToolRegistryService.getToolsForAgent` 跳过 Skill 工具注入，只返回内置工具 + MCP 工具。

---

## 五、API 设计

### Skills CRUD（新增 `SkillsController`，前缀 `/api/skills`）

#### `GET /api/skills`

- **权限**: 登录用户
- **说明**: 列出所有 `isActive=true` 的 Skills，用于 Agent 配置界面选配
- **响应**: `{ items: Skill[], total: number }`

---

#### `POST /api/skills`

- **权限**: 登录用户
- **请求体**:

```typescript
{
  name: string;              // 必填，全局唯一，snake_case，如 generate_ai_report
  description: string;       // 必填，LLM 看到的工具描述
  systemPrompt: string;      // 必填，子 Agent 执行指令
  inputSchema?: object;      // 可选，JSON Schema
  enabledTools?: string[];   // 可选，内置工具名列表，默认空
  mcpServerIds?: string[];   // 可选，关联的 MCP Server ID 列表
}
```

- **响应**: 创建的 `Skill` 对象

---

#### `PATCH /api/skills/:id`

- **权限**: 创建者或 admin
- **请求体**: 同 `POST`，所有字段可选（Partial）
- **响应**: 更新后的 `Skill` 对象

---

#### `DELETE /api/skills/:id`

- **权限**: 创建者或 admin
- **说明**: 硬删除；关联表 `ON DELETE CASCADE` 自动清理 Agent 关联
- **响应**: 204 No Content

---

### Agent 选配 Skills（扩展现有 `AgentsController`）

#### `GET /api/agents/:id/skills`

- **权限**: 登录用户（只能查自己的 Agent）
- **响应**: 当前 Agent 已关联的 Skill 列表

---

#### `PUT /api/agents/:id/skills`

- **权限**: Agent 拥有者
- **请求体**: `{ skillIds: string[] }`
- **执行逻辑**:
  1. 校验所有 `skillId` 存在且 `isActive=true`
  2. 删除旧关联，插入新关联
- **响应**: 更新后的关联列表

---

## 六、参数校验规则

### `POST /api/skills` 校验

| 字段 | 校验规则 |
|---|---|
| `name` | 非空；仅允许小写字母、数字、下划线（snake_case）；长度 ≤ 100；全局唯一（查库） |
| `description` | 非空，长度 ≤ 500 |
| `systemPrompt` | 非空 |
| `inputSchema` | 提供时必须是合法 JSON Schema 对象 |
| `enabledTools` | 数组，每项须是已注册的内置工具名 |
| `mcpServerIds` | 数组，每项为 UUID 格式；对应 McpServer 存在且 `isActive=true` |

---

## 七、模块结构

### 新增文件

```
src/
  skills/
    skill.entity.ts                ← Skill 实体
    skills.service.ts              ← CRUD 逻辑
    skills.controller.ts           ← REST API
    skill-tool.factory.ts          ← Skill → DynamicStructuredTool 转换
    dto/
      create-skill.dto.ts
      update-skill.dto.ts
    skills.module.ts
```

### 修改文件

```
src/
  app.module.ts                    ← imports 加 SkillsModule
  agents/
    entities/agent-config.entity.ts  ← 加 ManyToMany 关联 Skill
    agents.module.ts                 ← imports 加 SkillsModule
    agent-executor.service.ts        ← 工具加载加入 SkillToolFactory；runBatch 加 isSkillExecution 标志
    agents.controller.ts             ← 新增两个 skills 子路由
    agents.service.ts                ← 新增 updateSkills 方法
    tools/tool-registry.service.ts   ← 支持 isSkillExecution 跳过 Skill 注入
```

---

## 八、三期实施顺序

```
第一期：MCP Server 管理
  → mcp_servers 表 + CRUD API + AgentConfig 关联改造
  → AgentExecutorService MCP 加载逻辑更新

第二期：Skills 管理（可与第一期并行）
  → skills 表 + 关联表 + CRUD API
  → SkillToolFactory + AgentExecutorService 集成
  → 防递归机制

第三期：定时任务（依赖前两期）
  → agent_scheduled_tasks 表 + 4 个内置工具
  → AgentExecutorService.runBatch（第二期已实现可复用）
  → 启动恢复机制
```

---

## 九、风险与注意事项

1. **子 Agent 执行耗时**：Skill 调用会触发额外的 LLM 调用，主 Agent 的 TTL 和 maxIterations 需考虑嵌套执行耗时
2. **模型借用副作用**：子 Agent 使用主 Agent 的 apiKey，若 Skill 被频繁调用，token 消耗会归到同一账单
3. **name 冲突**：Skill 的 `name` 进入主 Agent 的工具列表，不能与内置工具名或 MCP 工具名冲突；`SkillToolFactory` 创建时应做冲突检查，冲突时给出告警

---

**设计文档完成，待实施计划跟进。**
