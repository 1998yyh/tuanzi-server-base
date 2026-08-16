-- Phase 5：assets 模块建表 SQL
-- 背景：30e7b2f 起 TypeORM synchronize 固定为 false，新表需手工执行（Adminer :8080）
-- 说明：文本素材内容存 text_content；图片/视频素材引用 media_files（media_id）

CREATE TABLE `assets` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `kind` enum('text','image','video') NOT NULL,
  `title` varchar(200) NOT NULL,
  `text_content` text NULL,
  `media_id` varchar(36) NULL,
  `tags` json NULL,
  `source` varchar(200) NOT NULL DEFAULT '',
  `note` varchar(500) NOT NULL DEFAULT '',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_assets_user_kind` (`user_id`, `kind`),
  KEY `FK_assets_media` (`media_id`),
  CONSTRAINT `FK_assets_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_assets_media` FOREIGN KEY (`media_id`) REFERENCES `media_files` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
