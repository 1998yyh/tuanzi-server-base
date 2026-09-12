-- AI复盘会话上下文（复用 conversations/messages，外键级联清理上下文）
CREATE TABLE IF NOT EXISTS stock_research_conversations (
 conversation_id varchar(36) NOT NULL PRIMARY KEY,
 user_id varchar(36) NOT NULL,
 context json NOT NULL,
 evidence json NOT NULL,
 created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 KEY idx_stock_research_user(user_id),
 CONSTRAINT fk_stock_research_conversation FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_research_watchlist (
 id varchar(36) NOT NULL PRIMARY KEY,
 user_id varchar(36) NOT NULL,
 code char(6) NOT NULL,
 name varchar(50) NOT NULL,
 reason text NOT NULL,
 created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
 UNIQUE KEY uq_stock_research_watch(user_id,code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
