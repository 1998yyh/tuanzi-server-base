-- 股票观察池（stock_watchlist）建表 + stock_signals 补索引
-- synchronize=false，需手动在 Adminer（:8080）/生产库执行后再发版
--（deploy.sh 前置的 check-prod-schema.sh 会校验 @Entity 表清单 vs 生产库 SHOW TABLES）

CREATE TABLE IF NOT EXISTS stock_watchlist (
  id varchar(36) NOT NULL PRIMARY KEY,
  user_id varchar(36) NOT NULL,
  code char(6) NOT NULL,
  market enum('sh','sz') NOT NULL,
  name varchar(50) NOT NULL,
  status enum('watching','triggered') NOT NULL DEFAULT 'watching',
  entry_signal_date date NOT NULL,
  triggered_signal_date date NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX IDX_watchlist_user (user_id),
  UNIQUE KEY UQ_watchlist_user_code (user_id, code)
);

-- 观察池 S 评估按 code 回查信号（WHERE code=? AND value='0' AND signal_date>?），
-- 现有 UNIQUE(signal_date, code) 左前缀是 signal_date，帮不上 code 查询，补复合索引
ALTER TABLE stock_signals ADD INDEX IDX_signal_code_date (code, signal_date);
