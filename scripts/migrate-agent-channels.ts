/**
 * 一次性迁移：agent_configs 内嵌 LLM 凭据（provider/apiKey/baseUrl/model）→ ai_channels 渠道物化。
 *
 * 用法：
 *   默认模式   npx ts-node -r tsconfig-paths/register scripts/migrate-agent-channels.ts
 *   删列模式   npx ts-node -r tsconfig-paths/register scripts/migrate-agent-channels.ts --drop-legacy
 *
 * 前置：先备份（mysqldump）。幂等：channel_id 列已存在时跳过 DDL，仅补跑未回填的行。
 * 删列模式在端到端验收通过后单独执行：DROP 旧四列，不可逆！
 *
 * 密文直接跨表复制：两表共用 AGENT_ENCRYPTION_KEY + AES-256-GCM。
 * 合并语义：同一 user + provider + baseUrl + key 的多个 Agent 合并为一个渠道，
 * 不同 model 逐个追加进渠道 models（用途均为「对话」）。
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';

/** 与 app.module 一致的 env 加载顺序（.env.local 优先，已存在的 process.env 最高优先） */
function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
}

/** Agent baseUrl 为空（走 SDK 默认）时物化出的渠道 baseUrl（ai_channels.base_url NOT NULL） */
const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

const LEGACY_COLUMNS = ['provider', 'model', 'api_key_encrypted', 'base_url'] as const;

interface AgentRow {
  id: string;
  user_id: string;
  provider: 'anthropic' | 'openai';
  model: string;
  api_key_encrypted: string;
  base_url: string | null;
}

async function connect(): Promise<DataSource> {
  loadEnv();
  const ds = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    username: process.env.DB_USERNAME ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'tuanzi_server',
  });
  await ds.initialize();
  return ds;
}

/** 删列模式：DROP 旧四列（幂等；前置校验 channel_id 已是 NOT NULL） */
async function dropLegacyColumns(): Promise<void> {
  const ds = await connect();
  const notNull = await ds.query<Array<{ Null: string }>>(
    `SHOW COLUMNS FROM agent_configs LIKE 'channel_id'`,
  );
  if (!notNull.length || notNull[0].Null !== 'NO') {
    throw new Error('channel_id 尚未回填/收紧为 NOT NULL，请先跑默认模式迁移');
  }
  const dropped: string[] = [];
  for (const col of LEGACY_COLUMNS) {
    const exists: unknown[] = await ds.query(`SHOW COLUMNS FROM agent_configs LIKE '${col}'`);
    if (!exists.length) continue;
    await ds.query(`ALTER TABLE agent_configs DROP COLUMN ${col}`);
    dropped.push(col);
  }
  await ds.destroy();
  console.log(dropped.length ? `已删除旧列：${dropped.join(', ')}` : '旧列均已删除，无需操作');
}

