import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DailyReportsModule } from './daily-reports/daily-reports.module';
import { AgentsModule } from './agents/agents.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { SkillsModule } from './skills/skills.module';
import { StockSignalsModule } from './stock-signals/stock-signals.module';
import { WeeklyGoalsModule } from './weekly-goals/weekly-goals.module';

@Module({
  imports: [
    // 配置模块
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // 数据库连接
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get('DB_PORT', 3306),
        username: configService.get('DB_USERNAME', 'root'),
        password: configService.get('DB_PASSWORD', ''),
        database: configService.get('DB_DATABASE', 'tuanzi_server'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        // synchronize 全局关闭：表结构变更一律走 migration（见 src/database/）
        synchronize: false,
        // 应用启动不自动跑迁移，部署流程里显式执行 pnpm migration:run
        migrationsRun: false,
        logging: configService.get('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),

    AuthModule,
    UsersModule,
    DailyReportsModule,
    AgentsModule,
    McpServersModule,
    SkillsModule,
    StockSignalsModule,
    WeeklyGoalsModule,
  ],
})
export class AppModule {}
