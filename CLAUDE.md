# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 身份定义

- **角色**: NestJS 后端工程师
- **技术栈**: TypeScript 5.8 + NestJS 11 + TypeORM 0.3 + MySQL 8.0 + passport-jwt + LangChain/LangGraph + zod + pnpm 10
- **项目描述**: 团子后台基础服务——用户认证 + 日报（AI情报/汪汪队）内容管理 + Agent 平台 API

## 项目结构

```
src/
  auth/           # 注册/登录/刷新令牌 + JwtStrategy（依赖 UsersModule）
  users/          # User 实体（含 role 字段）+ UsersService（无 controller，不暴露路由）
  daily-reports/  # 日报 CRUD，公开只读接口，无需鉴权
  agents/         # Agent 平台：配置 CRUD + 多轮会话 + LangGraph tool loop + MCP 工具 + SSE 流式
                  #   + tools/canvas/ 画布 Agent 工具 16 个（CanvasToolsService）
  mcp-servers/    # 全局 MCP Server 工具库 CRUD：Admin 集中配置，普通用户选配给 Agent；
                  #   env/headers AES-256-GCM 加密落库，绝不明文出现在 API 响应
  skills/         # 技能管理 CRUD + skill-tool.factory：Skill → DynamicStructuredTool，
                  #   主 Agent 像调普通工具一样调 Skill（zod 校验输入，内部走子 Agent）
  stock-signals/  # A股多空信号扫描：新浪 upbs 接口抓取（并发 12/超时 10s），
                  #   POST 扫描建异步任务轮询回填，GET 结果/历史日期公开只读
  media/          # 媒体文件：上传/落盘（saveBuffer 是生成结果主写入路径）+ /uploads/media 静态
  ai-generation/  # AI 渠道（key AES-256-GCM 加密）+ 图/视/音生成 + providers/ + cron 视频轮询
  canvas/         # 无限画布：canvas_projects（document JSON + version 乐观锁）+ CanvasOpsService 单一写路径
  prompts/        # 提示词库：prompt_sources 源管理（内容不入库，抓取 + 内存缓存 1h SWR）
  assets/         # 素材库：text/image/video 素材（媒体挂 media_id FK）
  uploads/        # ⚠️ 孤儿模块：MulterModule 磁盘存储配置，未在 app.module 注册
  common/         # guards/ decorators/ filters/（跨模块共享件）
```

- 功能模块在 `src/app.module.ts` 注册，当前：`AuthModule`、`UsersModule`、`DailyReportsModule`、`AgentsModule`、`McpServersModule`、`SkillsModule`、`StockSignalsModule`、`MediaModule`、`AiGenerationModule`、`CanvasModule`、`PromptsModule`、`AssetsModule`。新增模块必须手动加进 `imports`。
- **画布平台**（2026-08 从 infinite-canvas 迁移，AGPL-3.0，见根目录 NOTICE 与 `docs/plans/2026-08-07-canvas-platform-design.md`）：画布文档 = `canvas_projects.document` JSON 列 + version 乐观锁，所有写路径走 `CanvasDocumentService.applyMutation`；视频生成任务化（POST 立即返回 taskId，cron 10s 轮询回填）；模块依赖方向 CanvasModule ← AiGenerationModule ← AgentsModule（无环）。**自定义调用脚本 v1 不支持**（服务端 `new Function` = RCE 风险，决策见设计文档 §1）。
- `uploads/` 目录（仓库根）存封面图，`main.ts` 静态服务在 `/uploads/` 前缀（注意在 `/api` 前缀之外，前端拼 URL 要补 origin）。
- `agents/` 要点：**ChatModel 按 Agent 的数据库配置动态创建**（provider/model/apiKey 均落库，原 `src/llm/` 全局 env 配置模块已删除）；会话状态用 TypeORMCheckpointer（thread_id = conversationId）持久化；API Key AES-256-GCM 加密存储（密钥为必填环境变量 `AGENT_ENCRYPTION_KEY`，64 位 hex）；stdio 类型 MCP 仅 `role=admin` 用户可配置（首个管理员需手工 SQL 提权）；同一会话必须串行发消息（前端契约，后端未做行锁）。
- `agents/` 执行引擎不变式（2026-08 DSH 交互移植，踩坑实录）：① **`iterations: 0` 必须随每次图运行重置**（run/runStream/runSubAgent/runBatch 四个入口）——checkpoint 恢复会带上历史累计值，累计 ≥ maxIterations 后条件边永久跳过 tools_node，留下无 tool 回应的 tool_calls 毒化后续每一轮；② **子代理事件隔离**：LangChain callback 传播会让子图 streamEvents 全部冒泡到外层 streamEvents，且两边节点同名（agent_node/tools_node）——子运行必须带 `metadata.subAgentRun=true`（可继承标记），外层 pump 丢弃带标事件，子轨迹只经 subHook 旁路以 `sub_event { callId, ... }` 注入合并队列；③ **同会话执行锁** `ConversationExecutionLock`（内存 FIFO）：streamMessages 与后台任务 runner 共用，后台任务走 runBatch({threadId}) 才不会踩坏 checkpoint 基线；④ 工具失败透出走 per-run `erroredToolCalls` Set → SSE `tool_result.isError` + 持久化 `messages.is_error`。
  - 生产库手动 DDL（synchronize=false）：
    ```sql
    ALTER TABLE messages ADD COLUMN is_error tinyint(1) NOT NULL DEFAULT 0;
    CREATE TABLE background_tasks (
      id char(36) NOT NULL PRIMARY KEY,
      conversation_id char(36) NOT NULL,
      agent_config_id char(36) NOT NULL,
      status enum('pending','running','done','failed') NOT NULL DEFAULT 'pending',
      input text NOT NULL,
      result_message_id char(36) NULL,
      created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      finished_at datetime(6) NULL,
      KEY idx_bg_conv_status (conversation_id, status),
      CONSTRAINT fk_bg_conv FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ```

