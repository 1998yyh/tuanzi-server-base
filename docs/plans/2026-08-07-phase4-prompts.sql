-- Phase 4：prompts 模块建表 SQL
-- 背景：30e7b2f 起 TypeORM synchronize 固定为 false，新表需手工执行（Adminer :8080）
-- 说明：prompt_sources.user_id 为 NULL 表示内置源（所有用户共享），服务启动时幂等种子化

CREATE TABLE `prompt_sources` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NULL,
  `name` varchar(100) NOT NULL,
  `url` varchar(500) NOT NULL,
  `homepage` varchar(500) NOT NULL DEFAULT '',
  `is_builtin` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_prompt_sources_user_id` (`user_id`),
  CONSTRAINT `FK_prompt_sources_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