async function main(): Promise<void> {
  if (process.argv.includes('--drop-legacy')) {
    await dropLegacyColumns();
    return;
  }

  const ds = await connect();
  const cols: unknown[] = await ds.query(`SHOW COLUMNS FROM agent_configs LIKE 'channel_id'`);
  const ddlDone = cols.length > 0;

  if (!ddlDone) {
    // ── Phase A：DDL ──
    await ds.query(
      `ALTER TABLE ai_channels MODIFY COLUMN api_format ENUM('openai','gemini','ark','anthropic') NOT NULL`,
    );
    await ds.query(
      `ALTER TABLE agent_configs
         ADD COLUMN channel_id VARCHAR(36) NULL AFTER base_url,
         ADD COLUMN model_name VARCHAR(100) NULL AFTER channel_id`,
    );
    // 旧四列本阶段不删，由 --drop-legacy 在验收通过后统一删除
    console.log('Phase A：DDL 完成');
  } else {
    console.log('Phase A：channel_id 已存在，跳过 DDL');
  }

  // ── Phase A2：放宽旧四列 NOT NULL（独立探测，幂等）──
  // 实体已删除旧字段，新代码 INSERT 不再提供这些列；若不放宽约束，
  // 「验收 → --drop-legacy」窗口期内新建 Agent 必报 ER_NO_DEFAULT_FOR_FIELD。
  const LEGACY_RELAX: Array<[string, string]> = [
    ['provider', `ENUM('anthropic','openai','deepseek') NULL`],
    ['model', 'VARCHAR(100) NULL'],
    ['api_key_encrypted', 'TEXT NULL'],
    ['base_url', 'VARCHAR(500) NULL'],
  ];
  const legacyCols = await ds.query<Array<{ Field: string; Null: string }>>(
    `SHOW COLUMNS FROM agent_configs WHERE Field IN ('provider','model','api_key_encrypted','base_url')`,
  );
  const toRelax = LEGACY_RELAX.filter(([name]) =>
    legacyCols.some((c) => c.Field === name && c.Null === 'NO'),
  );
  if (toRelax.length > 0) {
    for (const [name, def] of toRelax) {
      await ds.query(`ALTER TABLE agent_configs MODIFY COLUMN ${name} ${def}`);
    }
    console.log(`Phase A2：旧列 ${toRelax.map(([n]) => n).join(', ')} 已放宽为 NULL`);
  } else {
    console.log('Phase A2：旧列均已为 NULL 或已删除，跳过');
  }

  // ── Phase B：存量数据物化（同一 user+provider+baseUrl+key 去重为一个渠道，model 逐个追加）──
  const agents = await ds.query<AgentRow[]>(
    `SELECT id, user_id, provider, model, api_key_encrypted, base_url
       FROM agent_configs
      WHERE channel_id IS NULL AND provider IS NOT NULL`,
  );
  // key → { channelId, models: 已挂进渠道的模型名 }
  const channelCache = new Map<string, { channelId: string; models: Set<string> }>();
  const failures: string[] = [];
  for (const agent of agents) {
    const baseUrl = agent.base_url ?? DEFAULT_BASE_URL[agent.provider];
    const key = [agent.user_id, agent.provider, baseUrl, agent.api_key_encrypted].join('|');
    const cached = channelCache.get(key);
    const channelId = cached?.channelId ?? randomUUID();
    // 单个 Agent 的「建渠道 + 追加模型 + 回填」是一个事务单元：
    // 中途崩溃整体回滚，不会留孤儿渠道，重跑安全
    try {
      await ds.transaction(async (manager) => {
        if (!cached) {
          await manager.query(
            `INSERT INTO ai_channels (id, user_id, name, api_format, base_url, api_key, models, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
            [
              channelId,
              agent.user_id,
              `迁移渠道（${agent.provider}）`,
              agent.provider,
              baseUrl,
              agent.api_key_encrypted,
              JSON.stringify([]),
            ],
          );
        }
        // 同凭据不同模型的 Agent 合并进同一渠道：模型逐个追加（JSON_ARRAY_APPEND 保持数组形态）。
        // 注意：渠道初始 models 为空数组、逐个追加——若插入时就带上第一个模型，
        // 同凭据的第二个 Agent 的模型会丢（grilling 自查出的合并缺陷）
        if (!cached || !cached.models.has(agent.model)) {
          await manager.query(
            `UPDATE ai_channels
                SET models = JSON_ARRAY_APPEND(models, '$', JSON_OBJECT('name', ?, 'capability', 'chat'))
              WHERE id = ?`,
            [agent.model, channelId],
          );
        }
        await manager.query(
          `UPDATE agent_configs SET channel_id = ?, model_name = ? WHERE id = ?`,
          [channelId, agent.model, agent.id],
        );
      });
      // 事务提交成功后再写内存缓存（回滚时不能留下指向不存在渠道的缓存项）
      const entry = cached ?? { channelId, models: new Set<string>() };
      entry.models.add(agent.model);
      channelCache.set(key, entry);
    } catch (err) {
      failures.push(agent.id);
      console.error(`Phase B：Agent ${agent.id} 物化失败（已回滚，重跑可补偿）：`, err);
    }
  }
  console.log(
    `Phase B：物化渠道 ${channelCache.size} 个，回填 Agent ${agents.length - failures.length} 条`,
  );
  if (failures.length) {
    await ds.destroy();
    console.error(
      `Phase B：${failures.length} 个 Agent 物化失败：${failures.join(', ')}，修复后重跑`,
    );
    process.exit(1);
  }

  // 未回填行（历史脏数据：provider 为 NULL）不给约束报错的机会
  const orphans: Array<{ c: number }> = await ds.query(
    `SELECT COUNT(*) AS c FROM agent_configs WHERE channel_id IS NULL`,
  );
  if (orphans[0].c > 0) {
    throw new Error(`仍有 ${orphans[0].c} 行 agent_configs.channel_id 为 NULL，请人工处理后重跑`);
  }

  // ── Phase C：约束收紧（独立探测，不依赖 Phase A 标志；每个子步骤缺啥补啥）──
  const nullableCols: string[] = [];
  for (const col of ['channel_id', 'model_name'] as const) {
    const rows = await ds.query<Array<{ Null: string }>>(
      `SHOW COLUMNS FROM agent_configs LIKE '${col}'`,
    );
    if (rows.length && rows[0].Null !== 'NO') nullableCols.push(col);
  }
  if (nullableCols.length) {
    const defs = nullableCols.map((c) =>
      c === 'channel_id'
        ? 'MODIFY COLUMN channel_id VARCHAR(36) NOT NULL'
        : 'MODIFY COLUMN model_name VARCHAR(100) NOT NULL',
    );
    await ds.query(`ALTER TABLE agent_configs ${defs.join(', ')}`);
    console.log(`Phase C：${nullableCols.join(', ')} 已收紧为 NOT NULL`);
  }
  const fkRows: unknown[] = await ds.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_NAME = 'fk_agent_configs_channel' AND TABLE_SCHEMA = DATABASE()`,
  );
  if (!fkRows.length) {
    await ds.query(
      `ALTER TABLE agent_configs
         ADD CONSTRAINT fk_agent_configs_channel
         FOREIGN KEY (channel_id) REFERENCES ai_channels (id) ON DELETE RESTRICT`,
    );
    console.log('Phase C：FK fk_agent_configs_channel 已添加');
  }
  if (!nullableCols.length && fkRows.length) {
    console.log('Phase C：约束已就位，跳过');
  }

  await ds.destroy();
  console.log('迁移完成（旧四列保留待验收，通过后以 --drop-legacy 删除）');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