## 可执行命令

```bash
docker-compose up -d      # 启动 MySQL 8.0 + Adminer（数据库管理界面 :8080）
cp .env.example .env      # 然后改 DB_PASSWORD / JWT_SECRET
pnpm start:dev            # watch 模式开发服务器（http://localhost:3000/api）
pnpm build                # 编译到 dist/
pnpm lint                 # eslint --fix（ESLint 9 flat config：eslint.config.mjs）
pnpm format               # prettier --write 全量格式化（规则见 .prettierrc）
pnpm typecheck            # tsc --noEmit 严格类型检查（tsconfig 已开 strict）
pnpm test                 # 全部 jest 测试
pnpm test -- auth.service # 按路径/模式跑单个测试
pnpm test:cov             # 覆盖率（排除 module/dto/entity/main）
```

- API 前缀 `api`（`main.ts` 设置）；Swagger UI: `http://localhost:3000/api/docs`
- 环境变量加载顺序：`.env.local` 优先于 `.env`（`app.module.ts` 的 `envFilePath`）
- 部署：`bash deploy.sh`（同步源码 → 服务器重建 app → 健康检查）。**前置会自动跑 `scripts/check-prod-schema.sh`**：代码 `@Entity` 表清单 vs 生产库 `SHOW TABLES`，缺表直接拒绝部署并提示待执行的 `docs/plans/*.sql`——synchronize 关闭后新实体必须先手动执行 DDL 再发版。
- 生产日志：`bash scripts/logs.sh`（排障一条龙）——`--since 2h --level error --path ai-channels` 按时间窗/级别/接口路径过滤，默认 1h 内 WARN+ERROR；日志为 pino JSON（nestjs-pino 接管全部 NestJS 日志，authorization/cookie 永不落盘），服务器侧 jq 过滤。列级 schema 深度排查用 `scripts/schema-diff-prod.js`（用法见文件头注释）。

## 核心架构：认证与请求链路

```
请求 → global ValidationPipe(严格白名单) → JwtAuthGuard(受保护路由)
     → JwtStrategy.validate: 验签(仅接受 type=access) → UsersService.findById → req.user = 剔除密码的完整 user
     → Controller: @CurrentUser() 直接取 user（无需再查库） → Service → TypeORM Repository
```

关键事实：

- access token / refresh token 的 payload 都带 `type` 标记（`TokenType` 枚举，`auth.service.ts`）：refresh 接口只接受 `type=refresh`，受保护路由只接受 `type=access`，两种 token 不可混用。两者仍用**同一个 `JWT_SECRET`** 签发；刷新接口（`POST /api/auth/refresh`）用 `jwtService.verify` 验证后重新签发一对 token。
- 过期时间走环境变量 `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN`（单位：秒，默认 7200 / 604800）。注意：env 读出来是字符串，代码里必须 `Number()` 转换，否则 jsonwebtoken 会把 `"7200"` 当成 7200 毫秒。
- `JWT_SECRET` 为必填——`auth.module.ts` 与 `jwt.strategy.ts` 在缺失时会直接抛错（fail fast），不再有默认值兜底。
- `JwtStrategy.validate` 返回**剔除密码的完整 user 实体**（查库确认用户存在后一次返回），controller 用 `@CurrentUser()` 直接获取，不要二次查库。
- `synchronize: false`（2026-08 起全环境关闭）：改实体后**手写 DDL 放 `docs/plans/YYYY-MM-DD-*.sql`**，手动在 Adminer（:8080）执行，不写 migration。
- 实体通过 `**/*.entity{.ts,.js}` glob 自动发现，新实体放哪都会被加载。
- 日报模块：只读接口（GET）公开，写接口（POST/PATCH/DELETE）必须 `@UseGuards(JwtAuthGuard)`。
- Swagger 仅非生产环境注册；CORS 仅在配置 `CORS_ORIGINS` 时开启 credentials（`origin: '*'` 与 credentials 互斥）。

