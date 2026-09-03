# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 身份定义

- **角色**: NestJS 后端工程师
- **技术栈**: TypeScript 5.8（target ES2023）+ NestJS 11 + TypeORM 0.3.17 + MySQL 8.0 + Node 22 + pnpm 10.32.0 + passport-jwt + LangChain/LangGraph 1.x + zod 4 + @nestjs/schedule 6
- **项目描述**: 团子后台基础服务——JWT 认证 + 日报（AI 情报/汪汪队）+ Agent 平台（多轮会话 / MCP / Skill 子代理 / SSE）+ AI 画布（图/视/音生成）+ A 股多空信号扫描
- **领域用词**（以根目录 `CONTEXT.md` 为准）：**AiChannel（AI 渠道）** 是全站唯一的模型凭据入口；模型 **用途** 对应代码里的 `capability`（chat / image / video / audio）；**Agent** 只引用某渠道下「对话」用途的模型，凭据不属于 Agent。禁止把渠道叫成「LLM 配置 / provider 配置」，禁止把 capability 叫成「能力 / 类型 / 模式」。

## 项目结构

```
src/
  auth/           # 注册/登录/刷新令牌 + JwtStrategy（依赖 UsersModule）
  users/          # User 实体（含 role）+ UsersService（无 controller，不暴露路由）
  daily-reports/  # 日报 CRUD，GET 公开，写接口需 JWT
  agents/         # Agent 配置/会话/LangGraph tool loop/MCP/Skill/SSE
                  #   + 定时任务 + 后台任务 + 画布工具 19 个（CanvasToolsService）
                  #   + delegate_task 子代理（流式路径由执行器注入）
  mcp-servers/    # 全局 MCP Server 工具库：Admin 集中配置，用户选配给 Agent；
                  #   env/headers AES-256-GCM 加密落库，绝不明文出现在 API 响应
  skills/         # 技能 CRUD + skill-tool.factory：Skill → DynamicStructuredTool
  stock-signals/  # A股多空信号：新浪 upbs（并发 12 / 超时 10s），POST 异步扫描，GET 公开只读
  media/          # 媒体上传/落盘（saveBuffer 是生成结果主写入路径）+ /uploads/media
  ai-generation/  # AI 渠道 CRUD + resolveChatModel + 图/视/音生成 + cron 视频轮询
  canvas/         # 无限画布：document JSON + version 乐观锁；唯一写路径 applyMutation
  prompts/        # 提示词源（内容不入库；抓取 + 进程内 Map 缓存 1h SWR）
  assets/         # 素材库 text/image/video（媒体挂 media_id FK）
  uploads/        # ⚠️ 孤儿模块：Multer 磁盘配置，未在 app.module 注册
  common/         # guards / decorators / filters / crypto.util / ssrf.util
```

- 功能模块在 `src/app.module.ts` 注册。当前：`AuthModule`、`UsersModule`、`DailyReportsModule`、`AgentsModule`、`McpServersModule`、`SkillsModule`、`StockSignalsModule`、`MediaModule`、`AiGenerationModule`、`CanvasModule`、`PromptsModule`、`AssetsModule`。新增模块必须手动加进 `imports`。
- **模块依赖方向（无环）**：`CanvasModule ← AiGenerationModule ← AgentsModule`。`AiGenerationModule` 用 `TypeOrmModule.forFeature([AgentConfig])` 做渠道删除引用检查，**不** import `AgentsModule`。新增依赖必须保持无环。
- **画布平台**（2026-08 从 infinite-canvas 迁移，AGPL-3.0，见根目录 NOTICE 与 `docs/plans/2026-08-07-canvas-platform-design.md`）：画布文档 = `canvas_projects.document` JSON 列 + `version` 乐观锁。所有写路径（前端整文档保存 / Agent ops / 生成回填）走 `CanvasDocumentService.applyMutation`；`CanvasOpsService` 是上层 ops 入口。视频生成任务化（POST 立即返回 taskId，`GenerationPollerService` cron 10s 轮询回填）。**自定义调用脚本 v1 不支持**（服务端 `new Function` = RCE，决策见设计文档 §1；`ChannelModel.script` 只保留字段形状）。
- `uploads/` 目录（仓库根）存封面图与媒体；`main.ts` 静态服务在 `/uploads/` 前缀（在 `/api` 之外，前端拼 URL 要补 origin）。静态响应带 `X-Content-Type-Options: nosniff` 与 CSP sandbox（防存储型 XSS）。媒体落盘目录是 `uploads/media`（`MediaService.MEDIA_DIR`）。
- `ScheduleModule.forRoot()` **只在 `AgentsModule` 调用一次**（Nest 全局）。视频轮询的 `@Cron` 挂在 `AiGenerationModule`，依赖 Agents 模块被加载才会跑。
- `agent_configs.mcp_servers` JSON 列（`legacyMcpServers`）已废弃，代码不再读写；MCP 走 `mcp_servers` + `agent_config_mcp_servers`。

