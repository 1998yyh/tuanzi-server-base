# 观澜策略库接口：第一阶段

2026-09-12，分支 feat/guanlan-stock-app。

本阶段新增策略保存与管理，不执行指标计算、行情筛选或 AI 分析。原型仍使用本机演示数据，尚未对接这些接口。

## 接口

统一前缀 `/api/stock-strategies`，全部需要 access JWT。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /templates | 五个固定模板，包含版本、名称、只读标记与完整定义 |
| GET | ?page=1&limit=20 | 当前用户未删除策略，返回 items/total/page/limit/totalPages |
| POST | / | 创建个人策略，返回 201 和 version=1 |
| GET | /:id | 本人策略及 revisions 历史快照 |
| PUT | /:id | 完整替换 name/definition，必须提供读取时的 version |
| DELETE | /:id?version=1 | 逻辑删除，成功204，保留历史和名称 |

固定模板没有写接口。复制模板即把其 definition 连同自己的 name POST 到个人策略接口。路径 ID 均为 UUID。请求额外字段（如 userId）会被拒绝；归属只取 JWT。外用户资源与不存在统一404。

名称去除首尾空白，1到80字符；同用户名称按现有 MySQL utf8mb4_unicode_ci 排序规则唯一，因此大小写不敏感。当前删除保留名称占用，重建需使用新名称。命名冲突409，不同用户可用相同名称。

PUT 是完整更新，不是 PATCH；版本不符或并发比较更新失败返回409，客户端重新获取再让用户处理。历史快照与当前定义在同一行的一次条件 UPDATE 中更新，不会只写入其中一半。删除同样检查版本。列表不显示已删除项；历史行保留供后续筛选快照引用，当前没有恢复和删除后历史读取接口。

## 创建示例

```json
{
  "name": "低位金叉观察",
  "definition": {
    "period": "day",
    "adjustment": "qfq",
    "scope": "watchlist",
    "match": "all",
    "conditions": [
      { "indicator": "MACD", "parameters": [12, 26, 9] },
      { "indicator": "KDJ", "parameters": [9, 3, 3], "threshold": 50 }
    ]
  }
}
```

## 定义约束及未来计算语义

`period` 为 day/week，`adjustment` 为 none/qfq/hfq，`scope` 为 watchlist/all，`match` 为 all/any（AND/OR）；全部使用已收盘 K 线。1到10个条件，无嵌套关系，不支持公式。周期类参数为1到500的整数。

| 指标 | parameters 顺序 | 条件语义 |
| --- | --- | --- |
| MA | 周期 | 收盘价高于均线 |
| MACD | 快线、慢线、信号周期 | DIF 上穿 DEA；快线周期必须小于慢线 |
| KDJ | RSV周期、K平滑、D平滑 | K 小于 threshold，阈值0到100 |
| RSI | 周期 | RSI 小于 threshold，阈值0到100 |
| BOLL | 周期、标准差倍数 | 收盘价高于中轨；倍数大于0且不超过10 |

额外字段、未知指标、缺少阈值、null、非有限数、参数个数错误均拒绝。每个条件的比较方向由指标固定，目前不能自行定义交叉方向或其他比较符号。首次版本只保存这种定义；EMA初值、预热、复权及交叉计算等仍在行情与指标阶段实现。

## 数据与部署

实体 `StockStrategy` 注册于新 `StockStrategiesModule`，根 AppModule 已引用。沿用 MySQL、TypeORM、synchronize=false。建表文件：`2026-09-12-stock-strategies.sql`，本轮未执行。

部署前在独立测试库按项目迁移方式执行 DDL，验证真实 MySQL 的唯一索引、JSON往返、条件更新并发及逻辑删除，再联调安卓。不要仅凭 Repository mock 测试视为数据库部署已验证。

当前 revisions 存为 JSON 数组，适合早期个人策略版本量；尚未做大规模版本历史的性能验证。未来迁移历史表时需保留策略 ID 和版本语义。

## 已有验证范围

新增3组31项测试：指标定义与模板、Service 归属/版本/冲突/逻辑删除、实际 Nest HTTP 路由与 ValidationPipe。

HTTP 测试使用本地端口、替代身份守卫和 mock Repository，不连接 MySQL 或模型。JWT真实验签由原认证测试负责；HTTP测试的拒绝身份为403，不表示生产JWT失败也返回403。

原有 Agent 搜索相关未提交改动未纳入本阶段，也未修改或提交。全仓校验结果由交付记录说明。
