import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from './skill.entity';
import { SkillsService } from './skills.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';

@Module({
  imports: [TypeOrmModule.forFeature([Skill]), McpServersModule],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