## 可执行命令

```bash
docker-compose up -d      # 启动 MySQL 8.0 + Adminer（:8080）
cp .env.example .env      # 然后改 DB_PASSWORD / JWT_SECRET / AGENT_ENCRYPTION_KEY
pnpm start:dev            # watch 模式（http://localhost:3000/api）
pnpm build                # 编译到 dist/
pnpm lint                 # eslint --fix（ESLint 9 flat：eslint.config.mjs）
pnpm format               # prettier --write，仅 src/**/*.ts（不含 test/）
pnpm typecheck            # tsc --noEmit（tsconfig 已开 strict）
pnpm test                 # 全部 jest
pnpm test -- auth.service # 按路径/模式跑单个测试
pnpm test:cov             # 覆盖率（排除 module/dto/entity/main）
```

- API 前缀 `api`（`main.ts`）；Swagger：`http://localhost:3000/api/docs`（仅非生产）。
- 环境变量加载顺序：`.env.local` 优先于 `.env`（`app.module.ts` 的 `envFilePath`）。已存在的 `process.env` 最高优先（迁移脚本 `scripts/migrate-agent-channels.ts` 同样按此顺序）。
- 部署：**push 到 `main` 自动触发 GitHub Actions**（`.github/workflows/deploy.yml`，方案 C）。流程：CI `pnpm build` → 下发 GitHub Secret `ENV_PRODUCTION` 为服务器 `.env.production` → rsync 源码（排除 `.git` / `node_modules` / `dist` / `uploads` / `.env*`）→ `scripts/run-migrations.sh` 执行 `docs/plans/*.sql`（`ddl_history` 按**文件名**记账，失败即中止不重建 app）→ `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build app` → 健康检查（本机 `POST /api/auth/login` 返 400）。服务器本地 `.env` 供 compose 插值（含 `DB_ROOT_PASSWORD`）。回滚 = Actions 重跑旧 ref（**DDL 只前进**：已记账的文件会跳过，数据库不回退）。纯 `**.md` 不触发部署。旧 `deploy.sh` 已退役。
- `scripts/check-prod-schema.sh` 是**手动**的生产表清单核对（代码 `@Entity('...')` vs `SHOW TABLES`），不在 CI 里；缺表直接 exit 1。脚本内写死了生产 SSH 目标。
- Agent 凭据物化到渠道是一次性脚本，**不走** `docs/plans/*.sql`：

  ```bash
  npx ts-node -r tsconfig-paths/register scripts/migrate-agent-channels.ts
  npx ts-node -r tsconfig-paths/register scripts/migrate-agent-channels.ts --drop-legacy  # 不可逆
  ```

  密文跨表直接复制（两表共用 `AGENT_ENCRYPTION_KEY`）。`--drop-legacy` 删除 `provider/model/api_key_encrypted/base_url` 四列，回滚旧代码会直接崩。

## 部署与运行环境

生产是腾讯云单机 Docker（`Dockerfile` 多阶段：Node 22 bookworm-slim + pnpm 10.32.0，构建用 npmmirror；`HUSKY=0` 避免容器无 `.git` 时装钩子失败）。`docker-compose.prod.yml`：

- `DB_HOST` 必须是 compose 服务名 `mysql`，不能写 `localhost`。
- app 只绑 `127.0.0.1:3000`，对外走 Nginx。
- `./uploads:/app/uploads` 挂载，容器重建不丢媒体。MySQL `utf8mb4` / `utf8mb4_unicode_ci`。

```ts
// ✅ 生产参考音视频 URL 必须是公网可达的绝对地址
// AiGenerationModule.onModuleInit：NODE_ENV=production 且未设 PUBLIC_BASE_URL → 拒绝启动
PUBLIC_BASE_URL=https://example.com

// ❌ 生产用缺省 localhost：远端模型服务拉不到参考素材，视频/音频生成会全部失败
```

单实例假设（当前不管多副本）：

