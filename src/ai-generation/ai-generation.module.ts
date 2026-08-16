import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '../media/media.module';
import { CanvasModule } from '../canvas/canvas.module';
import { encryptionKeyProvider } from '../agents/utils/encryption-key.provider';
import { AgentConfig } from '../agents/entities/agent-config.entity';
import { AiChannel } from './entities/ai-channel.entity';
import { GenerationTask } from './entities/generation-task.entity';
import { AiChannelsController } from './ai-channels.controller';
import { AiChannelsService } from './ai-channels.service';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { GenerationPollerService } from './generation-poller.service';

// 依赖方向：ai-generation → canvas（canvas 不反向依赖，无环）
@Module({
  imports: [
    TypeOrmModule.forFeature([AiChannel, GenerationTask, AgentConfig]),
    MediaModule,
    CanvasModule,
  ],
  controllers: [AiChannelsController, GenerationController],
  providers: [AiChannelsService, GenerationService, GenerationPollerService, encryptionKeyProvider],
  exports: [AiChannelsService, GenerationService],
})
export class AiGenerationModule implements OnModuleInit {
  /**
   * 生产环境 fail-fast：PUBLIC_BASE_URL 缺省是 localhost，远端模型服务侧不可达，
   * 参考音视频素材（videoReferenceUrls / audioReferenceUrls）会因此全部生成失败。
   */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_BASE_URL) {
      throw new Error(
        '生产环境必须配置 PUBLIC_BASE_URL（视频/音频参考素材需要公网可访问的绝对地址，不能使用 localhost 缺省值）',
      );
    }
  }
}
