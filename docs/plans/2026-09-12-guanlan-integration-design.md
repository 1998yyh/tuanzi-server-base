# 观澜 APP 后台接入方案

日期：2026-09-12。状态：接入设计已实施，五个新增模块已注册；新增 SQL 已在独立 MySQL 测试库执行。生产未部署。运行与验证见 [runbook](2026-09-12-guanlan-runbook.md)。

用户指定在 tuanzi-server-base 开发，并要求先创建新分支。已从本地 main 的 bb60ee0 创建 feat/guanlan-stock-app，工作目录沿用本仓库。原有未提交的 Agent 搜索改动保留在工作区，不作为观澜变更提交。

## 技术基线

沿用 NestJS 11、TypeORM、MySQL、JWT，以及既有 AI 渠道和 Agent 会话框架。观澜独立 H5 客户端在 ../guanlan 实现，保留已确认的深色原型。此前文档中 FastAPI 主后端、SQLite/PostgreSQL 主数据库的建议被本方案替代。Python 仅在行情采集或指标库验证后证明需要时作为适配组件，不另起完整业务后台。

交互基准为原型 V3：深色首页；固定策略与可保存的自定义组合策略；观察预警；合并后的 AI 复盘聊天（新建、历史、续聊、删除）；不做交易复盘和自定义公式。

## 可复用能力（已读源码）

| 能力 | 源码 | 使用方式 |
| --- | --- | --- |
| 登录注册与令牌刷新 | src/auth/、src/users/ | H5 接现有接口；沿用 access/refresh 类型校验 |
| 用户鉴权 | JwtAuthGuard、CurrentUser | 观澜私有资源按当前 userId 过滤，不相信客户端传入的归属 |
| AI 渠道 | src/ai-generation/ai-channels.service.ts | AiChannel 是唯一模型凭据入口，Agent 引用 channelId + modelName，经 resolveChatModel 校验 |
| 会话与消息 | src/agents/conversations.controller.ts、conversations.service.ts | 复用创建、分页历史、SSE 回复、删除；归属经 Agent 的 userId 校验 |
| 执行控制 | ConversationExecutionLock、执行器 | 沿用同会话串行、断线取消和 checkpoint 语义 |
| 股票相关参考 | src/stock-signals/ | 可参考异步扫描、缓存、用户观察池；不能当作通用行情与指标引擎 |

现有股票观察池基于 B 信号入池、之后 S 信号触发，代码和交易所范围也有约束。观澜需要任意策略/AI 依据入池、MACD/KDJ 等规则；应新增业务表与服务，不直接改写既有 B/S 行为。现有股票扫描部分 GET 公开，不能照搬为用户策略、报告或会话的权限方式。

## 新增模块边界

- stock-strategies：固定模板、用户策略 CRUD、版本、参数及 AND/OR 校验。固定模板只读；自定义从模板复制或组合。原策略版本由筛选快照保留。
- stock-market：标准行情/K线、来源、抓取时间与报价时间、交易日历、复权及缺失状态；数据源可替换。
- stock-screening：统一指标计算、批量筛选任务、候选与规则快照；与现有 stock-signals 入口分开。
- stock-research：观察理由、大盘/个股复盘上下文、会话关联及证据引用。复用 Agent 会话和消息存储，不重复实现聊天引擎。
- stock-alerts：可配置规则、持久去重状态、触发事件、送达状态；与现有信号观察池分开。

AI 复盘建议先使用当前用户配置的专用 Agent，凭据来自其 AI 渠道。会话关联通过研究上下文表绑定 conversationId、userId、讨论对象、日期、筛选/行情快照版本。通用 CreateConversationDto 保持只支持 title；新增 stock-research 接口保存领域上下文与证据，见 [AI复盘接口](2026-09-12-stock-research-impl.md)。

创建会话与关联上下文需有事务或失败补偿；删除会话时研究上下文按确定的外键/清理策略处理，独立保存的研究快照按保留策略管理。服务端负责组装可信行情证据，客户端传入的股票代码不能替代快照归属与来源校验。

## 接口实施顺序

1. 策略库：模板列表、用户策略创建/列表/详情/更新/删除；先实现不依赖外部行情的完整保存链路。验证跨用户不可见、名称冲突、参数非法、更新版本及已删除策略的历史快照。
2. AI 复盘：复用会话接口，加对象/日期/快照上下文；H5 验证流式事件、断线、消息顺序、历史分页、删除及继续追问。
3. 行情与筛选：先数据接口实测，再确定计算库。收盘日线先打通，后补分时、全市场批量与覆盖报告。
4. 观察预警：新增通用观察池与规则；验证后台任务、交易时段、失效数据、重试去重及目标手机推送通道。
5. 联调与交付：手机浏览器验证、私有数据权限、备份恢复和部署迁移检查。

各阶段完成后才扩展下一阶段，不能把策略 CRUD 当作全产品完成。

## 仓库约束与验证

使用现有中文 DTO/Swagger、UUID 管道、Service 数据访问和 MySQL ER_DUP_ENTRY 映射约定。实体变更采用 docs/plans/YYYY-MM-DD-*.sql，保持 synchronize=false。设计阶段不生成或运行生产迁移，不触发部署。

单实例执行锁与既有 ScheduleModule.forRoot() 位置保持现状。现有 Agent 定时任务最小间隔一小时，不直接用来承诺盘中高频预警。新监控任务仍需单独设计，不重复注册全局调度模块。

新增模块已进行测试、typecheck、lint 与构建，并增加真实 Nest/HTTP/JWT/MySQL 贯通脚本。全仓 lint 使用无自动修改方式，保留用户既有未提交文件。最终结果以交付记录为准。

原型与范围：[观澜原型](../../../guanlan/prototype/index.html)（跨仓库相对链接仅适用于当前并列工作目录；也可直接从 ../guanlan 打开）。
