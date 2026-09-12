-- 仅供项目 DDL 流水线执行；不要手工在环境中运行。
CREATE TABLE `stock_alerts` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `code` char(6) NOT NULL,
  `field` varchar(16) NOT NULL,
  `parameters` json NULL,
  `operator` varchar(3) NOT NULL,
  `threshold` decimal(20,6) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `last_match` tinyint(1) NULL,
  `last_bar_time` varchar(32) NULL,
  `last_observed_at` varchar(32) NULL,
  `version` int unsigned NOT NULL DEFAULT 1,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_stock_alerts_user_enabled` (`user_id`, `enabled`),
  CONSTRAINT `FK_stock_alerts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `CHK_stock_alerts_code` CHECK (`code` REGEXP '^[0-9]{6}$'),
  CONSTRAINT `CHK_stock_alerts_field` CHECK (`field` IN ('price', 'change', 'MA', 'MACD', 'KDJ', 'RSI', 'BOLL')),
  CONSTRAINT `CHK_stock_alerts_operator` CHECK (`operator` IN ('gte', 'lte'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stock_alert_events` (
  `id` varchar(36) NOT NULL,
  `alert_id` varchar(36) NOT NULL,
  `alert_version` int unsigned NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `code` char(6) NOT NULL,
  `message` varchar(255) NOT NULL,
  `read_at` datetime NULL,
  `delivery_status` varchar(16) NOT NULL DEFAULT 'queued',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQ_stock_alert_events_alert_version` (`alert_id`, `alert_version`),
  KEY `IDX_stock_alert_events_user_created` (`user_id`, `created_at`),
  CONSTRAINT `FK_stock_alert_events_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `CHK_stock_alert_events_delivery` CHECK (`delivery_status` IN ('queued'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
