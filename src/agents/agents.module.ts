import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentConfig } from './entities/agent-config.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { AgentCheckpoint } from './entities/agent-checkpoint.entity';
import { AgentCheckpointWrite } from './entities/agent-checkpoint-write.entity';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { AgentExecutorService } from './agent-executor.service';
import { ToolRegistryService } from './tools/tool-registry.service';
import { TypeORMCheckpointer } from './checkpointers/typeorm.checkpointer';
import { encryptionKeyProvider } from './utils/encryption-key.provider';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { SkillsModule } from '../skills/skills.module';
import { DailyReportsModule } from '../daily-reports/daily-reports.module';
import { ScheduledTask } from './scheduled-tasks/scheduled-task.entity';
import { ScheduledTasksService } from './scheduled-tasks/scheduled-tasks.service';
import { CanvasToolsService } from './tools/canvas/canvas-tools.service';
import { CanvasModule } from '../canvas/canvas.module';
import { AiGenerationModule } from '../ai-generation/ai-generation.module';
import { PromptsModule } from '../prompts/prompts.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      AgentConfig,
      Conversation,
      Message,
      AgentCheckpoint,
      AgentCheckpointWrite,
      ScheduledTask,
    ]),
    McpServersModule,
    SkillsModule,
    DailyReportsModule,
    // 画布工具依赖：canvas/ai-generation/prompts/assets（依赖方向 agents → 各模块，无环）
    CanvasModule,
    AiGenerationModule,
    PromptsModule,
    AssetsModule,
  ],
  controllers: [AgentsController, ConversationsController],
  providers: [
    AgentsService,
    ConversationsService,
    AgentExecutorService,
    ToolRegistryService,
    TypeORMCheckpointer,
    ScheduledTasksService,
    CanvasToolsService,
    encryptionKeyProvider,
  ],
})
export class AgentsModule {}