- `ConversationExecutionLock` 是**进程内 FIFO**，不是 DB 行锁。
- `GenerationPollerService` 无 leader 锁；多实例会重复轮询。

时区：Agent 系统消息时间戳与定时任务「今天」/cron 都按 `Asia/Shanghai`（`ScheduledTasksService` 的 `TZ`，执行器 `formatTimestamp`）。定时任务停机错过的触发**不补跑**；最小间隔 1 小时。

画布 JSON 很大：`main.ts` 关掉 Nest 默认 bodyParser，手动 `json/urlencoded` 上限 **5mb**（express 默认 100kb 会截断整文档保存）。

## 核心架构：认证与请求链路

```
请求 → global ValidationPipe(whitelist + forbidNonWhitelisted + transform)
     → JwtAuthGuard(受保护路由)
     → JwtStrategy.validate: 验签(仅接受 type=access) → UsersService.findById
     → req.user = 剔除密码的完整 user
     → Controller @CurrentUser() 直接取 user（无需再查库） → Service → TypeORM Repository
```

- access / refresh payload 都带 `type`（`TokenType`，`auth.service.ts`）：refresh 接口只接受 `type=refresh`，受保护路由只接受 `type=access`。两者共用同一个 `JWT_SECRET`；`POST /api/auth/refresh` 用 `jwtService.verify` 后重新签发一对。
- `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` 单位秒，默认 7200 / 604800。env 是字符串，必须 `Number()`，否则 jsonwebtoken 把 `"7200"` 当成 7200 毫秒。`auth.module.ts` 与 `auth.service.ts` 对非正整数 **fail-fast**（非法值会让所有新 token 无法验签）。
- `JWT_SECRET` 必填——`auth.module.ts` 与 `jwt.strategy.ts` 缺失即抛错，无默认值。
- 登录支持邮箱或用户名；用户不存在时仍跑一次对固定哈希的 `bcrypt.compare`（防账号枚举时序）。统一错误文案「用户名或密码错误」。密码 `bcrypt.hash(..., 10)`。
- `synchronize: false` 全环境关闭。改实体后手写 DDL 到 `docs/plans/YYYY-MM-DD-*.sql`，部署流水线自动执行（`scripts/run-migrations.sh` + `ddl_history`）。不写 TypeORM migration。文件名一旦执行不可改；DDL 只前进，不设回退脚本。本地可在 Adminer（:8080）手动执行。
- 实体经 `**/*.entity{.ts,.js}` glob 自动发现，新实体放哪都会被加载。
- 日报：GET 公开，POST/PATCH/DELETE 必须 `@UseGuards(JwtAuthGuard)`。
- Swagger 仅非生产注册。CORS：配了 `CORS_ORIGINS` 才 `credentials: true`（`origin: '*'` 与 credentials 互斥）。

## 核心架构：Agent 对话模型解析

Agent **不再内嵌** provider / apiKey / baseUrl / model。运行时链路：

```
创建/更新 Agent
  → DTO: channelId + modelName
  → AiChannelsService.resolveChatModel(userId, channelId, modelName)
      校验：渠道存在 / 归属当前用户 / isActive / 模型存在 / capability === chat
  → 只存 channelId + modelName

执行（run / runStream / runSubAgent / runBatch）
  → AgentExecutorService.createModelFromConfig
  → resolveChatModel 解密 apiKey（密文只活在函数栈帧）
  → apiFormat=anthropic → ChatAnthropic；openai → ChatOpenAI
  → 其他格式（gemini / ark）抛 400「不支持对话」
```

- 渠道删除：先查引用该渠道的 Agent，有则 400 并返回 `{ id, name }[]`；DB 层 `ON DELETE RESTRICT` 兜底（`ai-channels.service.ts`）。
- 决策见 `docs/adr/0001-unify-llm-credentials-into-ai-channels.md`。
- AES-256-GCM 密钥是必填 env `AGENT_ENCRYPTION_KEY`（64 位 hex，`openssl rand -hex 32`）。同一把钥匙加密：AI 渠道 apiKey、MCP env/headers。注入 token 是 `AGENT_ENCRYPTION_KEY` Symbol（`agents/utils/encryption-key.provider.ts`），测试用 `useValue` 注入固定 key。实现在 `common/utils/crypto.util.ts`。
- 会话状态：TypeORMCheckpointer（`thread_id = conversationId`）。stdio 类型 MCP 仅 `role=admin` 可配置（首个管理员需手工 SQL 提权）。
- 工具名静态表在 `agents/tools/tool-names.ts`（避免 AgentsModule ↔ SkillsModule 循环依赖）：内置 `web_search` / `calculator`；画布 19 个；Agent 作用域还有定时任务与 `run_background_task`；`delegate_task` 仅流式执行器注入。

