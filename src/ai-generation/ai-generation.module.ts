import { Module } from '@nestjs/common';
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
export class AiGenerationModule {}
