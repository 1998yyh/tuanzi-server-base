# 观澜部署与验证

H5 项目：`../guanlan`。后端工作分支：`feat/guanlan-stock-app`。原有未提交的 Agent 搜索代码保留；本次未提交、推送或部署到生产环境。

## 后端

使用现有 NestJS、MySQL 8、JWT 与 AiChannel 配置。沿用 `.env.example` 的变量；保留原来的 `AGENT_ENCRYPTION_KEY`，更换它会使既有渠道密文无法解密。新增业务不要求在 H5 写入 AI 密钥。

通过本项目已有 DDL 发布方式按顺序执行：

1. `docs/plans/2026-09-12-stock-strategies.sql`
2. `docs/plans/2026-09-12-stock-market-screening.sql`
3. `docs/plans/2026-09-12-stock-research.sql`
4. `docs/plans/2026-09-12-stock-alerts.sql`

这些文件创建新表，不修改原业务数据。`IF NOT EXISTS` 不是升级旧表结构的迁移工具；若曾执行早期草稿，需要对照最终字段生成单独 ALTER 迁移。发布前备份并核验外键字段字符集与排序规则。禁止启用 TypeORM synchronize。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test -- --runInBand
pnpm exec eslint "{src,test}/**/*.ts"
pnpm build
pnpm start:prod
```

使用现有 Dockerfile 或已有部署方式运行一个应用实例，通过 HTTPS 反向代理暴露 `/api`。SSE 路由需关闭代理缓冲并允许长连接。指标筛选是进程内单实例队列；不要配置多副本或 PM2 cluster。重启时遗留任务标记失败，历史完成结果保留。行情缓存、会话执行锁也是进程内状态。

在原有后台创建/启用具有 chat 模型的 AiChannel 和本人 Agent。H5 登录同一账户后选择 Agent。App 仅访问本人记录，首次登录空列表是正常状态。

## 手机连接

H5 默认使用同源 `/api`。开发时在 guanlan/.env 配置 GUANLAN_API_TARGET 指向 NestJS，再执行 npm run dev；同一局域网手机访问电脑的 Vite 地址。生产部署 dist 静态文件，以 HTTPS 反向代理 /api 到 NestJS。无需安卓工具链；手机 localhost 不会自动指向电脑。

服务端每分钟评估启用的提醒，事件先写 MySQL。H5 在前台查看和刷新触发记录。事件生成不等于手机收到通知：当前没有接入网页或厂商推送，关闭页面后不保证提醒。接口 `deliveryStatus=queued` 只表示待设备获取，不能展示为已送达。

## 独立集成数据库

仅用于开发验证，不能把生产数据库名传给脚本。手动提供 DB_HOST、DB_PORT、DB_USERNAME、DB_PASSWORD 和一个全新的 `guanlan_test_*` 数据库名，然后执行：

```sh
node scripts/guanlan-test-db.cjs
node scripts/guanlan-smoke.cjs
# 可选：真实 Agent/LangGraph 对接本机模型协议替身，无外部模型费用
GUANLAN_AGENT_HTTP=1 node scripts/guanlan-smoke.cjs
```

准备脚本只接受空测试库，从实体生成既有基础表，再执行本次正式 SQL 文件；全程 `synchronize=false`。基础 `stock_signals` 实体有两个同名索引，测试夹具对非唯一索引改名，不修改原实体或生产结构。smoke 使用真实 MySQL、HTTP 和 JWT，但行情及 AI 为测试替身；创建隔离测试账户，不删除既有数据。

本机另起的容器为 `guanlan-test-mysql`，仅绑定 `127.0.0.1:13306`；原有 MySQL 容器没有用于联调。停止该测试容器可执行 `docker stop guanlan-test-mysql`。

验证结果：39 项 HTTP 请求通过；完整 Agent 路径验证了历史通过 checkpoint 传入下一轮及删除后 checkpoint 清空。59 个 Jest 套件共 660 项测试通过，typecheck、ESLint、构建通过。

## 备份与恢复

用户策略、观察、会话、消息、筛选结果和提醒均在 MySQL。将数据库备份与 `AGENT_ENCRYPTION_KEY` 分别妥善保存；不要将密钥写入仓库。使用已有数据库运维账户执行 `mysqldump --single-transaction --routines --triggers`，密码通过登录配置提供，不放命令行。

恢复先导入一个空的验证库，使用相同加密密钥，在隔离服务中确认策略数、观察数、会话数和消息数，再按现有部署流程切换。不得用开发测试脚本重建生产库。浏览器当前标签页 sessionStorage 保存令牌，localStorage 仅保存服务地址，服务端记录需联网读取；完整离线行情与编辑同步暂未实现。

本次已在测试库执行备份与空库恢复，30 张表的行数一致；这不代替用户生产环境及真实渠道密钥的恢复演练。

真实行情贯通验证：专门测试用户观察池中的 3 只股票完成 RSI 筛选，任务状态 done、checked=3、无 dataGaps，使用腾讯历史 K 线。该结果仅为接口与数据链路验证，不是投资推荐。