## 核心架构：Agent 执行引擎不变式

2026-08 DSH 交互移植踩坑，四个入口（`run` / `runStream` / `runSubAgent` / `runBatch`）都必须遵守：

1. **`iterations: 0` 必须随每次图运行重置**。checkpoint 恢复会带上历史累计值，累计 ≥ maxIterations 后条件边永久跳过 `tools_node`，留下无 tool 回应的 `tool_calls`，毒化后续每一轮。
2. **子代理事件隔离**。LangChain callback 会让子图 `streamEvents` 全部冒泡到外层，且两边节点同名（`agent_node` / `tools_node`）。子运行必须带 `metadata.subAgentRun=true`（可继承）；外层 pump 丢弃带标事件；子轨迹只经 `subHook` 旁路以 `sub_event { callId, ... }` 注入合并队列。
3. **同会话执行锁** `ConversationExecutionLock`（内存 FIFO）：`streamMessages` 与后台任务 runner 共用。锁必须包住整个执行周期（含 baseline 捕获与回滚）。后台任务走 `runBatch({ threadId })` 才不会踩坏 checkpoint 基线。这不是 DB 行锁，多实例无效。
4. **工具失败透出**：per-run `erroredToolCalls` Set → SSE `tool_result.isError` + 持久化 `messages.is_error`。单工具超时 30s（`TOOL_TIMEOUT_MS`），超时文案喂给 LLM，未知异常脱敏为「工具执行失败，请稍后重试」。

`messages.is_error` 与 `background_tasks` 表的 DDL 已在 `docs/plans/2026-08-21-background-tasks-and-is-error.sql`，随流水线执行，不要再手工补这两段。

## 编码规范

从现有代码观察到的约定（新代码应保持一致）：

- **实体**: `snake_case` 表名/列名（`@Entity('daily_reports')`、`name: 'created_at'`），主键 `@PrimaryGeneratedColumn('uuid')`，必填 `createdAt/updatedAt`；枚举在实体文件里 export（如 `DailyReportType`、`ApiFormat`、`ModelCapability`、`UserRole`）。`check-prod-schema.sh` 按 `@Entity('...')` 单引号写法抽表名。
- **DTO**: 每个字段同时带 `@ApiProperty({ example, description })`（中文描述）+ class-validator；query 数字参数必须 `@Type(() => Number)` 并给默认值（见 `QueryDailyReportDto`）。
- **Controller**: 每个路由带 `@ApiOperation` / `@ApiResponse`；受保护路由 `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`；ID 用 `ParseUUIDPipe`；删除返回 204（`@HttpCode(HttpStatus.NO_CONTENT)`）。
- **Service**: 分页用 QueryBuilder，返回 `{ items, total, page, limit, totalPages }`；找不到抛 `NotFoundException`（中文，如 `` `日报 #${id} 不存在` ``）；业务冲突抛 `ConflictException`。多用户资源按 `userId` 过滤，查不到统一 404（不区分「不存在」与「别人的」）。唯一索引冲突把 `ER_DUP_ENTRY` 转成 `ConflictException`，不要漏 500（见 `users.service.ts` / `daily-reports.service.ts`）。
- **敏感字段**: 响应用 View 类型显式挑字段（`AiChannelView` 回 `apiKeyMasked`，`McpServerView` 去掉 env/headers 密文）。解构剔除写法依赖 eslint `ignoreRestSiblings`。
- **出站 URL**: 用户/远端提供、服务端主动 `fetch` 的入口必须先 `assertPublicUrl`（`common/utils/ssrf.util.ts`）：assets 图片导入、prompts 源抓取、ai-generation 结果下载、mcp-servers 的 sse/streamable-http URL。协议仅 http/https；拦截回环/私网/链路本地/CGNAT/云元数据。不要给 `BlockList` 加 `::ffff:0:0/96`（会误杀全部公网 IPv4）。
- **错误消息与 API 文案一律中文**。
- **Prettier**: `singleQuote`、`trailingComma: all`、`printWidth: 100`、`endOfLine: lf`（`.prettierrc`）。
- **提交规范**: husky `pre-commit` → lint-staged（eslint --fix + prettier，匹配 `*.ts` 含 test）；`commit-msg` → commitlint conventional commits（`feat:` / `fix:` / `chore:` …）。
- **分支规范**: `<type>/<kebab-case-描述>`，type 对齐 commitlint（另加 `hotfix`）。描述小写英文 2~4 词（如 `feat/llm-report-generation`）；有 issue 可写 `feat/123-llm-report`。长期分支只留 `main`，功能分支合并后即删。
- **测试**: `Test.createTestingModule` + `useValue` mock（见 `test/auth/auth.service.spec.ts`）；描述用中文。被测代码用 `src/` 别名导入（jest `moduleNameMapper`），不要用 tsconfig 的 `@/`（jest 未映射）。

