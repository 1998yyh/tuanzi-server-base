# StockMarketService 实时 K 线证据

## 结论

2026-09-12（Asia/Shanghai）从当前开发机实测，`StockMarketService.getBars('600519', 'day', 'none')` 和 `getBars('600519', 'minute', 'none')` 均不可用。失败发生在读取 HTTP 响应之前：东方财富 `push2his.eastmoney.com/api/qt/stock/kline/get` 主动断开连接，curl 报 `Empty reply from server`，Node 22 `fetch` 报 `UND_ERR_SOCKET`。三次连续请求均约 0.10 秒失败，HTTP 状态为 `000`。

这不是当前请求少传参数导致的。将请求替换为 AKShare 使用的完整参数组合（`fields1=f1..f6`、`fields2=f51..f61`、公开 `ut`、`beg/end`），并分别增加浏览器 User-Agent、Referer 和 JSONP callback，结果仍相同。AKShare 的 [`stock_zh_a_hist` 源码](https://github.com/akfamily/akshare/blob/main/akshare/stock_feature/stock_hist_em.py)同样使用该 `kline/get` 路径与这些参数；其 issue 中也有 `RemoteDisconnected`、换 IP 后恢复或因访问行为触发 IP 封禁的记录：[AKShare #6108](https://github.com/akfamily/akshare/issues/6108)、[AKShare #7027](https://github.com/akfamily/akshare/issues/7027)。

故障更符合东方财富对 `kline/get` 的路径级/IP 级风控或出口兼容问题。同一台机器、同一域名的 `stock/trends2/get` 返回 HTTP 200 和 1205 根真实分钟数据；`push2.eastmoney.com/api/qt/stock/get` 也返回 HTTP 200。全目录和指数成功不能证明 `kline/get` 可用，因为它们不是同一路径。

## 可用真实数据对照

以下探针均直接访问上游，没有 mock、fixture 或本地兜底数据：

| 数据                | 上游路径                             | 结果              | 600519 最新数据                                                         |
| ------------------- | ------------------------------------ | ----------------- | ----------------------------------------------------------------------- |
| 不复权日线          | 腾讯 `appstock/app/kline/kline`      | HTTP 200，600 根  | 2026-09-11，O 1285.150 / C 1275.160 / H 1286.150 / L 1263.010 / V 34801 |
| 前复权日线          | 腾讯 `appstock/app/fqkline/get`      | HTTP 200，600 根  | 最新一根与当日不复权相同，早期价格已调整                                |
| 1 分钟线            | 东方财富 `stock/trends2/get?ndays=5` | HTTP 200，1205 根 | 覆盖最近五个交易日，末根为 2026-09-11 15:00                             |
| 当前服务日线/分钟线 | 东方财富 `stock/kline/get`           | HTTP 000          | 无响应体，无法解析                                                      |

腾讯日线数组顺序为 `time, open, close, high, low, volume`，和当前 `MarketBar` 可直接映射。成交量单位与当前东方财富日线口径一致（600519 当日为 34801 手），不要额外乘 100 后再声称沿用原口径。

## 对实现的直接含义

1. `minute` 不应继续调用 `kline/get?klt=1`。AKShare 对 1 分钟数据也使用 `trends2/get`；其当前实现可见 [index_zh_em.py](https://github.com/akfamily/akshare/blob/main/akshare/index/index_zh_em.py)。该接口只提供最近最多五个交易日，并且不提供复权分钟线。服务应明确这一限制，截取调用方所需的最近数量，并继续过滤未完成分钟。
2. `day/week` 若要求当前网络环境稳定可用，需要真实备用源。当前探针证明腾讯日线的 `none` 和 `qfq` 可用；上线前还应验证 `hfq`、周线、沪深京代码前缀、停牌股票、除权日和最大返回数量。若做 Eastmoney→Tencent failover，响应中的 `source` 必须反映实际来源，不能把腾讯数据标成 Eastmoney。
3. 不应在失败时返回静默 mock 或伪造空成功。上游全部失败时继续返回明确的 502；若备用源成功，保留其抓取时间、数据源和完成状态。
4. 东方财富与腾讯端点都属于未承诺稳定性的网页行情接口。应保留短超时、有限重试/熔断、缓存，并对源切换做价格与成交量口径检查。对生产级行情许可、交易日历和 SLA 仍需另行解决。

## 最小复现

当前失败回路（URL 中没有凭据）：

```bash
curl -4 -sS --max-time 5 \
  'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61&klt=101&fqt=0&beg=0&end=20500101&lmt=5'
```

当前可用分钟线探针：

```bash
curl -4 -sS --max-time 10 \
  'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=1.600519&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6%2Cf7%2Cf8%2Cf9%2Cf10%2Cf11%2Cf12%2Cf13&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58&ndays=5&iscr=0'
```

当前可用日线探针：

```bash
curl -4 -sS --max-time 10 \
  'https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=sh600519%2Cday%2C%2C%2C600'
```
