import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';

/**
 * 基础 LLM 模块：只导出 LlmService，无 Controller，不暴露路由。
 * ConfigModule 在 app.module 已配置 isGlobal，此处显式 import 仅作声明。
 */
@Module({
  imports: [ConfigModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
