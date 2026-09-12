# 股票行情与策略筛选实现

`StockMarketModule` 提供 JWT 保护的报价、K 线和目录搜索接口。行情只访问固定的
`push2.eastmoney.com` 与 `push2his.eastmoney.com`；接口形状参照 AKShare 的
[A 股历史行情文档](https://akshare.akfamily.xyz/data/stock/stock.html)。网络错误、空响应和目录不完整均显式失败，绝不生成替代行情。报价/K 线缓存 30 秒，全市场目录缓存 24 小时。

分钟线固定使用东方财富 `stock/trends2/get`，只提供最近五个交易日的不复权数据；请求 `qfq` 或 `hfq` 返回 400。该源历史分钟的开盘字段可能按上游原值返回 0，服务不推算或伪造开盘价。日线、周线和指数 K 线先请求东方财富；网络失败或空结果后使用固定的腾讯 `web.ifzq.gtimg.cn` 备用源。实测腾讯支持沪深日线 `none/qfq/hfq`、周线与指数日线，响应准确标记 `source: tencent`。腾讯单次最多取 600 根，调用方请求更多时返回 `dataGap`；北交所备用能力未验证，因此主源失败时明确返回 502。

动态目录覆盖沪深京 A 股（主板、创业板、科创板、北交所）。搜索在动态目录失败时可降级到仓库已有的 3,044 只沪深主板真实静态目录，并在 `coverage` 中标明；`scope=all` 的筛选不降级，避免把主板子集冒充全市场。

K 线仅返回已完成柱，`indicators` 与 `items` 按下标对齐。预热期使用 `null`：MA 为窗口算术平均；MACD 的快慢 EMA 分别以各自周期的 SMA 初始化，DEA 以首批 signal 个有效 DIF 的 SMA 初始化，柱值为 `2*(DIF-DEA)`；KDJ 的 K/D 从 50 开始，最高价等于最低价时 RSV=50；RSI 使用 Wilder 平滑，全涨为 100、完全无涨跌为 50；BOLL 使用窗口总体标准差（除以 N）。

策略条件沿用 `StrategyDefinition`：MA 为收盘价高于均线，MACD 为当前 DIF 上穿 DEA 且前一根有效柱 DIF 不高于 DEA，KDJ 为 K 低于阈值，RSI 为 RSI 低于阈值，BOLL 为收盘价高于中轨。任一指标仍在预热时，该股票记录 `dataGap` 且不命中。

筛选任务在创建时固定目标代码，保存用户、策略定义快照、固定 `asOf`、实际 `sampledAt`、目录覆盖、进度、结果和数据缺口。每个候选项保存末根柱时间、价格、数据源、抓取时间和条件计算所用的指标事实，历史查看读取该持久化快照。指定代码上限 500；进程内任务串行，每个任务每批并发 5 只。状态更新带当前状态条件，已失败任务不会被迟到执行写成完成。服务启动时把遗留 `queued/running` 任务置为 `failed`，避免永久轮询。所有读取按 `userId` 限定。

任务队列明确采用单实例部署约束：进程内串行只在一个 Node 实例中成立；部署多个实例前需要数据库抢占或分布式队列，本版本不宣称支持多实例并发执行。

根模块注册：在 `AppModule.imports` 中加入 `StockMarketModule` 和 `StockScreeningModule`。其他模块可导入 `StockMarketModule` 后注入 `StockMarketService`，调用 `getQuotes(codes)` 或 `getBars(code, period, adjustment)`。
报价的 `asOf` 来自上游 `f124` 行情时间；上游缺失时为 `null`，不会用抓取时间冒充行情时间。`GET /stock-market/indices` 返回上证、深证成指和创业板指；`GET /stock-market/indices/:code/bars` 返回指数日线或周线。
