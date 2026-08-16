-- ============================================================================
-- 2026-08-15 代码审查：prompts / ai-generation 模块修复配套 DDL
-- 说明：synchronize 已全环境关闭，本文件需在 Adminer（:8080）手动执行，不写 migration。
-- 本文件仅记录 DDL，不执行（由人工在数据库执行）。
-- ============================================================================

-- 1) generation_tasks 补索引：轮询按 status + createdAt 排序扫描
--    generation-poller 每 10s 查询 pending/processing 任务并按创建时间升序处理，
--    该索引加速「按状态过滤 + 按创建时间排序」的扫描路径（现仅有 (user_id, status) 索引）。
CREATE INDEX idx_generation_tasks_status_created
  ON generation_tasks (status, created_at);

-- 说明：
-- - 实体侧同步加了 @Index(['status', 'createdAt'])（generation-task.entity.ts），
--   此处 DDL 与实体声明保持一致；若表已存在旧数据，执行 CREATE INDEX 即可增量建索引。
-- - prompts / ai-generation 其余修复均为纯代码改动（SSRF 防护、流式大小上限、
--   失败退避、参考素材上限校验等），不涉及表结构变更，无需额外 DDL。
