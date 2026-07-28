import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpServer } from './mcp-server.entity';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';
import { encryptionKeyProvider } from '../agents/utils/encryption-key.provider';

@Module({
  imports: [TypeOrmModule.forFeature([McpServer])],
  controllers: [McpServersController],
  providers: [McpServersService, encryptionKeyProvider],
  exports: [McpServersService],
})
export class McpServersModule {}
