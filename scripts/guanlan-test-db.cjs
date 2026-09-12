/* Creates an EMPTY, explicitly named guanlan_test_* database for local verification.
 * Existing base-module schema is generated only into this isolated database;
 * Guanlan tables use the actual reviewed SQL files, with synchronize always false.
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { DataSource } = require('typeorm');
const name = process.env.DB_DATABASE;
if (!/^guanlan_test_[a-z0-9_]+$/.test(name || ''))
  throw new Error('Use an isolated guanlan_test_* database name');
const connection = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 13306),
  user: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD,
};
async function main() {
  const admin = await mysql.createConnection(connection);
  try {
    await admin.query(
      'CREATE DATABASE IF NOT EXISTS `' +
        name +
        '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );
    const [tables] = await admin.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
      [name],
    );
    if (tables.length) throw new Error('Database must be empty; existing data will not be changed');
  } finally {
    await admin.end();
  }
  const ds = new DataSource({
    type: 'mysql',
    host: connection.host,
    port: connection.port,
    username: connection.user,
    password: connection.password,
    database: name,
    charset: 'utf8mb4_unicode_ci',
    entities: [path.resolve(__dirname, '../src/**/*.entity.ts')],
    synchronize: false,
  });
  await ds.initialize();
  try {
    const { upQueries } = await ds.driver.createSchemaBuilder().log();
    const newTables =
      /`(?:stock_strategies|stock_screening_runs|stock_research_conversations|stock_research_watchlist|stock_alerts|stock_alert_events)`/;
    for (const query of upQueries.filter((q) => !newTables.test(q.query))) {
      // Existing base entity defines two different index orders with the same generated name.
      // Isolated-fixture workaround only; never changes that pre-existing entity or production.
      await ds.query(
        query.query.replace(
          /(?<!UNIQUE )INDEX `IDX_e60ebaf1a2fcdeb96efb840698`/g,
          'INDEX `idx_test_stock_code_date`',
        ),
        query.parameters,
      );
    }
    for (const file of [
      'stock-strategies',
      'stock-market-screening',
      'stock-research',
      'stock-alerts',
    ]) {
      const sql = fs
        .readFileSync(path.resolve(__dirname, '../docs/plans/2026-09-12-' + file + '.sql'), 'utf8')
        .replace(/^\s*--.*$/gm, '');
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await ds.query(statement);
      console.log('Applied reviewed DDL: ' + file);
    }
    console.log('Isolated database prepared: ' + name);
  } finally {
    await ds.destroy();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
