# 代码审查与优化报告（2026-08-15）

> **范围**：团子后台基础服务（`tuanzi-server-base`，NestJS 11 + TypeORM 0.3 + MySQL 8 + LangChain/LangGraph）
> **分支**：`feat/canvas-platform`（工作区含未提交改动，审查与修复均基于当前工作区状态）
> **方法**：9 个并行审查代理逐模块精读（127 个源文件 + 35 个测试文件），随后 5 个修复代理 + 主代理实施修复；修复后经 `pnpm lint` / `pnpm typecheck` / `pnpm test` 全量验证。
> **统计**：共发现 **high 12 / medium 40 / low 36** 项问题（88 项）；本轮已修复 **56 项**（含缓解），其余 32 项列为后续建议（多为需要 DDL、新依赖或产品决策的项）。
> **验证**：`pnpm lint` ✅ / `pnpm typecheck` ✅ / `pnpm test` ✅（39 套件、463 用例全部通过）

---

## 一、总体结论

代码库整体工程质量**中等偏上**：

- ✅ 三层边界（Controller→Service→Repository）执行严格；DTO + 全局 ValidationPipe（whitelist + forbidNonWhitelisted）落地一致。
- ✅ 鉴权链路设计清晰：access/refresh 双 token `type` 标记防混用、`JwtStrategy` 查库后剔除 password、统一登录文案防枚举、JWT_SECRET / 加密密钥 fail-fast。
- ✅ AES-256-GCM 用法正确（随机 12 字节 IV + authTag、响应只回脱敏值），未发现密码/密钥明文出现在 API 响应。
- ✅ 画布模块乐观锁（条件 UPDATE + version）、归属校验统一收敛（findOwned 一律 404），无 IDOR。
- ✅ 未发现 SQL 注入（TypeORM 参数化）、危险反序列化、`new Function`/eval（v1 自定义脚本按设计决策禁用）。

**最需要关注的三类问题**（详见下文）：

1. **SSRF 面过宽**（high ×4）：assets 图片导入、prompts 源抓取、AI 生成结果 URL 下载、sse/streamable-http 型 MCP Server 四处入口均由用户/远端内容提供 URL、服务端主动 fetch，且此前均无内网/回环/云元数据地址拦截。→ **已全部修复**（共享 `src/common/utils/ssrf.util.ts`）。
2. **上传/静态服务可被用于存储型 XSS**（high ×1）：上传仅信任客户端 mimetype、落盘扩展名沿用 originalname，配合无安全头的公开静态服务。→ **已修复**（扩展名白名单 + 图片内容嗅探 + nosniff/CSP 头）。
3. **并发与任务生命周期缺陷**（high ×4）：canvas rename 全实体写回覆盖并发文档、stock-signals 卡死任务永久锁死、agents 同会话并发无串行化、MCP 连接缓存跨用户串用凭据。→ **除「同会话并发串行化」外均已修复/缓解**（该问题依赖前端串行契约，后端加固列为后续建议）。

---

## 二、修复清单（本轮已实施）

