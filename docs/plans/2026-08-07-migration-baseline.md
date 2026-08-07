# 数据库 Migration 上线操作手册（baseline）

**背景**：项目 `synchronize` 已全局关闭，表结构变更一律走 migration（`src/database/migrations/`）。但历史遗留：部分存量表是 synchronize 时代自动建/手工建的，**没有迁移记录**。这些表对应的迁移文件直接在存量库执行会报「表已存在」。本文是存量环境（尤其是生产）的 baseline 操作步骤。

**原则**：表已存在 → 手工把对应迁移记录插进 `migrations` 表（假装已执行）；表不存在 → 让迁移正常跑。**先查再插，别盲插。**

## 迁移清单（按 timestamp 顺序执行）

| timestamp | name | 建什么 |
|---|---|---|
| 1754558400000 | CreateWeeklyGoals1754558400000 | `weekly_goals` |
| 1786088458611 | CreateStockSignalTables1786088458611 | `stock_signals`、`stock_signal_scan_runs` |

## 生产上线步骤

### 第 1 步：确认每张表在库里是否存在

```sql
SHOW TABLES LIKE 'weekly_goals';
SHOW TABLES LIKE 'stock_signals';
SHOW TABLES LIKE 'stock_signal_scan_runs';
```

### 第 2 步：对「已存在」的表，手工插入 baseline 记录

⚠️ **只插已存在表对应的记录，不存在的别插**（插了迁移就会被跳过，表永远不会被创建）。

```sql
-- 示例：stock_signals / stock_signal_scan_runs 已存在（synchronize 时代建的），weekly_goals 不存在
INSERT INTO migrations (timestamp, name) VALUES
  (1786088458611, 'CreateStockSignalTables1786088458611');

-- 如果 weekly_goals 也已存在（比如提前手工建过），才追加这条：
-- INSERT INTO migrations (timestamp, name) VALUES
--   (1754558400000, 'CreateWeeklyGoals1754558400000');
```

### 第 3 步：跑剩余迁移

`deploy.sh` 已集成迁移步骤（切换 app 前自动执行），重新部署即可；或在服务器上手动：

```bash
pnpm migration:run:prod   # 用编译后的 dist/database/data-source.js
pnpm migration:show       # 确认全部 [X]
```

### 第 4 步：验证

```sql
SELECT * FROM migrations ORDER BY timestamp;
SHOW TABLES LIKE 'weekly_goals';
```

## 回滚

- `pnpm migration:revert` 回滚最近一次迁移（会执行 down()，**DROP 表**，生产慎用）。
- baseline 插入的记录如果想撤销（让迁移能真正执行）：`DELETE FROM migrations WHERE name = '<名称>';`，然后 `pnpm migration:run`。

## 已知残留漂移（暂不处理）

- `agent_configs.provider` 枚举：代码已移除 `deepseek`，存量库枚举仍含 `deepseek`。无害（代码层面已无法写入该值），修需要 ALTER 枚举——若存量数据里有 `provider='deepseek'` 的行会直接失败，处理前先查：`SELECT COUNT(*) FROM agent_configs WHERE provider='deepseek';` 为 0 才能 ALTER。

## 今后纪律

- 改实体 → `pnpm migration:generate src/database/migrations/<名称>` → 人工检查生成的 SQL → `pnpm migration:run` 本地验证 → 随代码一起提交。
- 新环境（新开发机/新测试库）：`pnpm migration:run` 一把梭，不需要 baseline。
- 禁止再手工改库表结构——手工改了实体和库就会漂移，`migration:generate` 会给你拉出屎山。
