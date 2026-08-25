import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { stdTimeFunctions, stdSerializers } from 'pino';
import { randomUUID } from 'crypto';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DailyReportsModule } from './daily-reports/daily-reports.module';
import { AgentsModule } from './agents/agents.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { SkillsModule } from './skills/skills.module';
import { StockSignalsModule } from './stock-signals/stock-signals.module';
import { MediaModule } from './media/media.module';
import { AiGenerationModule } from './ai-generation/ai-generation.module';
import { CanvasModule } from './canvas/canvas.module';
import { PromptsModule } from './prompts/prompts.module';
import { AssetsModule } from './assets/assets.module';

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
        synchronize: false,
        logging: configService.get('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),

    // 结构化日志（pino）：生产 JSON 输出供 scripts/logs.sh 按级别/路径/时间过滤查询，
    // 开发走 pino-pretty 保持可读；业务代码的 NestJS Logger 由 useLogger 接管，零改动
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // ISO 时间戳：jq 过滤结果人眼可读（默认 epoch 毫秒反人类）
        timestamp: stdTimeFunctions.isoTime,
        // traceId 贯穿 access log 与异常日志，单容器 uuid 防多行日志串号
        genReqId: () => randomUUID(),
        // 红线：凭据类头部绝不允许落盘
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        serializers: {
          // req 只留排障三要素（默认序列化整 headers，又吵又可能带敏感信息）
          req: (req: { id: string; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          err: stdSerializers.err,
        },
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),

    AuthModule,
    UsersModule,
    DailyReportsModule,
    AgentsModule,
    McpServersModule,
    SkillsModule,
    StockSignalsModule,
    MediaModule,
    AiGenerationModule,
    CanvasModule,
    PromptsModule,
    AssetsModule,
  ],
})
export class AppModule {}