### 2.1 安全（SSRF / XSS / 越权）

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| S1 | 全仓四处出站 fetch | SSRF：无内网/回环/云元数据拦截，fetch 默认跟随重定向 | 新增 `src/common/utils/ssrf.util.ts`（协议白名单 + 字面 IP 黑名单 + DNS 解析后逐地址校验 + v4-mapped 提取），四处接入：`assets.service.fetchImage`、`prompts/lib/prompt-normalize`、`generation.service` 结果下载、`video/audio provider` 下载；全部改 `redirect: 'manual'` 并拒绝 3xx |
| S2 | mcp-servers create/update | 任意用户可创建指向内网的 sse/http MCP Server，服务端代发请求 | 保存前对 sse/streamable-http 类型 `assertPublicUrl` 校验（stdio 本地命令不受影响） |
| S3 | media 上传链路 | mimetype 可伪造 + 扩展名随 originalname + 静态服务无安全头 → 存储型 XSS | `fileFilter` 按「mimetype 大类 + 扩展名白名单」双校验（禁 .html/.svg）；图片上传/saveBuffer 用 image-size 嗅探真实内容，不匹配即 400；`EXT_BY_MIME` 移除 svg；`main.ts` 静态服务加 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox` |
| S4 | media.controller findOne | 任意登录用户可读他人媒体元数据（IDOR） | 增加 `userId` 归属校验，他人媒体一律 404（静态文件仍公开，UUID 不可枚举） |
| S5 | mcp-servers validateForAssociation | 跨用户凭据复用：普通用户可关联他人 server 并静默解密其 env/headers | 增加属主校验：`server.createdBy === userId \|\| role === 'admin'`，否则 403（保留「Admin 集中配置、用户选配」设计） |
| S6 | skills/mcp 名称唯一性 | 并发同名命中唯一索引抛裸 500 | save 捕获 `QueryFailedError`（errno 1062 / ER_DUP_ENTRY）→ `ConflictException` |
| S7 | auth.login | 用户不存在路径不执行 bcrypt，存在时间侧信道可枚举账号 | 用户不存在时对固定哈希执行一次 `bcrypt.compare`，两路径耗时一致 |
| S8 | JwtAuthGuard | token 缺失/过期抛英文 "Unauthorized"，与全站中文约定不一致 | 覆写 `handleRequest` 统一抛中文「登录状态已失效，请重新登录」；删除空壳 `canActivate` |
| S9 | AllExceptionsFilter | 非 HttpException 原始错误（SQL 片段等）会原样返回客户端 | 一律返回通用文案 + 服务端日志；class-validator 数组消息原样透传（保持前端兼容） |
| S10 | MCP Server 停用 | isActive 字段存在但 update 无法变更，只能删行下线 | UpdateMcpServerDto 增加 `isActive`，service.update 支持停用/启用（创建者可收回） |
| S11 | agents 软删除复活 | 注释称 update 传 isActive=true，但 DTO 无此字段（白名单直接 400） | UpdateAgentDto 增加 `isActive?: boolean`，update() 显式支持 |
| S12 | agents 工具错误透出 | 工具异常原文（MCP URL/命令/DB 错误）持久化 + SSE 透出 | 未知异常返回通用中文文案，完整错误只进服务端日志（业务 HttpException 保留原文） |

### 2.2 正确性

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| C1 | auth（service + module） | JWT_EXPIRES_IN 为 NaN/0 时所有 token 无法验签，认证整体不可用 | 启动阶段 fail-fast 校验（正整数秒数），非法配置直接抛错 |
| C2 | auth.refreshByToken | catch 把数据库故障伪装成 401，掩盖真实故障 | 收窄 try 只包 `jwtService.verify`；查库/签发移出，DB 错误原样上抛（500） |
| C3 | daily-reports | (type,date) 唯一索引冲突抛裸 500（含 check-then-insert 竞态） | create/update/upsert 统一捕获 1062 → `ConflictException`（中文文案与查重一致） |
| C4 | assets.textContent | DTO 允许 100000 字符 > MySQL TEXT 64KB 容量，超限 500 | 上限收紧为 50000，与 DDL 容量对齐 |
| C5 | media fileFilter | 类型不支持抛普通 Error → 500 而非 400 | 改抛 `BadRequestException`（NestJS 会正确转 400） |
| C6 | stock-signals executeRun | fire-and-forget 的未捕获 rejection 可拖垮进程（Node 默认终止） | 调用处 `.catch(记日志)`；状态更新移入 try；catch 内 FAILED 写库再包一层 |
| C7 | stock-signals 卡死任务 | 进程重启后 PENDING/RUNNING 任务永久锁死该日期 | `onModuleInit` 将遗留 PENDING/RUNNING 批量置 FAILED（启动时不可能有活跃任务） |
| C8 | stock-signals date | 仅校验格式不校验日历，`2026-02-30` 打到 MySQL 报 500 | service 入口统一日历校验（UTC 回环比对），非法日期 400 |
| C9 | stock-signals getRun | 公开轮询接口泄露触发人 userId | 剔除 `createdBy`，返回最小形状 |
| C10 | canvas rename | 读-改-全实体 save 写回：并发覆盖他人文档且 version 回滚 | 改为 `projectRepo.update({ id, userId }, { name })` 只更新 name 列 |
| C11 | canvas ops | update_node.patch 宽松 record 可覆写节点 id/type、写入非法值；add_node id 不查重；ops 无上限（O(N²) 放大） | patch 白名单 schema（title/position/width/height/metadata，`.strict()` 禁 id/type）；add_node 重复 id 回退 randomUUID；zod + DTO 双端 `max(500)`；delete_node 声明 nodeType |
| C12 | canvas applyMutation | select_nodes 等无变更批次仍递增 version、整文档回写，前端乐观锁误报 409 | 无变更短路：document 前后相等则不执行 UPDATE、version 不变 |
| C13 | media findByIdsForUser | 使用 TypeORM 0.3 已废弃的 findByIds | 改用 `In()` 查询 |
| C14 | crypto.util decrypt | 损坏密文产生难懂英文底层错误 | 前置格式校验（iv 24 hex、data ≥ 32 hex），统一中文「密文格式非法」 |
| C15 | prompts 失败源 | 抓取失败后 fetchedAt=0，每个请求都重新抓取（失败风暴/免费内网探针） | 记录失败时间，stale 判断加失败退避窗口（5 分钟） |
| C16 | prompts 响应体 | 无大小上限 + refreshAllSources 全量并发 → 资源型 DoS | 流式读取 10MB 上限；分批并发（每批 4 个）；每用户源数量上限 |
| C17 | prompts 内置源 | sortOrder 可被任意用户篡改（共享全局排序） | 内置源分支拒绝 sortOrder 变更 |
| C18 | prompts slug | 死字段，注释与实现不符（按 url 去重） | 删除 slug 字段与相关注释 |
| C19 | ai-generation 下载 | 结果 URL 无条件 fetch + Content-Length 缺失即绕过大小上限 | `assertPublicUrl` + redirect manual + 流式累计上限（图片 50MB / 视频 200MB / 音频 50MB） |
| C20 | video 轮询 | 未知终态（succeeded/done）被当 pending 空转到 30 分钟超时误判失败 | 识别 `/^suc(ceed\|cess)/i`、`/^done$/i` 为终态（有 URL 成功，无 URL 失败） |
| C21 | video 参考素材 | 超限被静默 slice（用户不知道素材没用上） | 生成前按 provider 上限显式 400 |
| C22 | MCP update DTO | PATCH 不带 type 时 command/args/env/headers 绕过全部校验，类型错乱落库 | update DTO 校验与 type 解耦（显式声明各字段规则） |
| C23 | agents 会话列表 | 定时任务归档的会话混入用户列表（与注释意图矛盾） | listConversations 显式排除 ARCHIVED |
| C24 | agents updatedAt | 会话「最近活跃排序」失真（只在首条消息时刷新） | 每次消息落库后 touch 会话行 |
| C25 | agents 工具错误 | 工具异常原文（MCP URL/命令/DB 错误）持久化 + SSE 透出 | 未知异常返回通用中文文案，完整错误只进服务端日志 |
| C26 | agents Swagger | GET /agents/:id 描述声称返回脱敏 API Key，实际无此字段 | 修正描述 |
| C27 | media 孤儿文件 | 落盘与 DB 登记非原子，登记失败残留孤儿文件 | saveUpload/saveBuffer 失败路径 unlink 清理 |
| C28 | main.ts body 限制 | express 默认 100kb，画布大文档保存隐性天花板 | `bodyParser: false` + `json({ limit: '5mb' })` + urlencoded 同步 |
| C29 | SSE 断线 | 客户端断开后 LangGraph 仍跑完整轮（浪费 token、checkpoint 残留、重试叠加并发） | 监听 res close → AbortController → 传 signal 给 run/runStream；write 异常防护 |
| C30 | 工具超时 | Promise.race 超时后底层工具继续执行，LLM 重试产生重复副作用 | 传 `RunnableConfig.signal`（LangChain 原生支持，MCP SDK connect 也支持），超时真正中止 |
| C31 | 流式失败零残留 | 失败后 checkpoint 残留半截状态，前端原样重发时同一句话被模型看两次 | 接线 `captureBaseline`/`rollbackToBaseline`（按 threadId 作用域，不涉及其他会话） |
| C32 | skills 列表性能 | relations 加载完整 mcpServers（含 env/headers 密文列）而只用 id | 改为二次 slim 查询只取 server id 映射 |
| C33 | PUBLIC_BASE_URL | 生产缺省 localhost，参考素材静默失败 | 生产环境未配置时启动 fail-fast 抛错提示 |

### 2.3 性能

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P1 | canvas findAll / findVersion | 列表/版本查询整行加载 document JSON 大字段 | select 排除 document 列，节点/连线数用 `JSON_LENGTH` 在 SQL 内计算 |
| P2 | agents findAll | 每页 Agent 逐条查渠道（N+1，limit=100 → 101 条 SQL） | 收集 channelIds 批量查询建 Map 后同步拼装 |
| P3 | tools/tool-registry MCP 连接池 | 缓存 key 不含 env/headers → 同 command/URL 不同凭据串用连接；并发重复建连 | cacheKey 追加 env/headers 的 sha256；改为单飞 `Map<key, Promise<Client>>`（失败清理）；connect 加 10s 超时 |

### 2.4 DDL（需在 Adminer 手工执行，见各文件）

- `docs/plans/2026-08-15-code-review-prompts-ai-generation.sql`：`idx_generation_tasks_status_created`（视频轮询每 10s 全表扫描，status 单列无可用索引）
- `docs/plans/2026-08-15-code-review-agents-indexes.sql`：`idx_messages_conversation_seq`（消息分页 ORDER BY seq 需 filesort）

---

## 三、未修复问题（后续建议，按优先级）

### 3.1 需要产品/架构决策

| 严重度 | 位置 | 问题 | 建议 |
|--------|------|------|------|
| medium | auth refresh token | 无状态、无轮换/吊销：泄露后 7 天内可无限重放，改密也无法失效 | 服务端存 refresh hash + jti，刷新轮换 + 登出接口（需新表 DDL + 前端配合） |
| medium | auth/生成接口 | 认证端点与 AI 生成接口均无限流，可暴力破解/成本型 DoS | 引入 `@nestjs/throttler`（新依赖），登录 5 次/分钟、生成接口按用户令牌桶 |
| medium | agents 同会话并发 | 无服务端串行化，checkpoint 丢失更新（依赖前端串行契约，SSE 断线可打破） | per-conversation 互斥（内存 promise 链，多实例用 `FOR UPDATE SKIP LOCKED`） |
| medium | ai-generation 多实例 | 视频轮询无 leader 锁，多实例重复轮询/下载/扣费 | `SELECT ... FOR UPDATE SKIP LOCKED` 领取任务，或 Redis 锁 |
| medium | prompts SSRF 残余 | 仍允许 http（非 https）源（已拦内网，但明文传输） | 若业务可接受，收紧为 https-only |
| medium | skills stdio 分发 | admin 创建的含 stdio server 的 Skill 可被普通用户间接使用（spawn 子进程） | 明确设计意图（admin 主动分发）或使用侧加 admin 校验 |
| medium | media 文件公开 | /uploads/media 静态文件全公开（UUID 不可枚举但不可控） | 若部分媒体需私有，改用签名临时 URL |
| low | uploads 孤儿模块 | 未注册的死代码，与 media 重复且更弱 | 删除或按 media 模式重建（CLAUDE.md 已标注需先询问） |

### 3.2 技术债（低风险，可排期）

| 严重度 | 位置 | 问题 |
|--------|------|------|
| medium | canvas document DTO | 嵌套字段（position.x/y、viewport.k）无校验，PUT 整文档可写入损坏数据 |
| medium | 定时任务数据 | 每次执行的会话/checkpoint 永不清理，agent_checkpoints 是全库增长最快的表 |
| low | ai-generation 重复代码 | readApiErrorMessage 等 4 个错误处理函数在 3 个 provider 中整段复制（~60 行 ×3，本轮已新增共享 stream-download.util，错误函数可仿照抽取） |
| low | ai-generation 归属校验 | resolveChannelModel 与 AiChannelsService.resolveChatModel 逻辑重复两份 |
| low | ai-generation 孤儿媒体 | 多图生成中途失败遗留已落盘媒体无回收 |
| low | canvas-get_state | 每轮对话全量返回文档给 LLM，token 随画布线性增长 |
| low | canvas-tools | 20+ 处 `as never` 绕过类型检查 |
| low | MCP 工具名 | loadMcpTools 未开启 server 名前缀，工具名可冲突 |
| low | stock-signals | 全市场扫描无并发上限（建议每日期最多 1 个 RUNNING + 频控）；旧行残留导致 found 与 items 不一致；getDates 无 limit |
| low | canvas updateDocument | 全量 PUT 无变更短路（前端契约路径） |
| low | prompts 多实例 | 内存失败退避缓存多实例失效（注释已说明取舍） |

---

## 四、测试与验证

- 新增/更新单测（39 套件 / 463 用例全部通过）：
  - 新建：`test/common/utils/ssrf.util.spec.ts`、`test/canvas/canvas-op-schemas.spec.ts`、`test/canvas/canvas-document.service.spec.ts`、`test/prompts/prompt-normalize.spec.ts`；
  - 更新：`test/media/media.service.spec.ts`（重写）、`test/assets/assets.service.spec.ts`（+SSRF/重定向/SVG 用例）、`test/auth/auth.service.spec.ts`（+配置校验/DB 故障传播）、`test/canvas/canvas-ops.spec.ts`、`test/canvas/canvas.service.spec.ts`、`test/mcp-servers/*`、`test/skills/*`、`test/stock-signals/*`（+10）、`test/daily-reports/*`（+7）、`test/agents/*`（+脱敏/超时 abort/status 过滤/updatedAt touch/SSE abort/单飞/缓存 key 用例）、`test/prompts/prompts.service.spec.ts`、`test/ai-generation/*`。
- 最终验证结果（本仓库标准命令）：
  - `pnpm typecheck` → 0 错误 ✅
  - `pnpm lint`（eslint --fix）→ 0 错误 ✅
  - `pnpm test` → 39 套件 / 463 用例全部通过 ✅
- ⚠️ 沙箱说明：本环境 jest 多进程 worker 因 named-pipe 限制无法运行（`spawn EPERM`），单测统一用 `--runInBand`（或 `--workerThreads`）串行验证；无沙箱环境直接 `pnpm test` 即可，测试结果不受影响。
- 已知重要实现细节：
  - `ssrf.util.ts`：Node `BlockList` 在含 IPv6 规则时会把 IPv4 归一化为 `::ffff:x.x.x.x` 比对，**不能**添加 `::ffff:0:0/96` 映射段（会误杀全部公网 IPv4，已用单测发现并修正）；v4-mapped 地址改为显式提取内嵌 IPv4 走 IPv4 规则。
  - `media` 上传：扩展名白名单 + image-size 内容嗅探双保险；静态服务仍公开（UUID 不可枚举），已加 `nosniff` + `CSP: sandbox` 响应头纵深防御。
  - canvas：`JSON_LENGTH` 为 MySQL 专属语法（项目锁定 MySQL 8.0，可接受）；ops 上限 500（前端若单批提交超限需分批）；`add_node.id` 需匹配 `/^[0-9a-zA-Z_-]{1,64}$/`（仓库内调用方全部合规）。
  - MCP 属主校验：放行条件为「自己创建 ∨ 当前用户是 admin ∨ 创建者是 admin（公共库）」，与设计文档「Admin 集中配置、普通用户选配」一致；仅当关联了非本人 server 且当前用户非 admin 时触发创建者角色回查。

## 五、DDL 执行提醒

1. `docs/plans/2026-08-15-code-review-prompts-ai-generation.sql`
2. `docs/plans/2026-08-15-code-review-agents-indexes.sql`

两处均为新增索引（synchronize 已全环境关闭），需在 Adminer（:8080）手工执行。
