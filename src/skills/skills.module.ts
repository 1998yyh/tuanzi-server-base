import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from './skill.entity';
import { User } from '../users/users.entity';
import { SkillsService } from './skills.service';
import { SkillsController } from './skills.controller';
import { SkillToolFactory } from './skill-tool.factory';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

@Module({
  imports: [TypeOrmModule.forFeature([Skill, User]), McpServersModule],
  controllers: [SkillsController],
  providers: [SkillsService, SkillToolFactory],
  exports: [SkillsService, SkillToolFactory],
})
export class SkillsModule {}
