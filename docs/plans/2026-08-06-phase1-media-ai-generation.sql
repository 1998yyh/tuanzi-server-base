-- Phase 1：media + ai-generation 模块建表 SQL
-- 背景：30e7b2f 起 TypeORM synchronize 固定为 false，新表需手工执行（Adminer :8080）
-- 字符集与既有表保持一致：utf8mb4

CREATE TABLE `media_files` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `kind` enum('image','video','audio','file') NOT NULL,
  `file_name` varchar(200) NOT NULL,
  `url` varchar(500) NOT NULL,
  `mime_type` varchar(100) NOT NULL,
  `bytes` int unsigned NOT NULL,
  `width` int NULL,
  `height` int NULL,
  `duration_ms` int NULL,
  `source` enum('upload','generation','import') NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `UQ_media_files_file_name` (`file_name`),
  KEY `IDX_media_files_user_kind` (`user_id`,`kind`),
  CONSTRAINT `FK_media_files_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ai_channels` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `name` varchar(100) NOT NULL,
  `api_format` enum('openai','gemini','ark') NOT NULL,
  `base_url` varchar(500) NOT NULL,
  `api_key` text NOT NULL,
  `models` json NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  CONSTRAINT `FK_ai_channels_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `generation_tasks` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `channel_id` varchar(36) NOT NULL,
  `model` varchar(100) NOT NULL,
  `capability` enum('image','video','audio') NOT NULL,
  `status` enum('pending','processing','succeeded','failed','cancelled') NOT NULL DEFAULT 'pending',
  `prompt` text NOT NULL,
  `params` json NULL,
  `remote_task_id` varchar(200) NULL,
  `result_media_id` varchar(36) NULL,
  `result_extra` json NULL,
  `error` text NULL,
  `node_ref` json NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `IDX_generation_tasks_user_status` (`user_id`,`status`),
  CONSTRAINT `FK_generation_tasks_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_generation_tasks_channel` FOREIGN KEY (`channel_id`) REFERENCES `ai_channels` (`id`) ON DELETE CASCADE,
  CONSTRAINT `FK_generation_tasks_result_media` FOREIGN KEY (`result_media_id`) REFERENCES `media_files` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
