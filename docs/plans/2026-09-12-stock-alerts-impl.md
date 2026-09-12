# 股票条件提醒实现说明

## API 与权限

所有接口均在全局 `/api` 前缀下并要求 JWT。资源查询、修改、删除和已读操作始终带 `userId` 条件；访问他人资源统一返回 404。

- `GET/POST /api/stock-research/alerts`
- `PATCH/DELETE /api/stock-research/alerts/:id`
- `GET /api/stock-research/alert-events`
- `POST /api/stock-research/alert-events/:id/read`

列表统一默认 `page=1&limit=20`，最大 100。创建体为 `{ code, field, operator, threshold, parameters? }`；更新体只能为 `{ enabled }`。全局 `ValidationPipe` 的白名单和禁止额外字段规则继续生效。

## 条件和数据新鲜度

`price` 与 `change` 分别比较实时价格和涨跌幅：`gte` 为大于等于，`lte` 为小于等于。首次监控时若已满足会产生一个初始事件；持续满足不会重复，退出条件后再次进入才重新触发。

内置指标均采用前复权已完成日线，可用 `parameters` 覆盖默认参数：MA `[20]`、MACD `[12,26,9]`、KDJ `[9,3,3]`、RSI `[12]`、BOLL `[20,2]`。周期为 2–250；MACD fast 必须小于 slow；KDJ 平滑参数为 1–20；BOLL 倍数为 `(0,10]`。

- MA：收盘价对均线的上穿/下穿；
- MACD：DIF 对 DEA 的金叉/死叉；
- KDJ：K 对 D 的金叉/死叉；
- RSI：当前 RSI 与 `threshold` 作 `gte/lte` 比较；
- BOLL：`gte` 为收盘价上穿上轨，`lte` 为收盘价下穿下轨。

交叉类指标的 `threshold` 为维持统一契约而保留，不参与计算。交叉直接由当前和前一完成 bar 判断，不依赖 `lastMatch`；`lastBarTime` 只负责每根 bar 最多处理一次，因此服务停机错过中间非交叉 bar 后仍可识别下一次交叉。任何指标值非有限或尚未形成时都按 unknown 处理且不消费 bar。

报价仅在上海时区工作日的 09:30–11:30、13:00–15:00 接受，`asOf` 必须非空、为当天且与服务器相差不超过 5 分钟。日线在 15:10 后接受当天完成 bar，之前接受前一工作日 bar；这里只排除周末，不猜测节假日，无法确认新鲜度时宁可跳过。上游错误、缺字段、陈旧数据不会改变去重状态。

## 原子去重和交付

cron 每分钟第 0 秒扫描启用提醒。取得行情后，事务内对提醒行加写锁并重新检查 `enabled` 和去重状态。实时行情持久化 `lastObservedAt`，日线持久化 `lastBarTime`；时间戳重复或倒退均拒绝处理，避免新→旧→新导致重复事件。事件插入、`lastMatch/lastObservedAt/lastBarTime/version` 更新在同一事务中完成；任一写入失败会整体回滚。事件还有 `(alert_id, alert_version)` 唯一约束作为重复任务的最终防线。

当前没有推送平台密钥。事件的 `deliveryStatus` 固定为 `queued`，含义是已持久化并等待 App 轮询后触发本地/原生通知，不代表远程推送成功。

## 集成契约

根模块需导入 `StockAlertsModule`。该模块导入并依赖 `StockMarketModule` 导出的 `StockMarketService`：

- `getQuotes([code])` 提供 `{ items: [{ code, price, change, asOf }] }`；
- `getBars(code, 'day', 'qfq')` 提供已完成的 `items` 和同索引 `indicators`，MACD 键为 `12:26:9`。

DDL 位于同日 SQL 文件，仅加入项目迁移流水线，不由本实现直接执行。
