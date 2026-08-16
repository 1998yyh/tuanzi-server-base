# 团子后台服务 · 架构文档

> 版本：v1.0 · 最后更新：2026-08-08
> 技术栈：TypeScript 5.8 / NestJS 11 / TypeORM 0.3 / MySQL 8.0 / passport-jwt / LangChain + LangGraph / zod / pnpm 10

## 1. 系统定位

团子后台基础服务是一个**以 Agent 平台与 AI 画布为核心的综合后端**：

- 用户认证（JWT 双 token）
- 日报内容管理（AI 情报 / 汪汪队）
- Agent 平台：可配置的多 Agent 会话系统（LangGraph tool loop + MCP 工具 + Skill 子代理 + SSE 流式）
- AI 画布平台：无限画布文档 + AI 图/视/音生成 + 媒体/素材/提示词资产
- A 股多空信号扫描

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                          前端 / 客户端                            │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTP / SSE（/api 前缀）
┌──────────────────────────────▼──────────────────────────────────┐
│                         NestJS 应用层                             │
│  全局 ValidationPipe(严格白名单) → JwtAuthGuard → Controller       │
│  Swagger(仅非生产) · CORS(白名单才带 credentials)                  │
├─────────────────────────────────────────────────────────────────┤
│                          业务模块层                               │
│                                                                  │
│  基础域            Agent 域                 画布/AI 域            │
│  ├ auth           ├ agents(核心编排)        ├ canvas              │
│  ├ users          ├ mcp-servers            ├ ai-generation       │
│  ├ daily-reports  ├ skills                 ├ media               │
│  └ stock-signals  └ scheduled-tasks        ├ assets              │
│                                            └ prompts             │
├─────────────────────────────────────────────────────────────────┤
│  基础设施：TypeORM(MySQL) · @nestjs/schedule(cron) · 静态 /uploads │
│  加密：AES-256-GCM（apiKey / env / headers / AI 渠道 key）         │
└─────────────────────────────────────────────────────────────────┘
        │                │                  │
     MySQL 8.0      LLM Providers      外部服务
   (docker-compose)  (按 Agent 配置)   新浪 upbs / MCP Server / AI 生成渠道
```

## 3. 请求链路

```
请求
  → 全局 ValidationPipe（whitelist + forbidNonWhitelisted + transform）
  → JwtAuthGuard（受保护路由）
  → JwtStrategy.validate：验签（仅接受 type=access）→ 查库确认用户存在
  → req.user = 剔除密码的完整 User 实体
  → Controller @CurrentUser() 直接取 user（不二次查库）
  → Service（业务逻辑集中层，可覆盖率度量）
  → TypeORM Repository
```

关键约束：

- **access / refresh token 用 `type` 标记区分**，不可混用；共用同一 `JWT_SECRET`（缺失时 fail fast）。
- `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` 从 env 读取后必须 `Number()` 转换（否则 jsonwebtoken 按毫秒解释）。
- `synchronize: false` 全环境关闭；实体变更走手写 DDL（`docs/plans/*.sql`）+ Adminer 手动执行。
- 实体经 `**/*.entity{.ts,.js}` glob 自动发现，新实体放哪都会被加载。

## 4. 模块清单与依赖方向

| 模块 | 职责 | 鉴权 |
|---|---|---|
| `auth` | 注册 / 登录 / 刷新令牌，JwtStrategy | 公开 + 受保护 |
| `users` | User 实体（含 role）+ UsersService，**无 controller** | — |
| `daily-reports` | 日报 CRUD | GET 公开，写需 JWT |
| `agents` | Agent 配置 / 会话 / LangGraph 执行 / 定时任务 / 画布工具 | JWT |
| `mcp-servers` | 全局 MCP Server 工具库（Admin 配置，用户选配） | JWT + admin |
| `skills` | Skill CRUD + Skill→Tool 工厂（子 Agent） | JWT |
| `stock-signals` | A 股多空信号扫描（异步任务轮询回填） | GET 公开 |
| `canvas` | 无限画布项目（document JSON + version 乐观锁） | JWT |
| `ai-generation` | AI 渠道管理 + 图/视/音生成（任务化 + cron 回填） | JWT |
| `media` | 媒体文件上传 / 落盘 / 静态服务 | JWT |
| `prompts` | 提示词源管理（抓取 + 内存缓存 1h SWR） | JWT |
| `assets` | 素材库（text / image / video，挂 media_id FK） | JWT |
| ~~`uploads`~~ | ⚠️ 孤儿模块，未注册，保留备用 | — |

**模块依赖图（无环）：**

```
auth ──→ users
agents ──→ mcp-servers / skills / daily-reports
       ──→ canvas / ai-generation / prompts / assets
ai-generation ──→ canvas / media
canvas（叶子，不反向依赖任何人）
```

> 规则：画布平台依赖方向为 `CanvasModule ← AiGenerationModule ← AgentsModule`，新增依赖必须保持无环。

## 5. Agent 平台（agents/）——核心域

```
用户消息
  → ConversationsController（SSE）
  → AgentExecutorService
      ├─ 按 Agent 落库配置动态创建 ChatModel（provider / model / apiKey）
      │    apiKey AES-256-GCM 解密（AGENT_ENCRYPTION_KEY 必填，64 位 hex）
      ├─ ToolRegistryService 装配工具：
      │    ├─ builtin/            内置工具
      │    ├─ canvas/             画布工具 16 个（CanvasToolsService）
      │    ├─ MCP 工具            来自 mcp-servers（用户选配）
      │    └─ Skill 工具          skill-tool.factory 包装为 DynamicStructuredTool
      │                            （zod 校验输入，内部走子 Agent）
      ├─ LangGraph tool loop 执行，SSE 增量推送
      └─ TypeORMCheckpointer 持久化会话状态（thread_id = conversationId）
