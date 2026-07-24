import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentConfig,
      Conversation,
      Message,
      AgentCheckpoint,
      AgentCheckpointWrite,
    ]),
  ],
  controllers: [AgentsController, ConversationsController],
  providers: [
    AgentsService,
    ConversationsService,
    AgentExecutorService,
    ToolRegistryService,
    TypeORMCheckpointer,
    encryptionKeyProvider,
  ],
})
export class AgentsModule {}
