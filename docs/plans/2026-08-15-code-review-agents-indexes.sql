-- ============================================================
-- 2026-08-15 代码审查：agents 模块索引补充（synchronize 已关闭，需手工执行）
--
-- 背景：
-- 1. GET /api/conversations/:id/messages 按 (conversation_id, seq DESC) 分页查询，
--    原有的 (conversation_id, created_at) 索引无法覆盖 seq 排序，缺少该索引时
--    同一会话消息量增大后会出现 filesort 与全表扫描。
-- 2. 保留原有 (conversation_id, created_at) 索引不动（兼容既有查询路径）。
--
-- 执行方式：在 Adminer（http://localhost:8080）或 mysql 客户端手工执行以下 DDL。
-- 幂等说明：MySQL 8.0 的 CREATE INDEX 不支持 IF NOT EXISTS，
--   重复执行会报 Duplicate key name，属预期行为。
-- ============================================================

CREATE INDEX idx_messages_conversation_seq ON messages (conversation_id, seq);