```

- **ChatModel 不再走全局 env**：每个 Agent 的 provider/model/apiKey 均落库，运行时动态实例化（原 `src/llm/` 已删除）。
- 会话状态实体：`Conversation` / `Message` / `AgentCheckpoint` / `AgentCheckpointWrite`。
- 定时任务：`ScheduledTask` + `ScheduledTasksService`（`@nestjs/schedule`）。
- 系统消息每轮注入刷新的北京时间戳元数据。
- 前端契约：**同一会话必须串行发消息**（后端未做行锁）。
- stdio 类型 MCP 仅 `role=admin` 可配置。

## 6. 画布与 AI 生成域

### 6.1 画布（canvas/）

- 画布文档 = `canvas_projects.document` JSON 列 + `version` 乐观锁。
- **所有写路径收敛到 `CanvasDocumentService.applyMutation`**，`CanvasOpsService` 为上层操作入口（单一写路径，供 controller 与 Agent 工具共用）。
- 2026-08 从 infinite-canvas 迁移（AGPL-3.0，见根目录 NOTICE 与 `docs/plans/2026-08-07-canvas-platform-design.md`）。
- ❌ 自定义调用脚本 v1 不支持（服务端 `new Function` = RCE 风险）。

### 6.2 AI 生成（ai-generation/）

- `AiChannel`：AI 渠道配置，key AES-256-GCM 加密落库。
- `GenerationTask`：图/视/音生成统一任务模型；**视频生成任务化**——POST 立即返回 taskId，`GenerationPollerService` cron 每 10s 轮询渠道回填结果。
- `providers/`：各渠道适配实现。
- 生成结果落盘走 `MediaModule.saveBuffer`（媒体主写入路径）。

### 6.3 资产链路

```
prompts(提示词源，抓取+缓存) ─┐
assets(素材，挂 media_id FK) ─┼─→ agents 工具集 ─→ LLM 产出 ─→ media 落盘 ─→ /uploads/media 静态
canvas(画布文档)             ─┘                                  ↑
ai-generation 生成结果也走 media.saveBuffer 落盘 ────────────────┘
```

## 7. 横切关注点

| 关注点 | 方案 |
|---|---|
| 参数校验 | 全局 `ValidationPipe`（严格白名单），DTO 未声明字段直接 400 |
| 序列化 | `password` 永不进 API 响应（JwtStrategy 解构剔除） |
| 敏感信息 | AES-256-GCM：Agent apiKey / MCP env+headers / AI 渠道 key |
| 错误消息 | 一律中文；`NotFoundException` / `ConflictException` |
| 分页 | QueryBuilder，固定返回 `{ items, total, page, limit, totalPages }` |
| 静态文件 | `/uploads/` 前缀在 `/api` **之外**，前端拼 URL 需补 origin |
| Swagger | 仅非生产注册，`/api/docs` |
| CORS | 仅在配置 `CORS_ORIGINS` 时开 credentials（与 `origin: '*'` 互斥） |
| 异常过滤 | `AllExceptionsFilter` 已存在但**故意未全局注册**（会改变错误响应形状） |
| cron | `@nestjs/schedule`：视频轮询（10s）/ Agent 定时任务 |

## 8. 环境变量

| 变量 | 说明 |
|---|---|
| `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE` | MySQL 连接（默认库 `tuanzi_server`） |
| `JWT_SECRET` | **必填**，双 token 共用，缺失 fail fast |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | 秒，默认 7200 / 604800 |
| `AGENT_ENCRYPTION_KEY` | **必填**，64 位 hex，AES-256-GCM 密钥 |
| `CORS_ORIGINS` | 逗号分隔白名单；不配则 `origin: '*'` 无 credentials |
| `PORT` | 默认 3000 |
| `NODE_ENV` | development 时开 TypeORM logging；production 时关 Swagger |

加载顺序：`.env.local` 优先于 `.env`（`app.module.ts` 的 `envFilePath`）。

## 9. 部署与运行

```bash
docker-compose up -d    # MySQL 8.0 + Adminer(:8080)
cp .env.example .env    # 改 DB_PASSWORD / JWT_SECRET / AGENT_ENCRYPTION_KEY
pnpm start:dev          # http://localhost:3000/api（Swagger: /api/docs）
```

- 应用入口 `src/main.ts`；构建产物 `dist/`。
- 数据库变更流程：改实体 → 手写 DDL 到 `docs/plans/YYYY-MM-DD-*.sql` → Adminer 手动执行（无 migration 机制）。

## 10. 质量保障

- **测试**：Jest 30 + ts-jest，统一放 `test/` 镜像 `src/` 结构，`src/` 别名导入；单元测试 mock 全部外部依赖，不连真实库；覆盖率排除 module/dto/entity/main。
- **静态检查**：`pnpm lint`（ESLint 9 flat）/ `pnpm format`（Prettier）/ `pnpm typecheck`（tsc strict）。
- **提交门禁**：husky pre-commit（lint-staged）+ commitlint（conventional commits）。
- **分支规范**：`<type>/<kebab-case-描述>`，长期分支仅 `main`。
