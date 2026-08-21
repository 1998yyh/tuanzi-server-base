-- background_tasks 建表（CLAUDE.md 记录的生产手动 DDL，此前漏执行）
CREATE TABLE background_tasks (
  id char(36) NOT NULL PRIMARY KEY,
  conversation_id char(36) NOT NULL,
  agent_config_id char(36) NOT NULL,
  status enum('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  input text NOT NULL,
  result_message_id char(36) NULL,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  finished_at datetime(6) NULL,
  KEY idx_bg_conv_status (conversation_id, status),
  CONSTRAINT fk_bg_conv FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- messages 补 is_error 列（工具失败持久化标记，CLAUDE.md 记录的手动 DDL，此前漏执行）
ALTER TABLE messages ADD COLUMN is_error tinyint(1) NOT NULL DEFAULT 0;
