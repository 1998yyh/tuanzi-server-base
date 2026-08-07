import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 股票信号两张表（stock-signals 模块，对应 src/stock-signals/*.entity.ts）。
 * 历史欠账：这两张表当初靠 synchronize 自动创建，synchronize 关闭后新环境没有表。
 * 存量环境（表已存在）请勿直接执行本迁移——按 docs/plans/2026-08-07-migration-baseline.md
 * 先手工插入 baseline 记录。
 */
export class CreateStockSignalTables1786088458611 implements MigrationInterface {
  name = 'CreateStockSignalTables1786088458611';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`stock_signals\` (\`id\` varchar(36) NOT NULL, \`signal_date\` date NOT NULL, \`code\` char(6) NOT NULL, \`market\` enum ('sh', 'sz') NOT NULL, \`name\` varchar(50) NOT NULL, \`value\` varchar(10) NOT NULL, \`run_id\` varchar(36) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_e60ebaf1a2fcdeb96efb840698\` (\`signal_date\`, \`code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`stock_signal_scan_runs\` (\`id\` varchar(36) NOT NULL, \`query_date\` date NOT NULL, \`status\` enum ('pending', 'running', 'done', 'failed') NOT NULL DEFAULT 'pending', \`total\` int NOT NULL DEFAULT '0', \`checked\` int NOT NULL DEFAULT '0', \`found\` int NOT NULL DEFAULT '0', \`failed_codes\` json NULL, \`created_by\` varchar(36) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_d4b171be24408b5d19e8fd9767\` (\`query_date\`, \`status\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`IDX_d4b171be24408b5d19e8fd9767\` ON \`stock_signal_scan_runs\``,
    );
    await queryRunner.query(`DROP TABLE \`stock_signal_scan_runs\``);
    await queryRunner.query(`DROP INDEX \`IDX_e60ebaf1a2fcdeb96efb840698\` ON \`stock_signals\``);
    await queryRunner.query(`DROP TABLE \`stock_signals\``);
  }
}
