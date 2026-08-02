# Stock Signals（B 信号筛选）模块设计

**日期**: 2026-08-02
**状态**: 已实现
**来源**: 迁移自独立页面 b-signal-scanner（新浪 upbs JSONP 直连），服务端化并加缓存与历史

## 目标

1. 查询某日沪深主板非 ST 股票的 B（买入）信号（新浪多空信号值 = 1）
2. 非强制刷新返回后台缓存，不重复外呼新浪
3. 全量信号值落库，历史可查

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/stock-signals/scans` | JWT | 发起扫描。全市场 → 异步任务；`codes[]` → 同步抓取。`refresh=true` 忽略缓存 |
| GET | `/api/stock-signals/scans/:id` | 公开 | 任务状态轮询，done 附 B 列表 |
| GET | `/api/stock-signals?date=` | 公开 | 某日结果（最新 done 任务），未扫描 404 |
| GET | `/api/stock-signals/dates` | 公开 | 历史日期列表 |

## 缓存语义

- 某日期存在 `done` 任务且 `refresh != true` → 直接返回缓存，零外呼
- 该日期有 `pending/running` 任务 → 复用该任务（前端轮询），不重复开扫
- 强制刷新 → 新建任务重扫，`stock_signals` 按 `UNIQUE(signal_date, code)` upsert 覆盖
- 指定 codes 查询：命中 `stock_signals` 缓存的跳过抓取，未命中逐只同步抓并落库

## 建表 DDL（synchronize=false，需手动执行）

```sql
CREATE TABLE IF NOT EXISTS stock_signal_scan_runs (
  id varchar(36) NOT NULL PRIMARY KEY,
  query_date date NOT NULL,
  status enum('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  total int NOT NULL DEFAULT 0,
  checked int NOT NULL DEFAULT 0,
  found int NOT NULL DEFAULT 0,
  failed_codes json NULL,
  created_by varchar(36) NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX IDX_run_date_status (query_date, status)
);

CREATE TABLE IF NOT EXISTS stock_signals (
  id varchar(36) NOT NULL PRIMARY KEY,
  signal_date date NOT NULL,
  code char(6) NOT NULL,
  market enum('sh','sz') NOT NULL,
  name varchar(50) NOT NULL,
  value varchar(10) NOT NULL,
  run_id varchar(36) NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY UQ_signal_date_code (signal_date, code)
);
```

## 关键实现

- **股票清单**：`stock-list.data.ts` 静态常量（3044 只沪深主板非 ST，迁移自原页面内嵌数据）
- **抓取**：`SinaScannerService` 直接 HTTP 请求 `finance.sina.com.cn/finance/hq/upbs/{market}{code}.js`（替代 JSONP），正则解出 `var _touzibullbear_xxx={...}` 中的 JSON；12 路并发、10s 超时、单只失败不中断；**必须带 Referer 头**（新浪校验，缺失 403）
- **任务执行**：`executeRun` 异步 fire-and-forget；进度每 50 只节流写库；upsert 分批 500 行；异常落入 `status=failed`
- **只存当日有信号值的行**（value 非 null）；`found` 统计 value='1' 的行数
- **防滥用**：仅 POST /scans 需登录（3000+ 次外呼），查询类接口公开（与日报模块一致）
