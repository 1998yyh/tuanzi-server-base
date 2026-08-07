import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

// 与 app.module.ts 的 envFilePath 保持一致：.env.local 优先于 .env
dotenv.config({ path: ['.env.local', '.env'] });

/**
 * TypeORM CLI 专用 DataSource（migration:generate/run/revert/show）。
 * 应用运行时的连接配置在 app.module.ts 的 TypeOrmModule.forRootAsync 里，
 * 两边必须保持一致——改连接参数时记得同步。
 */
export default new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  username: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'tuanzi_server',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
});
