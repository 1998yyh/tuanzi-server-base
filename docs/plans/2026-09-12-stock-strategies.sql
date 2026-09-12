-- 观澜个人策略库。synchronize=false，按项目 DDL 流水线执行。
-- 逻辑删除保留版本和名称，便于后续筛选快照引用；当前无删除数据语句。
CREATE TABLE IF NOT EXISTS stock_strategies (
  id varchar(36) NOT NULL,
  user_id varchar(36) NOT NULL,
  name varchar(80) NOT NULL,
  version int unsigned NOT NULL DEFAULT 1,
  definition json NOT NULL,
  revisions json NOT NULL,
  deleted_at datetime NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_strategies_user_name (user_id, name),
  KEY idx_stock_strategies_user_deleted (user_id, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
