# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 身份定义

- **角色**: NestJS 后端工程师
- **技术栈**: TypeScript 5.8 + NestJS 11 + TypeORM 0.3 + MySQL 8.0 + passport-jwt + pnpm 10
- **项目描述**: 团子后台基础服务——用户认证 + 日报（AI情报/汪汪队）内容管理 API

## 项目结构

```
src/
  auth/           # 注册/登录/刷新令牌 + JwtStrategy（依赖 UsersModule）
  users/          # User 实体 + UsersService（无 controller，不暴露路由）
  daily-reports/  # 日报 CRUD，公开只读接口，无需鉴权
  uploads/        # ⚠️ 孤儿模块：MulterModule 磁盘存储配置，未在 app.module 注册
  common/         # guards/ decorators/ filters/（跨模块共享件）
```

- 功能模块在 `src/app.module.ts` 注册，当前仅：`AuthModule`、`UsersModule`、`DailyReportsModule`。新增模块必须手动加进 `imports`。
- `uploads/` 目录（仓库根）存封面图，`main.ts` 静态服务在 `/uploads/` 前缀。文件上传端点随 novels 模块一起被删除；如需恢复上传，把 `UploadsModule` import 进使用方模块并配 `FileInterceptor`。

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

## 核心架构：认证与请求链路

```
请求 → global ValidationPipe(严格白名单) → JwtAuthGuard(受保护路由)
     → JwtStrategy.validate: 验签 → UsersService.findById → req.user = { userId }
     → Controller: @CurrentUser() 取 userId → Service → TypeORM Repository
```

关键事实：

- access token 2h / refresh token 7d，两者用**同一个 `JWT_SECRET`** 签发；刷新接口（`POST /api/auth/refresh`）用 `jwtService.verify` 验证 refresh token 后重新签发一对 token（`auth.service.ts`）。
- `JwtStrategy.validate` 返回 `{ userId }` 而非完整 user 实体——controller 里只能拿到 `userId`，要用户数据需再查库。
- `synchronize: NODE_ENV !== 'production'`：开发环境改实体即自动改表，**不要写 migration**；生产环境绝不能开。
- 实体通过 `**/*.entity{.ts,.js}` glob 自动发现，新实体放哪都会被加载。

## 编码规范

从现有代码观察到的约定（新代码应保持一致）：

- **实体**: `snake_case` 表名/列名（`@Entity('daily_reports')`、`name: 'created_at'`），主键 `@PrimaryGeneratedColumn('uuid')`，必填 `createdAt/updatedAt` 时间戳列；枚举类型定义在实体文件里 export（如 `DailyReportType`）。
- **DTO**: 每个字段同时带 `@ApiProperty({ example, description })`（中文描述）+ class-validator 装饰器；query 数字参数必须 `@Type(() => Number)` 并在 DTO 里给默认值（见 `QueryDailyReportDto`）。
- **Controller**: 每个路由带 `@ApiOperation`/`@ApiResponse`，受保护路由加 `@UseGuards(JwtAuthGuard)` + `@ApiBearerAuth()`；ID 参数用 `ParseUUIDPipe`；删除接口返回 204（`@HttpCode(HttpStatus.NO_CONTENT)`）。
- **Service**: 分页查询用 QueryBuilder，返回固定形状 `{ items, total, page, limit, totalPages }`；找不到抛 `NotFoundException`（中文消息，如 `` `日报 #${id} 不存在` ``）；业务冲突抛 `ConflictException`。
- **错误消息与 API 文案一律中文**。
- **提交规范**：husky 管理 git hooks——`pre-commit` 跑 lint-staged（eslint --fix + prettier），`commit-msg` 用 commitlint 强制 conventional commits（`feat:`/`fix:`/`chore:`...），不规范的提交信息会被直接拦截。
- 测试用 `Test.createTestingModule` + `useValue` mock 依赖（见 `auth.service.spec.ts`），测试描述用中文。

## 三层边界模型

### ✅ 必须执行

- 所有请求字段走 DTO + class-validator——全局 `ValidationPipe` 开了 `forbidNonWhitelisted`，DTO 未声明的字段会直接 400。
- 新增实体字段后重启 dev server 让 synchronize 生效，然后用 Adminer（:8080）确认表结构。
- 新模块/实体/服务写完跑 `pnpm lint` 和 `pnpm test`。

### ⚠️ 需先询问

- 在 `main.ts` 注册 `AllExceptionsFilter`（它已存在于 `common/filters/` 但**故意未全局注册**——注册后错误响应形状会从 NestJS 默认变为 `{ code, message, timestamp }`，影响前端解析）。
- 修改 JWT 过期时间、`synchronize` 行为、CORS 配置。
- 删除 `src/uploads/` 孤儿模块或 `uploads/` 静态目录（恢复小说/封面上传功能时还要用）。

### ❌ 禁止操作

- 不要在生产配置中开启 TypeORM `synchronize`。
- 不要在 controller 里直接注入 Repository——数据访问一律经过 Service。
- 不要把 `password` 字段泄露到 API 响应（参照 `auth.service.ts#getProfile` 的解构剔除写法）。
- 不要提交 `.env` / `.env.local`（仅 `.env.example` 入库）。

## 测试要求

- Jest 29，`rootDir: src`，测试为与源码同目录的 `*.spec.ts`；路径别名 `src/*` 已在 `jest.config.js` 映射。
- 单元测试 mock 所有外部依赖（Service 的 Repository、被注入的其他 Service），不连真实数据库；目前无 e2e 测试。
- 覆盖率收集排除 `*.module.ts` / `*.dto.ts` / `*.entity.ts` / `main.ts`——业务逻辑应放在 Service 层才可被覆盖率度量。

## 文档同步

- 模块级设计/实现文档放 `docs/plans/`，命名格式 `YYYY-MM-DD-<模块>-design.md` / `-impl.md`（已被删除的 novels 模块文档即此格式）。
- 新增功能模块时同步更新本文件「项目结构」与 `app.module.ts` 注册清单。

---
**版本**: v2.0
**最后更新**: 2026-07-19
**维护者**: 团子项目组