## 三层边界模型

### ✅ 必须执行

- 请求字段走 DTO + class-validator。全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，DTO 未声明字段直接 400。
- 新增实体字段：手写 DDL 到 `docs/plans/YYYY-MM-DD-*.sql`（渠道物化那次除外，走 `migrate-agent-channels.ts`）。本地可在 Adminer 调试。
- 新模块/实体/服务写完跑 `pnpm lint` 和 `pnpm test`。
- Agent 的对话模型只写 `channelId` + `modelName`，创建/更新/执行都经 `resolveChatModel`。不要把 apiKey 写回 `agent_configs`。
- 服务端出站抓取先 `assertPublicUrl`。
- 图运行四个入口重置 `iterations: 0`；子代理带 `subAgentRun`；同会话走 `ConversationExecutionLock`。
- 画布写入走 `CanvasDocumentService.applyMutation`（空 patch 会短路不 bump version）。

### ⚠️ 需先询问

- 在 `main.ts` 注册 `AllExceptionsFilter`（已存在于 `common/filters/` 但**故意未全局注册**——注册后错误响应从 NestJS 默认变为 `{ code, message, timestamp }`，影响前端解析）。
- 修改 JWT 过期时间、`synchronize`、CORS、`PUBLIC_BASE_URL`、`AGENT_ENCRYPTION_KEY`。
- 删除 `src/uploads/` 孤儿模块或 `uploads/` 静态目录（恢复小说/封面上传时还要用）。
- 对 `agent_configs` 跑 `--drop-legacy`，或删 `legacyMcpServers` 列。
- 把 `ScheduleModule.forRoot()` 挪出 `AgentsModule`，或按多实例改执行锁 / 视频轮询。

### ❌ 禁止操作

- 不要在任何环境打开 TypeORM `synchronize`（生产尤其禁止）。
- 不要在 controller 里直接注入 Repository——数据访问一律经过 Service。
- 不要把 `password`、渠道 `apiKey` 明文、MCP `env`/`headers` 明文送进 API 响应。
- 不要提交 `.env` / `.env.local` / `.env.production`（仅 `.env.example` 入库）。
- 不要用 `new Function` / `eval` 执行渠道 `script`。
- 不要改已经进入 `ddl_history` 的 SQL 文件名。
- 不要给用户可控 URL 的服务端 `fetch` 跳过 SSRF 校验，也不要 `redirect: follow` 绕过（生成下载是 `redirect: manual`）。

## 测试要求

- Jest 30 + ts-jest 29，测试放 `test/`、镜像 `src/` 模块结构，`roots` 限定 `test/`。
- 单元测试 mock 所有外部依赖（Repository、被注入的其他 Service），不连真实数据库；目前无 e2e。
- 覆盖率收集排除 `*.module.ts` / `*.dto.ts` / `*.entity.ts` / `main.ts`——业务逻辑放 Service 层才进覆盖率。
- 测试里 `@typescript-eslint/no-explicit-any` 关闭；生产代码是 `warn`。

## 文档同步

- 模块级设计/实现：`docs/plans/YYYY-MM-DD-<模块>-design.md` / `-impl.md` / `*.sql`。
- 架构决策：`docs/adr/`（现有 `0001-unify-llm-credentials-into-ai-channels.md`）。领域词：`CONTEXT.md`。
- 新增功能模块时同步更新本文件「项目结构」与 `app.module.ts` 注册清单。
- `docs/architecture.md` 仍写「按 Agent 落库的 provider/apiKey 建 ChatModel」，**已过期**；以本文件与代码为准。

---
**版本**: v3.0
**最后更新**: 2026-09-03
**维护者**: 团子项目组