## 编码规范

从现有代码观察到的约定（新代码应保持一致）：

- **实体**: `snake_case` 表名/列名（`@Entity('daily_reports')`、`name: 'created_at'`），主键 `@PrimaryGeneratedColumn('uuid')`，必填 `createdAt/updatedAt` 时间戳列；枚举类型定义在实体文件里 export（如 `DailyReportType`）。
- **DTO**: 每个字段同时带 `@ApiProperty({ example, description })`（中文描述）+ class-validator 装饰器；query 数字参数必须 `@Type(() => Number)` 并在 DTO 里给默认值（见 `QueryDailyReportDto`）。
- **Controller**: 每个路由带 `@ApiOperation`/`@ApiResponse`，受保护路由加 `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`；ID 参数用 `ParseUUIDPipe`；删除接口返回 204（`@HttpCode(HttpStatus.NO_CONTENT)`）。
- **Service**: 分页查询用 QueryBuilder，返回固定形状 `{ items, total, page, limit, totalPages }`；找不到抛 `NotFoundException`（中文消息，如 `` `日报 #${id} 不存在` ``）；业务冲突抛 `ConflictException`。
- **错误消息与 API 文案一律中文**。
- **提交规范**：husky 管理 git hooks——`pre-commit` 跑 lint-staged（eslint --fix + prettier），`commit-msg` 用 commitlint 强制 conventional commits（`feat:`/`fix:`/`chore:`...），不规范的提交信息会被直接拦截。
- **分支规范**：格式 `<type>/<kebab-case-描述>`，type 与 commitlint 类型集合对齐（`feat`/`fix`/`chore`/`refactor`/`docs`/`test`），另加 `hotfix` 用于线上紧急修复。描述用小写英文 2~4 个词，说清"做什么"（如 `feat/llm-report-generation`、`fix/jwt-refresh-expiry`）；有 issue 编号可加在描述前（`feat/123-llm-report`）。长期分支只保留 `main`，功能分支合并后即删。
- 测试用 `Test.createTestingModule` + `useValue` mock 依赖（见 `test/auth/auth.service.spec.ts`），测试描述用中文。

## 三层边界模型

### ✅ 必须执行

- 所有请求字段走 DTO + class-validator——全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，DTO 未声明的字段会直接 400。
- 新增实体字段后：手写 DDL 到 `docs/plans/` 并在 Adminer（:8080）执行（synchronize 已全环境关闭）。
- 新模块/实体/服务写完跑 `pnpm lint` 和 `pnpm test`。

### ⚠️ 需先询问

- 在 `main.ts` 注册 `AllExceptionsFilter`（它已存在于 `common/filters/` 但**故意未全局注册**——注册后错误响应形状会从 NestJS 默认变为 `{ code, message, timestamp }`，影响前端解析）。
- 修改 JWT 过期时间、`synchronize` 行为、CORS 配置。
- 删除 `src/uploads/` 孤儿模块或 `uploads/` 静态目录（恢复小说/封面上传功能时还要用）。

### ❌ 禁止操作

- 不要在生产配置中开启 TypeORM `synchronize`。
- 不要在 controller 里直接注入 Repository——数据访问一律经过 Service。
- 不要把 `password` 字段泄露到 API 响应（参照 `jwt.strategy.ts#validate` 的解构剔除写法）。
- 不要提交 `.env` / `.env.local`（仅 `.env.example` 入库）。

## 测试要求

- Jest 30（ts-jest 29），测试统一放 `test/` 目录、镜像 `src/` 模块结构（如 `test/auth/auth.service.spec.ts`），`roots` 限定为 `test/`；被测代码一律用 `src/` 别名导入（已在 `jest.config.js` 的 `moduleNameMapper` 映射），不写相对路径。
- 单元测试 mock 所有外部依赖（Service 的 Repository、被注入的其他 Service），不连真实数据库；目前无 e2e 测试。
- 覆盖率收集排除 `*.module.ts` / `*.dto.ts` / `*.entity.ts` / `main.ts`——业务逻辑应放在 Service 层才可被覆盖率度量。

## 文档同步

- 模块级设计/实现文档放 `docs/plans/`，命名格式 `YYYY-MM-DD-<模块>-design.md` / `-impl.md`（已被删除的 novels 模块文档即此格式）。
- 新增功能模块时同步更新本文件「项目结构」与 `app.module.ts` 注册清单。

---
**版本**: v2.4
**最后更新**: 2026-08-08
**维护者**: 团子项目组
